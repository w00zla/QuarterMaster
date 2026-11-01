// The gear part of the inventory scan (ship components and FPS gear): what the OCR read off the
// character inventory's tooltip (Rust: components.rs, the `components` part of the event
// "inventory-read") turned into sightings, and the sightings into proposals. Pure (tested from
// test/companion-components.test.ts): no Vue, no Tauri.
//
// The tooltip's title names the item, a ship component with the game's "class/size/grade" prefix
// ("Mil/3/A Blizzard"); the stat lines show absolute values ("Coolant Rating: 67.50") or, for some FPS
// stats, the change in percent ("Recoil Kick: -28.44 %", `CatalogStat.tooltip`); the stock keeps a
// crafted item's gain over the unmodified value (`CatalogStat.base`: "12.5" = +12.5 %, power pips in
// steps), so each read stat is converted; a tooltip without stat lines is a looted item (no stats).
// Stackable FPS gear (weapon attachments) shows its count on the tile ("2x"): one sighting per tile
// with that many pieces. A sighting's identity is its tile's place in the page's content (page, row with the pane's
// scroll counted in, units; the Rust side finds them) and its content: a tile hovered again after a
// scroll is the same sighting, equal components on other tiles stay apart. A tooltip counts only once
// the cursor stayed on its tile for a read or had rested when the frame was grabbed (right after a
// move the game may still show the previous tile's tooltip), and a sighting only once two such reads
// in a row agree (an OCR glitch in one read books nothing).
import { FPS_TYPES } from "../../src/catalog/components.ts";
import { norm } from "../../src/stock/material-names.ts";
import type { CatalogStat, CompanionCatalogResponse, StockAddRequest, StockBatch } from "../../src/webapp/api-types.ts";

// --- what the OCR sends ------------------------------------------------------------------------------

export interface ReadRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ReadLine {
  text: string;
  rect: ReadRect;
}

export interface ReadTooltip {
  title: string;
  lines: ReadLine[];
  rect: ReadRect;
}

/** The character inventory's part of a read. */
export interface ComponentRead {
  tooltip: ReadTooltip | null;
  page: { index: number; total: number } | null;
  // The tile under the mouse cursor: its row in the page's content (the pane's scroll counted in), its
  // first unit of four and how many it spans (weapons 2), the stack's count where the tile shows one
  // ("2x"; null: one piece); null outside the grid or without a lit tile
  cell: { row: number; col: number; span: number; rect: ReadRect; count?: number | null } | null;
}

// --- catalog ---------------------------------------------------------------------------------------

export interface ComponentDef {
  uuid: string;
  // The catalog's unique label ("Blizzard · Cooler · S3 · A Military", the first language's)
  label: string;
  // Normalized names in every language and the player's pack
  names: Set<string>;
  size: number | null;
  gradeLetter: string | null;
  stats: CatalogStat[];
  // FPS gear (weapons, attachments, armor, gadgets), else a ship component
  fps: boolean;
}

export interface ComponentCatalog {
  components: ComponentDef[];
  // Crafted property UUID -> its normalized names in every language and the player's pack
  statNames: Map<string, Set<string>>;
}

/** The loc keys of the stat names (for the player's language pack). */
export function statNameKeys(responses: CompanionCatalogResponse[]): string[] {
  const keys = new Set<string>();
  for (const r of responses) for (const m of r.materials) for (const s of m.stats) if (s.nameKey) keys.add(s.nameKey);
  return [...keys];
}

/** The components and stat names from the web app's catalog (each language) and the player's own texts. */
export function buildComponentCatalog(responses: CompanionCatalogResponse[], gameNames: Record<string, string>): ComponentCatalog {
  const byUuid = new Map<string, ComponentDef>();
  const statNames = new Map<string, Set<string>>();
  for (const r of responses) {
    for (const m of r.materials) {
      if (!m.component) continue;
      const fps = !!m.type && Object.hasOwn(FPS_TYPES, m.type);
      const def = byUuid.get(m.uuid) ?? { uuid: m.uuid, label: m.label, names: new Set<string>(), size: m.size, gradeLetter: m.gradeLetter, stats: m.stats, fps };
      def.names.add(norm(m.name));
      const own = m.nameKey ? gameNames[m.nameKey] : undefined;
      if (own) def.names.add(norm(own));
      byUuid.set(m.uuid, def);
      for (const s of m.stats) {
        const names = statNames.get(s.uuid) ?? new Set<string>();
        names.add(norm(s.name));
        const ownStat = s.nameKey ? gameNames[s.nameKey] : undefined;
        if (ownStat) names.add(norm(ownStat));
        statNames.set(s.uuid, names);
      }
    }
  }
  return { components: [...byUuid.values()], statNames };
}

// "Ind/1/B Guardian", "Mil/3/A JS-500", "Sth/2/B Bolt"; the OCR drops the space now and then ("Sth/1/ASnowBlind")
// and reads the grade in lower case (PP-OCRv6 tiny: "Sth/1/c HeatSafe")
const PREFIX = /^[A-Za-z]{3}\/(\d+)\/([A-Za-z])\s*(.+)$/;

// A normalized text without accents: the OCR adds some ("RADIATION CAPAÇITY", "VOLÙME")
const plain = (normed: string) => normed.normalize("NFD").replace(/\p{M}/gu, "");

// A normalized name with the OCR's look-alikes folded: "Sion Compensatorl" for "Sion Compensator1"
const loose = (normed: string) => plain(normed).replace(/[LI]/g, "1").replace(/O/g, "0");

/** The items a tooltip title can mean: none, one, or several; without an exact match the names with
 * look-alike letters and digits folded (l/I and 1, O and 0). The prefix's size and grade narrow
 * them; among variants that share a name (a ship weapon's turret, low-poly and ship-fitted records next
 * to the one the blueprints make), the craftable ones (with stats) count. */
export function findComponents(cat: ComponentCatalog, title: string): ComponentDef[] {
  const prefix = PREFIX.exec(title.trim());
  let hits = cat.components.filter((c) => c.names.has(norm(title)));
  if (!hits.length && prefix) hits = cat.components.filter((c) => c.names.has(norm(prefix[3]!)));
  if (!hits.length) {
    const folded = loose(norm(prefix ? prefix[3]! : title));
    hits = cat.components.filter((c) => [...c.names].some((n) => loose(n) === folded));
  }
  if (hits.length > 1 && prefix) {
    const narrowed = hits.filter((c) => c.size === Number(prefix[1]) && c.gradeLetter === prefix[2]!.toUpperCase());
    if (narrowed.length) hits = narrowed;
  }
  if (hits.length > 1) {
    const crafted = hits.filter((c) => c.stats.length);
    if (crafted.length) hits = crafted;
  }
  return hits;
}

// --- tooltip lines -----------------------------------------------------------------------------------

export interface Field {
  label: string;
  value: string;
}

/** "Coolant Rating: 60.00" -> label and value; a line without a colon ends in the value when it ends in a number
 * (the OCR drops a colon now and then: "Integrity 1800.00"); description lines yield nothing. */
export function parseField(text: string): Field | null {
  const t = text.trim();
  const colon = t.search(/[:;]/);
  if (colon > 0) {
    const [label, value] = [t.slice(0, colon).trim(), t.slice(colon + 1).trim()];
    return label && value ? { label, value } : null;
  }
  const m = /^(.+?)\s+(\d[\d.,]*(?:\s*\S+)?)$/.exec(t);
  return m ? { label: m[1]!, value: m[2]! } : null;
}

/** The leading number of a value ("259.05 Mm/s" -> 259.05, "1,800.00" -> 1800); null when none. */
export function parseNumber(value: string): number | null {
  const m = /^[+-]?\d[\d,]*(?:\.\d+)?/.exec(value.trim().replace(/\s/g, ""));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** The stored gain for a tooltip value: percent over the base (one decimal) or whole steps; "0" for
 * no gain; null when it cannot be: no base known, no number, worse than the base beyond rounding, or
 * better than what the blueprint can make. A stat whose improvement is a drop (recoil) mirrors this.
 * A stat the tooltip shows as its change in percent needs no base ("+6.11 %"; negated for some:
 * "Recoil Smoothness: +28.44 %" is a factor of 0.72, stored -28.4). A negative base (armor's minimum
 * temperature, -61) divides the same way. */
export function statFromTooltip(stat: CatalogStat, value: string): string | null {
  const v = parseNumber(value);
  const change = stat.tooltip !== "value" && stat.kind === "multiplier";
  if (v === null || (!change && !stat.base)) return null;
  const dir = stat.min < 0 ? -1 : 1;
  const best = dir * (dir < 0 ? stat.min : stat.max);
  if (stat.kind === "multiplier") {
    const pct = change ? Math.round((stat.tooltip === "negatedChange" ? -v : v) * 10) / 10 : Math.round((v / stat.base! - 1) * 1000) / 10;
    if (dir * pct < -0.5 || dir * pct > best + 0.05) return null;
    return dir * pct <= 0 ? "0" : String(pct);
  }
  const steps = Math.round(v - stat.base!);
  if (dir * steps < 0 || dir * steps > best) return null;
  return String(steps);
}

export type StatsResult = {
  // {property UUID: gain}, only gains (what is booked)
  stats: Record<string, string>;
  // The property UUIDs whose line was read, gain or not (an unmodified component shows its stats at ±0)
  read: string[];
  // The stats whose line could not be turned into a gain
  unreadable: string[];
};

/** The component's stats in the tooltip's lines: the gains to book, which stats were read at all, and
 * the stats whose line could not be read. Lines of other labels are ignored. */
export function statsOf(def: ComponentDef, lines: string[], cat: ComponentCatalog): StatsResult {
  const stats: Record<string, string> = {};
  const read: string[] = [];
  const unreadable: string[] = [];
  const fields = lines.map(parseField).filter((f): f is Field => f !== null);
  for (const s of def.stats) {
    const names = cat.statNames.get(s.uuid);
    const field = names && (fields.find((f) => names.has(norm(f.label))) ?? fields.find((f) => [...names].some((n) => plain(n) === plain(norm(f.label)))));
    if (!field) continue;
    const value = statFromTooltip(s, field.value);
    if (value === null) unreadable.push(s.name);
    else {
      read.push(s.uuid);
      if (value !== "0") stats[s.uuid] = value;
    }
  }
  return { stats: Object.fromEntries(Object.entries(stats).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), read, unreadable };
}

// --- sightings -------------------------------------------------------------------------------------

export type ComponentProblem = "unknownComponent" | "ambiguousComponent" | "statsUnreadable";

export interface ComponentSighting {
  // page | row | col | span | component (or title) | stats: the tile's place in the page's content, so
  // equal components stay apart and a tile hovered again after a scroll is the same
  key: string;
  // As the tooltip shows it
  title: string;
  componentUuid: string | null;
  // The catalog's label, else the title
  label: string;
  // The gains read off the tooltip ({} = none); null while unreadable
  stats: Record<string, string> | null;
  // The stats read at all (property UUIDs): shown at ±0 where there is no gain
  readStats: string[];
  // The stats that could not be read
  unreadable: string[];
  // FPS gear, a ship component, or not known (an unknown title, variants of both)
  fps: boolean | null;
  // The pieces on the tile (a stack of attachments: its count; else 1); not part of the key (a stack
  // whose count changes stays the same sighting)
  count: number;
  page: number | null;
  row: number;
  col: number;
  span: number;
  atMs: number;
  problem: ComponentProblem | null;
}

/** A read's tile as text (page, row, units), null without one. */
const tileOf = (e: ComponentRead) => (e.cell ? `${e.page?.index ?? "?"}|${e.cell.row}|${e.cell.col}|${e.cell.span}` : null);

/** The sighting in a read: the tooltip at the cursor's tile; null without both. */
export function sightingOf(atMs: number, e: ComponentRead, cat: ComponentCatalog): ComponentSighting | null {
  if (!e.tooltip || !e.cell) return null;
  const title = e.tooltip.title.trim();
  const hits = findComponents(cat, title);
  const def = hits.length === 1 ? hits[0]! : null;
  const read: StatsResult = def ? statsOf(def, e.tooltip.lines.map((l) => l.text), cat) : { stats: {}, read: [], unreadable: [] };
  const problem: ComponentProblem | null = !hits.length ? "unknownComponent" : !def ? "ambiguousComponent" : read.unreadable.length ? "statsUnreadable" : null;
  const page = e.page?.index ?? null;
  const stats = problem ? null : read.stats;
  return {
    key: `${tileOf(e)}|${def?.uuid ?? norm(title)}|${stats ? JSON.stringify(stats) : "-"}`,
    title,
    componentUuid: def?.uuid ?? null,
    label: def?.label ?? title,
    stats,
    readStats: read.read,
    unreadable: read.unreadable,
    fps: hits.length && hits.every((h) => h.fps === hits[0]!.fps) ? hits[0]!.fps : null,
    count: e.cell.count ?? 1,
    page,
    row: e.cell.row,
    col: e.cell.col,
    span: e.cell.span,
    atMs,
    problem,
  };
}

// A frame grabbed once the cursor rested this long shows the tooltip of the tile under it (the
// capture waits for it, `REST` in capture.rs): its read counts even right after a move
export const SETTLED_MS = 200;

/** The sightings of one scan session, by key. */
export class ComponentScan {
  readonly sightings = new Map<string, ComponentSighting>();
  // The last read's sighting, waiting for a second read that agrees
  private pending: ComponentSighting | null = null;
  // The last read's tile: a tooltip counts only once the cursor stayed on its tile for a read (right
  // after a move the game may still show the previous tile's tooltip)
  private lastTile: string | null = null;

  /** Takes a read in; the sighting it added (or a known one with another count), null when nothing
   * changed (the cursor just came to the tile, a known sighting read again, a first read still waiting
   * for its confirmation, or one `accept` turns down). `restMs`: how long the cursor had rested when
   * the frame was grabbed; from SETTLED_MS on a read of a tile just come to counts. */
  feed(atMs: number, e: ComponentRead, cat: ComponentCatalog, accept: (s: ComponentSighting) => boolean = () => true, restMs = 0): ComponentSighting | null {
    const tile = tileOf(e);
    const arrived = tile !== this.lastTile;
    this.lastTile = tile;
    if (arrived) {
      this.pending = null;
      if (restMs < SETTLED_MS) return null;
    }
    const s = sightingOf(atMs, e, cat);
    if (!s || !accept(s)) return null;
    if (this.sightings.get(s.key)?.count === s.count) return null;
    if (this.pending?.key !== s.key || this.pending.count !== s.count) {
      this.pending = s;
      return null;
    }
    this.pending = null;
    this.sightings.set(s.key, s);
    return s;
  }

  clear() {
    this.sightings.clear();
    this.pending = null;
    this.lastTile = null;
  }

  /** Newest first. */
  list(): ComponentSighting[] {
    return [...this.sightings.values()].sort((a, b) => b.atMs - a.atMs);
  }
}

// --- proposals -------------------------------------------------------------------------------------

export interface ComponentProposal {
  // The sighting's key
  id: string;
  componentUuid: string;
  label: string;
  // The gains to book
  stats: Record<string, string>;
  // The stats read at all, to show (±0 without a gain)
  readStats: string[];
  // The pieces (a stack's count, else 1)
  amount: number;
  fps: boolean;
}

/** One proposal per complete sighting (its tile's pieces). */
export function proposalsOf(sightings: Iterable<ComponentSighting>): ComponentProposal[] {
  const out: ComponentProposal[] = [];
  for (const s of sightings) {
    if (s.problem || !s.componentUuid || !s.stats) continue;
    out.push({ id: s.key, componentUuid: s.componentUuid, label: s.label, stats: s.stats, readStats: s.readStats, amount: s.count, fps: !!s.fps });
  }
  return out;
}

// A stat value without trailing zeros ("12.50" -> "12.5", "0.0" -> "0")
const canonical = (v: string) => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v);
// A component as the stock tells it apart: its UUID and its gains
const stockKey = (uuid: string, stats: Record<string, string> | null) =>
  `${uuid}|${Object.entries(stats ?? {}).map(([k, v]) => [k, canonical(v)]).filter(([, v]) => v !== "0").map(([k, v]) => `${k}=${v}`).sort().join(",")}`;

/** The proposals (newest first, as listed) the stored stock at the location already holds: per item and
 * stats as many as the stock holds pieces, the ones registered here first, then the earliest seen; the
 * others are new (5 tiles hovered, 4 pieces stored: one new; a stack of 3 with 2 stored: new). Ship
 * components do not stack in the game, attachments do. A registered one always counts. */
export function inStockOf(proposals: ComponentProposal[], batches: StockBatch[], locationUuid: string, registered: ReadonlySet<string>): Set<string> {
  const left = new Map<string, bigint>();
  for (const b of batches) {
    if (!b.component || b.state !== "stored" || !b.canChange || b.locationUuid !== locationUuid) continue;
    const key = stockKey(b.subjectUuid, b.stats);
    left.set(key, (left.get(key) ?? 0n) + BigInt(b.quantity));
  }
  // Stable: the registered first, each part oldest first
  const order = [...proposals].reverse().sort((a, b) => Number(registered.has(b.id)) - Number(registered.has(a.id)));
  const out = new Set<string>();
  for (const p of order) {
    const key = stockKey(p.componentUuid, p.stats);
    const have = left.get(key) ?? 0n;
    const need = BigInt(p.amount);
    if (!registered.has(p.id) && have < need) continue;
    out.add(p.id);
    left.set(key, have > need ? have - need : 0n);
  }
  return out;
}

/** The add for a proposal: its pieces, no quality, its stats, shared right away in `guildIds` (none: unshared). */
export function addRequest(p: ComponentProposal, locationUuid: string, guildIds: string[] = []): StockAddRequest {
  const req: StockAddRequest = { subjectUuid: p.componentUuid, locationUuid, quality: 0, amount: String(p.amount) };
  if (Object.keys(p.stats).length) req.stats = p.stats;
  return guildIds.length ? { ...req, guildIds } : req;
}
