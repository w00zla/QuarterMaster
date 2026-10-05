// Discord bot process. Separate from the admin web UI; shares code and database with it.
import { Client, Events, GatewayIntentBits, type Guild } from 'discord.js';
import { connect } from '../db/client.ts';
import { commands } from './commands.ts';
import { handleInteraction } from './interactions.ts';
import { memberInfo } from './roster.ts';
import { BEAT_INTERVAL_MS, RosterKeeper, onFullSyncRequest } from './roster-keeper.ts';
import { findGuildSettings, markGuildLeft, markGuildPresent, reconcilePresence } from './settings.ts';
import { createRegistry } from './registry.ts';

const { DISCORD_TOKEN } = process.env;
const RESYNC_INTERVAL_MS = 6 * 3600_000;
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
  // Servers that removed the bot while it was offline (or added it again)
  reconcilePresence(db, [...c.guilds.cache.keys()]).catch((err: unknown) => console.error('Presence check failed', err));
});

// The roster: synced in full whenever member events may have been missed, kept current by the
// member events in between; per org the keeper records whether it can vouch for it (roster-keeper.ts)
const shardsUp = new Set<number>();
const log = (message: string, err?: unknown) => (err === undefined ? console.log(message) : console.error(message, err));
const keeper = new RosterKeeper(db, (guildId) => {
  const guild = client.guilds.cache.get(guildId);
  return !!guild?.available && shardsUp.has(guild.shardId);
}, log);
const fullSync = (guild: Guild) =>
  keeper.fullSync(guild.id, guild.name, async () => [...(await guild.members.fetch()).values()].map(memberInfo));
const guildsOf = (shardId: number) => [...client.guilds.cache.filter((g) => g.shardId === shardId).values()];
onFullSyncRequest((guild) => void fullSync(guild));

const shardUp = (shardId: number) => {
  shardsUp.add(shardId);
  for (const guild of guildsOf(shardId)) void fullSync(guild);
};
const shardDown = (shardId: number) => {
  shardsUp.delete(shardId);
  void keeper.invalidate(guildsOf(shardId).map((g) => g.id));
};
// A new session: member events since the last one are lost. A resume too: discord.js drops the
// member events Discord replays before RESUMED (the shard is not Ready yet)
client.on(Events.ShardReady, shardUp);
client.on(Events.ShardResume, shardUp);
client.on(Events.ShardReconnecting, shardDown);
client.on(Events.ShardDisconnect, (_event, shardId) => shardDown(shardId));
// Joined a server, or a server came back after an outage. At startup every server becomes available
// before ShardReady, which syncs them anyway: only an outage later counts
client.on(Events.GuildCreate, (guild) => {
  markGuildPresent(db, guild.id).catch((err: unknown) => log(`Presence update failed for ${guild.id}`, err));
  void fullSync(guild);
});
client.on(Events.GuildAvailable, (guild) => {
  if (shardsUp.has(guild.shardId)) void fullSync(guild);
});
// Outage, or the bot was removed: nobody keeps that roster current any more
client.on(Events.GuildUnavailable, (guild) => void keeper.invalidate([guild.id]));
client.on(Events.GuildDelete, (guild) => {
  void keeper.invalidate([guild.id]);
  markGuildLeft(db, guild.id).catch((err: unknown) => log(`Presence update failed for ${guild.id}`, err));
});
// Discord sends no member updates when a role is deleted
client.on(Events.GuildRoleDelete, (role) => {
  void findGuildSettings(db, role.guild.id).then((settings) => {
    if (settings && [...settings.memberRoleIds, ...settings.officerRoleIds].includes(role.id)) void fullSync(role.guild);
  }, (err: unknown) => log(`Role check failed for ${role.guild.id}`, err));
});

client.on(Events.GuildMemberAdd, (m) => void keeper.memberEvent(m.guild.id, m.id, memberInfo(m)));
client.on(Events.GuildMemberUpdate, (_old, m) => void keeper.memberEvent(m.guild.id, m.id, memberInfo(m)));
client.on(Events.GuildMemberRemove, (m) => void keeper.memberEvent(m.guild.id, m.id, null));

const beatTimer = setInterval(() => void keeper.beat(), BEAT_INTERVAL_MS);
// Backstop for anything the events above miss
const resyncTimer = setInterval(() => {
  for (const guild of client.guilds.cache.values()) if (guild.available) void fullSync(guild);
}, RESYNC_INTERVAL_MS);

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction, registry, { db }).catch((err: unknown) => console.error('Interaction handling failed', err));
});

const shutdown = async () => {
  clearInterval(beatTimer);
  clearInterval(resyncTimer);
  await keeper.stop();
  await client.destroy();
  await close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await client.login(DISCORD_TOKEN);
