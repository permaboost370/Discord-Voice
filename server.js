// server.js — Discord <-> ElevenLabs realtime bridge
// Stable playback: pipeline created once on join. VAD mic capture + /dao-say. Handles audio.delta & legacy audio.

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
import { PassThrough } from 'stream';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

// --- crash logging (keep alive for /health) ---
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
  ELEVEN_VOICE_ID,            // optional voice override
  USE_SIGNED_URL = 'true',
  ENABLE_VAD = 'true',
  PORT = 8080,
  LOG_LEVEL = 'info',
  CHUNK_MS = '20',
  VAD_THRESHOLD = '800',
  VAD_HANG_MS = '300',
  IDLE_CLOSE_MS = '120000'    // generous while testing
} = process.env;

const log = pino({ level: LOG_LEVEL });

// --- Express healthcheck ---
const app = express();
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('alive'));
app.listen(Number(PORT), '0.0.0.0', () => log.info(`HTTP up on :${PORT} (/health)`));

// --- Discord client ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.GuildMember]
});

// ---- Slash Command Auto-Registration ----
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const commands = [
    { name: 'dao-join', description: 'Join your VC and start ElevenLabs realtime' },
    { name: 'dao-leave', description: 'Leave the VC and stop session' },
    { name: 'dao-beep', description: 'Play a 1s test beep' },
    {
      name: 'dao-say',
      description: 'Ask the agent to say something',
      options: [{ name: 'text', description: 'What to say', type: 3, required: true }]
    }
  ];
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
  log.info('Slash commands registered');
}

// ---------------- Playback chain (created once on join) ----------------
let connection = null;
let audioPlayer = null;
let oggOpus = null;

// Long-lived PCM16k source we write agent audio into
const playbackPCM16k = new PassThrough({ highWaterMark: 1 << 24 });

function createTranscoder() {
  const ff = new prism.FFmpeg({
    command: ffmpegPath,
    args: [
      '-f', 's16le', '-ar', '16000', '-ac', '1',
      '-i', 'pipe:0',
      '-ar', '48000', '-ac', '2',
      '-c:a', 'libopus', '-b:a', '64k',
      '-f', 'ogg', 'pipe:1'
    ]
  });
  ff.on('error', (e) => console.error('ffmpeg ogg error:', e));
  return ff;
}

function ensurePlaybackPipelineOnce() {
  if (audioPlayer && oggOpus) return;

  if (!oggOpus) {
    oggOpus = createTranscoder();
    playbackPCM16k.pipe(oggOpus);
  }

  if (!audioPlayer) {
    audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    audioPlayer.on('error', (e) => console.error('AudioPlayer error:', e));
    audioPlayer.on(AudioPlayerStatus.Playing, () => log.info('AudioPlayer: playing'));
    audioPlayer.on(AudioPlayerStatus.Idle,    () => log.info('AudioPlayer: idle'));
  }

  const resource = createAudioResource(oggOpus, { inputType: StreamType.OggOpus });
  audioPlayer.play(resource);
  log.info('Playback pipeline ready (PCM16k -> OggOpus -> player)');
}

function playBeep() {
  const sr = 16000, secs = 1, total = sr * secs;
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const s = Math.sin(2 * Math.PI * 440 * (i / sr));
    pcm.writeInt16LE((Math.max(-1, Math.min(1, s)) * 32767) | 0, i * 2);
  }
  const ok = playbackPCM16k.write(pcm);
  log.info({ ok, bytes: pcm.length }, 'Beep PCM written');
}

// ---------------- ElevenLabs realtime WS ----------------
let ws = null;
let wantWs = false;
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log(`Idle ${IDLE_CLOSE_MS}ms — closing WS`);
    stopEleven();
  }, Number(IDLE_CLOSE_MS));
}
function stopEleven() { wantWs = false; if (ws) { try { ws.close(); } catch {} ws = null; } }

async function getSignedUrl() {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(ELEVEN_AGENT_ID)}`;
  const res = await fetch(url, { headers: { 'xi-api-key': ELEVEN_API_KEY } });
  if (!res.ok) throw new Error(`get-signed-url failed: ${res.status}`);
  return (await res.json()).signed_url;
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

    // DO NOT rebuild playback pipeline here; it's already created on join
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

      // Legacy single-chunk audio
      if (msg.type === 'audio' && msg.audio_event?.audio_base_64) {
        resetIdleTimer();
        const buf = Buffer.from(msg.audio_event.audio_base_64, 'base64'); // 16k mono PCM
        const ok = playbackPCM16k.write(buf);
        console.log('↓ audio (legacy)', buf.length, 'bytes', 'writeOK=', ok);
        return;
      }

      // Streaming audio
      if (msg.type === 'audio.delta' && msg.delta) {
        resetIdleTimer();
        const buf = Buffer.from(msg.delta, 'base64'); // 16k mono PCM
        const ok = playbackPCM16k.write(buf);
        console.log('↓ audio.delta', buf.length, 'bytes', 'writeOK=', ok);
        return;
      }

      if (msg.type === 'audio.end') { console.log('↓ audio.end'); return; }

      // See other events/errors
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

// Mic → Eleven (VAD)
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

// Force agent to speak (/dao-say)
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

// ---------------- Mic capture (VAD) ----------------
const BYTES_PER_MS = 16000 * 2 / 1000;
const chunkBytes = Math.max(10, Math.min(60, Number(CHUNK_MS))) * BYTES_PER_MS;
const VAD_THRESH = Number(VAD_THRESHOLD);
const VAD_HANG = Number(VAD_HANG_MS);

function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) { const s = buf.readInt16LE(i); sum += s * s; }
  return Math.sqrt(sum / (buf.length / 2 || 1));
}

function listenToUser(userId) {
  if (!connection) return;
  console.log('listenToUser ->', userId);

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 800 }
  });

  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const downsampler = new prism.FFmpeg({
    command: ffmpegPath,
    args: ['-f','s16le','-ar','48000','-ac','2','-i','pipe:0','-f','s16le','-ar','16000','-ac','1','pipe:1']
  });

  opusStream.pipe(decoder).pipe(downsampler);

  let sendBuffer = Buffer.alloc(0);
  let vadTalking = false;
  let vadLastVoiceAt = 0;

  downsampler.on('data', (chunk) => {
    const level = rms(chunk);
    const now = Date.now();

    if (level >= VAD_THRESH) {
      vadTalking = true;
      vadLastVoiceAt = now;
      sendBuffer = Buffer.concat([sendBuffer, chunk]);
    } else if (vadTalking && (now - vadLastVoiceAt) < VAD_HANG) {
      sendBuffer = Buffer.concat([sendBuffer, chunk]);
    }

    while (vadTalking && sendBuffer.length >= chunkBytes) {
      const slice = sendBuffer.subarray(0, chunkBytes);
      sendUserAudioChunk(slice);
      sendBuffer = sendBuffer.subarray(chunkBytes);
    }

    if (vadTalking && (now - vadLastVoiceAt) >= VAD_HANG) {
      if (sendBuffer.length) sendUserAudioChunk(sendBuffer);
      sendBuffer = Buffer.alloc(0);
      vadTalking = false;
      sendUserAudioEnd();
    }
  });
}

// ---------------- Join/Leave ----------------
async function joinVoice(guild, voiceChannel) {
  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  ensurePlaybackPipelineOnce(); // build once here

  const sub = connection.subscribe(audioPlayer);
  log.info('Subscribed to audioPlayer', { sub: !!sub });
}

function leaveVoice() {
  if (connection) { try { connection.destroy(); } catch {} connection = null; }
  stopEleven();
}

// ---------------- Slash commands ----------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'dao-join') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const voice = member.voice?.channel;
      if (!voice || voice.type !== ChannelType.GuildVoice) { await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true }); return; }
      const perms = voice.permissionsFor(interaction.guild.members.me);
      if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) { await interaction.reply({ content: 'I need Connect & Speak perms.', ephemeral: true }); return; }

      await interaction.deferReply({ ephemeral: true });
      await joinVoice(interaction.guild, voice);

      if (!ELEVEN_AGENT_ID) { await interaction.editReply('Missing ELEVEN_AGENT_ID.'); return; }
      if (USE_SIGNED_URL === 'true' && !ELEVEN_API_KEY) { await interaction.editReply('Missing ELEVEN_API_KEY.'); return; }

      await connectElevenWS();

      if (ENABLE_VAD === 'true') {
        listenToUser(interaction.user.id);
        await interaction.editReply('Joined VC and listening to you.');
      } else {
        await interaction.editReply('Joined VC (VAD disabled). Use /dao-say to test speech.');
      }
    }

    if (interaction.commandName === 'dao-leave') {
      leaveVoice();
      await interaction.reply({ content: 'Left VC and closed session.', ephemeral: true });
    }

    if (interaction.commandName === 'dao-beep') {
      if (!connection) { await interaction.reply({ content: 'Not in a VC. Use /dao-join first.', ephemeral: true }); return; }
      playBeep();
      await interaction.reply({ content: 'Beep played.', ephemeral: true });
    }

    if (interaction.commandName === 'dao-say') {
      const text = interaction.options.getString('text', true);
      const ok = forceSay(text);
      await interaction.reply({ content: ok ? 'Asked the agent to speak.' : 'Agent not connected. Use /dao-join first.', ephemeral: true });
    }
  } catch (e) {
    log.error(e);
    if (interaction.deferred || interaction.replied) { await interaction.editReply('Error. Check logs.'); }
    else { await interaction.reply({ content: 'Error. Check logs.', ephemeral: true }); }
  }
});

// ---- Start bot ----
(async () => {
  if (DISCORD_TOKEN && APP_ID && GUILD_ID) {
    try { await registerCommands(); await client.login(DISCORD_TOKEN); log.info('Discord bot logged in'); }
    catch (e) { console.error('Discord startup failed:', e?.message || e); }
  } else {
    console.warn('Missing DISCORD_TOKEN/APP_ID/GUILD_ID. /health still OK.');
  }
})();
