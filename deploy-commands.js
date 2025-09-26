import 'dotenv/config';
import { REST, Routes } from '@discordjs/rest';

const {
  DISCORD_TOKEN,
  APP_ID,
  GUILD_ID
} = process.env;

if (!DISCORD_TOKEN || !APP_ID || !GUILD_ID) {
  throw new Error('DISCORD_TOKEN, APP_ID, and GUILD_ID are required to deploy commands.');
}

const commands = [
  {
    name: 'dao-join',
    description: 'Join your current voice channel and start realtime with ElevenLabs.',
  },
  {
    name: 'dao-leave',
    description: 'Leave the voice channel and end the session.',
  },
  {
    name: 'dao-context',
    description: 'Send a live context nudge to the agent.',
    options: [
      {
        name: 'text',
        description: 'Context text',
        type: 3, // STRING
        required: true
      }
    ]
  },
  {
    name: 'dao-target',
    description: 'Switch the microphone target to a user in your voice channel.',
    options: [
      {
        name: 'user',
        description: 'User to target',
        type: 6, // USER
        required: true
      }
    ]
  }
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

try {
  const data = await rest.put(
    Routes.applicationGuildCommands(APP_ID, GUILD_ID),
    { body: commands }
  );
  console.log(`Registered ${data.length} guild commands.`);
} catch (err) {
  console.error('Command registration failed:', err);
  process.exit(1);
}
