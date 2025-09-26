// server.js — stable playback via prism.opus.Encoder, VAD + idle-close, /dao-beep
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
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior
} from '@discordjs/voice';
import prism from 'prism-media';
import { PassThrough } from 'stream';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

// --- crash logging ---
process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exit(1); });
console.log('BOOT: starting server.js');

// --- env ---
const {
  DISCORD_TOKEN,
  APP_ID,
  GUILD_ID,
  ELEVEN_API_KEY,
  ELEVEN_AGENT_ID,
  USE_SIGNED_URL = 'true',
  PORT = 8080,
  LOG_LEVEL = 'info',
  CHUNK_MS = '20',
  // cost controls (defaults are credit-friendly already)
  VAD_THRESHOLD = '800',      // lower than before to ensure trigger
  VAD_HANG_MS = '300',
  IDLE_CLOSE_MS = '45000'
} = process.env;

const log = pino({ level: LOG_LEVEL });

// --- Express up FIRST so /health always works ---
const app = express();
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('alive'));
app.listen(Number(PORT), '0.0.0.0', () => log.info(`HTTP up on :${PORT} (/health)`));

// quick env diagnostics
log.info({
  has_DISCORD_TOKEN: !!DISCORD_TOKEN,
  has_APP_ID: !!APP_ID,
  has_GUILD_ID: !!GUILD_ID,
  has_ELEVEN_AGENT_ID: !!ELEVEN_AGENT_ID,
  use_signed_url: USE_SIGNED_URL
}, 'Env check');

// --- Discord client ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.GuildMember]
});

// ---- Slash Command Auto-Registration ----
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const commands = [
    { name: 'dao-join', description: 'Join your voice channel and start ElevenLabs realtime' },
    { name: 'dao-leave', description: 'Leave the voice channel and stop session' },
    {
      name: 'dao-context',
      description: 'Send a context nudge to the agent',
      options: [{ name: 'text', description: 'Context text', type: 3, required: true }]
    },
    {
      name: 'dao-target',
      description: 'Switch mic target to another user',
      options: [{ name: 'user', description: 'User to target', type: 6, required: true }]
    },
    { name: 'dao-beep', description: 'Play a 1s test beep to verify playback' },
    {
      name: 'dao-brief',
      description: 'Toggle brief replies to save credits',
      options: [{ name: 'mode', description: 'on/off', type: 3, required: true, choices: [
        { name: 'on', value: 'on' }, { name: 'off', value: 'off' }
      ]}]
    }
  ];
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
  log.info('Slash commands registered');
}

// ---------------- Playback chain (agent PCM16k → resample 48k → Opus) ----------------
let connection = null;
let audioPlayer = null;
let shouldStayInVC = false;

// agent writes 16k mono PCM here
const playbackPCM16k = new PassThrough({ highWaterMark: 1 << 24 });

// ffmpeg: 16k mono → 48k stereo PCM
function resample16kTo48k() {
  const ff = new prism.FFmpeg({
    command: ffmpegPath,
    args: [
      '-f', 's16le', '-ar', '16000', '-ac', '1', // input
      '-i', 'pipe:0',
      '-f', 's16le', '-ar', '48000', '-ac', '2', // output
      'pipe:1'
    ]
  });
  ff.on('spawn', () => {
    try { ff.process.stderr.on('data', d => console.error('[ffmpeg resample]', d.toString())); } catch {}
  });
  ff.on('error', (e) => console.error('ffmpeg resample error:', e));
  return ff;
}

const resampler = resample16kTo48k();

// prism’s Opus encoder (stable)
const opusEncoder = new prism.opus.Encoder({
  rate: 48000,
  channels: 2,
  frameSize: 960
});
opusEncoder.on('error', (e) => console.error('opusEncoder error:', e));

// wiring: agent 16k PCM -> resampler -> encoder -> audio resource
playbackPCM16k.pipe(resampler).pipe(opusEncoder);

function ensureAudioPlayer() {
  if (audioPlayer) return audioPlayer;
  audioPlayer = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play } // don't auto-stop, keeps resource hot
  });
  audioPlayer.on('error', (e) => console.error('AudioPlayer error:', e));
  audioPlayer.on(AudioPlayerStatus.Playing, () => log.info('AudioPlayer: playing'));
  audioPlayer.on(AudioPlayerStatus.Idle, () => log.info('AudioPlayer: idle'));

  // IMPORTANT: we’re feeding RAW Opus packets
  const resource = createAudioResource(opusEncoder, { inputType: StreamType.Opus });
  audioPlayer.play(resource);
  return audioPlayer;
}

// test tone: write 16k mono PCM into playbackPCM16k
function playBeep() {
  const sr = 16000, secs = 1;
  const total = sr * secs;
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const sample = Math.sin(2 * Math.PI * 440 * (i / sr));
    pcm.writeInt16LE((Math.max(-1, Math.min(1, sample)) * 32767) | 0, i * 2);
  }
  playbackPCM16k.write(pcm);
  log.info('Beep PCM written');
}

// ---------------- Join/Leave + Auto-rejoin guard ----------------
async function joinVoice(guild, voiceChannel) {
  shouldStayInVC = true;
  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });
  const player = ensureAudioPlayer();
  const sub = connection.subscribe(player);
  log.info('Subscribed to audioPlayer', { sub: !!sub });
  watchVoiceConnection(connection, guild, voiceChannel);
}

function leaveVoice() {
  shouldStayInVC = false;
  if (connection) { try { connection.destroy(); } catch {} connection = null; }
  stopEleven();
}

// ---------------- Mic capture → VAD → ElevenLabs ----------------
const BYTES_PER_MS = 16000 * 2 / 1000;
const chunkBytes = Math.max(10, Math.min(60, Number(CHUNK_MS))) * BYTES_PER_MS;
const VAD_THRESH = Number(VAD_THRESHOLD);
const VAD_HANG = Number(VAD_HANG_MS);

let currentTargetUserId = null;
let bytesSent = 0;
let vadTalking = false;
let vadLastVoiceAt = 0;
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log(`Idle ${IDLE_CLOSE_MS}ms — closing Eleven WS to save credits`);
    stopEleven();
  }, Number(IDLE_CLOSE_MS));
}

function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
  }
  const mean = sum / (buf.length / 2 || 1);
  return Math.sqrt(mean);
}

function listenToUser(userId) {
  if (!connection) return;
  currentTargetUserId = userId;
  console.log('listenToUser ->', userId);

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 800 }
  });

  opusStream.on('data', (c) => console.log('opus chunk', c.length));
  opusStream.on('error', (e) => console.error('opusStream error:', e));

  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  decoder.on('error', (e) => console.error('opus decoder error:', e));

  const downsampler = new prism.FFmpeg({
    command: ffmpegPath,
    args: [
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      '-i', 'pipe:0',
      '-f', 's16le', '-ar', '16000', '-ac', '1',
      'pipe:1'
    ]
  });
  downsampler.on('spawn', () => {
    try { downsampler.process.stderr.on('data', d => console.error('[ffmpeg downsample]', d.toString())); } catch {}
  });
  downsampler.on('error', (e) => console.error('downsampler ffmpeg error:', e));

  opusStream.pipe(decoder).pipe(downsampler);

  let sendBuffer = Buffer.alloc(0);
  downsampler.on('data', (chunk) => {
    resetIdleTimer();
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

  downsampler.on('end', () => {
    if (sendBuffer.length) sendUserAudioChunk(sendBuffer);
    if (vadTalking) sendUserAudioEnd();
    vadTalking = false;
  });
}

// ---------------- Voice connection watchdog (only if shouldStayInVC) ----------------
const vcRetry = new Map();
async function watchVoiceConnection(conn, guild, channel) {
  const key = guild.id;
  vcRetry.set(key, 0);

  conn.on('stateChange', async (oldState, newState) => {
    console.log(`VOICE state: ${oldState.status} -> ${newState.status}`);

    if (newState.status === VoiceConnectionStatus.Disconnected) {
      if (!shouldStayInVC) { console.log('Bot was removed/kicked, not rejoining.'); return; }
      const attempts = (vcRetry.get(key) || 0) + 1;
      vcRetry.set(key, attempts);
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000)
        ]);
        vcRetry.set(key, 0);
        return;
      } catch {}
      const backoff = Math.min(30_000, 1000 * Math.pow(2, attempts));
      console.warn(`Voice disconnected; rejoining in ${backoff}ms (attempt ${attempts})`);
      setTimeout(async () => {
        try {
          await joinVoice(guild, channel);
          if (connection) watchVoiceConnection(connection, guild, channel);
          if (currentTargetUserId) listenToUser(currentTargetUserId);
        } catch (e) { console.error('Rejoin failed:', e); }
      }, backoff);
    }

    if (newState.status === VoiceConnectionStatus.Destroyed) {
      console.warn('Voice connection destroyed');
      vcRetry.delete(key);
    }
  });

  const networkStateChangeHandler = (oldNetworkState, newNetworkState) => {
    const newUdp = Reflect.get(newNetworkState, 'udp');
    clearInterval(newUdp?.keepAliveInterval);
  };
  conn.on('stateChange', (oldState, newState) => {
    Reflect.get(oldState, 'networking')?.off('stateChange', networkStateChangeHandler);
    Reflect.get(newState, 'networking')?.on('stateChange', networkStateChangeHandler);
  });
}

// ---------------- ElevenLabs realtime WS ----------------
let ws = null;
let wantWs = false;

function stopEleven() {
  wantWs = false;
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

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
    ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' }));
    ws.send(JSON.stringify({
      type: 'session_update',
      input_audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 }
    }));
  });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', event_id: data.ping_event.event_id }));
        return;
      }
      if (data.type === 'audio') {
        resetIdleTimer();
        const buf = Buffer.from(data.audio_event.audio_base_64, 'base64'); // PCM 16k mono
        playbackPCM16k.write(buf);
        // console.log('audio evt', data.audio_event.event_id);
      }
    } catch { /* ignore */ }
  });

  ws.on('close', () => {
    console.warn('Agent WS closed');
    ws = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (wantWs && connection) {
      setTimeout(() => connectElevenWS().catch(() => {}), 1500);
    }
  });

  ws.on('error', (err) => console.error('Agent WS error', err));
}

function sendUserAudioChunk(buf) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ user_audio_chunk: buf.toString('base64') }));
  }
}
function sendUserAudioEnd() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ user_audio_end: true }));
  }
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
      if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) { await interaction.reply({ content: 'I need Connect & Speak permissions in that channel.', ephemeral: true }); return; }
      await interaction.deferReply({ ephemeral: true });
      await joinVoice(interaction.guild, voice);
      try {
        const me = await interaction.guild.members.fetchMe();
        if (me?.voice) { await me.voice.setDeaf(false).catch(() => {}); await me.voice.setMute(false).catch(() => {}); }
      } catch {}
      if (!ELEVEN_AGENT_ID) { await interaction.editReply('Missing ELEVEN_AGENT_ID. Set it in Railway Variables.'); return; }
      if (USE_SIGNED_URL === 'true' && !ELEVEN_API_KEY) { await interaction.editReply('Missing ELEVEN_API_KEY (signed URL mode).'); return; }

      await connectElevenWS();
      listenToUser(interaction.user.id);
      await interaction.editReply('Joined VC and listening to you.');
    }

    if (interaction.commandName === 'dao-leave') {
      leaveVoice();
      await interaction.reply({ content: 'Left VC and closed session.', ephemeral: true });
    }

    if (interaction.commandName === 'dao-context') {
      const text = interaction.options.getString('text', true);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'contextual_update', text }));
        await interaction.reply({ content: 'Context updated.', ephemeral: true });
      } else {
        await interaction.reply({ content: 'Agent not connected. Use /dao-join first.', ephemeral: true });
      }
    }

    if (interaction.commandName === 'dao-target') {
      const user = interaction.options.getUser('user', true);
      const member = await interaction.guild.members.fetch(user.id);
      if (!connection) { await interaction.reply({ content: 'Bot not in VC. Use /dao-join first.', ephemeral: true }); return; }
      if (member.voice?.channelId !== connection.joinConfig.channelId) {
        await interaction.reply({ content: 'That user is not in my voice channel.', ephemeral: true });
        return;
      }
      listenToUser(user.id);
      await interaction.reply({ content: `Now listening to <@${user.id}>.`, ephemeral: true });
    }

    if (interaction.commandName === 'dao-beep') {
      if (!connection) { await interaction.reply({ content: 'I need to be in a VC. Use /dao-join first.', ephemeral: true }); return; }
      playBeep();
      await interaction.reply({ content: 'Beep played.', ephemeral: true });
    }

    if (interaction.commandName === 'dao-brief') {
      const mode = interaction.options.getString('mode', true);
      if (!ws || ws.readyState !== WebSocket.OPEN) { await interaction.reply({ content: 'Agent not connected. Use /dao-join first.', ephemeral: true }); return; }
      const on = mode === 'on';
      ws.send(JSON.stringify({ type: 'contextual_update', text: on ? 'Keep replies brief: 1–2 sentences max.' : 'You can reply normally again.' }));
      await interaction.reply({ content: `Brief mode ${on ? 'enabled' : 'disabled'}.`, ephemeral: true });
    }

  } catch (err) {
    log.error(err);
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
    console.warn('⏭️ Skipping Discord login (missing DISCORD_TOKEN or APP_ID or GUILD_ID). /health still OK.');
  }
})();
