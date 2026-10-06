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
  // Discord profile at login, for the user's own header (also without any org); refreshed by every login
  discordUsername: text('discord_username').notNull(),
  discordGlobalName: text('discord_global_name'),
  // Avatar hash; NULL = Discord's default avatar
  discordAvatar: text('discord_avatar'),
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

/**
 * The web app's own user settings (the bot keeps its own in bot.user_config). No FK to app.app_user,
 * like the sessions: the roster cleanup does not know this table.
 */
export const userSetting = web.table('user_setting', {
  userId: text('user_id').primaryKey(),
  // NULL = follow the browser language
  lang: text('lang'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('user_setting_user_id_format', snowflake(t.userId)),
  check('user_setting_lang', sql`${t.lang} IS NULL OR ${t.lang} IN ('de', 'en')`),
]);

/**
 * A user's API token for the companion app: one per user, only its SHA-256 here (shown once when
 * created; creating a new one replaces it). Acts as the user like a session, without the token
 * route itself. No FK to app.app_user, like the sessions.
 */
export const apiToken = web.table('api_token', {
  userId: text('user_id').primaryKey(),
  // Hex SHA-256 of the token
  tokenHash: text('token_hash').notNull().unique(),
  // Discord profile of the session that created the token (for /api/me through the token)
  discordUsername: text('discord_username').notNull(),
  discordGlobalName: text('discord_global_name'),
  discordAvatar: text('discord_avatar'),
  createdAt: createdAt(),
  // NULL = never used; written at most hourly
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (t) => [
  check('api_token_user_id_format', snowflake(t.userId)),
  check('api_token_token_hash_format', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
]);
