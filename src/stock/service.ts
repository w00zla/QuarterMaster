// Stock service: the only module that writes app.stock_batch and app.stock_journal.
// Shared by the bot and (later) the web UI. Every operation runs in one transaction: batch
// rows and their journal rows land together or not at all. Source batches are locked
// (SELECT … FOR UPDATE) and overdraw is checked in SQL, so concurrent bookings cannot
// take the same units twice.
//
// Who may do what (see .claude/requirements.md "Stock"):
// - personal stock (guild_id NULL): only its owner, from anywhere (also without any org)
// - org stock: members add stock they hold themselves and donate their own stock (holder: themselves);
//   officers do everything, also for other holders
// - refinery jobs are personal; their result is personal too and can be donated afterwards
// Every operation also writes one row of the users' history (src/history/record.ts), with the
// actor's source (bot, web app, companion app).
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.ts';
import { one } from '../db/query.ts';
import { refineryLocations } from '../ext/refineries.ts';
import { recordHistory, type HistoryCategory, type HistoryDetails, type Source } from '../history/record.ts';
import { formatAmount, parseAmount, type SubjectKind } from './amount.ts';

export type Designation = 'personal' | 'org';
export type StockState = 'stored' | 'refining';
export type JournalAction = 'add' | 'remove' | 'adjust' | 'move_out' | 'move_in' | 'refine_out' | 'refine_in';

export interface Actor {
  userId: string;
  // The org the action happens in; null outside any org (personal stock only)
  guildId: string | null;
  officer: boolean;
  // Where the action comes from (kept in the history)
  source: Source;
}

export interface Batch {
  id: number;
  guildId: string | null;
  ownerUserId: string;
  designation: Designation;
  kind: SubjectKind;
  resourceUuid: string | null;
  itemUuid: string | null;
  locationUuid: string;
  state: StockState;
  quality: number;
  // NUMERIC text as Postgres returns it ("12.500000")
  quantity: string;
}

type BatchKey = Omit<Batch, 'id' | 'quantity'>;

export interface JournalEntry extends BatchKey {
  id: number;
  groupId: string | null;
  action: JournalAction;
  actorUserId: string;
  delta: string;
}

export interface StockResult {
  journal: JournalEntry[];
  // The batch the booking ended in (add, move, refinery result) or what is left of the source
  // (remove, adjust); null when that batch was emptied
  batch: Batch | null;
}

export type StockErrorCode =
  | 'notAllowed' | 'unknownSubject' | 'notBookable' | 'oreViaRefinery' | 'notOre' | 'unknownLocation' | 'notRefinery' | 'unknownMethod' | 'invalidDuration' | 'retired'
  | 'invalidAmount' | 'invalidQuality' | 'batchNotFound' | 'batchChanged' | 'insufficient' | 'holderNotMember'
  | 'notRefining' | 'refiningFixed' | 'nothingToMove' | 'noChange';

/** A booking that is refused; the caller turns the code into a message. */
export class StockError extends Error {
  readonly code: StockErrorCode;

  constructor(code: StockErrorCode) {
    super(code);
    this.name = 'StockError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Locations stock can be booked at (`l` = catalog.location): stations and landing zones with an English
 * name; not jump points (types Anomaly, PointOfInterest) and not unfinished objects ("WIP …", the game uses
 * a no-break space there, so the word boundary `\M` instead of a plain space).
 */
export const selectableLocationSql = (l = 'l') => sql.raw(`(${l}.nav_icon IN ('Station', 'LandingZone') AND NOT ${l}.hide_in_starmap
  AND coalesce(${l}.type, '') NOT IN ('Anomaly', 'PointOfInterest')
  AND EXISTS (SELECT 1 FROM catalog.localization_effective e WHERE e.lang = 'en' AND e.key = ${l}.name_key AND e.value !~ '^WIP\\M'))`);

const BATCH_COLUMNS = sql.raw(`id::int AS id, guild_id AS "guildId", owner_user_id AS "ownerUserId", designation, kind,
  resource_uuid AS "resourceUuid", item_uuid AS "itemUuid", location_uuid AS "locationUuid", state, quality, quantity::text AS quantity`);

const JOURNAL_COLUMNS = sql.raw(`id::int AS id, group_id AS "groupId", action, guild_id AS "guildId", actor_user_id AS "actorUserId",
  owner_user_id AS "ownerUserId", designation, kind, resource_uuid AS "resourceUuid", item_uuid AS "itemUuid",
  location_uuid AS "locationUuid", state, quality, delta::text AS delta`);

function parse(text: string, kind: SubjectKind): string {
  const amount = parseAmount(text, kind);
  if (!amount) throw new StockError('invalidAmount');
  return amount;
}

function checkQuality(quality: number) {
  if (!Number.isInteger(quality) || quality < 0 || quality > 1000) throw new StockError('invalidQuality');
}

interface SubjectInfo {
  isOre: boolean;
  refinedUuid: string | null;
  retired: boolean;
  // Used in a recipe (for an ore: its refined resource is)
  bookable: boolean;
}

async function subjectInfo(tx: Tx, kind: SubjectKind, uuid: string): Promise<SubjectInfo> {
  if (!UUID.test(uuid)) throw new StockError('unknownSubject');
  const info = kind === 'resource'
    ? await one<SubjectInfo>(tx, sql`
        SELECT r.is_ore AS "isOre", r.refined_uuid AS "refinedUuid", r.retired_at IS NOT NULL AS retired,
          EXISTS (SELECT 1 FROM catalog.blueprint_input bi
                  WHERE bi.resource_uuid = CASE WHEN r.is_ore THEN r.refined_uuid ELSE r.uuid END) AS bookable
        FROM catalog.resource r WHERE r.uuid = ${uuid}`)
    : await one<SubjectInfo>(tx, sql`
        SELECT false AS "isOre", NULL::uuid AS "refinedUuid", i.retired_at IS NOT NULL AS retired,
          EXISTS (SELECT 1 FROM catalog.blueprint_input bi WHERE bi.item_uuid = i.uuid) AS bookable
        FROM catalog.item i WHERE i.uuid = ${uuid}`);
  if (!info) throw new StockError('unknownSubject');
  if (info.retired) throw new StockError('retired');
  if (!info.bookable) throw new StockError('notBookable');
  return info;
}

async function checkLocation(tx: Tx, uuid: string) {
  if (!UUID.test(uuid)) throw new StockError('unknownLocation');
  const loc = await one<{ retired: boolean; selectable: boolean }>(tx, sql`
    SELECT l.retired_at IS NOT NULL AS retired, ${selectableLocationSql()} AS selectable FROM catalog.location l WHERE l.uuid = ${uuid}`);
  if (!loc?.selectable) throw new StockError('unknownLocation');
  if (loc.retired) throw new StockError('retired');
}

async function checkHolder(tx: Tx, guildId: string, userId: string) {
  const m = await one<{ active: boolean }>(tx, sql`SELECT active FROM app.member WHERE guild_id = ${guildId} AND user_id = ${userId}`);
  if (!m?.active) throw new StockError('holderNotMember');
}

async function ensureUser(tx: Tx, userId: string) {
  await tx.execute(sql`INSERT INTO app.app_user (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`);
}

/** Who may change an existing batch (remove, move, adjust, refinery completion). */
function checkMayChange(actor: Actor, batch: Batch) {
  const allowed = batch.designation === 'personal'
    ? batch.ownerUserId === actor.userId
    : actor.officer && actor.guildId === batch.guildId;
  if (!allowed) throw new StockError('notAllowed');
}

/** Locks the batch; `expected` is the quantity the user saw when confirming. */
async function lockBatch(tx: Tx, id: number, expected?: string): Promise<Batch> {
  const batch = await one<Batch>(tx, sql`SELECT ${BATCH_COLUMNS} FROM app.stock_batch WHERE id = ${id} FOR UPDATE`);
  if (!batch) throw new StockError('batchNotFound');
  if (expected !== undefined && formatAmount(expected) !== formatAmount(batch.quantity)) throw new StockError('batchChanged');
  return batch;
}

const keyValues = (k: BatchKey): SQL => sql`${k.guildId}, ${k.ownerUserId}, ${k.designation}, ${k.kind}, ${k.resourceUuid}, ${k.itemUuid},
  ${k.locationUuid}, ${k.state}, ${k.quality}`;

/** Adds to the batch with this key (merge) or creates it. */
async function upsert(tx: Tx, key: BatchKey, quantity: string): Promise<Batch> {
  try {
    return (await one<Batch>(tx, sql`
      INSERT INTO app.stock_batch (guild_id, owner_user_id, designation, kind, resource_uuid, item_uuid, location_uuid, state, quality, quantity)
      VALUES (${keyValues(key)}, ${quantity}::numeric)
      ON CONFLICT ON CONSTRAINT stock_batch_merge_key
      DO UPDATE SET quantity = app.stock_batch.quantity + excluded.quantity, updated_at = now()
      RETURNING ${BATCH_COLUMNS}`))!;
  } catch (err) {
    // numeric field overflow: the merged batch would exceed NUMERIC(14,6)
    if ((err as { cause?: { code?: string } }).cause?.code === '22003') throw new StockError('invalidAmount');
    throw err;
  }
}

/** Takes `amount` off a locked batch (refused if it holds less); deletes it at 0. */
async function decrease(tx: Tx, batch: Batch, amount: string): Promise<Batch | null> {
  // The row is locked, so comparing first and writing second is safe; compared in SQL, not as floats
  const cmp = (await one<{ c: number }>(tx, sql`SELECT sign(${batch.quantity}::numeric - ${amount}::numeric)::int AS c`))!.c;
  if (cmp < 0) throw new StockError('insufficient');
  if (cmp === 0) {
    // Deleted right away: an update to 0 would violate quantity > 0
    await tx.execute(sql`DELETE FROM app.stock_batch WHERE id = ${batch.id}`);
    return null;
  }
  return (await one<Batch>(tx, sql`
    UPDATE app.stock_batch SET quantity = quantity - ${amount}::numeric, updated_at = now()
    WHERE id = ${batch.id} RETURNING ${BATCH_COLUMNS}`))!;
}

async function journal(tx: Tx, actor: Actor, action: JournalAction, key: BatchKey, delta: string, groupId: string | null = null) {
  return (await one<JournalEntry>(tx, sql`
    INSERT INTO app.stock_journal (guild_id, owner_user_id, designation, kind, resource_uuid, item_uuid, location_uuid, state, quality,
      action, group_id, actor_user_id, delta)
    VALUES (${keyValues(key)}, ${action}, ${groupId}, ${actor.userId}, ${delta}::numeric)
    RETURNING ${JOURNAL_COLUMNS}`))!;
}

/** The history row of an operation on a batch key (the material is the target). */
async function history(tx: Tx, actor: Actor, category: HistoryCategory, action: string, key: BatchKey, details: HistoryDetails,
  to?: BatchKey) {
  await recordHistory(tx, {
    source: actor.source, category, action, actorUserId: actor.userId, ownerUserId: key.ownerUserId,
    toOwnerUserId: to && to.ownerUserId !== key.ownerUserId ? to.ownerUserId : null, guildId: key.guildId ?? to?.guildId ?? null,
    targetKind: key.kind, targetUuid: key.resourceUuid ?? key.itemUuid!,
    details: { quality: key.quality, locationUuid: key.locationUuid, designation: key.designation, ...details },
  });
}

// A refinery job's batch is in the refinery category, everything else is stock
const categoryOf = (key: BatchKey): HistoryCategory => (key.state === 'refining' ? 'refinery' : 'stock');

const keyOf = ({ id: _id, quantity: _q, ...key }: Batch): BatchKey => key;
const negate = (amount: string) => `-${amount}`;
const sameKey = (a: BatchKey, b: BatchKey) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export interface AddInput {
  kind: SubjectKind;
  uuid: string;
  locationUuid: string;
  quality: number;
  // As typed by the user
  amount: string;
  // Org stock of actor.guildId instead of personal stock
  org?: boolean;
  // Org stock only: who holds it (default: the actor; others only for officers)
  holderUserId?: string;
}

/** Books new stock (ores only via refineStart). */
export async function add(db: Db, actor: Actor, input: AddInput): Promise<StockResult> {
  const amount = parse(input.amount, input.kind);
  checkQuality(input.quality);
  return db.transaction(async (tx) => {
    await ensureUser(tx, actor.userId);
    const subject = await subjectInfo(tx, input.kind, input.uuid);
    if (subject.isOre) throw new StockError('oreViaRefinery');
    await checkLocation(tx, input.locationUuid);
    const holder = input.holderUserId ?? actor.userId;
    if (holder !== actor.userId && !(input.org && actor.officer)) throw new StockError('notAllowed');
    if (input.org) {
      if (!actor.guildId) throw new StockError('notAllowed');
      await checkHolder(tx, actor.guildId, holder);
    }
    const key: BatchKey = {
      guildId: input.org ? actor.guildId : null, ownerUserId: holder, designation: input.org ? 'org' : 'personal',
      kind: input.kind, resourceUuid: input.kind === 'resource' ? input.uuid : null, itemUuid: input.kind === 'item' ? input.uuid : null,
      locationUuid: input.locationUuid, state: 'stored', quality: input.quality,
    };
    const batch = await upsert(tx, key, amount);
    await history(tx, actor, 'stock', 'add', key, { amount });
    return { journal: [await journal(tx, actor, 'add', key, amount)], batch };
  });
}

// Longest refinery job accepted (the community values give about 19 h per SCU for the slowest method)
const MAX_REFINE_SECONDS = 365 * 24 * 3600;

export interface RefineStartInput {
  oreUuid: string;
  locationUuid: string;
  quality: number;
  amount: string;
  // ext.refining_method code
  method?: string;
  // Estimates (the user may have taken them from the terminal): processing time and refined SCU
  durationSeconds?: number;
  expectedYield?: string;
}

/**
 * Ore delivered to a refinery: a personal batch in state `refining`. Every job is a batch of its own
 * (the start time is part of the merge key), with its method, end and expected yield if given.
 */
export async function refineStart(db: Db, actor: Actor, input: RefineStartInput) {
  const amount = parse(input.amount, 'resource');
  checkQuality(input.quality);
  const expected = input.expectedYield === undefined ? null : parse(input.expectedYield, 'resource');
  const seconds = input.durationSeconds ?? null;
  if (seconds !== null && (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_REFINE_SECONDS)) throw new StockError('invalidDuration');
  return db.transaction(async (tx): Promise<StockResult> => {
    await ensureUser(tx, actor.userId);
    const subject = await subjectInfo(tx, 'resource', input.oreUuid);
    if (!subject.isOre) throw new StockError('notOre');
    await checkLocation(tx, input.locationUuid);
    // Refineries per UEX; without UEX data yet every selectable location
    const refineries = await refineryLocations(db);
    if (refineries && !refineries.has(input.locationUuid)) throw new StockError('notRefinery');
    const method = input.method ?? null;
    if (method !== null && !(await one(tx, sql`SELECT 1 FROM ext.refining_method WHERE code = ${method}`))) throw new StockError('unknownMethod');
    const key: BatchKey = {
      guildId: null, ownerUserId: actor.userId, designation: 'personal', kind: 'resource', resourceUuid: input.oreUuid, itemUuid: null,
      locationUuid: input.locationUuid, state: 'refining', quality: input.quality,
    };
    const batch = (await one<Batch>(tx, sql`
      INSERT INTO app.stock_batch (guild_id, owner_user_id, designation, kind, resource_uuid, item_uuid, location_uuid, state, quality, quantity,
        refine_method, refine_started_at, refine_ends_at, refine_expected)
      VALUES (${keyValues(key)}, ${amount}::numeric, ${method}, now(),
        now() + ${seconds}::int * interval '1 second', ${expected}::numeric)
      RETURNING ${BATCH_COLUMNS}`))!;
    await history(tx, actor, 'refinery', 'start', key, { amount, method, durationSeconds: seconds, expectedYield: expected });
    return { journal: [await journal(tx, actor, 'add', key, amount)], batch };
  });
}

/** Refinery job done: the whole ore batch is consumed, the refined resource is stored at the same location. */
export async function refineDone(db: Db, actor: Actor, input: { batchId: number; amount: string; quality: number; expected?: string }) {
  const amount = parse(input.amount, 'resource');
  checkQuality(input.quality);
  return db.transaction(async (tx): Promise<StockResult> => {
    const ore = await lockBatch(tx, input.batchId, input.expected);
    checkMayChange(actor, ore);
    if (ore.state !== 'refining') throw new StockError('notRefining');
    const refined = await one<{ uuid: string | null }>(tx, sql`SELECT refined_uuid AS uuid FROM catalog.resource WHERE uuid = ${ore.resourceUuid}`);
    if (!refined?.uuid) throw new StockError('notBookable');
    const group = randomUUID();
    const out = await journal(tx, actor, 'refine_out', keyOf(ore), negate(ore.quantity), group);
    await decrease(tx, ore, ore.quantity);
    const key: BatchKey = { ...keyOf(ore), resourceUuid: refined.uuid, state: 'stored', quality: input.quality };
    const batch = await upsert(tx, key, amount);
    await history(tx, actor, 'refinery', 'done', key, { amount, oreUuid: ore.resourceUuid!, oreAmount: ore.quantity, oreQuality: ore.quality });
    return { journal: [out, await journal(tx, actor, 'refine_in', key, amount, group)], batch };
  });
}

/** Takes an amount (null: everything) off a batch. */
export async function remove(db: Db, actor: Actor, input: { batchId: number; amount: string | null; expected?: string }) {
  return db.transaction(async (tx): Promise<StockResult> => {
    const batch = await lockBatch(tx, input.batchId, input.expected);
    checkMayChange(actor, batch);
    const amount = input.amount === null ? batch.quantity : parse(input.amount, batch.kind);
    const left = await decrease(tx, batch, amount);
    await history(tx, actor, categoryOf(batch), 'remove', keyOf(batch), { amount });
    return { journal: [await journal(tx, actor, 'remove', keyOf(batch), negate(amount))], batch: left };
  });
}

/** Sets a batch to a counted amount ("0" empties it). */
export async function adjust(db: Db, actor: Actor, input: { batchId: number; amount: string; expected?: string }) {
  return db.transaction(async (tx): Promise<StockResult> => {
    const batch = await lockBatch(tx, input.batchId, input.expected);
    checkMayChange(actor, batch);
    const target = /^\s*0+(?:[.,]0+)?\s*$/.test(input.amount) ? '0' : parse(input.amount, batch.kind);
    const delta = (await one<{ d: string }>(tx, sql`SELECT (${target}::numeric - ${batch.quantity}::numeric)::text AS d`))!.d;
    if (Number(delta) === 0) throw new StockError('noChange');
    let left: Batch | null = null;
    if (target === '0') await tx.execute(sql`DELETE FROM app.stock_batch WHERE id = ${batch.id}`);
    else left = await one<Batch>(tx, sql`UPDATE app.stock_batch SET quantity = ${target}::numeric, updated_at = now() WHERE id = ${batch.id} RETURNING ${BATCH_COLUMNS}`);
    await history(tx, actor, categoryOf(batch), 'adjust', keyOf(batch), { amount: target, from: batch.quantity });
    return { journal: [await journal(tx, actor, 'adjust', keyOf(batch), delta)], batch: left };
  });
}

export interface MoveInput {
  batchId: number;
  // null: everything
  amount: string | null;
  expected?: string;
  toLocationUuid?: string;
  // true: becomes org stock of actor.guildId (donation); false: becomes personal stock of the holder
  toOrg?: boolean;
  // New holder (org) or owner (org stock handed out as personal stock); not for personal → personal
  toHolderUserId?: string;
}

/** Changes location, holder or personal/org of an amount of a batch (refinery jobs stay where they are). */
export async function move(db: Db, actor: Actor, input: MoveInput) {
  return db.transaction(async (tx): Promise<StockResult> => {
    const batch = await lockBatch(tx, input.batchId, input.expected);
    if (batch.state === 'refining') throw new StockError('refiningFixed');
    checkMayChange(actor, batch);
    const toOrg = input.toOrg ?? batch.designation === 'org';
    const location = input.toLocationUuid ?? batch.locationUuid;
    if (location !== batch.locationUuid) await checkLocation(tx, location);

    let target: BatchKey;
    if (toOrg) {
      const guildId = batch.designation === 'org' ? batch.guildId : actor.guildId;
      if (!guildId) throw new StockError('notAllowed');
      const holder = input.toHolderUserId ?? (batch.designation === 'org' ? batch.ownerUserId : actor.userId);
      // Members donate as holders themselves; other holders only for officers
      if (holder !== actor.userId && !actor.officer) throw new StockError('notAllowed');
      if (holder !== batch.ownerUserId || guildId !== batch.guildId) await checkHolder(tx, guildId, holder);
      target = { ...keyOf(batch), guildId, ownerUserId: holder, designation: 'org', locationUuid: location };
    } else {
      // Personal stock stays with its owner (no gifts); org stock goes to its holder or another member
      const owner = batch.designation === 'personal' ? batch.ownerUserId : (input.toHolderUserId ?? batch.ownerUserId);
      if (input.toHolderUserId && input.toHolderUserId !== owner) throw new StockError('notAllowed');
      if (batch.designation === 'org' && owner !== batch.ownerUserId) await checkHolder(tx, batch.guildId!, owner);
      target = { ...keyOf(batch), guildId: null, ownerUserId: owner, designation: 'personal', locationUuid: location };
    }
    if (sameKey(target, keyOf(batch))) throw new StockError('nothingToMove');

    const amount = input.amount === null ? batch.quantity : parse(input.amount, batch.kind);
    const group = randomUUID();
    const out = await journal(tx, actor, 'move_out', keyOf(batch), negate(amount), group);
    await decrease(tx, batch, amount);
    const moved = await upsert(tx, target, amount);
    await history(tx, actor, 'stock', 'move', keyOf(batch), { amount, toLocationUuid: target.locationUuid, toDesignation: target.designation }, target);
    return { journal: [out, await journal(tx, actor, 'move_in', target, amount, group)], batch: moved };
  });
}

