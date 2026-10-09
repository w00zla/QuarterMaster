// Server settings as /qm-setup edits them: roles live in app.org, bot-only settings in bot.guild.
import { and, eq, inArray, isNotNull, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { org } from '../db/schema/app.ts';
import { guild } from '../db/schema/bot.ts';
import type { Lang } from './i18n.ts';

export const LOGS_LEVELS = ['off', 'org'] as const;
export type LogsLevel = (typeof LOGS_LEVELS)[number];

export interface GuildSettings {
  memberRoleIds: string[];
  baseLang: Lang;
  logsChannelId: string | null;
  logsLevel: LogsLevel;
}

/** Creates the org and its bot settings on first use (keeps the cached server name current). */
export async function ensureGuild(db: Db, guildId: string, name: string): Promise<GuildSettings> {
  await db.transaction(async (tx) => {
    await tx.insert(org).values({ guildId, name }).onConflictDoUpdate({
      target: org.guildId,
      set: { name, updatedAt: sql`now()` },
      setWhere: sql`${org.name} IS DISTINCT FROM excluded.name`,
    });
    await tx.insert(guild).values({ guildId }).onConflictDoNothing();
  });
  return getGuildSettings(db, guildId);
}

/** The bot was removed from the server (its data is kept). */
export async function markGuildLeft(db: Db, guildId: string) {
  await db.transaction(async (tx) => {
    await tx.update(guild).set({ leftAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(guild.guildId, guildId), isNull(guild.leftAt)));
    await deactivateMembers(tx, sql`${guildId}`);
  });
}

// Nobody keeps a server's roster current once the bot is gone: its members go inactive (the org is
// gone for them; a full sync after the bot came back makes them active again)
const deactivateMembers = (tx: Pick<Db, 'execute'>, guildIds: SQL) => tx.execute(sql`
  UPDATE app.member SET active = false, inactive_since = coalesce(inactive_since, now()), updated_at = now()
  WHERE active AND guild_id IN (${guildIds})`);

/** The bot joined the server (again). */
export async function markGuildPresent(db: Db, guildId: string) {
  await db.update(guild).set({ leftAt: null, updatedAt: sql`now()` }).where(and(eq(guild.guildId, guildId), isNotNull(guild.leftAt)));
}

/** At startup: the servers the bot is on are present, every other one was left while it was offline. */
export async function reconcilePresence(db: Db, presentGuildIds: string[]) {
  await db.transaction(async (tx) => {
    if (presentGuildIds.length) {
      await tx.update(guild).set({ leftAt: null, updatedAt: sql`now()` })
        .where(and(inArray(guild.guildId, presentGuildIds), isNotNull(guild.leftAt)));
    }
    await tx.update(guild).set({ leftAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(presentGuildIds.length ? notInArray(guild.guildId, presentGuildIds) : sql`true`, isNull(guild.leftAt)));
    await deactivateMembers(tx, sql`SELECT guild_id FROM bot.guild WHERE left_at IS NOT NULL`);
  });
}

export async function getGuildSettings(db: Db, guildId: string): Promise<GuildSettings> {
  const settings = await findGuildSettings(db, guildId);
  if (!settings) throw new Error(`No settings for guild ${guildId}`);
  return settings;
}

/** null when the server has not run /qm-setup yet. */
export async function findGuildSettings(db: Db, guildId: string): Promise<GuildSettings | null> {
  const [row] = await db
    .select({
      memberRoleIds: org.memberRoleIds,
      baseLang: guild.baseLang,
      logsChannelId: guild.logsChannelId,
      logsLevel: guild.logsLevel,
    })
    .from(org)
    .innerJoin(guild, eq(guild.guildId, org.guildId))
    .where(eq(org.guildId, guildId));
  if (!row) return null;
  return { ...row, baseLang: row.baseLang as Lang, logsLevel: row.logsLevel as LogsLevel };
}

export async function updateGuildSettings(db: Db, guildId: string, patch: Partial<GuildSettings>): Promise<GuildSettings> {
  const { memberRoleIds, baseLang, logsChannelId, logsLevel } = patch;
  await db.transaction(async (tx) => {
    if (memberRoleIds !== undefined) {
      await tx.update(org).set({ memberRoleIds, updatedAt: sql`now()` }).where(eq(org.guildId, guildId));
    }
    if (baseLang !== undefined || logsChannelId !== undefined || logsLevel !== undefined) {
      await tx.update(guild).set({ baseLang, logsChannelId, logsLevel, updatedAt: sql`now()` }).where(eq(guild.guildId, guildId));
    }
  });
  return getGuildSettings(db, guildId);
}
