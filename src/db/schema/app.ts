// App data, managed by the bot and (later) the web UI: orgs with their roles, users, roster,
// stock and the blueprint registry. Bot-only configuration and state live in schema `bot`.
// Design and rationale: docs/bot.md "Schemas", docs/stock.md. Orgs, users and members are never deleted
// (flags instead), so stock and journal stay resolvable. Catalog references are plain FKs:
// catalog rows are never deleted either, only retired.
import { sql, type SQLWrapper } from 'drizzle-orm';
import {
  bigint, boolean, check, customType, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, unique, uuid,
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

/** User × org (roster). Active = holds a configured member role, while the bot is on the server. */
export const member = app.table('member', {
  guildId: text('guild_id').notNull().references(() => org.guildId),
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
 * One row = one batch. Every batch belongs to one user (who has it in game; one character, one
 * inventory) and only that user changes it. Visible to its owner only, usable without any org,
 * unless shared: app.stock_share offers it in any number of the owner's orgs. Booking the same merge key again adds to
 * the quantity; a batch that reaches 0 is deleted. Rules a CHECK cannot express (only crafting inputs, never ores,
 * selectable and non-retired locations/subjects) are enforced by the stock service.
 */
export const stockBatch = app.table('stock_batch', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  // Whose it is (who has it in game), shared or not
  ownerUserId: text('owner_user_id').notNull().references(() => appUser.userId),
  kind: text('kind').notNull(),
  resourceUuid: uuid('resource_uuid').references(() => resource.uuid),
  itemUuid: uuid('item_uuid').references(() => item.uuid),
  locationUuid: uuid('location_uuid').notNull().references(() => location.uuid),
  state: text('state').notNull().default('stored'),
  quality: integer('quality').notNull(),
  // SCU for resources, pieces for items
  quantity: quantity('quantity').notNull(),
  // Refinery jobs only (all NULL for stored stock; NULL on jobs from before migration 0009). A job is a work order:
  // its batches share `refine_job` and carry the same start and end. Each batch is a refined material with the expected
  // yield as its quantity (ores are not booked since migration 0025); yield and end are estimates the terminal may
  // correct later.
  refineJob: uuid('refine_job'),
  refineStartedAt: timestamp('refine_started_at', { withTimezone: true }),
  refineEndsAt: timestamp('refine_ends_at', { withTimezone: true }),
  // A part split off by its owner (a random UUID): kept apart from the batch it came from, so it can be
  // shared on its own; NULL for everything booked normally
  lot: uuid('lot'),
  // Ship components only: the stats, {crafted property UUID: text} like the crafting check shows them (a
  // multiplier's change in percent, additive steps; src/stock/component-stats.ts), keys sorted; NULL = none
  // (looted, or not entered). Part of the merge key
  stats: jsonb('stats'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('stock_batch_stats', sql`${t.stats} IS NULL OR (${t.kind} = 'item' AND jsonb_typeof(${t.stats}) = 'object')`),
  check('stock_batch_kind', sql`(${t.kind} = 'resource' AND ${t.resourceUuid} IS NOT NULL AND ${t.itemUuid} IS NULL)
    OR (${t.kind} = 'item' AND ${t.itemUuid} IS NOT NULL AND ${t.resourceUuid} IS NULL)`),
  check('stock_batch_state', sql`${t.state} IN ('stored', 'refining')`),
  check('stock_batch_refining_resource', sql`${t.state} = 'stored' OR ${t.kind} = 'resource'`),
  check('stock_batch_quality', sql`${t.quality} BETWEEN 0 AND 1000`),
  check('stock_batch_quantity', sql`${t.quantity} > 0`),
  check('stock_batch_item_pieces', sql`${t.kind} = 'resource' OR ${t.quantity} = trunc(${t.quantity})`),
  check('stock_batch_refine_job', sql`${t.state} = 'refining' OR (${t.refineStartedAt} IS NULL
    AND ${t.refineEndsAt} IS NULL)`),
  check('stock_batch_refine_ends', sql`${t.refineEndsAt} IS NULL OR ${t.refineEndsAt} >= ${t.refineStartedAt}`),
  check('stock_batch_refine_job_id', sql`(${t.state} = 'refining') = (${t.refineJob} IS NOT NULL)`),
  // The job keeps two refinery jobs with the same material, place and quality apart, the lot a split-off part
  // (stored stock: both NULL, merges), the stats components with other values
  unique('stock_batch_merge_key').on(
    t.ownerUserId, t.kind, t.resourceUuid, t.itemUuid, t.locationUuid, t.state, t.quality, t.refineJob, t.lot, t.stats,
  ).nullsNotDistinct(),
  index().on(t.ownerUserId),
  index().on(t.refineJob),
]);

/**
 * A batch offered in an org: its members see it. Only the owner shares (while an active member there)
 * and takes it back; refinery jobs are never shared. Shares of someone who left the org stay but the
 * org no longer sees them. Gone with the batch.
 */
export const stockShare = app.table('stock_share', {
  batchId: bigint('batch_id', { mode: 'number' }).notNull().references(() => stockBatch.id, { onDelete: 'cascade' }),
  guildId: text('guild_id').notNull().references(() => org.guildId),
  sharedAt: timestamp('shared_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.batchId, t.guildId] }), index().on(t.guildId)]);

/**
 * Append-only journal of quantities, the source of truth. Keeps a copy of the batch key instead of a
 * reference (batches get deleted at 0). Moves, splits and refinery completions are two rows sharing a
 * group_id. Sharing changes no quantity: it is in the history only.
 */
export const stockJournal = app.table('stock_journal', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  createdAt: createdAt(),
  action: text('action').notNull(),
  groupId: uuid('group_id'),
  // Who executed the booking vs. whose batch it affected (differ on the receiving side of a give)
  actorUserId: text('actor_user_id').notNull().references(() => appUser.userId),
  ownerUserId: text('owner_user_id').notNull().references(() => appUser.userId),
  kind: text('kind').notNull(),
  resourceUuid: uuid('resource_uuid').references(() => resource.uuid),
  itemUuid: uuid('item_uuid').references(() => item.uuid),
  locationUuid: uuid('location_uuid').notNull().references(() => location.uuid),
  state: text('state').notNull(),
  quality: integer('quality').notNull(),
  // Copy of the batch's stats (ship components)
  stats: jsonb('stats'),
  // Signed
  delta: quantity('delta').notNull(),
  note: text('note'),
}, (t) => [
  check('stock_journal_action', sql`${t.action} IN ('add', 'remove', 'adjust', 'move_out', 'move_in', 'refine_out', 'refine_in')`),
  check('stock_journal_group', sql`(${t.action} IN ('move_out', 'move_in', 'refine_out', 'refine_in')) = (${t.groupId} IS NOT NULL)`),
  check('stock_journal_kind', sql`(${t.kind} = 'resource' AND ${t.resourceUuid} IS NOT NULL AND ${t.itemUuid} IS NULL)
    OR (${t.kind} = 'item' AND ${t.itemUuid} IS NOT NULL AND ${t.resourceUuid} IS NULL)`),
  check('stock_journal_state', sql`${t.state} IN ('stored', 'refining')`),
  check('stock_journal_quality', sql`${t.quality} BETWEEN 0 AND 1000`),
  check('stock_journal_delta', sql`${t.delta} <> 0`),
  index().on(t.groupId),
  index().on(t.ownerUserId, t.createdAt.desc()),
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
  // Who did it vs. whose data it touched; a give touches a second user, the new owner
  actorUserId: text('actor_user_id').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  toOwnerUserId: text('to_owner_user_id'),
  // The org involved (sharing, taking back, the org a give happened in), else NULL
  guildId: text('guild_id'),
  targetKind: text('target_kind').notNull(),
  targetUuid: uuid('target_uuid').notNull(),
  // Amounts, quality, locations, … as the action had them (catalog UUIDs, NUMERIC text)
  details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
}, (t) => [
  check('history_source', sql`${t.source} IN ('bot', 'webapp', 'companion')`),
  check('history_action', sql`(${t.category} = 'stock' AND ${t.action} IN ('add', 'remove', 'adjust', 'move', 'share', 'unshare', 'give', 'split', 'merge'))
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

// Bytes (postgres.js hands out a Buffer); drizzle's pg-core has no bytea column
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * A feature beyond the roles for single users, e.g. a supporter tool (docs/webapp.md "Features and privileges"):
 * it comes with its migration, keeps its data in app.feature_entry and is used through its privileges. Never
 * deleted (its data and privileges keep referencing it), retired instead.
 */
export const feature = app.table('feature', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
  createdAt: createdAt(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
}, (t) => [check('feature_key_format', sql`${t.key} ~ '^[a-z][a-z0-9-]{1,40}$'`)]);

/**
 * A privilege: one right within one feature (key `<feature>.<right>`, e.g. thumb-review.mark); the feature's code
 * checks it per action. Comes with the feature's migrations; never deleted, retired instead.
 */
export const privilege = app.table('privilege', {
  key: text('key').primaryKey(),
  featureKey: text('feature_key').notNull().references(() => feature.key),
  description: text('description').notNull(),
  createdAt: createdAt(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
}, (t) => [
  check('privilege_key_format', sql`${t.key} ~ '^[a-z][a-z0-9-]{1,40}[.][a-z][a-z0-9-]{1,40}$' AND split_part(${t.key}, '.', 1) = ${t.featureKey}`),
  index().on(t.featureKey),
]);

/**
 * Who holds which privilege, assigned in the admin UI until taken back. No FK to app.app_user: the roster cleanup
 * deletes users without data and does not know this table.
 */
export const userPrivilege = app.table('user_privilege', {
  userId: text('user_id').notNull(),
  privilegeKey: text('privilege_key').notNull().references(() => privilege.key),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.privilegeKey] }),
  check('user_privilege_user_id_format', snowflake(t.userId)),
  index().on(t.privilegeKey),
]);

/**
 * A feature's data: one row per user and subject (e.g. a thumbnail marked as wrong), the payload checked by the
 * feature's schema in code (src/webapp/features.ts), optionally one file (an image). Which privilege reads or
 * writes the rows is the code's; only the row's user changes it. Rows stay when privileges are taken back.
 * No FK to app.app_user, like user_privilege.
 */
export const featureEntry = app.table('feature_entry', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  featureKey: text('feature_key').notNull().references(() => feature.key),
  userId: text('user_id').notNull(),
  subject: text('subject').notNull(),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  blob: bytea('blob'),
  blobType: text('blob_type'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique('feature_entry_user_subject').on(t.featureKey, t.userId, t.subject),
  check('feature_entry_user_id_format', snowflake(t.userId)),
  check('feature_entry_subject', sql`length(${t.subject}) BETWEEN 1 AND 200`),
  check('feature_entry_payload', sql`jsonb_typeof(${t.payload}) = 'object'`),
  check('feature_entry_blob', sql`(${t.blob} IS NULL) = (${t.blobType} IS NULL)`),
  index().on(t.featureKey, t.subject),
]);
