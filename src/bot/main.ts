// Discord bot process. Separate from the admin web UI; shares code and database with it.
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { connect } from '../db/client.ts';
import { commands } from './commands.ts';
import { handleInteraction } from './interactions.ts';
import { createRegistry } from './registry.ts';

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN must be set (see .env.example)');
  process.exit(1);
}

const { db, close } = connect(process.env.DATABASE_URL);
const registry = createRegistry(commands);
// Slash commands need no privileged intents; Guilds gives the guild/channel/role caches
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} on ${c.guilds.cache.size} server(s), ${registry.size} command(s)`);
});
client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction, registry, { db }).catch((err: unknown) => console.error('Interaction handling failed', err));
});

const shutdown = async () => {
  await client.destroy();
  await close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await client.login(DISCORD_TOKEN);
