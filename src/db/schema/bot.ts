// Discord bot configuration and state. The data the bot works on (orgs, roster, stock,
// blueprints) lives in schema `app`; nothing in `app` references this schema.
import { sql } from 'drizzle-orm';
import { bigint, check, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { appUser, createdAt, org, snowflake, stockJournal, updatedAt } from './app.ts';

export const bot = pgSchema('bot');

/** Bot settings and presence per server. */
export const guild = bot.table('guild', {
  guildId: text('guild_id').primaryKey().references(() => org.guildId),
  // Language of public output (#logs etc.); never Discord's guildLocale
  baseLang: text('base_lang').notNull().default('en'),
  // NULL = no #logs, whatever the level
  logsChannelId: text('logs_channel_id'),
  logsLevel: text('logs_level').notNull().default('org'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  // Bot removed from the server; the data is kept
  leftAt: timestamp('left_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('guild_logs_channel_id_format', sql`${t.logsChannelId} IS NULL OR ${snowflake(t.logsChannelId)}`),
  check('guild_base_lang', sql`${t.baseLang} IN ('de', 'en')`),
  check('guild_logs_level', sql`${t.logsLevel} IN ('off', 'org')`),
]);

/** Bot settings per user, global. */
export const userConfig = bot.table('user_config', {
  userId: text('user_id').primaryKey().references(() => appUser.userId),
  // NULL = follow interaction.locale
  langOverride: text('lang_override'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [check('user_config_lang_override', sql`${t.langOverride} IS NULL OR ${t.langOverride} IN ('de', 'en')`)]);

/**
 * #logs outbox: a journal row without an entry here is not posted yet. On startup the bot posts
 * what is missing (filtered by the current logs level) and records older rows as done without
 * posting them, so a crash between commit and post loses nothing.
 */
export const logsOutbox = bot.table('logs_outbox', {
  journalId: bigint('journal_id', { mode: 'number' }).primaryKey().references(() => stockJournal.id),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
});
