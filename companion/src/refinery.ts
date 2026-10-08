// What the refinery OCR read (Rust: refinery.rs), turned into work order drafts. Pure (tested from
// test/companion-refinery.test.ts): no Vue, no Tauri.
//
// The terminal's quote (SETUP after GET QUOTE) holds everything a job needs (station, method, ores
// with quality and quantity, yields, processing time) but may be cancelled; the PROCESSING screen
// proves the job started and tells its end, but lacks the method and the ore quantities. So the last
// quote is kept, and a PROCESSING screen whose rows (quality and yield) match it makes a draft. The
// user registers a draft (or drops it); nothing is booked by itself.
import type { CatalogResponse, RefineryStartRequest } from "../../src/webapp/api-types.ts";

export interface ScreenRow {
  name: string;
  inert: boolean;
  quality: number | null;
  qty: number | null;
  yieldCscu: number | null;
  todo: number | null;
  done: number | null;
}

export interface Screen {
  kind: "quote" | "processing";
  station: string | null;
  method: string | null;
  // Quote: processing time; processing: time remaining
  seconds: number | null;
  rows: ScreenRow[];
}

export interface ScreenEvent {
  // When the frame was taken (Unix ms)
  atMs: number;
  screen: Screen;
}

export interface DraftRow {
  // As the terminal shows it ("AGRICIUM (ORE)")
  name: string;
  quality: number;
  qtyCscu: number;
  yieldCscu: number;
}

export interface Draft {
  id: string;
  station: string | null;
  method: string | null;
  // The quoted processing time and the end as the PROCESSING screen tells it
  seconds: number;
  endsAtMs: number;
  rows: DraftRow[];
}

// A quote older than this is not the job's (the PROCESSING screen follows the confirmation at once)
const QUOTE_MAX_AGE_MS = 30 * 60_000;
// Slack for reading the screens a moment apart and the game's rounding
const SLACK_S = 120;

/** Letters and digits only, upper case (as the Rust side compares texts). */
export const norm = (text: string) => text.normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();

/** cSCU as exact SCU text: 389 -> "3.89", 20 -> "0.2", 0 -> "0". */
export function cscuToScu(cscu: number): string {
  const whole = Math.floor(cscu / 100);
  const frac = String(cscu % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

const key = (quality: number, yieldCscu: number) => `${quality}:${yieldCscu}`;
const signature = (rows: { quality: number | null; yieldCscu: number | null }[]) =>
  rows.map((r) => key(r.quality ?? -1, r.yieldCscu ?? -1)).sort().join(",");

/** The quote's rows that are refined: not inert, every number read (a "--" yield is not selected). */
function quoteRows(s: Screen): DraftRow[] | null {
  const rows = s.rows.filter((r) => !r.inert && r.yieldCscu !== null);
  if (!rows.length || rows.some((r) => r.quality === null || r.qty === null)) return null;
  return rows.map((r) => ({ name: r.name, quality: r.quality!, qtyCscu: r.qty!, yieldCscu: r.yieldCscu! }));
}

/** Follows the screens read and makes a draft when a started job matches the last quote. */
export class RefineryTracker {
  private quote: { atMs: number; screen: Screen; rows: DraftRow[] } | null = null;
  readonly drafts: Draft[] = [];

  /** The new draft, if this screen completed one. */
  feed(e: ScreenEvent): Draft | null {
    const s = e.screen;
    if (s.kind === "quote") {
      const rows = quoteRows(s);
      if (rows && s.seconds !== null) this.quote = { atMs: e.atMs, screen: s, rows };
      return null;
    }
    const q = this.quote;
    if (!q || s.seconds === null || e.atMs - q.atMs > QUOTE_MAX_AGE_MS || e.atMs < q.atMs) return null;
    const running = s.rows.filter((r) => !r.inert);
    if (signature(running) !== signature(q.rows)) return null;
    // The time left fits the quote (counted down since then)
    const elapsed = (e.atMs - q.atMs) / 1000;
    const quoted = q.screen.seconds!;
    if (s.seconds > quoted + SLACK_S || s.seconds < quoted - elapsed - SLACK_S) return null;
    const endsAtMs = e.atMs + s.seconds * 1000;
    const id = `${endsAtMs}:${signature(q.rows)}`;
    this.quote = null;
    // The same job seen again (another PROCESSING frame): no second draft
    const sig = signature(q.rows);
    if (this.drafts.some((d) => signature(d.rows) === sig && Math.abs(d.endsAtMs - endsAtMs) < SLACK_S * 1000)) return null;
    const draft: Draft = { id, station: q.screen.station, method: q.screen.method, seconds: quoted, endsAtMs, rows: q.rows };
    this.drafts.push(draft);
    return draft;
  }

  remove(id: string) {
    const i = this.drafts.findIndex((d) => d.id === id);
    if (i >= 0) this.drafts.splice(i, 1);
  }
}

// --- matching against the catalog (names in every language the game may use) ---------------------

export interface RefineryCatalog {
  // Normalized name -> UUID
  ores: Map<string, string>;
  // Every ore name split into stem and qualifier (findOre)
  oreParts: { stem: string; qual: string; uuid: string }[];
  refineries: Map<string, string>;
}

/** A name's stem and qualifier, normalized: "Hephaestanite (Raw)" and "HEPH (RAW)" ->
 * HEPHAESTANITE/HEPH + RAW, "Raw Silicon" -> SILICON + RAW, "Hephaestanite (R)" -> … + R. */
export function oreParts(name: string): { stem: string; qual: string } {
  const paren = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(name);
  if (paren) return { stem: norm(paren[1]!), qual: norm(paren[2]!) };
  const raw = /^raw\s+(.+)$/i.exec(name.trim());
  if (raw) return { stem: norm(raw[1]!), qual: "RAW" };
  return { stem: norm(name), qual: "" };
}

/** The ore a terminal name means: the exact name, else the one ore whose stem starts with the
 * terminal's (it abbreviates: "HEPH (RAW)") and whose qualifier fits ("Raw" / "R"). */
export function findOre(cat: RefineryCatalog, name: string): string | null {
  const exact = cat.ores.get(norm(name));
  if (exact) return exact;
  const { stem, qual } = oreParts(name);
  if (!stem) return null;
  const fits = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
  const uuids = new Set(cat.oreParts.filter((o) => o.stem.startsWith(stem) && fits(o.qual, qual)).map((o) => o.uuid));
  return uuids.size === 1 ? [...uuids][0]! : null;
}

/** The lookups from the web app's catalog in each language (the game's language is unknown). */
export function buildCatalog(responses: CatalogResponse[]): RefineryCatalog {
  const cat: RefineryCatalog = { ores: new Map(), oreParts: [], refineries: new Map() };
  for (const r of responses) {
    for (const m of r.materials) {
      if (!m.isOre) continue;
      cat.ores.set(norm(m.name), m.uuid);
      cat.oreParts.push({ ...oreParts(m.name), uuid: m.uuid });
    }
    // The location's own name: the label's first part ("Name · planet · system")
    for (const l of r.locations) if (l.refinery) cat.refineries.set(norm(l.label.split(" · ")[0]!), l.uuid);
  }
  return cat;
}

export interface ResolvedDraft {
  locationUuid: string | null;
  rows: { name: string; oreUuid: string | null; quality: number; amount: string; expectedYield: string }[];
}

export function resolveDraft(d: Draft, cat: RefineryCatalog): ResolvedDraft {
  return {
    locationUuid: d.station ? cat.refineries.get(norm(d.station)) ?? null : null,
    rows: d.rows.map((r) => ({
      name: r.name, oreUuid: findOre(cat, r.name), quality: r.quality,
      amount: cscuToScu(r.qtyCscu), expectedYield: cscuToScu(r.yieldCscu),
    })),
  };
}

/** The web app request for a resolved draft (null while a station or ore is unknown); the duration
 * is what is left of the job now, so its end stays the game's. */
export function startRequest(r: ResolvedDraft, endsAtMs: number, nowMs: number): RefineryStartRequest | null {
  if (!r.locationUuid || r.rows.some((x) => !x.oreUuid)) return null;
  return {
    locationUuid: r.locationUuid,
    durationSeconds: Math.max(1, Math.round((endsAtMs - nowMs) / 1000)),
    rows: r.rows.map((x) => ({ oreUuid: x.oreUuid!, quality: x.quality, amount: x.amount, expectedYield: x.expectedYield })),
  };
}
