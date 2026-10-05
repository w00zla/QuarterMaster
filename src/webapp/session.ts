// Login sessions (web.session): a random token in a __Host- cookie, only its SHA-256 in the DB.
// Rights are never cached here: every request reads the roster (see me.ts).
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';

export const SESSION_COOKIE = 'qm_session';
export const IDLE_MS = 14 * 24 * 3600_000;
export const ABSOLUTE_MS = 30 * 24 * 3600_000;
// last_seen_at is written at most this often
const TOUCH_MS = 3600_000;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Creates a session (and the app_user row if missing) and returns the cookie token (shown nowhere else). */
export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.execute(sql`
    WITH u AS (INSERT INTO app.app_user (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING)
    INSERT INTO web.session (token_hash, user_id, expires_at)
    VALUES (${hashToken(token)}, ${userId}, now() + ${`${ABSOLUTE_MS} milliseconds`}::interval)`);
  return token;
}

/**
 * The session's user, or null when the token is unknown, idle too long or past its absolute end.
 * Recreates the app_user row when the roster cleanup removed it (no FK by design).
 */
export async function validateSession(db: Db, token: string): Promise<{ userId: string } | null> {
  const rows = await db.execute<{ user_id: string; stale: boolean }>(sql`
    WITH s AS (
      SELECT user_id, last_seen_at < now() - ${`${TOUCH_MS} milliseconds`}::interval AS stale FROM web.session
      WHERE token_hash = ${hashToken(token)} AND expires_at > now()
        AND last_seen_at > now() - ${`${IDLE_MS} milliseconds`}::interval
    ), u AS (
      INSERT INTO app.app_user (user_id) SELECT user_id FROM s ON CONFLICT DO NOTHING
    )
    SELECT user_id, stale FROM s`);
  const row = rows[0];
  if (!row) return null;
  if (row.stale) await db.execute(sql`UPDATE web.session SET last_seen_at = now() WHERE token_hash = ${hashToken(token)}`);
  return { userId: row.user_id };
}

export async function deleteSession(db: Db, token: string) {
  await db.execute(sql`DELETE FROM web.session WHERE token_hash = ${hashToken(token)}`);
}

/** Removes expired and idle sessions; returns how many. */
export async function deleteExpiredSessions(db: Db): Promise<number> {
  const rows = await db.execute(sql`DELETE FROM web.session
    WHERE expires_at <= now() OR last_seen_at <= now() - ${`${IDLE_MS} milliseconds`}::interval RETURNING 1`);
  return rows.length;
}
