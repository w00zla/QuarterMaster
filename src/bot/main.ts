// Discord bot process. Separate from the admin web UI; shares code and database with it.
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { connect } from '../db/client.ts';
import { commands } from './commands.ts';
import { HEARTBEAT_INTERVAL_MS, writeHeartbeat } from './heartbeat.ts';
import { handleInteraction } from './interactions.ts';
import { memberInfo, syncDiscordGuild, syncMemberEvent } from './roster.ts';
import { createRegistry } from './registry.ts';

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN must be set (see .env.example)');
  process.exit(1);
}

const { db, close } = connect(process.env.DATABASE_URL);
const registry = createRegistry(commands);
// Guilds: guild/channel/role caches. GuildMembers (privileged, enable it in the developer portal):
// member events and member lists for the roster sync
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} on ${c.guilds.cache.size} server(s), ${registry.size} command(s)`);
});

// Catch up on everything that changed while the bot was offline. ShardReady fires on every new
// gateway session, not only at startup: member events missed in between are not replayed (a resume
// would replay them). Syncs run one after another.
let rosterSync = Promise.resolve();
let pendingSyncs = 0;
client.on(Events.ShardReady, (shardId) => {
  pendingSyncs++;
  rosterSync = rosterSync.then(async () => {
    for (const guild of client.guilds.cache.filter((g) => g.shardId === shardId).values()) {
      try {
        const counts = await syncDiscordGuild(db, guild);
        if (counts) console.log(`Roster ${guild.name}: ${JSON.stringify(counts)}`);
      } catch (err) {
        console.error(`Roster sync failed for ${guild.id}`, err);
      }
    }
    pendingSyncs--;
    beat();
  });
});

// Heartbeat for the user web app: only while the gateway is connected and no full roster sync is
// pending; otherwise member events may be missing and the web app should treat the roster as stale
function beat() {
  if (client.isReady() && pendingSyncs === 0) writeHeartbeat(db).catch((err: unknown) => console.error('Heartbeat failed', err));
}
const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

const onMember = (guildId: string, userId: string, info: Parameters<typeof syncMemberEvent>[3]) =>
  syncMemberEvent(db, guildId, userId, info).catch((err: unknown) => console.error(`Roster update failed for ${guildId}/${userId}`, err));
client.on(Events.GuildMemberAdd, (m) => onMember(m.guild.id, m.id, memberInfo(m)));
client.on(Events.GuildMemberUpdate, (_old, m) => onMember(m.guild.id, m.id, memberInfo(m)));
client.on(Events.GuildMemberRemove, (m) => onMember(m.guild.id, m.id, null));
client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction, registry, { db }).catch((err: unknown) => console.error('Interaction handling failed', err));
});

const shutdown = async () => {
  clearInterval(heartbeatTimer);
  await client.destroy();
  await close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await client.login(DISCORD_TOKEN);
