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
  // What the logs channel posts: 'stock' (the org's shared stock), 'blueprints' (its members' blueprints), 'all' or 'off'
  logsLevel: text('logs_level').notNull().default('stock'),
  // The last app.history row the logs channel has handled (posted or skipped); NULL = start at the newest
  // row, never post the past (set again whenever channel or level change)
  logsAfter: bigint('logs_after', { mode: 'number' }),
  // The board: one message the bot keeps current with what the org offers; NULL = no board
  boardChannelId: text('board_channel_id'),
  // The board message in that channel; NULL = not posted yet (posted on the next round)
  boardMessageId: text('board_message_id'),
  // How the board shows the figures and materials: 'list' (text lines) or 'table' (code-block tables)
  boardStyle: text('board_style').notNull().default('list'),
  // The board's title; NULL = the org name
  boardTitle: text('board_title'),
  // A small line below the title; NULL = none
  boardSubtitle: text('board_subtitle'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  // Bot removed from the server; the data is kept
  leftAt: timestamp('left_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('guild_logs_channel_id_format', sql`${t.logsChannelId} IS NULL OR ${snowflake(t.logsChannelId)}`),
  check('guild_board_channel_id_format', sql`${t.boardChannelId} IS NULL OR ${snowflake(t.boardChannelId)}`),
  check('guild_board_message_id_format', sql`${t.boardMessageId} IS NULL OR ${snowflake(t.boardMessageId)}`),
  check('guild_board_style', sql`${t.boardStyle} IN ('list', 'table')`),
  check('guild_board_title_length', sql`${t.boardTitle} IS NULL OR char_length(${t.boardTitle}) BETWEEN 1 AND 100`),
  check('guild_board_subtitle_length', sql`${t.boardSubtitle} IS NULL OR char_length(${t.boardSubtitle}) BETWEEN 1 AND 100`),
  check('guild_base_lang', sql`${t.baseLang} IN ('de', 'en')`),
  check('guild_logs_level', sql`${t.logsLevel} IN ('off', 'stock', 'blueprints', 'all')`),
]);

/** Texts the bot shows as its Discord status, one at random every few minutes (status.ts); edited in the admin UI. */
export const statusQuote = bot.table('status_quote', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  // Discord's limit for a custom status
  text: text('text').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [check('status_quote_text_length', sql`char_length(${t.text}) BETWEEN 1 AND 128`)]);

/** Bot settings per user, global. */
export const userConfig = bot.table('user_config', {
  userId: text('user_id').primaryKey().references(() => appUser.userId),
  // NULL = follow interaction.locale
  langOverride: text('lang_override'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [check('user_config_lang_override', sql`${t.langOverride} IS NULL OR ${t.langOverride} IN ('de', 'en')`)]);
