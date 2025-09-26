// server.js (ffmpeg-static wired, safe boot, realtime, debug, /dao-beep)
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
  entersState
} from '@discordjs/voice';
import prism from 'prism-media';
import { PassThrough } from 'stream';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

// crash logging
process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exit(1); });
console.log('BOOT: starting server.js');

const {
  DISCORD_TOKEN,
  APP_ID,
  GUILD_ID,
  ELEVEN_API_KEY,
  ELEVEN_AGENT_ID,
  USE_SIGNED_URL = 'true',
  PORT = 8080,
  LOG_LEVEL = 'info',
  CHUNK_MS = '20'
} = process.env;

const log = pino({ level: LOG_LEVEL });

// --- Express up FIRST so /health always works ---
const app = express();
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('alive'));
app.listen(Number(PORT), '0.0.0.0', () => log.info(`HTTP up on :${PORT} (/health)`));

// Env diagnostics
log.info({
  has_DISCORD_TOKEN: Boolean(DISCORD_TOKEN),
  has_APP_ID: Boolean(APP_ID),
  has_GUILD_ID: Boolean(GUILD_ID),
  has_ELEVEN_AGENT_ID: Boolean(ELEVEN_AGENT_ID),
  use_signed_url: USE_SIGNED_URL
}, 'Env check');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.GuildMember]
});

// ---- Slash Command Auto-Registration (/dao-beep included) ----
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
    { name: 'dao-beep', description: 'Play a 1s test beep to verify playback' }
  ];
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
  log.info('Slash commands registered');
}

// ---- Discord Voice + ElevenLabs bridge ----
let connection = null;
let audioPlayer = null;
let shouldStayInVC = false;

const playbackPCM = new PassThrough({ highWaterMark: 1 << 24 });
const BYTES_PER_MS = 16000 * 2 / 1000;
const chunkBytes = Math.max(10, Math.min(60, Number(CHUNK_MS))) * BYTES_PER_MS;

// encoder: PCM16k mono -> Opus 48k stereo for Discord
function pcmToDiscordOpus() {
  const ff = new prism.FFmpeg({
    command: ffmpegPath,
    args: [
      '-f', 's16le', '-ar', '16000', '-ac', '1',
      '-i', 'pipe:0',
      '-ac', '2', '-ar', '48000',
      // raw Opus RTP-ish packets are fine for discord.js voice resource
      '-f', 'opus', 'pipe:1'
    ]
  });
  ff.on('error', (e) => console.error('opusEncoder ffmpeg error:', e));
  return ff;
}
const opusEncoder = pcmToDiscordOpus();
playbackPCM.pipe(opusEncoder);

function ensureAudioPlayer() {
  if (audioPlayer) return audioPlayer;
  audioPlayer = createAudioPlayer();
  audioPlayer.on(AudioPlayerStatus.Idle, () => {});
  // IMPORTANT: we’re feeding RAW Opus packets, not Ogg
  const resource = createAudioResource(opusEncoder, { inputType: StreamType.Opus });
  audioPlayer.play(resource);
  return audioPlayer;
}

// test tone to verify playback path
function playBeep() {
  const sr = 16000, secs = 1;
  const total = sr * secs;
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const sample = Math.sin(2 * Math.PI * 440 * (i / sr));
    pcm.writeInt16LE((Math.max(-1, Math.min(1, sample)) * 32767) | 0, i * 2);
  }
  playbackPCM.write(pcm);
}

async function joinVoice(guild, voiceChannel) {
  shouldStayInVC = true;
  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });
  connection.subscribe(ensureAudioPlayer());
  watchVoiceConnection(connection, guild, voiceChannel);
}

function leaveVoice() {
  shouldStayInVC = false;
  if (connection) { try { connection.destroy(); } catch {} connection = null; }
  wantWs = false;
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

// capture + chunking
let currentTargetUserId = null;
let bytesSent = 0;

function listenToUser(userId) {
  if (!connection) return;
  currentTargetUserId = userId;
  console.log('listenToUser ->', userId);

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 800 }
  });

  // DEBUG: confirm incoming mic Opus packets
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
  downsampler.on('error', (e) => console.error('downsampler ffmpeg error:', e));

  opusStream.pipe(decoder).pipe(downsampler);

  let sendBuffer = Buffer.alloc(0);
  downsampler.on('data', (chunk) => {
    sendBuffer = Buffer.concat([sendBuffer, chunk]);
    while (sendBuffer.length >= chunkBytes) {
      const slice = sendBuffer.subarray(0, chunkBytes);
      sendUserAudioChunk(slice);
      sendBuffer = sendBuffer.subarray(chunkBytes);
    }
  });

  downsampler.on('end', () => {
    if (sendBuffer.length) sendUserAudioChunk(sendBuffer);
    sendUserAudioEnd(); // signal utterance end so agent replies
  });
}

// ---- Voice connection watchdog (auto-rejoin unless kicked) ----
const vcRetry = new Map();
async function watchVoiceConnection(conn, guild, channel) {
  const key = guild.id;
  vcRetry.set(key, 0);

  conn.on('stateChange', async (oldState, newState) => {
    console.log(`VOICE state: ${oldState.status} -> ${newState.status}`);

    if (newState.status === VoiceConnectionStatus.Disconnected) {
      if (!shouldStayInVC) {
        console.log('Bot was removed/kicked, not rejoining.');
        return;
      }
      const attempts = (vcRetry.get(key) || 0) + 1;
      vcRetry.set(key, attempts);
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000)
        ]);
        vcRetry.set(key, 0);
        return;
      } catch {/* fall through */}
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

// ---- ElevenLabs realtime WebSocket ----
let ws = null;
let wantWs = false;
let nextExpectedEventId = 1;
const pendingAudio = new Map();

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
    ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' }));
    ws.send(JSON.stringify({
      type: 'session_update',
      input_audio_format: {
        encoding: 'pcm_s16le',
        sample_rate_hz: 16000,
        channels: 1
      }
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
        console.log('audio evt', data.audio_event.event_id, 'len', data.audio_event.audio_base_64.length);
        const buf = Buffer.from(data.audio_event.audio_base_64, 'base64');
        pendingAudio.set(data.audio_event.event_id, buf);
        while (pendingAudio.has(nextExpectedEventId)) {
          playbackPCM.write(pendingAudio.get(nextExpectedEventId));
          pendingAudio.delete(nextExpectedEventId);
          nextExpectedEventId++;
        }
      }
    } catch {/* ignore non-JSON */}
  });

  ws.on('close', () => {
    console.warn('Agent WS closed');
    ws = null;
    nextExpectedEventId = 1;
    pendingAudio.clear();
    if (wantWs && connection) {
      setTimeout(() => connectElevenWS().catch(() => {}), 1500);
    }
  });

  ws.on('error', (err) => console.error('Agent WS error', err));
}

function sendUserAudioChunk(buf) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ user_audio_chunk: buf.toString('base64') }));
    bytesSent += buf.length;
  }
}
function sendUserAudioEnd() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log(`user_audio_end (sentBytes=${bytesSent})`);
    ws.send(JSON.stringify({ user_audio_end: true }));
    bytesSent = 0;
  }
}

// ---- Slash command handling ----
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'dao-join') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const voice = member.voice?.channel;
      if (!voice || voice.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
        return;
      }
      const perms = voice.permissionsFor(interaction.guild.members.me);
      if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) {
        await interaction.reply({ content: 'I need Connect & Speak permissions in that channel.', ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      await joinVoice(interaction.guild, voice);

      // undeafen / unmute after joining
      try {
        const me = await interaction.guild.members.fetchMe();
        if (me?.voice) {
          await me.voice.setDeaf(false).catch(() => {});
          await me.voice.setMute(false).catch(() => {});
        }
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
  } catch (err) {
    log.error(err);
    if (interaction.deferred || interaction.replied) { await interaction.editReply('Error. Check logs.'); }
    else { await interaction.reply({ content: 'Error. Check logs.', ephemeral: true }); }
  }
});

// ---- Start bot only if the three core Discord vars exist ----
(async () => {
  if (DISCORD_TOKEN && APP_ID && GUILD_ID) {
    try {
      await registerCommands();
      await client.login(DISCORD_TOKEN);
      log.info('Discord bot logged in');
    } catch (e) {
      console.error('Discord startup failed:', e?.message || e);
    }
  } else {
    console.warn('⏭️ Skipping Discord login (missing DISCORD_TOKEN or APP_ID or GUILD_ID). /health still OK.');
  }
})();
