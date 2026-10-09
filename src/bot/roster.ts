// Roster: app.member mirrors who holds one of the org's member roles.
// Rows exist only for current role holders. Someone who loses the role (or leaves the server)
// keeps an inactive row only while they share stock in this org or its history names them (it shows
// their name from this row); otherwise
// the row is deleted. Their app_user row goes too, but only once it holds no data at all:
// users can work without any org (personal stock, blueprints, profile).
import { and, eq, sql } from 'drizzle-orm';
import { GuildMemberRoleManager, type APIInteractionGuildMember, type GuildMember } from 'discord.js';
import type { Db } from '../db/client.ts';
import { appUser, member } from '../db/schema/app.ts';
import { findGuildSettings, type GuildSettings } from './settings.ts';

/** What the roster needs to know about a Discord server member. */
export interface MemberInfo {
  userId: string;
  // Server nickname, else global name, else username
  displayName: string;
  roleIds: string[];
  bot: boolean;
}

export function memberInfo(m: GuildMember | APIInteractionGuildMember): MemberInfo {
  if (m.roles instanceof GuildMemberRoleManager) {
    const gm = m as GuildMember;
    return { userId: gm.id, displayName: gm.displayName, roleIds: [...gm.roles.cache.keys()], bot: gm.user.bot };
  }
  const api = m as APIInteractionGuildMember;
  return {
    userId: api.user.id,
    displayName: api.nick ?? api.user.global_name ?? api.user.username,
    roleIds: api.roles,
    bot: api.user.bot ?? false,
  };
}

export interface Access {
  // Holds a member role
  member: boolean;
}

export function accessOf(roleIds: string[], settings: Pick<GuildSettings, 'memberRoleIds'>): Access {
  return { member: settings.memberRoleIds.some((id) => roleIds.includes(id)) };
}

export type SyncResult = 'active' | 'inactive' | 'deleted' | 'none';

const FOREIGN_KEY_VIOLATION = '23503';

/** Brings one person's roster row in line with their current roles (null = no longer on the server). */
export async function syncMember(
  db: Db, guildId: string, settings: GuildSettings, userId: string, info: MemberInfo | null,
): Promise<SyncResult> {
  const access = info && !info.bot ? accessOf(info.roleIds, settings) : null;
  if (info && access?.member) {
    await db.transaction(async (tx) => {
      await tx.insert(appUser).values({ userId }).onConflictDoNothing();
      await tx.insert(member).values({ guildId, userId, displayName: info.displayName }).onConflictDoUpdate({
        target: [member.guildId, member.userId],
        set: { active: true, inactiveSince: null, displayName: info.displayName, updatedAt: sql`now()` },
        setWhere: sql`NOT ${member.active} OR ${member.displayName} IS DISTINCT FROM excluded.display_name`,
      });
    });
    return 'active';
  }
  return db.transaction(async (tx) => {
    const deleted = await tx.execute(sql`
      DELETE FROM app.member m WHERE m.guild_id = ${guildId} AND m.user_id = ${userId}
        AND NOT EXISTS (SELECT 1 FROM app.stock_share s JOIN app.stock_batch b ON b.id = s.batch_id
                          WHERE s.guild_id = m.guild_id AND b.owner_user_id = m.user_id)
        AND NOT EXISTS (SELECT 1 FROM app.history h WHERE h.guild_id = m.guild_id
                          AND m.user_id IN (h.actor_user_id, h.owner_user_id, h.to_owner_user_id))
      RETURNING 1`);
    if (deleted.length) {
      // In a savepoint: a concurrent first write by this user (e.g. from the web app) makes the
      // delete fail on a foreign key; the user row then simply stays, the member change commits
      await tx.transaction(async (sp) => {
        await sp.execute(sql`
          DELETE FROM app.app_user u WHERE u.user_id = ${userId} AND u.rsi_handle IS NULL
            AND NOT EXISTS (SELECT 1 FROM app.member m WHERE m.user_id = u.user_id)
            AND NOT EXISTS (SELECT 1 FROM app.user_blueprint b WHERE b.user_id = u.user_id)
            AND NOT EXISTS (SELECT 1 FROM app.stock_batch b WHERE b.owner_user_id = u.user_id)
            AND NOT EXISTS (SELECT 1 FROM app.stock_journal j WHERE j.owner_user_id = u.user_id OR j.actor_user_id = u.user_id)
            AND NOT EXISTS (SELECT 1 FROM bot.user_config c WHERE c.user_id = u.user_id)`);
      }).catch((err: unknown) => {
        if ((err as { cause?: { code?: string } }).cause?.code !== FOREIGN_KEY_VIOLATION) throw err;
      });
      return 'deleted';
    }
    const updated = await tx.update(member)
      .set({
        active: false,
        inactiveSince: sql`coalesce(${member.inactiveSince}, now())`,
        ...(info ? { displayName: info.displayName } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(member.guildId, guildId), eq(member.userId, userId)))
      .returning({ userId: member.userId });
    return updated.length ? 'inactive' : 'none';
  });
}

/**
 * Full sync of one server: everyone on it plus everyone the roster still lists as active
 * (they may have left while the bot was offline). Members without a role and without a row
 * cost no query.
 */
export async function syncGuild(db: Db, guildId: string, settings: GuildSettings, members: MemberInfo[]) {
  const rows = await db.select({ userId: member.userId, active: member.active }).from(member).where(eq(member.guildId, guildId));
  const known = new Map(rows.map((r) => [r.userId, r.active]));
  const counts: Record<SyncResult, number> = { active: 0, inactive: 0, deleted: 0, none: 0 };
  const seen = new Set<string>();
  for (const info of members) {
    seen.add(info.userId);
    const relevant = known.has(info.userId) || (!info.bot && accessOf(info.roleIds, settings).member);
    if (relevant) counts[await syncMember(db, guildId, settings, info.userId, info)]++;
  }
  for (const [userId, active] of known) {
    if (!seen.has(userId) && active) counts[await syncMember(db, guildId, settings, userId, null)]++;
  }
  return counts;
}

/** Member event: joined, roles or nickname changed (info), or left (null). */
export async function syncMemberEvent(db: Db, guildId: string, userId: string, info: MemberInfo | null) {
  const settings = await findGuildSettings(db, guildId);
  if (settings) await syncMember(db, guildId, settings, userId, info);
}

/**
 * Autocomplete over the org's active members: display name or RSI handle contains every word;
 * names starting with the first word come first, then alphabetical.
 */
export async function searchMembers(db: Db, guildId: string, query: string, limit = 25) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = sql`lower(${member.displayName} || ' ' || coalesce(${appUser.rsiHandle}, ''))`;
  const conditions = words.map((w) => sql`strpos(${hay}, ${w}) > 0`);
  const first = words[0] ?? '';
  return db.select({ userId: member.userId, displayName: member.displayName, rsiHandle: appUser.rsiHandle })
    .from(member)
    .innerJoin(appUser, eq(appUser.userId, member.userId))
    .where(and(eq(member.guildId, guildId), eq(member.active, true), ...conditions))
    .orderBy(sql`starts_with(lower(${member.displayName}), ${first}) DESC`, sql`lower(${member.displayName})`)
    .limit(limit);
}
