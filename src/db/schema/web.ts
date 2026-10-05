// User web app state. The data it works on lives in schema `app`; nothing in `app` references
// this schema. Sessions are ephemeral and get deleted when they expire or the user logs out.
import { sql } from 'drizzle-orm';
import { check, index, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { createdAt, snowflake } from './app.ts';

export const web = pgSchema('web');

/**
 * Login session. Only the SHA-256 of the cookie token is stored, so a dump yields no usable
 * session. No FK to app.app_user: the roster cleanup deletes users that hold no data and does not
 * know about sessions; the app upserts app_user on every authenticated request instead.
 */
export const session = web.table('session', {
  // Hex SHA-256 of the token
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull(),
  createdAt: createdAt(),
  // Idle timeout counts from here
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  // Absolute end, whatever the activity
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [
  check('session_token_hash_format', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  check('session_user_id_format', snowflake(t.userId)),
  index().on(t.userId),
  index().on(t.expiresAt),
]);
