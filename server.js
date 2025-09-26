import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import pino from 'pino';
import {
  Client, GatewayIntentBits, Partials, Events, ChannelType, PermissionsBitField
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  EndBehaviorType,
  AudioPlayerStatus
} from '@discordjs/voice';
import prism from 'prism-media';
import { PassThrough } from 'stream';
import { REST, Routes } from '@discordjs/rest';

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

if (!DISCORD_TOKEN || !APP_ID || !GUILD_ID) {
  throw new Error('Missing DISCORD_TOKEN, APP_ID, or GUILD_ID');
}
if (!ELEVEN_AGENT_ID) throw new Error('Missing ELEVEN_AGENT_ID');

const log = pino({ level: LOG_LEVEL });
const app = express();
app.get('/health', (_req, res) => res.status(200).send('ok'));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.GuildMember]
});

// ----- Slash Command Auto-Registration -----
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
    }
  ];
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
  log.info('Slash commands registered');
}

// ----- Discord Voice + ElevenLabs Bridge -----
let connection = null;
let audioPlayer = null;
let targetUserId = null;

const playbackPCM = new PassThrough({ highWaterMark: 1 << 24 });
const BYTES_PER_MS = 16000 * 2 / 1000;
const chunkBytes = Math.max(10, Math.min(60, Number(CHUNK_MS))) * BYTES_PER_MS;

// ElevenLabs WS
let ws = null;
let nextExpectedEventId = 1;
const pendingAudio = new Map();

async function getSignedUrl() {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(ELEVEN_AGENT_ID)}`;
  const res = await fetch(url, { headers: { 'xi-api-key': ELEVEN_API_KEY } });
  if (!res.ok) throw new Error(`get-signed-url failed: ${res.status}`);
  return (await res.json()).signed_url;
}

async function connectElevenWS() {
  if (ws) return;
  const url = (USE_SIGNED_URL === 'true')
    ? await getSignedUrl()
    : `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(ELEVEN_AGENT_ID)}`;
  ws = new WebSocket(url);

  ws.on('open', () => {
    log.info('Agent WS connected');
    ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' }));
  });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', event_id: data.ping_event.event_id }));
        return;
      }
      if (data.type === 'audio') {
        const { audio_event } = data;
        const buf = Buffer.from(audio_event.audio_base_64, 'base64');
        pendingAudio.set(audio_event.event_id, buf);
        while (pendingAudio.has(nextExpectedEventId)) {
          playbackPCM.write(pendingAudio.get(nextExpectedEventId));
          pendingAudio.delete(nextExpectedEventId);
          nextExpectedEventId++;
        }
      }
    } catch { /* ignore non-JSON */ }
  });

  ws.on('close', () => {
    log.warn('Agent WS closed');
    ws = null;
    nextExpectedEventId = 1;
    pendingAudio.clear();
  });
}

function sendUserAudioChunk(buf) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ user_audio_chunk: buf.toString('base64') }));
  }
}

function pcmToDiscordOpus() {
  return new prism.FFmpeg({
    args: [
      '-f', 's16le', '-ar', '16000', '-ac', '1',
      '-i', 'pipe:0',
      '-ac', '2', '-ar', '48000',
      '-f', 'opus', 'pipe:1'
    ]
  });
}
const opusEncoder = pcmToDiscordOpus();
playbackPCM.pipe(opusEncoder);

function ensureAudioPlayer() {
  if (audioPlayer) return audioPlayer;
  audioPlayer = createAudioPlayer();
  audioPlayer.on(AudioPlayerStatus.Idle, () => {});
  const resource = createAudioResource(opusEncoder, { inputType: StreamType.OggOpus });
  audioPlayer.play(resource);
  return audioPlayer;
}

async function joinVoice(guild, voiceChannel) {
  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator
  });
  connection.subscribe(ensureAudioPlayer());
}

function leaveVoice() {
  if (connection) { try { connection.destroy(); } catch {} connection = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

function listenToUser(userId) {
  if (!connection) return;
  targetUserId = userId;
  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 800 }
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const downsampler = new prism.FFmpeg({
    args: [
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      '-i', 'pipe:0',
      '-f', 's16le', '-ar', '16000', '-ac', '1',
      'pipe:1'
    ]
  });
  opusStream.pipe(decoder).pipe(downsampler);

  let sendBuffer = Buffer.alloc(0);
  downsampler.on('data', (chunk) => {
    sendBuffer = Buffer.concat([sendBuffer, chunk]);
    while (sendBuffer.length >= chunkBytes) {
      sendUserAudioChunk(sendBuffer.subarray(0, chunkBytes));
      sendBuffer = sendBuffer.subarray(chunkBytes);
    }
  });
  downsampler.on('end', () => { if (sendBuffer.length) sendUserAudioChunk(sendBuffer); });
}

// ----- Command Handling -----
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
      await interaction.deferReply({ ephemeral: true });
      await joinVoice(interaction.guild, voice);
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
      if (!connection) {
        await interaction.reply({ content: 'Bot not in VC. Use /dao-join first.', ephemeral: true });
        return;
      }
      if (member.voice?.channelId !== connection.joinConfig.channelId) {
        await interaction.reply({ content: 'That user is not in my voice channel.', ephemeral: true });
        return;
      }
      listenToUser(user.id);
      await interaction.reply({ content: `Now listening to <@${user.id}>.`, ephemeral: true });
    }
  } catch (err) {
    log.error(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('Error. Check logs.');
    } else {
      await interaction.reply({ content: 'Error. Check logs.', ephemeral: true });
    }
  }
});

// ----- Startup -----
client.once(Events.ClientReady, () => log.info(`Logged in as ${client.user.tag}`));
(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
app.listen(PORT, () => log.info(`HTTP up on :${PORT} (/health)`));
