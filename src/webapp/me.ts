// What the logged-in user may do, read from the roster on every request (never from the session).
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import type { MeResponse } from './api-types.ts';

// The bot writes the heartbeat every minute; older than this = the roster may miss role changes
export const HEARTBEAT_STALE_MS = 5 * 60_000;

/** True when the bot's roster sync is alive (bot.heartbeat recent enough). */
export async function rosterFresh(db: Db): Promise<boolean> {
  const rows = await db.execute<{ fresh: boolean }>(sql`
    SELECT at > now() - ${`${HEARTBEAT_STALE_MS} milliseconds`}::interval AS fresh FROM bot.heartbeat WHERE id = 1`);
  return rows[0]?.fresh ?? false;
}

export async function getMe(db: Db, userId: string): Promise<MeResponse> {
  const orgs = await db.execute<{ guild_id: string; name: string; display_name: string; officer: boolean }>(sql`
    SELECT o.guild_id, o.name, m.display_name, m.officer FROM app.member m JOIN app.org o ON o.guild_id = m.guild_id
    WHERE m.user_id = ${userId} AND m.active ORDER BY lower(o.name)`);
  return {
    userId,
    orgs: orgs.map((o) => ({ guildId: o.guild_id, name: o.name, displayName: o.display_name, officer: o.officer })),
    rosterFresh: await rosterFresh(db),
  };
}
