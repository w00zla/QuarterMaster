// App data, managed by the bot and (later) the web UI: orgs with their roles, users, roster,
// stock and the blueprint registry. Bot-only configuration and state live in schema `bot`.
// Design and rationale: .claude/bot-schema-draft.md. Orgs, users and members are never deleted
// (flags instead), so stock and journal stay resolvable. Catalog references are plain FKs:
// catalog rows are never deleted either, only retired.
import { sql, type SQLWrapper } from 'drizzle-orm';
import {
  bigint, boolean, check, foreignKey, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { item, location, resource, blueprint } from './catalog.ts';

export const app = pgSchema('app');

// Discord snowflakes are kept as text, the way discord.js hands them out
export const snowflake = (column: SQLWrapper) => sql`${column} ~ '^[0-9]{17,20}$'`;

export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
// Fractional SCU (smallest seen 0.005), same precision as the planner's micro units
const quantity = (name: string) => numeric(name, { precision: 14, scale: 6 });

/** One Discord server = one org. */
export const org = app.table('org', {
  guildId: text('guild_id').primaryKey(),
  // Cached server name, for lists outside Discord
  name: text('name').notNull(),
  memberRoleIds: text('member_role_ids').array().notNull().default(sql`'{}'`),
  officerRoleIds: text('officer_role_ids').array().notNull().default(sql`'{}'`),
  // Last time the bot vouched for the roster (src/bot/roster-keeper.ts), NULL while it cannot. The
  // user web app treats an older value as a stale roster: org stock read-only
  rosterCheckedAt: timestamp('roster_checked_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [check('org_guild_id_format', snowflake(t.guildId))]);

/** Global per Discord user, shared by all orgs. */
export const appUser = app.table('app_user', {
  userId: text('user_id').primaryKey(),
  rsiHandle: text('rsi_handle'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [check('app_user_id_format', snowflake(t.userId))]);

/**
 * User × org (roster). Active = holds a configured member or officer role. The officer flag is
 * stored for the user web app, which has no interaction with roles; the bot still resolves rights
 * live from the interaction (and refreshes the row on every requireMember).
 */
export const member = app.table('member', {
  guildId: text('guild_id').notNull().references(() => org.guildId),
  userId: text('user_id').notNull().references(() => appUser.userId),
  active: boolean('active').notNull().default(true),
  // Holds an officer role; false while inactive
  officer: boolean('officer').notNull().default(false),
  // Cached for lists and #logs after a member left
  displayName: text('display_name').notNull(),
  defaultLocationUuid: uuid('default_location_uuid').references(() => location.uuid),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  inactiveSince: timestamp('inactive_since', { withTimezone: true }),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.guildId, t.userId] })]);

/**
 * One row = one batch. Personal stock belongs to the user, not to an org (one character, one
 * inventory): guild_id NULL, visible to its owner only, usable without any org. Org stock has a
 * guild_id and a holder who is a member of that org. Booking the same merge key again adds to
 * the quantity; a batch that reaches 0 is deleted. Rules a CHECK cannot express (refining only for ores, only crafting
 * inputs, selectable and non-retired locations/subjects) are enforced by the stock service.
 */
export const stockBatch = app.table('stock_batch', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  // NULL for personal stock
  guildId: text('guild_id'),
  // Who physically holds it, also for org stock
  ownerUserId: text('owner_user_id').notNull().references(() => appUser.userId),
  designation: text('designation').notNull(),
  kind: text('kind').notNull(),
  resourceUuid: uuid('resource_uuid').references(() => resource.uuid),
  itemUuid: uuid('item_uuid').references(() => item.uuid),
  locationUuid: uuid('location_uuid').notNull().references(() => location.uuid),
  state: text('state').notNull().default('stored'),
  quality: integer('quality').notNull(),
  // SCU for resources, pieces for items
  quantity: quantity('quantity').notNull(),
  // Refinery jobs only (all NULL for stored stock; NULL on jobs from before migration 0009). The method is an
  // ext.refining_method code, checked by the stock service (no FK: nothing references schema ext). Ends at and
  // expected yield are estimates the user may overwrite with the terminal's values.
  refineMethod: text('refine_method'),
  refineStartedAt: timestamp('refine_started_at', { withTimezone: true }),
  refineEndsAt: timestamp('refine_ends_at', { withTimezone: true }),
  refineExpected: quantity('refine_expected'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // Org stock only: the composite FK is not checked while guild_id is NULL
  foreignKey({ columns: [t.guildId, t.ownerUserId], foreignColumns: [member.guildId, member.userId] }),
  check('stock_batch_designation', sql`${t.designation} IN ('personal', 'org')`),
  check('stock_batch_personal_global', sql`(${t.designation} = 'personal') = (${t.guildId} IS NULL)`),
  check('stock_batch_kind', sql`(${t.kind} = 'resource' AND ${t.resourceUuid} IS NOT NULL AND ${t.itemUuid} IS NULL)
    OR (${t.kind} = 'item' AND ${t.itemUuid} IS NOT NULL AND ${t.resourceUuid} IS NULL)`),
  check('stock_batch_state', sql`${t.state} IN ('stored', 'refining')`),
  check('stock_batch_refining_resource', sql`${t.state} = 'stored' OR ${t.kind} = 'resource'`),
  // Refinery jobs belong to the player who runs them; the result can be donated afterwards
  check('stock_batch_refining_personal', sql`${t.state} = 'stored' OR ${t.designation} = 'personal'`),
  check('stock_batch_quality', sql`${t.quality} BETWEEN 0 AND 1000`),
  check('stock_batch_quantity', sql`${t.quantity} > 0`),
  check('stock_batch_item_pieces', sql`${t.kind} = 'resource' OR ${t.quantity} = trunc(${t.quantity})`),
  check('stock_batch_refine_job', sql`${t.state} = 'refining' OR (${t.refineMethod} IS NULL AND ${t.refineStartedAt} IS NULL
    AND ${t.refineEndsAt} IS NULL AND ${t.refineExpected} IS NULL)`),
  check('stock_batch_refine_ends', sql`${t.refineEndsAt} IS NULL OR ${t.refineEndsAt} >= ${t.refineStartedAt}`),
  check('stock_batch_refine_expected', sql`${t.refineExpected} IS NULL OR ${t.refineExpected} >= 0`),
  // The start time keeps two refinery jobs with the same ore, place and quality apart (stored stock: NULL, merges)
  unique('stock_batch_merge_key').on(
    t.guildId, t.ownerUserId, t.designation, t.kind, t.resourceUuid, t.itemUuid, t.locationUuid, t.state, t.quality, t.refineStartedAt,
  ).nullsNotDistinct(),
  index().on(t.guildId, t.resourceUuid),
  index().on(t.guildId, t.itemUuid),
  index().on(t.ownerUserId, t.guildId),
  index().on(t.guildId, t.locationUuid),
]);

/**
 * Append-only journal, the source of truth (also for #logs). Keeps a copy of the batch key
 * instead of a reference (batches get deleted at 0). Moves and refinery completions are two
 * rows sharing a group_id. Rows about personal stock have no guild_id, like the batch.
 */
export const stockJournal = app.table('stock_journal', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  // NULL for personal stock
  guildId: text('guild_id'),
  createdAt: createdAt(),
  action: text('action').notNull(),
  groupId: uuid('group_id'),
  // Who executed the booking vs. whose batch it affected (differ when an officer books for someone)
  actorUserId: text('actor_user_id').notNull().references(() => appUser.userId),
  ownerUserId: text('owner_user_id').notNull().references(() => appUser.userId),
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
}, (t) => [
  foreignKey({ columns: [t.guildId, t.actorUserId], foreignColumns: [member.guildId, member.userId] }),
  foreignKey({ columns: [t.guildId, t.ownerUserId], foreignColumns: [member.guildId, member.userId] }),
  check('stock_journal_personal_global', sql`(${t.designation} = 'personal') = (${t.guildId} IS NULL)`),
  check('stock_journal_action', sql`${t.action} IN ('add', 'remove', 'adjust', 'move_out', 'move_in', 'refine_out', 'refine_in')`),
  check('stock_journal_group', sql`(${t.action} IN ('move_out', 'move_in', 'refine_out', 'refine_in')) = (${t.groupId} IS NOT NULL)`),
  check('stock_journal_designation', sql`${t.designation} IN ('personal', 'org')`),
  check('stock_journal_kind', sql`(${t.kind} = 'resource' AND ${t.resourceUuid} IS NOT NULL AND ${t.itemUuid} IS NULL)
    OR (${t.kind} = 'item' AND ${t.itemUuid} IS NOT NULL AND ${t.resourceUuid} IS NULL)`),
  check('stock_journal_state', sql`${t.state} IN ('stored', 'refining')`),
  check('stock_journal_refining_personal', sql`${t.state} = 'stored' OR ${t.designation} = 'personal'`),
  check('stock_journal_quality', sql`${t.quality} BETWEEN 0 AND 1000`),
  check('stock_journal_delta', sql`${t.delta} <> 0`),
  index().on(t.guildId, t.createdAt.desc()),
  index().on(t.groupId),
  index().on(t.ownerUserId, t.guildId, t.createdAt.desc()),
]);

/**
 * Blueprints a user owns, global per user (blueprints belong to the game character). Default
 * blueprints (catalog.blueprint.is_default) are not stored: everyone has them.
 */
export const userBlueprint = app.table('user_blueprint', {
  userId: text('user_id').notNull().references(() => appUser.userId),
  blueprintUuid: uuid('blueprint_uuid').notNull().references(() => blueprint.uuid),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.blueprintUuid] }), index().on(t.blueprintUuid)]);

/**
 * What happened to a user's data, for the user's own history (src/history/history.ts): every stock,
 * refinery and blueprint action, with where it came from (bot, web app, companion app). Written in
 * the same transaction as the change; append-only like the journal. The users are plain Discord IDs
 * without foreign keys: the history outlives the cleanup of users without data.
 */
export const history = app.table('history', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  createdAt: createdAt(),
  source: text('source').notNull(),
  category: text('category').notNull(),
  action: text('action').notNull(),
  // Who did it vs. whose data it touched (differ when an officer books for someone); a move to
  // another holder touches a second user
  actorUserId: text('actor_user_id').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  toOwnerUserId: text('to_owner_user_id'),
  // The org involved (org stock on either side of a move), else NULL
  guildId: text('guild_id'),
  targetKind: text('target_kind').notNull(),
  targetUuid: uuid('target_uuid').notNull(),
  // Amounts, quality, locations, … as the action had them (catalog UUIDs, NUMERIC text)
  details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
}, (t) => [
  check('history_source', sql`${t.source} IN ('bot', 'webapp', 'companion')`),
  check('history_action', sql`(${t.category} = 'stock' AND ${t.action} IN ('add', 'remove', 'adjust', 'move'))
    OR (${t.category} = 'refinery' AND ${t.action} IN ('start', 'done', 'remove', 'adjust'))
    OR (${t.category} = 'blueprint' AND ${t.action} IN ('add', 'remove'))`),
  check('history_target', sql`(${t.category} = 'blueprint') = (${t.targetKind} = 'blueprint')
    AND ${t.targetKind} IN ('resource', 'item', 'blueprint')`),
  check('history_users', sql`${snowflake(t.actorUserId)} AND ${snowflake(t.ownerUserId)}
    AND (${t.toOwnerUserId} IS NULL OR ${snowflake(t.toOwnerUserId)}) AND (${t.guildId} IS NULL OR ${snowflake(t.guildId)})`),
  index().on(t.actorUserId, t.id),
  index().on(t.ownerUserId, t.id),
  index().on(t.toOwnerUserId, t.id),
]);
