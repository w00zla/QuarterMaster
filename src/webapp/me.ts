// What the logged-in user may do, read from the roster on every request (never from the session).
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import type { MeResponse } from './api-types.ts';
import type { Session } from './session.ts';

// The bot refreshes app.org.roster_checked_at every minute while it vouches for the org's roster
// (src/bot/roster-keeper.ts); older than this = role changes may be missing: org stock read-only
export const ROSTER_STALE_MS = 5 * 60_000;

const CDN = 'https://cdn.discordapp.com';

/** The user's Discord avatar, or Discord's default one (new username system: (id >> 22) % 6). */
export const avatarUrl = (userId: string, avatar: string | null) => avatar
  ? `${CDN}/avatars/${userId}/${avatar}.png?size=64`
  : `${CDN}/embed/avatars/${(BigInt(userId) >> 22n) % 6n}.png`;

export async function getMe(db: Db, session: Session): Promise<MeResponse> {
  const { userId } = session;
  const orgs = await db.execute<{
    guild_id: string; name: string; display_name: string; officer: boolean; roster_fresh: boolean; fresh_for_ms: number; bot_present: boolean;
  }>(sql`
    SELECT o.guild_id, o.name, m.display_name, m.officer,
      coalesce(o.roster_checked_at > now() - ${`${ROSTER_STALE_MS} milliseconds`}::interval, false) AS roster_fresh,
      greatest(0, coalesce(extract(epoch FROM o.roster_checked_at + ${`${ROSTER_STALE_MS} milliseconds`}::interval - now()) * 1000, 0))::int
        AS fresh_for_ms,
      g.left_at IS NULL AS bot_present
    FROM app.member m JOIN app.org o ON o.guild_id = m.guild_id LEFT JOIN bot.guild g ON g.guild_id = o.guild_id
    WHERE m.user_id = ${userId} AND m.active ORDER BY lower(o.name)`);
  return {
    userId,
    // Shown in the user's own header, also without any org
    name: session.globalName ?? session.username,
    username: session.username,
    avatarUrl: avatarUrl(userId, session.avatar),
    orgs: orgs.map((o) => ({
      guildId: o.guild_id, name: o.name, displayName: o.display_name, officer: o.officer,
      rosterFresh: o.roster_fresh, rosterFreshForMs: o.fresh_for_ms, botPresent: o.bot_present,
    })),
  };
}
