import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import pino from 'pino';
import {
  Client, GatewayIntentBits
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
  USE_SIGNED_URL = 'false',
  PORT = 8080,
  LOG_LEVEL = 'info',
  CHUNK_MS = '20'
} = process.env;

const log = pino({ level: LOG_LEVEL });

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!ELEVEN_AGENT_ID) throw new Error('Missing ELEVEN_AGENT_ID');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => res.status(200).send('ok'));

/** Discord setup **/
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

let connection = null;
let audioPlayer = null;

// Outbound (agent -> Discord) PCM stream
const playbackPCM = new PassThrough({ highWaterMark: 1 << 24 });

// PCM16k mono -> Opus 48k stereo for Discord
function pcmToDiscordOpusStream() {
  return new prism.FFmpeg({
    args: [
      '-f', 's16le', '-ar', '16000', '-ac', '1',
      '-i', 'pipe:0',
      '-ac', '2', '-ar', '48000',
      '-f', 'opus', 'pipe:1'
    ]
  });
}

const opusEncoder = pcmToDiscordOpusStream();
playbackPCM.pipe(opusEncoder);

function ensureAudioPlayer() {
  if (audioPlayer) return audioPlayer;
  audioPlayer = createAudioPlayer();
  audioPlayer.on(AudioPlayerStatus.Idle, () => {});
  const resource = createAudioResource(opusEncoder, { inputType: StreamType.OggOpus });
  audioPlayer.play(resource);
  return audioPlayer;
}

/** ElevenLabs WS **/
let ws = null;
let nextExpectedEventId = 1;
const pendingAudio = new Map(); // event_id -> Buffer

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

  log.info('Connecting to ElevenLabs WS');
  ws = new WebSocket(url);

  ws.on('open', () => {
    log.info('ElevenLabs WS connected');
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
        const { audio_event } = data; // { audio_base_64, event_id }
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

      // Optional transcript logs
      if (data.type === 'agent_response' || data.type === 'user_transcript') {
        log.debug({ data }, 'Transcript');
      }
    } catch {
      // Ignore if non-JSON (future-proof)
    }
  });

  ws.on('close', () => {
    log.warn('ElevenLabs WS closed');
    ws = null;
    nextExpectedEventId = 1;
    pendingAudio.clear();
  });

  ws.on('error', (err) => log.error({ err }, 'ElevenLabs WS error'));
}

function sendUserAudioChunk(pcmBuffer16kMono) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    user_audio_chunk: pcmBuffer16kMono.toString('base64')
  }));
}

/** Discord voice **/
async function joinVoice(guildId, channelId) {
  const guild = await client.guilds.fetch(guildId);
  await guild.channels.fetch(channelId);
  connection = joinVoiceChannel({
    channelId,
    guildId,
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
}

function startListeningToUser(userId) {
  if (!connection) return;

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

  const BYTES_PER_MS = 16000 /*hz*/ * 2 /*bytes*/ / 1000;
  const chunkBytes = Math.max(10, Math.min(60, Number(CHUNK_MS))) * BYTES_PER_MS;

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

/** REST endpoints for n8n **/

// POST /join { guildId, channelId, targetUserId }
app.post('/join', async (req, res) => {
  try {
    const { guildId, channelId, targetUserId } = req.body || {};
    if (!guildId || !channelId || !targetUserId) {
      return res.status(400).json({ error: 'guildId, channelId, targetUserId required' });
    }
    await joinVoice(guildId, channelId);
    await connectElevenWS();
    startListeningToUser(targetUserId);
    return res.json({ ok: true });
  } catch (e) {
    log.error(e);
    return res.status(500).json({ error: e.message });
  }
});

// POST /leave
app.post('/leave', (_req, res) => {
  leaveVoice();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  return res.json({ ok: true });
});

// POST /context { text }
app.post('/context', (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  if (ws && ws.readyState === WebSocket.OPEN) {
    // non-interrupting context nudge
    ws.send(JSON.stringify({ type: 'contextual_update', text }));
  }
  return res.json({ ok: true });
});

// POST /mute { enabled: boolean }
app.post('/mute', (req, res) => {
  const { enabled } = req.body || {};
  if (enabled) {
    if (audioPlayer) audioPlayer.pause(true);
  } else {
    if (audioPlayer) audioPlayer.unpause();
  }
  return res.json({ ok: true });
});

client.once('ready', () => log.info(`Discord logged in as ${client.user.tag}`));
client.login(DISCORD_TOKEN);

app.listen(Number(PORT), () => log.info(`Bridge listening on :${PORT}`));
