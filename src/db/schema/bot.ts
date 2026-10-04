// Bot data: per-guild settings and roster, global user settings, stock and the blueprint registry.
// Design and rationale: .claude/bot-schema-draft.md. Guilds, users and members are never deleted
// (flags instead), so stock and journal stay resolvable. Catalog references are plain FKs:
// catalog rows are never deleted either, only retired.
import { sql, type SQLWrapper } from 'drizzle-orm';
import {
  bigint, boolean, check, foreignKey, index, integer, numeric, pgSchema, primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { item, location, resource, blueprint } from './catalog.ts';

export const bot = pgSchema('bot');

// Discord snowflakes are kept as text, the way discord.js hands them out
const snowflake = (column: SQLWrapper) => sql`${column} ~ '^[0-9]{17,20}$'`;

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
// Fractional SCU (smallest seen 0.005), same precision as the planner's micro units
const quantity = (name: string) => numeric(name, { precision: 14, scale: 6 });

/** One Discord server = one org. */
export const guild = bot.table('guild', {
  guildId: text('guild_id').primaryKey(),
  // Language of public output (#logs etc.); never Discord's guildLocale
  baseLang: text('base_lang').notNull().default('en'),
  memberRoleIds: text('member_role_ids').array().notNull().default(sql`'{}'`),
  officerRoleIds: text('officer_role_ids').array().notNull().default(sql`'{}'`),
  // NULL = no #logs, whatever the level
  logsChannelId: text('logs_channel_id'),
  logsLevel: text('logs_level').notNull().default('org'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  // Bot removed from the server; the data is kept
  leftAt: timestamp('left_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('guild_id_format', snowflake(t.guildId)),
  check('guild_logs_channel_id_format', sql`${t.logsChannelId} IS NULL OR ${snowflake(t.logsChannelId)}`),
  check('guild_base_lang', sql`${t.baseLang} IN ('de', 'en')`),
  check('guild_logs_level', sql`${t.logsLevel} IN ('off', 'org', 'all')`),
]);

/** Global per Discord user, shared by all guilds. */
export const appUser = bot.table('app_user', {
  userId: text('user_id').primaryKey(),
  // NULL = follow interaction.locale
  langOverride: text('lang_override'),
  rsiHandle: text('rsi_handle'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('app_user_id_format', snowflake(t.userId)),
  check('app_user_lang_override', sql`${t.langOverride} IS NULL OR ${t.langOverride} IN ('de', 'en')`),
]);

/**
 * User × guild (roster). Active = holds a configured member or officer role. The permission
 * level is not stored: it is computed live from the interaction's roles and Manage Server.
 */
export const guildMember = bot.table('guild_member', {
  guildId: text('guild_id').notNull().references(() => guild.guildId),
  userId: text('user_id').notNull().references(() => appUser.userId),
  active: boolean('active').notNull().default(true),
  // Cached for lists and #logs after a member left
  displayName: text('display_name').notNull(),
  defaultLocationUuid: uuid('default_location_uuid').references(() => location.uuid),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  inactiveSince: timestamp('inactive_since', { withTimezone: true }),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.guildId, t.userId] })]);

/**
 * One row = one batch. Booking the same merge key again adds to the quantity; a batch that
 * reaches 0 is deleted. Rules a CHECK cannot express (refining only for ores, only crafting
 * inputs, selectable and non-retired locations/subjects) are enforced by the stock service.
 */
export const stockBatch = bot.table('stock_batch', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  guildId: text('guild_id').notNull(),
  // Who physically holds it, also for org stock
  ownerUserId: text('owner_user_id').notNull(),
  designation: text('designation').notNull(),
  kind: text('kind').notNull(),
  resourceUuid: uuid('resource_uuid').references(() => resource.uuid),
  itemUuid: uuid('item_uuid').references(() => item.uuid),
  locationUuid: uuid('location_uuid').notNull().references(() => location.uuid),
  state: text('state').notNull().default('stored'),
  quality: integer('quality').notNull(),
  // SCU for resources, pieces for items
  quantity: quantity('quantity').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  foreignKey({ columns: [t.guildId, t.ownerUserId], foreignColumns: [guildMember.guildId, guildMember.userId] }),
  check('stock_batch_designation', sql`${t.designation} IN ('personal', 'org')`),
  check('stock_batch_kind', sql`(${t.kind} = 'resource' AND ${t.resourceUuid} IS NOT NULL AND ${t.itemUuid} IS NULL)
    OR (${t.kind} = 'item' AND ${t.itemUuid} IS NOT NULL AND ${t.resourceUuid} IS NULL)`),
  check('stock_batch_state', sql`${t.state} IN ('stored', 'refining')`),
  check('stock_batch_refining_resource', sql`${t.state} = 'stored' OR ${t.kind} = 'resource'`),
  check('stock_batch_quality', sql`${t.quality} BETWEEN 0 AND 1000`),
  check('stock_batch_quantity', sql`${t.quantity} > 0`),
  check('stock_batch_item_pieces', sql`${t.kind} = 'resource' OR ${t.quantity} = trunc(${t.quantity})`),
  unique('stock_batch_merge_key').on(
    t.guildId, t.ownerUserId, t.designation, t.kind, t.resourceUuid, t.itemUuid, t.locationUuid, t.state, t.quality,
  ).nullsNotDistinct(),
  index().on(t.guildId, t.resourceUuid),
  index().on(t.guildId, t.itemUuid),
  index().on(t.guildId, t.ownerUserId),
  index().on(t.guildId, t.locationUuid),
]);

/**
 * Append-only journal, the source of truth for #logs. Keeps a copy of the batch key instead of
 * a reference (batches get deleted at 0). Moves and refinery completions are two rows sharing
 * a group_id.
 */
export const stockJournal = bot.table('stock_journal', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  guildId: text('guild_id').notNull(),
  createdAt: createdAt(),
  action: text('action').notNull(),
  groupId: uuid('group_id'),
  // Who executed the booking vs. whose batch it affected (differ when an officer books for someone)
  actorUserId: text('actor_user_id').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  designation: text('designation').notNull(),
  kind: text('kind').notNull(),
  resourceUuid: uuid('resource_uuid').references(() => resource.uuid),
  itemUuid: uuid('item_uuid').references(() => item.uuid),
  locationUuid: uuid('location_uuid').notNull().references(() => location.uuid),
  state: text('state').notNull(),
  quality: integer('quality').notNull(),
  // Signed
  delta: quantity('delta').notNull(),
  note: text('note'),
  // #logs outbox: set once the line is posted (or skipped as too old)
  logsPostedAt: timestamp('logs_posted_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.guildId, t.actorUserId], foreignColumns: [guildMember.guildId, guildMember.userId] }),
  foreignKey({ columns: [t.guildId, t.ownerUserId], foreignColumns: [guildMember.guildId, guildMember.userId] }),
  check('stock_journal_action', sql`${t.action} IN ('add', 'remove', 'adjust', 'move_out', 'move_in', 'refine_out', 'refine_in')`),
  check('stock_journal_group', sql`(${t.action} IN ('move_out', 'move_in', 'refine_out', 'refine_in')) = (${t.groupId} IS NOT NULL)`),
  check('stock_journal_designation', sql`${t.designation} IN ('personal', 'org')`),
  check('stock_journal_kind', sql`(${t.kind} = 'resource' AND ${t.resourceUuid} IS NOT NULL AND ${t.itemUuid} IS NULL)
    OR (${t.kind} = 'item' AND ${t.itemUuid} IS NOT NULL AND ${t.resourceUuid} IS NULL)`),
  check('stock_journal_state', sql`${t.state} IN ('stored', 'refining')`),
  check('stock_journal_quality', sql`${t.quality} BETWEEN 0 AND 1000`),
  check('stock_journal_delta', sql`${t.delta} <> 0`),
  index().on(t.guildId, t.createdAt.desc()),
  index().on(t.groupId),
  index().on(t.guildId, t.ownerUserId, t.createdAt.desc()),
]);

/**
 * Blueprints a user owns, global per user (blueprints belong to the game character). Default
 * blueprints (catalog.blueprint.is_default) are not stored: everyone has them.
 */
export const userBlueprint = bot.table('user_blueprint', {
  userId: text('user_id').notNull().references(() => appUser.userId),
  blueprintUuid: uuid('blueprint_uuid').notNull().references(() => blueprint.uuid),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.blueprintUuid] }), index().on(t.blueprintUuid)]);
