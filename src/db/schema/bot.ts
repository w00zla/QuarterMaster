// Discord bot configuration and state. The data the bot works on (orgs, roster, stock,
// blueprints) lives in schema `app`; nothing in `app` references this schema.
import { sql } from 'drizzle-orm';
import { bigint, check, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { appUser, createdAt, org, snowflake, updatedAt } from './app.ts';

export const bot = pgSchema('bot');

/** Bot settings and presence per server. */
export const guild = bot.table('guild', {
  guildId: text('guild_id').primaryKey().references(() => org.guildId),
  // Language of public output (#logs etc.); never Discord's guildLocale
  baseLang: text('base_lang').notNull().default('en'),
  // NULL = no #logs, whatever the level
  logsChannelId: text('logs_channel_id'),
  logsLevel: text('logs_level').notNull().default('org'),
  // The last app.history row the logs channel has handled (posted or skipped); NULL = start at the newest
  // row, never post the past (set again whenever channel or level change)
  logsAfter: bigint('logs_after', { mode: 'number' }),
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
