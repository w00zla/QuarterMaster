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
import { COMPONENT_TYPES, fpsTypeSql } from '../catalog/components.ts';
import type { Db, Tx } from '../db/client.ts';
import { one, rows } from '../db/query.ts';
import { recordHistory, type HistoryCategory, type HistoryDetails, type Source } from '../history/record.ts';
import type { ModifierRange } from '../planner/types.ts';
import { formatAmount, parseAmount, type SubjectKind } from './amount.ts';
import { statBounds, statValue, unionBounds, type StatBounds } from './component-stats.ts';

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
  // Ship components: their stats ({crafted property UUID: decimal text}), else null
  stats: Stats | null;
}

export type Stats = Record<string, string>;

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
  | 'notRefining' | 'refiningFixed' | 'nothingToMove' | 'noChange' | 'sharedSplit' | 'invalidStats';

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

// Places whose star map record lists the amenity "Commodity Trading - Freight Elevator" have a freight elevator,
// so a location inventory (catalog.location.has_freight_elevator, set by the extractor)
// Places with a freight elevator whose record lacks the amenity: the freight manager's Warehouse was opened
// there per Game.log (checked 2026-10-19); keys lower case. Nyx_Kaboos is hidden in the starmap.
const FREIGHT_ELEVATOR_KEYS = [
  'thecollectorasteroid_stanton1', 'thecollectorasteroid_stanton2', 'thecollectorasteroid_stanton4',
  'stanton1_junksite_reclamationanddisposalorinth', 'stanton2b_junksite_briosbreakeryard', 'stanton3b_junksite_samsonsonssalvagecenter',
  'nyx_kaboos', 'stanton4a_shubin_smca_6', 'stanton4a_shubin_smca_8', 'outpost_olp_stanton1b_vivere',
];

/**
 * Locations stock can be booked at (`l` = catalog.location): stations and landing zones, and every other
 * place with a freight elevator (by amenity or FREIGHT_ELEVATOR_KEYS), not hidden in the starmap (the
 * Onyx facilities are) unless listed; each with an English name; not jump points (types Anomaly,
 * PointOfInterest) and not unfinished objects ("WIP …", the game uses a no-break space there, so the word
 * boundary `\M` instead of a plain space).
 */
export const selectableLocationSql = (l = 'l') => sql.raw(`((NOT ${l}.hide_in_starmap AND (${l}.nav_icon IN ('Station', 'LandingZone')
    OR ${l}.has_freight_elevator)
    OR lower(${l}.key) IN (${FREIGHT_ELEVATOR_KEYS.map((k) => `'${k}'`).join(', ')}))
  AND coalesce(${l}.type, '') NOT IN ('Anomaly', 'PointOfInterest')
  AND EXISTS (SELECT 1 FROM catalog.localization_effective e WHERE e.lang = 'en' AND e.key = ${l}.name_key AND e.value !~ '^WIP\\M'))`);

/** Ship component groups among the blueprint categories (sizes stripped): their outputs are bookable as components. */
/** Whether item `x` is no blueprint's output (sorts after the crafted ones). */
const notCraftedSql = (x: string) => `NOT EXISTS (SELECT 1 FROM catalog.blueprint cb WHERE cb.output_item_uuid = ${x}.uuid AND cb.retired_at IS NULL)`;

/**
 * The item `uuid` (a column) is gear: a ship component (one of the COMPONENT_TYPES) or FPS gear (FPS_TYPES),
 * crafted or not. Of the items sharing a name, type, size and grade (the game's ship-bound, turret, low-poly
 * and derelict variants of one part: 414 of 1243 in 4.10; the AI and test variants of FPS weapons) only
 * one counts, the plain part: a blueprint's output first, else the shortest class name
 * ("KLWE_LaserRepeater_S5", not its "_Idris_M", "_LowPoly" or "_Turret"). Items without a name are left
 * as they are.
 */
export const componentItemSql = (uuid = 'i.uuid') => sql.raw(`EXISTS (SELECT 1 FROM catalog.item ci
  WHERE ci.uuid = ${uuid} AND (ci.type IN (${COMPONENT_TYPES.map((t) => `'${t}'`).join(', ')}) OR ${fpsTypeSql('ci')})
    AND (ci.name_key IS NULL OR NOT EXISTS (SELECT 1 FROM catalog.item o
      WHERE o.retired_at IS NULL AND o.uuid <> ci.uuid AND o.type = ci.type AND o.name_key = ci.name_key
        AND o.size IS NOT DISTINCT FROM ci.size AND o.grade_letter IS NOT DISTINCT FROM ci.grade_letter
        AND (${notCraftedSql('o')}, length(o.class_name), o.class_name) < (${notCraftedSql('ci')}, length(ci.class_name), ci.class_name))))`);

/** Components have no quality: every batch of one is stored with this one. */
export const COMPONENT_QUALITY = 0;

/**
 * The stats components can carry (`where`: a condition on catalog.item `i`), per item and crafted
 * property: what its blueprints' slots can make of it (component-stats.ts). Those are what the game
 * lists in a crafted component's tooltip; a stat nothing can change (a flat range) is left out.
 */
export async function componentStats(db: Db | Tx, where: SQL): Promise<Map<string, Map<string, StatBounds>>> {
  const found = await rows<{ item: string; blueprint: string; property: string; ranges: ModifierRange[] }>(db, sql`
    SELECT cb.output_item_uuid AS item, cb.uuid AS blueprint, lower(m->>'propertyUuid') AS property, m->'ranges' AS ranges
    FROM catalog.blueprint cb
    JOIN catalog.blueprint_slot s ON s.blueprint_uuid = cb.uuid
    CROSS JOIN LATERAL jsonb_array_elements(s.modifiers) m
    WHERE cb.retired_at IS NULL AND m->>'propertyUuid' IS NOT NULL
      AND cb.output_item_uuid IN (SELECT i.uuid FROM catalog.item i WHERE ${where} AND ${componentItemSql()})`);
  // item -> property -> blueprint -> the slots' ranges
  const grouped = new Map<string, Map<string, Map<string, ModifierRange[][]>>>();
  for (const r of found) {
    const byProperty = grouped.get(r.item) ?? new Map<string, Map<string, ModifierRange[][]>>();
    const byBlueprint = byProperty.get(r.property) ?? new Map<string, ModifierRange[][]>();
    byBlueprint.set(r.blueprint, [...(byBlueprint.get(r.blueprint) ?? []), Array.isArray(r.ranges) ? r.ranges : []]);
    byProperty.set(r.property, byBlueprint);
    grouped.set(r.item, byProperty);
  }
  const result = new Map<string, Map<string, StatBounds>>();
  for (const [item, byProperty] of grouped) {
    const stats = new Map<string, StatBounds>();
    for (const [property, byBlueprint] of byProperty) {
      const each = [...byBlueprint.values()].map(statBounds);
      const bounds = each.every((b) => b) ? unionBounds(each as StatBounds[]) : null;
      if (bounds) stats.set(property, bounds);
    }
    result.set(item, stats);
  }
  return result;
}

const BATCH_COLUMNS = sql.raw(`id::int AS id, owner_user_id AS "ownerUserId", kind,
  resource_uuid AS "resourceUuid", item_uuid AS "itemUuid", location_uuid AS "locationUuid", state, quality, quantity::text AS quantity, lot, stats`);

const JOURNAL_COLUMNS = sql.raw(`id::int AS id, group_id AS "groupId", action, actor_user_id AS "actorUserId",
  owner_user_id AS "ownerUserId", kind, resource_uuid AS "resourceUuid", item_uuid AS "itemUuid",
  location_uuid AS "locationUuid", state, quality, stats, delta::text AS delta`);

/**
 * A component's stats as stored: only stats its blueprints can improve, each within its bounds and
 * normalized (statValue), keys sorted (the merge key compares the JSON); empty values and no change ("0")
 * dropped, none at all = null (the same batch as a looted one).
 */
async function checkStats(tx: Tx, itemUuid: string, input: Record<string, string>): Promise<Stats | null> {
  const entries = Object.entries(input).map(([k, v]) => [k.toLowerCase(), v.trim()] as const).filter(([, v]) => v !== '');
  if (!entries.length) return null;
  const allowed = (await componentStats(tx, sql`i.uuid = ${itemUuid}`)).get(itemUuid) ?? new Map<string, StatBounds>();
  const stats: Stats = {};
  for (const [k, v] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const bounds = allowed.get(k);
    const value = bounds ? statValue(bounds, v) : null;
    if (value === null || k in stats) throw new StockError('invalidStats');
    if (value !== '0') stats[k] = value;
  }
  return Object.keys(stats).length ? stats : null;
}

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
  // Used in a recipe (ores never are: they are not booked at all), or a ship component
  bookable: boolean;
  component: boolean;
}

async function subjectInfo(tx: Tx, kind: SubjectKind, uuid: string): Promise<SubjectInfo> {
  if (!UUID.test(uuid)) throw new StockError('unknownSubject');
  const info = kind === 'resource'
    ? await one<SubjectInfo>(tx, sql`
        SELECT r.retired_at IS NOT NULL AS retired,
          EXISTS (SELECT 1 FROM catalog.blueprint_input bi WHERE bi.resource_uuid = r.uuid) AS bookable, false AS component
        FROM catalog.resource r WHERE r.uuid = ${uuid}`)
    : await one<SubjectInfo>(tx, sql`
        SELECT i.retired_at IS NOT NULL AS retired,
          (EXISTS (SELECT 1 FROM catalog.blueprint_input bi WHERE bi.item_uuid = i.uuid) OR ${componentItemSql()}) AS bookable,
          ${componentItemSql()} AS component
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

/**
 * The places with a refinery (catalog.location.has_refinery, not retired); null while none is flagged at all
 * (a database not imported from a v7 snapshot yet): then every selectable location counts as a refinery.
 */
export async function refineryLocations(db: Db | Tx): Promise<Set<string> | null> {
  const found = await rows<{ uuid: string }>(db, sql`SELECT uuid FROM catalog.location WHERE has_refinery AND retired_at IS NULL`);
  return found.length ? new Set(found.map((r) => r.uuid)) : null;
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
  ${k.locationUuid}, ${k.state}, ${k.quality}, ${k.stats ? JSON.stringify(k.stats) : null}::jsonb`;

/** Adds to the batch with this key (merge) or creates it; `created` = a new batch. */
async function upsert(tx: Tx, key: BatchKey, quantity: string): Promise<Batch & { created: boolean }> {
  try {
    return (await one<Batch & { created: boolean }>(tx, sql`
      INSERT INTO app.stock_batch (owner_user_id, kind, resource_uuid, item_uuid, location_uuid, state, quality, stats, lot, quantity)
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
    INSERT INTO app.stock_journal (owner_user_id, kind, resource_uuid, item_uuid, location_uuid, state, quality, stats,
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
    details: { quality: key.quality, ...(key.stats ? { stats: key.stats } : {}), locationUuid: key.locationUuid, ...details },
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
  // Ship components: stats as typed, {crafted property UUID: value}; empty values are left out
  stats?: Record<string, string>;
}

/** Books new stock. */
export async function add(db: Db, actor: Actor, input: AddInput): Promise<StockResult> {
  const amount = parse(input.amount, input.kind);
  checkQuality(input.quality);
  return db.transaction(async (tx) => {
    await ensureUser(tx, actor.userId);
    const subject = await subjectInfo(tx, input.kind, input.uuid);
    if (subject.component && input.quality !== COMPONENT_QUALITY) throw new StockError('invalidQuality');
    if (input.stats && Object.keys(input.stats).length && !subject.component) throw new StockError('invalidStats');
    const stats = subject.component && input.stats ? await checkStats(tx, input.uuid, input.stats) : null;
    await checkLocation(tx, input.locationUuid);
    if (input.org) {
      if (!actor.guildId) throw new StockError('notAllowed');
      await checkHolder(tx, actor.guildId, actor.userId);
    }
    const key: BatchKey = {
      ownerUserId: actor.userId, kind: input.kind, resourceUuid: input.kind === 'resource' ? input.uuid : null,
      itemUuid: input.kind === 'item' ? input.uuid : null, locationUuid: input.locationUuid, state: 'stored', quality: input.quality, lot: null,
      stats,
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
    // Refinery places from the catalog; none flagged yet = every selectable location
    const refineries = await refineryLocations(tx);
    if (refineries && !refineries.has(input.locationUuid)) throw new StockError('notRefinery');
    const jobId = randomUUID();
    const started = (await one<{ now: string }>(tx, sql`SELECT now()::text AS now`))!.now;
    const result: RefineJobResult = { jobId, journal: [], batches: [] };
    for (const row of materials) {
      await subjectInfo(tx, 'resource', row.resourceUuid);
      const key: BatchKey = {
        ownerUserId: actor.userId, kind: 'resource', resourceUuid: row.resourceUuid, itemUuid: null,
        locationUuid: input.locationUuid, state: 'refining', quality: row.quality, lot: null, stats: null,
      };
      const batch = (await one<Batch>(tx, sql`
        INSERT INTO app.stock_batch (owner_user_id, kind, resource_uuid, item_uuid, location_uuid, state, quality, stats, quantity,
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

/**
 * Sets a batch to a counted amount ("0" empties it); a component's stats too (`stats`: the whole new set
 * as for add, omitted = unchanged). Other stats are another merge key: the batch moves there (journal
 * move_out/move_in), into an existing batch with those stats (which keeps its shares) or as a new one
 * (which takes this one's).
 */
export async function adjust(db: Db, actor: Actor, input: { batchId: number; amount: string; expected?: string; stats?: Record<string, string> }) {
  return db.transaction(async (tx): Promise<StockResult> => {
    const batch = await lockBatch(tx, actor, input.batchId, input.expected);
    const target = /^\s*0+(?:[.,]0+)?\s*$/.test(input.amount) ? '0' : parse(input.amount, batch.kind);
    const delta = (await one<{ d: string }>(tx, sql`SELECT (${target}::numeric - ${batch.quantity}::numeric)::text AS d`))!.d;
    let stats = batch.stats;
    if (input.stats !== undefined) {
      const component = batch.itemUuid !== null
        && !!(await one<{ c: boolean }>(tx, sql`SELECT ${componentItemSql()} AS c FROM catalog.item i WHERE i.uuid = ${batch.itemUuid}`))?.c;
      if (!component) throw new StockError('invalidStats');
      stats = await checkStats(tx, batch.itemUuid!, input.stats);
    }
    // Emptied: the stats do not matter any more
    const restat = target !== '0' && JSON.stringify(stats) !== JSON.stringify(batch.stats);
    if (Number(delta) === 0 && !restat) throw new StockError('noChange');
    const sharedIn = await sharesOf(tx, batch.id);
    const entries: JournalEntry[] = [];
    if (Number(delta) !== 0) entries.push(await journal(tx, actor, 'adjust', keyOf(batch), delta));
    let left: Batch | null = null;
    if (target === '0') await tx.execute(sql`DELETE FROM app.stock_batch WHERE id = ${batch.id}`);
    else left = await one<Batch>(tx, sql`UPDATE app.stock_batch SET quantity = ${target}::numeric, updated_at = now() WHERE id = ${batch.id} RETURNING ${BATCH_COLUMNS}`);
    const key: BatchKey = { ...keyOf(batch), stats };
    if (restat) {
      const group = randomUUID();
      entries.push(await journal(tx, actor, 'move_out', keyOf(batch), negate(target), group));
      await decrease(tx, left!, target);
      const { created, ...moved } = await upsert(tx, key, target);
      if (created) await addShares(tx, moved.id, sharedIn);
      entries.push(await journal(tx, actor, 'move_in', key, target, group));
      left = moved;
    }
    await history(tx, actor, categoryOf(batch), 'adjust', key, {
      amount: target, from: batch.quantity, ...(restat ? { statsFrom: batch.stats ?? {} } : {}), ...offered(sharedIn),
    });
    return { journal: entries, batch: left };
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
