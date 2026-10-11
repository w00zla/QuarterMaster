// Stock service: the only module that writes app.stock_batch and app.stock_journal.
// Shared by the bot and (later) the web UI. Every operation runs in one transaction: batch
// rows and their journal rows land together or not at all. Source batches are locked
// (SELECT … FOR UPDATE) and overdraw is checked in SQL, so concurrent bookings cannot
// take the same units twice.
//
// Who may do what (see docs/requirements.md "Stock"): every batch belongs to one user, and only
// that user changes it: add, remove, adjust, move, split, merge, share, give, from anywhere (also without any
// org). Sharing offers the whole batch in any number of the owner's orgs (app.stock_share); a split-off
// part (its own `lot`) can be shared apart. Giving hands it to an active member of the actor's org, who
// gets it unshared. Refinery jobs are never shared; their result can be afterwards.
// Every operation also writes one row of the users' history (src/history/record.ts), with the
// actor's source (bot, web app, companion app).
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.ts';
import { one, rows } from '../db/query.ts';
import { refineryLocations } from '../ext/refineries.ts';
import { recordHistory, type HistoryCategory, type HistoryDetails, type Source } from '../history/record.ts';
import { formatAmount, parseAmount, type SubjectKind } from './amount.ts';

export type StockState = 'stored' | 'refining';
export type JournalAction = 'add' | 'remove' | 'adjust' | 'move_out' | 'move_in' | 'refine_out' | 'refine_in';

export interface Actor {
  userId: string;
  // The org the action happens in (sharing into it, giving to its members); null outside any org
  guildId: string | null;
  // Where the action comes from (kept in the history)
  source: Source;
}

export interface Batch {
  id: number;
  ownerUserId: string;
  kind: SubjectKind;
  resourceUuid: string | null;
  itemUuid: string | null;
  locationUuid: string;
  state: StockState;
  quality: number;
  // NUMERIC text as Postgres returns it ("12.500000")
  quantity: string;
  // A split-off part (UUID), else null
  lot: string | null;
}

type BatchKey = Omit<Batch, 'id' | 'quantity'>;

export interface JournalEntry extends Omit<BatchKey, 'lot'> {
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
  | 'notAllowed' | 'unknownSubject' | 'notBookable' | 'unknownLocation' | 'notRefinery' | 'invalidDuration' | 'retired'
  | 'invalidAmount' | 'invalidQuality' | 'batchNotFound' | 'batchChanged' | 'insufficient' | 'holderNotMember'
  | 'notRefining' | 'refiningFixed' | 'nothingToMove' | 'noChange' | 'sharedSplit';

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

const BATCH_COLUMNS = sql.raw(`id::int AS id, owner_user_id AS "ownerUserId", kind,
  resource_uuid AS "resourceUuid", item_uuid AS "itemUuid", location_uuid AS "locationUuid", state, quality, quantity::text AS quantity, lot`);

const JOURNAL_COLUMNS = sql.raw(`id::int AS id, group_id AS "groupId", action, actor_user_id AS "actorUserId",
  owner_user_id AS "ownerUserId", kind, resource_uuid AS "resourceUuid", item_uuid AS "itemUuid",
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
  retired: boolean;
  // Used in a recipe (ores never are: they are not booked at all)
  bookable: boolean;
}

async function subjectInfo(tx: Tx, kind: SubjectKind, uuid: string): Promise<SubjectInfo> {
  if (!UUID.test(uuid)) throw new StockError('unknownSubject');
  const info = kind === 'resource'
    ? await one<SubjectInfo>(tx, sql`
        SELECT r.retired_at IS NOT NULL AS retired,
          EXISTS (SELECT 1 FROM catalog.blueprint_input bi WHERE bi.resource_uuid = r.uuid) AS bookable
        FROM catalog.resource r WHERE r.uuid = ${uuid}`)
    : await one<SubjectInfo>(tx, sql`
        SELECT i.retired_at IS NOT NULL AS retired,
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

/** Who may change an existing batch (remove, move, adjust, refinery completion): its owner only. */
function checkMayChange(actor: Actor, batch: Batch) {
  if (batch.ownerUserId !== actor.userId) throw new StockError('notAllowed');
}

/**
 * Locks the batch of the actor; `expected` is the quantity the user saw when confirming.
 * The owner is checked first: a stranger's batch must not answer with its quantity or state.
 */
async function lockBatch(tx: Tx, actor: Actor, id: number, expected?: string): Promise<Batch> {
  const batch = await one<Batch>(tx, sql`SELECT ${BATCH_COLUMNS} FROM app.stock_batch WHERE id = ${id} FOR UPDATE`);
  if (!batch) throw new StockError('batchNotFound');
  checkMayChange(actor, batch);
  if (expected !== undefined && formatAmount(expected) !== formatAmount(batch.quantity)) throw new StockError('batchChanged');
  return batch;
}

const keyValues = (k: Omit<BatchKey, 'lot'>): SQL => sql`${k.ownerUserId}, ${k.kind}, ${k.resourceUuid}, ${k.itemUuid},
  ${k.locationUuid}, ${k.state}, ${k.quality}`;

/** Adds to the batch with this key (merge) or creates it; `created` = a new batch. */
async function upsert(tx: Tx, key: BatchKey, quantity: string): Promise<Batch & { created: boolean }> {
  try {
    return (await one<Batch & { created: boolean }>(tx, sql`
      INSERT INTO app.stock_batch (owner_user_id, kind, resource_uuid, item_uuid, location_uuid, state, quality, lot, quantity)
      VALUES (${keyValues(key)}, ${key.lot}::uuid, ${quantity}::numeric)
      ON CONFLICT ON CONSTRAINT stock_batch_merge_key
      DO UPDATE SET quantity = app.stock_batch.quantity + excluded.quantity, updated_at = now()
      RETURNING ${BATCH_COLUMNS}, xmax = 0 AS created`))!;
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
    INSERT INTO app.stock_journal (owner_user_id, kind, resource_uuid, item_uuid, location_uuid, state, quality,
      action, group_id, actor_user_id, delta)
    VALUES (${keyValues(key)}, ${action}, ${groupId}, ${actor.userId}, ${delta}::numeric)
    RETURNING ${JOURNAL_COLUMNS}`))!;
}

/**
 * The history row of an operation on a batch key (the material is the target). `guildId`: the org
 * involved (sharing, taking back, the org a give happened in).
 */
async function history(tx: Tx, actor: Actor, category: HistoryCategory, action: string, key: BatchKey, details: HistoryDetails,
  to?: BatchKey, guildId: string | null = null) {
  await recordHistory(tx, {
    source: actor.source, category, action, actorUserId: actor.userId, ownerUserId: key.ownerUserId,
    toOwnerUserId: to && to.ownerUserId !== key.ownerUserId ? to.ownerUserId : null,
    guildId,
    targetKind: key.kind, targetUuid: key.resourceUuid ?? key.itemUuid!,
    details: { quality: key.quality, locationUuid: key.locationUuid, ...details },
  });
}

/** `details.sharedIn` of a history row: the orgs the batch was shared in when it changed (nothing if none). */
const offered = (guildIds: string[]): HistoryDetails => (guildIds.length ? { sharedIn: guildIds } : {});

/** The orgs a batch is shared in. */
async function sharesOf(tx: Tx, batchId: number): Promise<string[]> {
  return (await rows<{ g: string }>(tx, sql`SELECT guild_id AS g FROM app.stock_share WHERE batch_id = ${batchId} ORDER BY guild_id`)).map((r) => r.g);
}

/** Shares a batch in these orgs (the ones it is in already stay). */
async function addShares(tx: Tx, batchId: number, guildIds: string[]) {
  for (const g of guildIds) await tx.execute(sql`INSERT INTO app.stock_share (batch_id, guild_id) VALUES (${batchId}, ${g}) ON CONFLICT DO NOTHING`);
}

// A refinery job's batch is in the refinery category, everything else is stock
const categoryOf = (key: BatchKey): HistoryCategory => (key.state === 'refining' ? 'refinery' : 'stock');

const keyOf = ({ id: _id, quantity: _q, ...key }: Batch & { created?: boolean }): BatchKey => {
  const { created: _c, ...rest } = key as BatchKey & { created?: boolean };
  return rest;
};
const negate = (amount: string) => `-${amount}`;
const sameKey = (a: BatchKey, b: BatchKey) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export interface AddInput {
  kind: SubjectKind;
  uuid: string;
  locationUuid: string;
  quality: number;
  // As typed by the user
  amount: string;
  // Shared in actor.guildId right away (the batch it lands in; one shared already stays shared)
  org?: boolean;
  // Also shared in these orgs right away (the owner an active member in each; same rule as `org`)
  shareIn?: string[];
}

/** Books new stock. */
export async function add(db: Db, actor: Actor, input: AddInput): Promise<StockResult> {
  const amount = parse(input.amount, input.kind);
  checkQuality(input.quality);
  return db.transaction(async (tx) => {
    await ensureUser(tx, actor.userId);
    await subjectInfo(tx, input.kind, input.uuid);
    await checkLocation(tx, input.locationUuid);
    if (input.org) {
      if (!actor.guildId) throw new StockError('notAllowed');
      await checkHolder(tx, actor.guildId, actor.userId);
    }
    const key: BatchKey = {
      ownerUserId: actor.userId, kind: input.kind, resourceUuid: input.kind === 'resource' ? input.uuid : null,
      itemUuid: input.kind === 'item' ? input.uuid : null, locationUuid: input.locationUuid, state: 'stored', quality: input.quality, lot: null,
    };
    const { created: _c, ...batch } = await upsert(tx, key, amount);
    // Added to a batch that is shared already: the orgs see their offer grow
    const shared = await sharesOf(tx, batch.id);
    await history(tx, actor, 'stock', 'add', key, { amount, batchAmount: batch.quantity, ...offered(shared) });
    if (input.org) {
      await addShares(tx, batch.id, [actor.guildId!]);
      await history(tx, actor, 'stock', 'share', key, { amount: batch.quantity }, undefined, actor.guildId);
    }
    for (const g of new Set(input.shareIn ?? [])) {
      if (shared.includes(g) || (input.org && g === actor.guildId)) continue;
      await checkHolder(tx, g, actor.userId);
      await addShares(tx, batch.id, [g]);
      await history(tx, actor, 'stock', 'share', key, { amount: batch.quantity }, undefined, g);
    }
    return { journal: [await journal(tx, actor, 'add', key, amount)], batch };
  });
}

// Longest refinery job accepted
const MAX_REFINE_SECONDS = 365 * 24 * 3600;
// Rows per work order (the terminal lists a ship's whole load)
export const MAX_REFINE_ROWS = 30;

export interface RefineStartRow {
  // The refined material (ores are not booked)
  resourceUuid: string;
  quality: number;
  // The expected yield in SCU (the terminal's estimate)
  amount: string;
}

export interface RefineStartInput {
  locationUuid: string;
  // Estimate for the whole work order: processing time
  durationSeconds?: number;
  rows: RefineStartRow[];
}

export interface RefineJobResult {
  jobId: string;
  journal: JournalEntry[];
  batches: Batch[];
}

/**
 * A work order at a refinery: one personal batch in state `refining` per row (a refined material with
 * its expected yield), all sharing a new job ID (part of the merge key: rows of the same material and
 * quality within the job add up, other jobs stay apart), the start and the end. It is not stock yet
 * (a game patch may still take it): only refineDone stores it.
 */
export async function refineStart(db: Db, actor: Actor, input: RefineStartInput): Promise<RefineJobResult> {
  if (!input.rows.length || input.rows.length > MAX_REFINE_ROWS) throw new StockError('invalidAmount');
  const materials = input.rows.map((r) => {
    checkQuality(r.quality);
    return { ...r, amount: parse(r.amount, 'resource') };
  });
  const seconds = input.durationSeconds ?? null;
  if (seconds !== null && (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_REFINE_SECONDS)) throw new StockError('invalidDuration');
  return db.transaction(async (tx) => {
    await ensureUser(tx, actor.userId);
    await checkLocation(tx, input.locationUuid);
    // Refineries per UEX; without UEX data yet every selectable location
    const refineries = await refineryLocations(db);
    if (refineries && !refineries.has(input.locationUuid)) throw new StockError('notRefinery');
    const jobId = randomUUID();
    const started = (await one<{ now: string }>(tx, sql`SELECT now()::text AS now`))!.now;
    const result: RefineJobResult = { jobId, journal: [], batches: [] };
    for (const row of materials) {
      await subjectInfo(tx, 'resource', row.resourceUuid);
      const key: BatchKey = {
        ownerUserId: actor.userId, kind: 'resource', resourceUuid: row.resourceUuid, itemUuid: null,
        locationUuid: input.locationUuid, state: 'refining', quality: row.quality, lot: null,
      };
      const batch = (await one<Batch>(tx, sql`
        INSERT INTO app.stock_batch (owner_user_id, kind, resource_uuid, item_uuid, location_uuid, state, quality, quantity,
          refine_job, refine_started_at, refine_ends_at)
        VALUES (${keyValues(key)}, ${row.amount}::numeric, ${jobId}, ${started}::timestamptz,
          ${started}::timestamptz + ${seconds}::int * interval '1 second')
        ON CONFLICT ON CONSTRAINT stock_batch_merge_key
        DO UPDATE SET quantity = app.stock_batch.quantity + excluded.quantity
        RETURNING ${BATCH_COLUMNS}`))!;
      await history(tx, actor, 'refinery', 'start', key, { amount: row.amount, durationSeconds: seconds, jobId });
      result.journal.push(await journal(tx, actor, 'add', key, row.amount));
      result.batches = [...result.batches.filter((b) => b.id !== batch.id), batch];
    }
    return result;
  });
}

/** A refined amount: like any amount, but 0 is allowed (nothing came out). */
function parseYield(text: string): string {
  return /^\s*0+(?:[.,]0+)?\s*$/.test(text) ? '0' : parse(text, 'resource');
}

export interface RefineDoneRow {
  batchId: number;
  // Refined SCU as the game hands it out ("0": nothing came out)
  amount: string;
  // The expected yield the user saw (the batch's quantity)
  expected?: string;
}

/**
 * Locks every batch of a job; the request must name exactly these (a changed job is refused, not half
 * finished or half removed).
 */
async function lockJob(tx: Tx, actor: Actor, jobId: string, wanted: { batchId: number; expected?: string }[]): Promise<Batch[]> {
  if (!UUID.test(jobId)) throw new StockError('batchNotFound');
  const ids = (await rows<{ id: number }>(tx, sql`
    SELECT id::int AS id FROM app.stock_batch WHERE refine_job = ${jobId} ORDER BY id FOR UPDATE`)).map((r) => r.id);
  if (!ids.length) throw new StockError('batchNotFound');
  const asked = new Set(wanted.map((r) => r.batchId));
  if (asked.size !== wanted.length || asked.size !== ids.length || !ids.every((id) => asked.has(id))) throw new StockError('batchChanged');
  const batches: Batch[] = [];
  for (const row of wanted) {
    const batch = await lockBatch(tx, actor, row.batchId, row.expected);
    if (batch.state !== 'refining') throw new StockError('notRefining');
    batches.push(batch);
  }
  return batches;
}

/**
 * Work order done: every batch of the job (the game hands out the whole order) is stored at the same
 * place in its quality with the amount that came out (expected or not). One journal group per job.
 */
export async function refineDone(db: Db, actor: Actor, input: { jobId: string; rows: RefineDoneRow[] }): Promise<RefineJobResult> {
  const amounts = input.rows.map((r) => parseYield(r.amount));
  return db.transaction(async (tx) => {
    const batches = await lockJob(tx, actor, input.jobId, input.rows);
    const group = randomUUID();
    const result: RefineJobResult = { jobId: input.jobId, journal: [], batches: [] };
    for (const [i, job] of batches.entries()) {
      const amount = amounts[i]!;
      result.journal.push(await journal(tx, actor, 'refine_out', keyOf(job), negate(job.quantity), group));
      await decrease(tx, job, job.quantity);
      const key: BatchKey = { ...keyOf(job), state: 'stored' };
      if (amount !== '0') {
        const { created: _c, ...stored } = await upsert(tx, key, amount);
        result.batches.push(stored);
        result.journal.push(await journal(tx, actor, 'refine_in', key, amount, group));
      }
      await history(tx, actor, 'refinery', 'done', key, { amount, expectedYield: job.quantity, jobId: input.jobId });
    }
    return result;
  });
}

/** A work order that will not come out (cancelled, lost to a game patch): every batch of the job goes. */
export async function refineRemove(db: Db, actor: Actor, input: { jobId: string; rows: { batchId: number; expected?: string }[] }): Promise<RefineJobResult> {
  return db.transaction(async (tx) => {
    const batches = await lockJob(tx, actor, input.jobId, input.rows);
    const result: RefineJobResult = { jobId: input.jobId, journal: [], batches: [] };
    for (const job of batches) {
      await decrease(tx, job, job.quantity);
      await history(tx, actor, 'refinery', 'remove', keyOf(job), { amount: job.quantity, batchAmount: '0', jobId: input.jobId });
      result.journal.push(await journal(tx, actor, 'remove', keyOf(job), negate(job.quantity)));
    }
    return result;
  });
}

/**
 * Sets the time a running work order still needs, e.g. read off the terminal later: end = now + seconds
 * for all its batches; null clears the end. An estimate of the job, no stock change: no journal, no history.
 */
export async function refineSetDuration(db: Db, actor: Actor, input: { jobId: string; durationSeconds: number | null }): Promise<{ endsAt: string | null }> {
  if (!UUID.test(input.jobId)) throw new StockError('batchNotFound');
  const seconds = input.durationSeconds;
  if (seconds !== null && (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_REFINE_SECONDS)) throw new StockError('invalidDuration');
  return db.transaction(async (tx) => {
    const batches = await rows<Batch>(tx, sql`SELECT ${BATCH_COLUMNS} FROM app.stock_batch WHERE refine_job = ${input.jobId} ORDER BY id FOR UPDATE`);
    if (!batches.length) throw new StockError('batchNotFound');
    for (const b of batches) checkMayChange(actor, b);
    // The new end as ISO text (null: cleared), the same for every batch of the job
    return (await one<{ endsAt: string | null }>(tx, sql`
      WITH changed AS (
        UPDATE app.stock_batch SET refine_ends_at = now() + ${seconds}::int * interval '1 second', updated_at = now()
        WHERE refine_job = ${input.jobId} RETURNING refine_ends_at)
      SELECT to_json(max(refine_ends_at))#>>'{}' AS "endsAt" FROM changed`))!;
  });
}

/** Takes an amount (null: everything) off a batch. */
export async function remove(db: Db, actor: Actor, input: { batchId: number; amount: string | null; expected?: string }) {
  return db.transaction(async (tx): Promise<StockResult> => {
    const batch = await lockBatch(tx, actor, input.batchId, input.expected);
    const amount = input.amount === null ? batch.quantity : parse(input.amount, batch.kind);
    // Before the decrease: an emptied batch takes its shares along
    const sharedIn = await sharesOf(tx, batch.id);
    const left = await decrease(tx, batch, amount);
    await history(tx, actor, categoryOf(batch), 'remove', keyOf(batch), { amount, batchAmount: left?.quantity ?? '0', ...offered(sharedIn) });
    return { journal: [await journal(tx, actor, 'remove', keyOf(batch), negate(amount))], batch: left };
  });
}

/** Sets a batch to a counted amount ("0" empties it). */
export async function adjust(db: Db, actor: Actor, input: { batchId: number; amount: string; expected?: string }) {
  return db.transaction(async (tx): Promise<StockResult> => {
    const batch = await lockBatch(tx, actor, input.batchId, input.expected);
    const target = /^\s*0+(?:[.,]0+)?\s*$/.test(input.amount) ? '0' : parse(input.amount, batch.kind);
    const delta = (await one<{ d: string }>(tx, sql`SELECT (${target}::numeric - ${batch.quantity}::numeric)::text AS d`))!.d;
    if (Number(delta) === 0) throw new StockError('noChange');
    const sharedIn = await sharesOf(tx, batch.id);
    let left: Batch | null = null;
    if (target === '0') await tx.execute(sql`DELETE FROM app.stock_batch WHERE id = ${batch.id}`);
    else left = await one<Batch>(tx, sql`UPDATE app.stock_batch SET quantity = ${target}::numeric, updated_at = now() WHERE id = ${batch.id} RETURNING ${BATCH_COLUMNS}`);
    await history(tx, actor, categoryOf(batch), 'adjust', keyOf(batch), { amount: target, from: batch.quantity, ...offered(sharedIn) });
    return { journal: [await journal(tx, actor, 'adjust', keyOf(batch), delta)], batch: left };
  });
}

export interface MoveInput {
  batchId: number;
  // null: everything
  amount: string | null;
  expected?: string;
  toLocationUuid?: string;
  // Give it to this user (an active member of actor.guildId): it becomes theirs, unshared. The
  // actor themselves or omitted: stays theirs
  toOwnerUserId?: string;
}

/**
 * Changes the location or the owner of an amount of a batch (refinery jobs stay where they are). A
 * part that makes a new batch takes the batch's shares along; one that lands in an existing batch takes
 * that one's. A give lands unshared in the recipient's stock.
 */
export async function move(db: Db, actor: Actor, input: MoveInput) {
  return db.transaction(async (tx): Promise<StockResult> => {
    const batch = await lockBatch(tx, actor, input.batchId, input.expected);
    if (batch.state === 'refining') throw new StockError('refiningFixed');
    const location = input.toLocationUuid ?? batch.locationUuid;
    if (location !== batch.locationUuid) await checkLocation(tx, location);

    const owner = input.toOwnerUserId ?? actor.userId;
    const give = owner !== actor.userId;
    if (give) {
      // To an active member of the org it happens in
      if (!actor.guildId) throw new StockError('notAllowed');
      await checkHolder(tx, actor.guildId, owner);
      await ensureUser(tx, owner);
    }
    // A give lands in the recipient's main stock; a split-off part stays one when moved
    const target: BatchKey = { ...keyOf(batch), ownerUserId: owner, locationUuid: location, lot: give ? null : batch.lot };
    if (sameKey(target, keyOf(batch))) throw new StockError('nothingToMove');

    const amount = input.amount === null ? batch.quantity : parse(input.amount, batch.kind);
    const sharedIn = await sharesOf(tx, batch.id);
    const shares = give ? [] : sharedIn;
    const group = randomUUID();
    const out = await journal(tx, actor, 'move_out', keyOf(batch), negate(amount), group);
    await decrease(tx, batch, amount);
    const { created, ...moved } = await upsert(tx, target, amount);
    if (created) await addShares(tx, moved.id, shares);
    await history(tx, actor, 'stock', give ? 'give' : 'move', keyOf(batch), { amount, toLocationUuid: target.locationUuid, ...offered(sharedIn) }, target,
      give ? actor.guildId : null);
    return { journal: [out, await journal(tx, actor, 'move_in', target, amount, group)], batch: moved };
  });
}

/** Splits an amount off an unshared batch into a batch of its own (a new lot), e.g. to share it apart. */
export async function split(db: Db, actor: Actor, input: { batchId: number; amount: string; expected?: string }) {
  return db.transaction(async (tx): Promise<StockResult> => {
    const batch = await lockBatch(tx, actor, input.batchId, input.expected);
    if (batch.state === 'refining') throw new StockError('refiningFixed');
    if ((await sharesOf(tx, batch.id)).length) throw new StockError('sharedSplit');
    const amount = parse(input.amount, batch.kind);
    // Splitting off everything would leave the same batch under another name
    if ((await one<{ c: number }>(tx, sql`SELECT sign(${batch.quantity}::numeric - ${amount}::numeric)::int AS c`))!.c === 0) {
      throw new StockError('nothingToMove');
    }
    const target: BatchKey = { ...keyOf(batch), lot: randomUUID() };
    const group = randomUUID();
    const out = await journal(tx, actor, 'move_out', keyOf(batch), negate(amount), group);
    await decrease(tx, batch, amount);
    const { created: _c, ...part } = await upsert(tx, target, amount);
    await history(tx, actor, 'stock', 'split', keyOf(batch), { amount });
    return { journal: [out, await journal(tx, actor, 'move_in', target, amount, group)], batch: part };
  });
}

/**
 * Merges a split-off part back into the main batch of its kind (same material, quality, place; created
 * if it is gone, then with the part's shares). The main batch keeps its own shares.
 */
export async function merge(db: Db, actor: Actor, input: { batchId: number; expected?: string }) {
  return db.transaction(async (tx): Promise<StockResult> => {
    const batch = await lockBatch(tx, actor, input.batchId, input.expected);
    if (!batch.lot) throw new StockError('nothingToMove');
    const shares = await sharesOf(tx, batch.id);
    const target: BatchKey = { ...keyOf(batch), lot: null };
    const group = randomUUID();
    const out = await journal(tx, actor, 'move_out', keyOf(batch), negate(batch.quantity), group);
    await decrease(tx, batch, batch.quantity);
    const { created, ...main } = await upsert(tx, target, batch.quantity);
    if (created) await addShares(tx, main.id, shares);
    await history(tx, actor, 'stock', 'merge', keyOf(batch), { amount: batch.quantity, ...offered(shares) });
    return { journal: [out, await journal(tx, actor, 'move_in', target, batch.quantity, group)], batch: main };
  });
}

/**
 * Sets the orgs a batch is shared in (the whole batch). New ones need the owner as an active member
 * there; taking one back always works. One history row per org shared or taken back.
 */
export async function share(db: Db, actor: Actor, input: { batchId: number; guildIds: string[] }) {
  return db.transaction(async (tx): Promise<{ batch: Batch; guildIds: string[] }> => {
    const batch = await lockBatch(tx, actor, input.batchId);
    if (batch.state === 'refining') throw new StockError('refiningFixed');
    const before = await sharesOf(tx, batch.id);
    const wanted = [...new Set(input.guildIds)].sort();
    const added = wanted.filter((g) => !before.includes(g));
    const removed = before.filter((g) => !wanted.includes(g));
    if (!added.length && !removed.length) throw new StockError('noChange');
    for (const g of added) await checkHolder(tx, g, actor.userId);
    await addShares(tx, batch.id, added);
    for (const g of removed) await tx.execute(sql`DELETE FROM app.stock_share WHERE batch_id = ${batch.id} AND guild_id = ${g}`);
    for (const g of added) await history(tx, actor, 'stock', 'share', keyOf(batch), { amount: batch.quantity }, undefined, g);
    for (const g of removed) await history(tx, actor, 'stock', 'unshare', keyOf(batch), { amount: batch.quantity }, undefined, g);
    return { batch, guildIds: wanted };
  });
}
