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

const {
  DISCORD_TOKEN,
  ELEVEN_API_KEY,
  ELEVEN_AGENT_ID,
  USE_SIGNED_URL = 'true',
  PORT = 8080,
  LOG_LEVEL = 'info',
  CHUNK_MS = '20'
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!ELEVEN_AGENT_ID) throw new Error('Missing ELEVEN_AGENT_ID');

const log = pino({ level: LOG_LEVEL });
const app = express();
app.get('/health', (_req, res) => res.status(200).send('ok'));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.GuildMember]
});

let connection = null;
let audioPlayer = null;
let targetUserId = null;

// Outbound PCM stream (agent -> Discord)
const playbackPCM = new PassThrough({ highWaterMark: 1 << 24 });
const BYTES_PER_MS = 16000 /*Hz*/ * 2 /*bytes*/ / 1000;
const chunkBytes = Math.max(10, Math.min(60, Number(CHUNK_MS))) * BYTES_PER_MS;

/** ElevenLabs WS session **/
let ws = null;
let nextExpectedEventId = 1;
const pendingAudio = new Map();

async function getSignedUrl() {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(ELEVEN_AGENT_ID)}`;
  const res = await fetch(url, { headers: { 'xi-api-key': ELEVEN_API_KEY } });
  if (!res.ok) throw new Error(`get-signed-url failed: ${res.status}`);
  const { signed_url } = await res.json();
  return signed_url;
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
          const chunk = pendingAudio.get(nextExpectedEventId);
          pendingAudio.delete(nextExpectedEventId);
          nextExpectedEventId += 1;
          playbackPCM.write(chunk);
        }
        return;
      }
    } catch {
      /* ignore */
    }
  });
  ws.on('close', () => {
    log.warn('Agent WS closed');
    ws = null;
    nextExpectedEventId = 1;
    pendingAudio.clear();
  });
  ws.on('error', (err) => log.error({ err }, 'Agent WS error'));
}

function sendUserAudioChunk(pcm16kMono) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ user_audio_chunk: pcm16kMono.toString('base64') }));
}

/** PCM16k mono -> Opus 48k stereo (Discord) */
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

/** Voice helpers **/
async function joinVoice(guild, voiceChannel) {
  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator
  });
  const player = ensureAudioPlayer();
  connection.subscribe(player);
}

function leaveVoice() {
  if (connection) {
    try { connection.destroy(); } catch {}
    connection = null;
  }
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
      const slice = sendBuffer.subarray(0, chunkBytes);
      sendBuffer = sendBuffer.subarray(chunkBytes);
      sendUserAudioChunk(slice);
    }
  });

  downsampler.on('end', () => {
    if (sendBuffer.length) sendUserAudioChunk(sendBuffer);
  });
}

/** Slash commands **/
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'dao-join') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const voice = member.voice?.channel;

      if (!voice || voice.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
        return;
      }

      // Permission hint
      const perms = voice.permissionsFor(interaction.guild.members.me);
      if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) {
        await interaction.reply({ content: 'I need Connect & Speak permissions in that channel.', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      await joinVoice(interaction.guild, voice);
      await connectElevenWS();
      listenToUser(interaction.user.id);

      await interaction.editReply('Joined your VC. Listening to you. Say something :)');
      return;
    }

    if (interaction.commandName === 'dao-leave') {
      leaveVoice();
      await interaction.reply({ content: 'Left the VC and closed the session.', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'dao-context') {
      const text = interaction.options.getString('text', true);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'contextual_update', text }));
        await interaction.reply({ content: 'Context updated.', ephemeral: true });
      } else {
        await interaction.reply({ content: 'Agent not connected. Use /dao-join first.', ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'dao-target') {
      const user = interaction.options.getUser('user', true);
      const member = await interaction.guild.members.fetch(user.id);

      // Must be in same voice channel as the bot
      if (!connection) {
        await interaction.reply({ content: 'I need to be in a voice channel. Use /dao-join first.', ephemeral: true });
        return;
      }
      const botChannelId = connection.joinConfig.channelId;
      const userVoice = member.voice?.channelId;
      if (userVoice !== botChannelId) {
        await interaction.reply({ content: 'That user is not in my voice channel.', ephemeral: true });
        return;
      }

      listenToUser(user.id);
      await interaction.reply({ content: `Now listening to <@${user.id}>.`, ephemeral: true });
      return;
    }
  } catch (err) {
    log.error(err);
    if (interaction.deferred || interaction.replied) {
      try { await interaction.editReply('Error. Check logs.'); } catch {}
    } else {
      try { await interaction.reply({ content: 'Error. Check logs.', ephemeral: true }); } catch {}
    }
  }
});

client.once(Events.ClientReady, () => log.info(`Logged in as ${client.user.tag}`));
client.login(DISCORD_TOKEN);

app.listen(Number(PORT), () => log.info(`HTTP up on :${PORT} (/health)`));
