// API tokens for the companion app (web.api_token): one per user, created in the profile, shown
// once (only the SHA-256 is stored). Sent as "Authorization: Bearer", it acts as the user like a
// session; creating a new one replaces the old.
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import type { ApiTokenInfo } from './api-types.ts';
import { hashToken, type Session } from './session.ts';

// last_used_at is written at most this often
const TOUCH_MS = 3600_000;

/** Creates the session user's token (replacing an existing one) and returns it; shown nowhere else. */
export async function createApiToken(db: Db, session: Session): Promise<string> {
  const token = `qmt_${randomBytes(32).toString('base64url')}`;
  await db.execute(sql`
    INSERT INTO web.api_token (user_id, token_hash, discord_username, discord_global_name, discord_avatar)
    VALUES (${session.userId}, ${hashToken(token)}, ${session.username}, ${session.globalName}, ${session.avatar})
    ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, discord_username = excluded.discord_username,
      discord_global_name = excluded.discord_global_name, discord_avatar = excluded.discord_avatar, created_at = now(), last_used_at = NULL`);
  return token;
}

export async function apiTokenInfo(db: Db, userId: string): Promise<ApiTokenInfo> {
  const [row] = await db.execute<{ created_at: string; last_used_at: string | null }>(sql`
    SELECT created_at, last_used_at FROM web.api_token WHERE user_id = ${userId}`);
  return {
    createdAt: row ? new Date(row.created_at).toISOString() : null,
    lastUsedAt: row?.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  };
}

/** The token's user as a session, or null for an unknown token. Recreates a missing app_user row. */
export async function validateApiToken(db: Db, token: string): Promise<Session | null> {
  const rows = await db.execute<{
    user_id: string; discord_username: string; discord_global_name: string | null; discord_avatar: string | null; stale: boolean;
  }>(sql`
    WITH t AS (
      SELECT user_id, discord_username, discord_global_name, discord_avatar,
        last_used_at IS NULL OR last_used_at < now() - ${`${TOUCH_MS} milliseconds`}::interval AS stale
      FROM web.api_token WHERE token_hash = ${hashToken(token)}
    ), u AS (
      INSERT INTO app.app_user (user_id) SELECT user_id FROM t ON CONFLICT DO NOTHING
    )
    SELECT * FROM t`);
  const row = rows[0];
  if (!row) return null;
  if (row.stale) await db.execute(sql`UPDATE web.api_token SET last_used_at = now() WHERE user_id = ${row.user_id}`);
  return { userId: row.user_id, username: row.discord_username, globalName: row.discord_global_name, avatar: row.discord_avatar };
}
