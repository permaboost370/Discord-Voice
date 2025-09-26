// server.js — Discord <-> ElevenLabs realtime bridge
// Reliable playback (raw Opus), buffered ElevenLabs utterances, VAD mic capture,
// /dao-say to force speech, /tone to verify Discord playback.
// Includes manual-end guarded receiver to avoid push-after-EOF.

import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import pino from 'pino';
import ffmpegPath from 'ffmpeg-static';
import {
  Client, GatewayIntentBits, Partials, Events, ChannelType, PermissionsBitField
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  EndBehaviorType,
  AudioPlayerStatus,
  NoSubscriberBehavior
} from '@discordjs/voice';
import prism from 'prism-media';
import { Readable } from 'stream';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

// --- crash logging (do not kill, keep /health up) ---
process.on('uncaughtException', (e) => console.error('UNCAUGHT', e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED', e));
console.log('BOOT: starting server.js');

// --- env ---
const {
  DISCORD_TOKEN,
  APP_ID,
  GUILD_ID,
  ELEVEN_API_KEY,
  ELEVEN_AGENT_ID,
  ELEVEN_VOICE_ID,       // optional override
  USE_SIGNED_URL = 'true',
  ENABLE_VAD = 'true',
  PORT = 8080,
  LOG_LEVEL = 'info',
  CHUNK_MS = '20',
  VAD_THRESHOLD = '800',
  VAD_HANG_MS = '300',
  IDLE_CLOSE_MS = '120000'
} = process.env;

const log = pino({ level: LOG_LEVEL });

// --- HTTP health ---
const app = express();
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('alive'));
app.listen(Number(PORT), '0.0.0.0', () => log.info(`HTTP up on :${PORT}`));

// --- Discord client ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.GuildMember]
});

// ---- Commands ----
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const commands = [
    { name: 'dao-join', description: 'Join your VC and start realtime' },
    { name: 'dao-leave', description: 'Leave the VC' },
    { name: 'dao-say', description: 'Force the agent to speak', options: [{ name: 'text', description: 'What to say', type: 3, required: true }] },
    { name: 'tone', description: 'Play a 2s test tone (no ElevenLabs)' }
  ];
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
  log.info('Commands registered');
}

// ---------------- Playback: raw Opus encoder (utterance-buffered) ----------------
let connection = null;
let audioPlayer = null;

// Build a one-shot playback for a whole PCM16k utterance buffer
function playPcm16kBufferOnce(pcm16kBuf) {
  if (!pcm16kBuf || !pcm16kBuf.length) return;

  const pcmSource = Readable.from(pcm16kBuf);

  // 16k mono -> 48k stereo
  const resampler = new prism.FFmpeg({
    command: ffmpegPath,
    args: ['-f','s16le','-ar','16000','-ac','1','-i','pipe:0','-f','s16le','-ar','48000','-ac','2','pipe:1']
  });
  resampler.on('error', (e) => console.error('ffmpeg resampler error:', e));

  // 48k stereo PCM -> raw Opus frames
  const opusEnc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  opusEnc.on('error', (e) => console.error('Opus encoder error:', e));

  pcmSource.pipe(resampler).pipe(opusEnc);

  // Ensure player
  if (!audioPlayer) {
    audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    audioPlayer.on('error', (e) => console.error('AudioPlayer error:', e));
    audioPlayer.on(AudioPlayerStatus.Playing, () => log.info('AudioPlayer: playing'));
    audioPlayer.on(AudioPlayerStatus.Idle,    () => log.info('AudioPlayer: idle'));
  }

  const resource = createAudioResource(opusEnc, { inputType: StreamType.Opus });
  audioPlayer.play(resource);
}

// Simple 2s tone (PCM16k) → same path
function playTone2s() {
  const sr = 16000, secs = 2, total = sr * secs;
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const s = Math.sin(2 * Math.PI * 440 * (i / sr));
    pcm.writeInt16LE((Math.max(-1, Math.min(1, s)) * 32767) | 0, i * 2);
  }
  playPcm16kBufferOnce(pcm);
}

// ---------------- ElevenLabs realtime WS (utterance buffering) ----------------
let ws = null;
let wantWs = false;
let idleTimer = null;

// Buffer an utterance: collect deltas, flush on audio.end or short idle
let currentUtteranceChunks = [];
let flushTimer = null;
const FLUSH_IDLE_MS = 600;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { console.log(`Idle ${IDLE_CLOSE_MS}ms — closing WS`); stopEleven(); }, Number(IDLE_CLOSE_MS));
}
function stopEleven() { wantWs = false; if (ws) { try { ws.close(); } catch {} ws = null; } }

async function getSignedUrl() {
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(ELEVEN_AGENT_ID)}`, { headers: { 'xi-api-key': ELEVEN_API_KEY } });
  if (!res.ok) throw new Error(`get-signed-url failed: ${res.status}`);
  return (await res.json()).signed_url;
}

function flushUtterance(reason = 'flush') {
  if (!currentUtteranceChunks.length) return;
  const pcm = Buffer.concat(currentUtteranceChunks);
  currentUtteranceChunks = [];
  clearTimeout(flushTimer); flushTimer = null;
  console.log(`▶️  Playing buffered utterance (${pcm.length} bytes) reason=${reason}`);
  playPcm16kBufferOnce(pcm);
}

async function connectElevenWS() {
  if (ws || wantWs) return;
  wantWs = true;

  const url = (USE_SIGNED_URL === 'true')
    ? await getSignedUrl()
    : `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(ELEVEN_AGENT_ID)}`;

  ws = new WebSocket(url);

  ws.on('open', () => {
    log.info('Agent WS connected');
    resetIdleTimer();

    ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' }));
    const sessionPayload = {
      type: 'session.update',
      session: {
        input_audio_format:  { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
        output_audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 }
      }
    };
    if (ELEVEN_VOICE_ID) {
      sessionPayload.session.voice_id = ELEVEN_VOICE_ID;
      sessionPayload.session.voice = { voice_id: ELEVEN_VOICE_ID };
    }
    ws.send(JSON.stringify(sessionPayload));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event?.event_id }));
        return;
      }

      // Legacy single-chunk audio (PCM16k mono)
      if (msg.type === 'audio' && msg.audio_event?.audio_base_64) {
        resetIdleTimer();
        const buf = Buffer.from(msg.audio_event.audio_base_64, 'base64');
        currentUtteranceChunks.push(buf);
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(() => flushUtterance('idle'), FLUSH_IDLE_MS);
        console.log('↓ audio (legacy)', buf.length, 'bytes (buffering)');
        return;
      }

      // Streaming audio deltas (PCM16k mono)
      if (msg.type === 'audio.delta' && msg.delta) {
        resetIdleTimer();
        const buf = Buffer.from(msg.delta, 'base64');
        currentUtteranceChunks.push(buf);
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(() => flushUtterance('idle'), FLUSH_IDLE_MS);
        // console.log('↓ audio.delta', buf.length, 'bytes (buffering)');
        return;
      }

      if (msg.type === 'audio.end') { console.log('↓ audio.end (flushing)'); flushUtterance('audio.end'); return; }

      // Log everything else (errors, text, etc.)
      try {
        const preview = JSON.stringify(msg);
        console.log('WS EVENT', msg.type, preview.length > 500 ? preview.slice(0, 500) + '…' : preview);
      } catch {}
    } catch (e) {
      console.error('WS parse error', e);
    }
  });

  ws.on('close', () => {
    console.warn('Agent WS closed');
    ws = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (wantWs && connection) setTimeout(() => connectElevenWS().catch(() => {}), 1500);
  });

  ws.on('error', (err) => console.error('Agent WS error', err));
}

// -------- Mic → Eleven (VAD) + guarded receive pipeline --------
const BYTES_PER_MS = 16000 * 2 / 1000;
const chunkBytes = Math.max(10, Math.min(60, Number(CHUNK_MS))) * BYTES_PER_MS;
const VAD_THRESH = Number(VAD_THRESHOLD);
const VAD_HANG = Number(VAD_HANG_MS);

function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) { const s = buf.readInt16LE(i); sum += s * s; }
  return Math.sqrt(sum / (buf.length / 2 || 1));
}

// --- receive pipeline guard to avoid push-after-EOF ---
let recv = {
  userId: null,
  opus: null,
  decoder: null,
  downsampler: null,
};

function cleanupReceivePipeline(reason = 'cleanup') {
  try { recv.opus?.removeAllListeners(); recv.opus?.destroy(); } catch {}
  try { recv.decoder?.removeAllListeners(); recv.decoder?.destroy(); } catch {}
  try { recv.downsampler?.removeAllListeners(); recv.downsampler?.destroy(); } catch {}
  recv = { userId: null, opus: null, decoder: null, downsampler: null };
  console.log('[recv] pipeline cleaned:', reason);
}

function sendUserAudioChunk(buf) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') }));
  }
}
function sendUserAudioEnd() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    ws.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio'],
        ...(ELEVEN_VOICE_ID ? { voice_id: ELEVEN_VOICE_ID } : {}),
        output_audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 }
      }
    }));
  }
}

function listenToUser(userId) {
  if (!connection) return;

  if (recv.userId === userId && recv.opus) {
    console.log('[recv] already listening to', userId);
    return;
  }

  // Stop old pipeline first
  cleanupReceivePipeline('retarget');

  recv.userId = userId;
  console.log('listenToUser ->', userId);

  // Manual end control to avoid push-after-EOF
  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual }
  });

  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const downsampler = new prism.FFmpeg({
    command: ffmpegPath,
    args: ['-f','s16le','-ar','48000','-ac','2','-i','pipe:0','-f','s16le','-ar','16000','-ac','1','pipe:1']
  });

  opusStream.pipe(decoder).pipe(downsampler);

  recv.opus = opusStream;
  recv.decoder = decoder;
  recv.downsampler = downsampler;

  opusStream.on('error', (e) => console.error('[recv] opus stream error:', e?.message || e));
  decoder.on('error',    (e) => console.error('[recv] decoder error:', e?.message || e));
  downsampler.on('error',(e) => console.error('[recv] downsampler error:', e?.message || e));

  const manualStop = () => cleanupReceivePipeline('manualStop');
  opusStream.on('end', manualStop);
  opusStream.on('close', manualStop);

  let sendBuffer = Buffer.alloc(0);
  let talking = false;
  let lastVoice = 0;

  downsampler.on('data', (chunk) => {
    const level = rms(chunk);
    const now = Date.now();

    if (level >= VAD_THRESH) {
      talking = true;
      lastVoice = now;
      sendBuffer = Buffer.concat([sendBuffer, chunk]);
    } else if (talking && (now - lastVoice) < VAD_HANG) {
      sendBuffer = Buffer.concat([sendBuffer, chunk]);
    }

    while (talking && sendBuffer.length >= chunkBytes) {
      sendUserAudioChunk(sendBuffer.subarray(0, chunkBytes));
      sendBuffer = sendBuffer.subarray(chunkBytes);
    }

    if (talking && (now - lastVoice) >= VAD_HANG) {
      if (sendBuffer.length) sendUserAudioChunk(sendBuffer);
      sendBuffer = Buffer.alloc(0);
      talking = false;
      sendUserAudioEnd();
    }
  });
}

// -------- Force agent to speak (/dao-say) --------
function forceSay(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'input_text', text } }));
  ws.send(JSON.stringify({
    type: 'response.create',
    response: {
      modalities: ['audio'],
      ...(ELEVEN_VOICE_ID ? { voice_id: ELEVEN_VOICE_ID } : {}),
      output_audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 }
    }
  }));
  return true;
}

// -------- Join/Leave --------
async function joinVoice(guild, voiceChannel) {
  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, selfMute: false
  });

  // Create player & subscribe once
  if (!audioPlayer) {
    audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    audioPlayer.on('error', (e) => console.error('AudioPlayer error:', e));
    audioPlayer.on(AudioPlayerStatus.Playing, () => log.info('AudioPlayer: playing'));
    audioPlayer.on(AudioPlayerStatus.Idle,    () => log.info('AudioPlayer: idle'));
  }
  const sub = connection.subscribe(audioPlayer);
  log.info('Subscribed to audioPlayer', { sub: !!sub });
}

function leaveVoice() {
  cleanupReceivePipeline('leaving VC');
  if (connection) { try { connection.destroy(); } catch {} connection = null; }
  stopEleven();
}

// -------- Command handlers --------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'dao-join') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const voice = member.voice?.channel;
      if (!voice || voice.type !== ChannelType.GuildVoice) { await interaction.reply({ content: 'Join a voice channel first.', flags: 64 }); return; }
      const perms = voice.permissionsFor(interaction.guild.members.me);
      if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) { await interaction.reply({ content: 'I need Connect & Speak perms.', flags: 64 }); return; }

      await interaction.reply({ content: 'Joining…', flags: 64 });
      await joinVoice(interaction.guild, voice);

      if (!ELEVEN_AGENT_ID) { await interaction.editReply({ content: 'Missing ELEVEN_AGENT_ID.' }); return; }
      if (USE_SIGNED_URL === 'true' && !ELEVEN_API_KEY) { await interaction.editReply({ content: 'Missing ELEVEN_API_KEY.' }); return; }

      await connectElevenWS();

      if (ENABLE_VAD === 'true') {
        listenToUser(interaction.user.id);
        await interaction.editReply({ content: 'Joined VC and listening to you.' });
      } else {
        await interaction.editReply({ content: 'Joined VC (VAD disabled). Use /dao-say or /tone.' });
      }
    }

    if (interaction.commandName === 'dao-leave') {
      leaveVoice();
      await interaction.reply({ content: 'Left VC and closed session.', flags: 64 });
    }

    if (interaction.commandName === 'dao-say') {
      const text = interaction.options.getString('text', true);
      const ok = forceSay(text);
      await interaction.reply({ content: ok ? 'Asked the agent to speak.' : 'Agent not connected. Use /dao-join first.', flags: 64 });
    }

    if (interaction.commandName === 'tone') {
      if (!connection) { await interaction.reply({ content: 'Not in a VC. Use /dao-join first.', flags: 64 }); return; }
      playTone2s();
      await interaction.reply({ content: 'Playing 2s test tone.', flags: 64 });
    }
  } catch (e) {
    log.error(e);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: 'Error. Check logs.' });
      else await interaction.reply({ content: 'Error. Check logs.', flags: 64 });
    } catch {}
  }
});

// --- Start ---
(async () => {
  if (DISCORD_TOKEN && APP_ID && GUILD_ID) {
    try { await registerCommands(); await client.login(DISCORD_TOKEN); log.info('Discord bot logged in'); }
    catch (e) { console.error('Discord startup failed:', e?.message || e); }
  } else {
    console.warn('Missing DISCORD_TOKEN/APP_ID/GUILD_ID.');
  }
})();
