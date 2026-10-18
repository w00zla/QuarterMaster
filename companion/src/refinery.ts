// The refinery sync: what the OCR read off a terminal's work order overview (Rust: refinery.rs) held
// against the user's running jobs at that station. Pure (tested from test/companion-refinery.test.ts):
// no Vue, no Tauri.
//
// A terminal order and a job are the same when their rows match: the same refined materials in the
// same qualities (rows of one material and quality add up). A running order that matches updates its
// job by itself (the yields, the time left: estimates, no stock yet); everything else is a proposal the
// user confirms: a running order without a job (register it), a finished order of a job (store it), a
// job of this station not seen during the whole visit (remove it; the terminal scrolls its orders
// sideways, so only the visit as a whole tells). An order is acted on only once two reads in a row
// showed it the same (OCR misreads do not book anything).
import { addName, emptyNames, findMaterial, norm, type MaterialNames } from "../../src/stock/material-names.ts";
import type { CatalogResponse, StockBatch } from "../../src/webapp/api-types.ts";

// --- what the OCR sends ------------------------------------------------------------------------------

export interface OverviewRow {
  // As the terminal shows it ("HEPHAESTANITE")
  name: string;
  quality: number | null;
  yieldCscu: number | null;
}

export interface OverviewOrder {
  status: "processing" | "completed";
  // Processing: the time remaining
  seconds: number | null;
  rows: OverviewRow[];
}

export interface Overview {
  // The terminal's title ("CRU-L1 AMBITIOUS DREAM STATION")
  station: string | null;
  orders: OverviewOrder[];
}

export interface OverviewEvent {
  // When the frame was taken (Unix ms)
  atMs: number;
  overview: Overview;
}

export interface VisitEvent {
  atMs: number;
  // Arrived at a terminal (true) or left it (false)
  active: boolean;
}

/** cSCU as exact SCU text: 389 -> "3.89", 20 -> "0.2", 0 -> "0". */
export function cscuToScu(cscu: number): string {
  const whole = Math.floor(cscu / 100);
  const frac = String(cscu % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

// --- names ---------------------------------------------------------------------------------------

export interface SyncCatalog {
  // The refinery's materials: resources only
  materials: MaterialNames;
  // The inventory's: every bookable material (resources and items)
  allMaterials: MaterialNames;
  // Material UUID -> its unit
  units: Map<string, "SCU" | "pcs">;
  // Normalized station name -> location UUID (refineries only)
  stations: Map<string, string>;
  // Location UUID -> display name
  stationNames: Map<string, string>;
  // Material UUID -> display name (resources and items; the first language's)
  materialNames: Map<string, string>;
  // Every selectable location for the inventory's location picker (the first language's labels)
  locations: { uuid: string; label: string; short: string }[];
}

/** The loc keys whose texts the player's language pack may change (materials, refinery stations). */
export function gameNameKeys(responses: CatalogResponse[]): string[] {
  const keys = new Set<string>();
  for (const r of responses) {
    for (const m of r.materials) if (m.nameKey) keys.add(m.nameKey);
    for (const l of r.locations) if (l.refinery && l.nameKey) keys.add(l.nameKey);
  }
  return [...keys];
}

/** The lookups from the web app's catalog (each language) and the player's own texts (`gameNames`: loc key -> text). */
export function buildCatalog(responses: CatalogResponse[], gameNames: Record<string, string>): SyncCatalog {
  const cat: SyncCatalog = {
    materials: emptyNames(), allMaterials: emptyNames(), units: new Map(), stations: new Map(), stationNames: new Map(), materialNames: new Map(), locations: [],
  };
  for (const r of responses) {
    for (const m of r.materials) {
      const own = m.nameKey ? gameNames[m.nameKey] : undefined;
      addName(cat.allMaterials, m.name, m.uuid);
      if (own) addName(cat.allMaterials, own, m.uuid);
      cat.units.set(m.uuid, m.unit);
      if (!cat.materialNames.has(m.uuid)) cat.materialNames.set(m.uuid, m.name);
      if (m.kind !== "resource") continue;
      addName(cat.materials, m.name, m.uuid);
      if (own) addName(cat.materials, own, m.uuid);
    }
    if (!cat.locations.length) cat.locations = r.locations.map((l) => ({ uuid: l.uuid, label: l.label, short: l.short }));
    for (const l of r.locations) {
      if (!l.refinery) continue;
      // The location's own name: the label's first part ("Name · planet · system")
      cat.stations.set(norm(l.label.split(" · ")[0]!), l.uuid);
      const own = l.nameKey ? gameNames[l.nameKey] : undefined;
      if (own) cat.stations.set(norm(own), l.uuid);
      if (!cat.stationNames.has(l.uuid)) cat.stationNames.set(l.uuid, l.short);
    }
  }
  return cat;
}

export const findStation = (cat: SyncCatalog, title: string | null): string | null => (title ? cat.stations.get(norm(title)) ?? null : null);

// --- orders and jobs -----------------------------------------------------------------------------

export interface OrderRow {
  resourceUuid: string;
  quality: number;
  yieldCscu: number;
}

export interface Order {
  status: "processing" | "completed";
  seconds: number | null;
  // Merged per material and quality, sorted
  rows: OrderRow[];
}

const rowKey = (resourceUuid: string, quality: number) => `${resourceUuid}:${quality}`;

/** Rows of one material and quality summed, sorted by key. */
function merged(rows: OrderRow[]): OrderRow[] {
  const by = new Map<string, OrderRow>();
  for (const r of rows) {
    const k = rowKey(r.resourceUuid, r.quality);
    const had = by.get(k);
    by.set(k, had ? { ...had, yieldCscu: had.yieldCscu + r.yieldCscu } : { ...r });
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => r);
}

/** An order with its names resolved; rows that cannot be (unknown name, a number missing, nothing out) are left out; null when none is left. */
export function resolveOrder(o: OverviewOrder, cat: SyncCatalog): Order | null {
  const rows: OrderRow[] = [];
  for (const r of o.rows) {
    if (r.quality === null || r.yieldCscu === null || r.yieldCscu <= 0) continue;
    const uuid = findMaterial(cat.materials, r.name);
    if (uuid) rows.push({ resourceUuid: uuid, quality: r.quality, yieldCscu: r.yieldCscu });
  }
  return rows.length ? { status: o.status, seconds: o.seconds, rows: merged(rows) } : null;
}

/** Which job an order may be: its materials and qualities. */
export const signature = (rows: { resourceUuid: string; quality: number }[]) =>
  [...new Set(rows.map((r) => rowKey(r.resourceUuid, r.quality)))].sort().join(",");

// What two reads must agree on (the time left counts down: not part of it)
const content = (o: Order) => `${o.status}|${o.rows.map((r) => `${rowKey(r.resourceUuid, r.quality)}=${r.yieldCscu}`).join(",")}`;

export interface JobBatch {
  id: number;
  resourceUuid: string;
  quality: number;
  // Exact SCU text: the expected yield
  quantity: string;
}

export interface Job {
  jobId: string;
  locationUuid: string;
  // ISO, null: open
  endsAt: string | null;
  batches: JobBatch[];
}

/** The running jobs in a personal stock list. */
export function jobsOf(batches: StockBatch[]): Job[] {
  const jobs = new Map<string, Job>();
  for (const b of batches) {
    if (b.state !== "refining" || !b.refine || b.kind !== "resource") continue;
    const id = b.refine.jobId;
    if (!jobs.has(id)) jobs.set(id, { jobId: id, locationUuid: b.locationUuid, endsAt: b.refine.endsAt, batches: [] });
    jobs.get(id)!.batches.push({ id: b.id, resourceUuid: b.subjectUuid, quality: b.quality, quantity: b.quantity });
  }
  return [...jobs.values()];
}

// --- the sync -----------------------------------------------------------------------------------

/** A change made right away (estimates of a matched running job). */
export type Update =
  | { kind: "yield"; jobId: string; batchId: number; amount: string; expected: string }
  | { kind: "duration"; jobId: string; durationSeconds: number };

export type Proposal =
  | { kind: "new"; id: string; locationUuid: string; endsAtMs: number | null; rows: OrderRow[] }
  | { kind: "store"; id: string; locationUuid: string; job: Job; rows: OrderRow[] }
  | { kind: "missing"; id: string; locationUuid: string; job: Job };

export interface FeedResult {
  // The station read (null: not recognized; then nothing happens)
  locationUuid: string | null;
  updates: Update[];
}

// The end may differ this much (the terminal shows minutes only above an hour, reads come a moment apart)
const END_SLACK_MS = 120_000;

export class RefinerySync {
  readonly proposals: Proposal[] = [];
  // Dismissed in this session: never proposed again
  private readonly dismissed = new Set<string>();
  // Per station the order contents of the last read (stability)
  private readonly lastRead = new Map<string, Set<string>>();
  // The visit: stations read and the jobs seen there
  private visitStations = new Set<string>();
  private seenJobs = new Set<string>();

  startVisit() {
    this.visitStations = new Set();
    this.seenJobs = new Set();
    this.lastRead.clear();
  }

  /** One read of an overview against the jobs as the server has them now. */
  feed(e: OverviewEvent, cat: SyncCatalog, jobs: Job[], nowMs: number): FeedResult {
    const locationUuid = findStation(cat, e.overview.station);
    if (!locationUuid) return { locationUuid: null, updates: [] };
    this.visitStations.add(locationUuid);
    const here = jobs.filter((j) => j.locationUuid === locationUuid);
    const orders = e.overview.orders.map((o) => resolveOrder(o, cat)).filter((o): o is Order => o !== null);
    const before = this.lastRead.get(locationUuid) ?? new Set<string>();
    this.lastRead.set(locationUuid, new Set(orders.map(content)));

    const updates: Update[] = [];
    const used = new Set<string>();
    for (const o of orders) {
      const endsAtMs = o.seconds === null ? null : e.atMs + o.seconds * 1000;
      const job = match(o, here, used, endsAtMs);
      if (job) {
        used.add(job.jobId);
        this.seenJobs.add(job.jobId);
        this.drop(`missing:${job.jobId}`);
      }
      // Only what two reads in a row showed the same
      if (!before.has(content(o))) continue;
      if (o.status === "processing" && job) updates.push(...jobUpdates(job, o, endsAtMs, nowMs));
      else if (o.status === "processing") this.propose({ kind: "new", id: `new:${locationUuid}:${signature(o.rows)}`, locationUuid, endsAtMs, rows: o.rows });
      else if (job) this.propose({ kind: "store", id: `store:${job.jobId}`, locationUuid, job, rows: o.rows });
    }
    return { locationUuid, updates };
  }

  /** The visit is over: jobs of its stations no read matched are proposed for removal. */
  endVisit(jobs: Job[]) {
    for (const job of jobs) {
      if (this.visitStations.has(job.locationUuid) && !this.seenJobs.has(job.jobId)) {
        this.propose({ kind: "missing", id: `missing:${job.jobId}`, locationUuid: job.locationUuid, job });
      }
    }
    this.visitStations = new Set();
    this.seenJobs = new Set();
    this.lastRead.clear();
  }

  /** Drops proposals the jobs no longer call for (a new job registered elsewhere, a job gone). */
  prune(jobs: Job[]) {
    const byId = new Map(jobs.map((j) => [j.jobId, j]));
    const signatures = new Set(jobs.map((j) => `${j.locationUuid}:${signature(j.batches)}`));
    for (const p of [...this.proposals]) {
      if (p.kind === "new" ? signatures.has(`${p.locationUuid}:${signature(p.rows)}`) : !byId.has(p.job.jobId)) this.drop(p.id);
    }
  }

  /** The user said no: not proposed again in this session. */
  dismiss(id: string) {
    this.dismissed.add(id);
    this.drop(id);
  }

  /** Done (registered, stored, removed). */
  drop(id: string) {
    const i = this.proposals.findIndex((p) => p.id === id);
    if (i >= 0) this.proposals.splice(i, 1);
  }

  private propose(p: Proposal) {
    if (this.dismissed.has(p.id)) return;
    const i = this.proposals.findIndex((x) => x.id === p.id);
    // The newest read replaces the older (the time left, the job's batches)
    if (i >= 0) this.proposals[i] = p;
    else this.proposals.push(p);
  }
}

/** The job an order is: the same rows; of several the one whose end is closest. */
function match(o: Order, jobs: Job[], used: Set<string>, endsAtMs: number | null): Job | null {
  const sig = signature(o.rows);
  const fits = jobs.filter((j) => !used.has(j.jobId) && signature(j.batches) === sig);
  const distance = (j: Job) => (endsAtMs === null || !j.endsAt ? Number.MAX_SAFE_INTEGER : Math.abs(Date.parse(j.endsAt) - endsAtMs));
  return fits.sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

/** What differs between a running job and the terminal: each row's yield, the end. */
function jobUpdates(job: Job, o: Order, endsAtMs: number | null, nowMs: number): Update[] {
  const out: Update[] = [];
  for (const b of job.batches) {
    const row = o.rows.find((r) => r.resourceUuid === b.resourceUuid && r.quality === b.quality);
    const amount = row && cscuToScu(row.yieldCscu);
    if (amount && amount !== b.quantity) out.push({ kind: "yield", jobId: job.jobId, batchId: b.id, amount, expected: b.quantity });
  }
  if (endsAtMs !== null && (!job.endsAt || Math.abs(Date.parse(job.endsAt) - endsAtMs) > END_SLACK_MS)) {
    out.push({ kind: "duration", jobId: job.jobId, durationSeconds: Math.max(1, Math.round((endsAtMs - nowMs) / 1000)) });
  }
  return out;
}

// --- requests -------------------------------------------------------------------------------------

/** POST /api/refinery/start for a new job; the duration is what is left now (the end stays the game's). */
export function startRequest(p: Extract<Proposal, { kind: "new" }>, nowMs: number) {
  return {
    locationUuid: p.locationUuid,
    ...(p.endsAtMs === null ? {} : { durationSeconds: Math.max(1, Math.round((p.endsAtMs - nowMs) / 1000)) }),
    rows: p.rows.map((r) => ({ resourceUuid: r.resourceUuid, quality: r.quality, amount: cscuToScu(r.yieldCscu) })),
  };
}

/** POST /api/refinery/done: every batch of the job with the terminal's yield. */
export function doneRequest(p: Extract<Proposal, { kind: "store" }>) {
  return {
    jobId: p.job.jobId,
    rows: p.job.batches.map((b) => {
      const row = p.rows.find((r) => r.resourceUuid === b.resourceUuid && r.quality === b.quality);
      return { batchId: b.id, amount: row ? cscuToScu(row.yieldCscu) : b.quantity, expected: b.quantity };
    }),
  };
}

/** POST /api/refinery/remove: every batch of the job. */
export function removeRequest(job: Job) {
  return { jobId: job.jobId, rows: job.batches.map((b) => ({ batchId: b.id, expected: b.quantity })) };
}
