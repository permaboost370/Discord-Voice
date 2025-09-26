// server.js — Discord <-> ElevenLabs realtime bridge
// Supports playback via Ogg/Opus, VAD gating, idle-close, and slash cmds including /dao-say.

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

// --- crash logging (don’t kill process so /health stays up) ---
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
  ELEVEN_VOICE_ID,           // 👈 new: optional voice override
  USE_SIGNED_URL = 'true',
  PORT = 8080,
  LOG_LEVEL = 'info',
  CHUNK_MS = '20',
  VAD_THRESHOLD = '800',
  VAD_HANG_MS = '300',
  IDLE_CLOSE_MS = '45000'
} = process.env;

const log = pino({ level: LOG_LEVEL });

// --- Express (healthcheck) ---
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
    },
    {
      name: 'dao-say',
      description: 'Ask the agent to say something (debug TTS path)',
      options: [{ name: 'text', description: 'What to say', type: 3, required: true }]
    }
  ];
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
  log.info('Slash commands registered');
}

// ---------------- Playback chain ----------------
let connection = null;
let audioPlayer = null;
let shouldStayInVC = false;
const playbackPCM16k = new PassThrough({ highWaterMark: 1 << 24 });

function pcm16kToOggOpus() {
  const ff = new prism.FFmpeg({
    command: ffmpegPath,
    args: ['-f','s16le','-ar','16000','-ac','1','-i','pipe:0',
           '-ar','48000','-ac','2','-c:a','libopus','-b:a','64k','-f','ogg','pipe:1']
  });
  ff.on('spawn', () => { try { ff.process.stderr.on('data', d => console.error('[ffmpeg ogg]', d.toString())); } catch {} });
  ff.on('error', (e) => console.error('ffmpeg ogg error:', e));
  return ff;
}
let oggOpus = null;
function ensureTranscoder() {
  if (oggOpus) return oggOpus;
  try { oggOpus = pcm16kToOggOpus(); playbackPCM16k.pipe(oggOpus); return oggOpus; }
  catch (e) { console.error('Failed FFmpeg (ogg/opus):', e); oggOpus = null; return null; }
}
function ensureAudioPlayer() {
  if (audioPlayer) return audioPlayer;
  const ogg = ensureTranscoder(); if (!ogg) return null;
  audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play }});
  audioPlayer.on('error', (e) => console.error('AudioPlayer error:', e));
  const resource = createAudioResource(ogg, { inputType: StreamType.OggOpus });
  audioPlayer.play(resource);
  return audioPlayer;
}
function playBeep() {
  const sr=16000, secs=1, total=sr*secs, pcm=Buffer.alloc(total*2);
  for (let i=0;i<total;i++){ const s=Math.sin(2*Math.PI*440*(i/sr)); pcm.writeInt16LE((s*32767)|0,i*2);}
  playbackPCM16k.write(pcm);
}

// ---------------- ElevenLabs realtime WS ----------------
let ws=null, wantWs=false, idleTimer=null;
function resetIdleTimer(){ if(idleTimer) clearTimeout(idleTimer);
  idleTimer=setTimeout(()=>{ console.log(`Idle ${IDLE_CLOSE_MS}ms — closing Eleven WS`); stopEleven();}, Number(IDLE_CLOSE_MS));
}
function stopEleven(){ wantWs=false; if(ws){ try{ws.close();}catch{} ws=null; } }
async function getSignedUrl(){ const url=`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(ELEVEN_AGENT_ID)}`;
  const res=await fetch(url,{headers:{'xi-api-key':ELEVEN_API_KEY}}); if(!res.ok) throw new Error(`get-signed-url failed: ${res.status}`);
  return (await res.json()).signed_url; }
async function connectElevenWS(){
  if(ws||wantWs) return; wantWs=true;
  const url=(USE_SIGNED_URL==='true')? await getSignedUrl() : `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(ELEVEN_AGENT_ID)}`;
  ws=new WebSocket(url);
  ws.on('open',()=>{ log.info('Agent WS connected'); resetIdleTimer();
    ws.send(JSON.stringify({type:'conversation_initiation_client_data'}));
    ws.send(JSON.stringify({type:'session.update', session:{
      input_audio_format:{encoding:'pcm_s16le',sample_rate_hz:16000,channels:1},
      output_audio_format:{encoding:'pcm_s16le',sample_rate_hz:16000,channels:1},
      ...(ELEVEN_VOICE_ID?{voice_id:ELEVEN_VOICE_ID}:{})
    }}));
  });
  ws.on('message',(raw)=>{ try{ const msg=JSON.parse(raw.toString());
    if(msg.type==='ping'){ ws.send(JSON.stringify({type:'pong',event_id:msg.ping_event?.event_id})); return;}
    if(msg.type==='audio.delta'&&msg.delta){ resetIdleTimer(); const buf=Buffer.from(msg.delta,'base64'); console.log('↓ audio.delta',buf.length); playbackPCM16k.write(buf); return;}
    if(msg.type==='audio'&&msg.audio_event?.audio_base_64){ resetIdleTimer(); const buf=Buffer.from(msg.audio_event.audio_base_64,'base64'); console.log('↓ audio (legacy)',buf.length); playbackPCM16k.write(buf); return;}
    if(msg.type==='audio.end'){ console.log('↓ audio.end'); return;}
    console.log('WS EVENT', msg.type, JSON.stringify(msg).slice(0,400));
  }catch(e){console.error('WS parse error',e);} });
  ws.on('close',()=>{console.warn('Agent WS closed'); ws=null; if(idleTimer){clearTimeout(idleTimer);idleTimer=null;} if(wantWs&&connection){setTimeout(()=>connectElevenWS().catch(()=>{}),1500);} });
  ws.on('error',(err)=>console.error('Agent WS error',err));
}
function sendUserAudioChunk(buf){ if(ws&&ws.readyState===WebSocket.OPEN){ ws.send(JSON.stringify({type:'input_audio_buffer.append',audio:buf.toString('base64')}));}}
function sendUserAudioEnd(){ if(ws&&ws.readyState===WebSocket.OPEN){ ws.send(JSON.stringify({type:'input_audio_buffer.commit'})); ws.send(JSON.stringify({type:'response.create'})); }}

// ---------------- Force-say helper ----------------
function forceSay(text){
  if(!ws||ws.readyState!==WebSocket.OPEN) return false;
  ws.send(JSON.stringify({type:'conversation.item.create', item:{type:'input_text', text}}));
  ws.send(JSON.stringify({type:'response.create', response:{modalities:['audio'], ...(ELEVEN_VOICE_ID?{voice_id:ELEVEN_VOICE_ID}:{}), output_audio_format:{encoding:'pcm_s16le',sample_rate_hz:16000,channels:1}}}));
  setTimeout(()=>{ try{ ws.send(JSON.stringify({type:'response.create', modalities:['audio'], ...(ELEVEN_VOICE_ID?{voice_id:ELEVEN_VOICE_ID}:{})})); }catch{} },150);
  return true;
}

// ---------------- Slash commands ----------------
client.on(Events.InteractionCreate, async (interaction)=>{
  if(!interaction.isChatInputCommand()) return;
  try{
    if(interaction.commandName==='dao-join'){ const member=await interaction.guild.members.fetch(interaction.user.id);
      const voice=member.voice?.channel; if(!voice||voice.type!==ChannelType.GuildVoice){ await interaction.reply({content:'Join a voice channel first.',ephemeral:true}); return;}
      const perms=voice.permissionsFor(interaction.guild.members.me);
      if(!perms?.has(PermissionsBitField.Flags.Connect)||!perms?.has(PermissionsBitField.Flags.Speak)){ await interaction.reply({content:'I need Connect & Speak perms.',ephemeral:true}); return;}
      await interaction.deferReply({ephemeral:true}); await joinVoice(interaction.guild,voice);
      if(!ELEVEN_AGENT_ID){ await interaction.editReply('Missing ELEVEN_AGENT_ID.'); return;}
      if(USE_SIGNED_URL==='true'&&!ELEVEN_API_KEY){ await interaction.editReply('Missing ELEVEN_API_KEY.'); return;}
      await connectElevenWS(); listenToUser(interaction.user.id); await interaction.editReply('Joined VC and listening to you.'); }
    if(interaction.commandName==='dao-leave'){ leaveVoice(); await interaction.reply({content:'Left VC.',ephemeral:true}); }
    if(interaction.commandName==='dao-beep'){ if(!connection){ await interaction.reply({content:'Not in VC.',ephemeral:true}); return;} playBeep(); await interaction.reply({content:'Beep played.',ephemeral:true}); }
    if(interaction.commandName==='dao-say'){ const text=interaction.options.getString('text',true);
      const ok=forceSay(text); await interaction.reply({content: ok?'Asked agent to speak.':'Agent not connected.',ephemeral:true}); }
    // dao-context, dao-target, dao-brief unchanged for brevity...
  }catch(e){ log.error(e); if(interaction.deferred||interaction.replied){ await interaction.editReply('Error.'); } else { await interaction.reply({content:'Error.',ephemeral:true}); } }
});

// ---- Voice helpers (joinVoice, listenToUser etc.) ----
// (Keep the ones you already had; unchanged for brevity)

(async()=>{ if(DISCORD_TOKEN&&APP_ID&&GUILD_ID){ try{ await registerCommands(); await client.login(DISCORD_TOKEN); log.info('Discord bot logged in'); }catch(e){ console.error('Discord startup failed',e);} }
else { console.warn('Skipping Discord login: missing vars.'); }})();
