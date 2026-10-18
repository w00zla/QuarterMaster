// The ship component scan: what the OCR read off the character inventory's tooltip (Rust:
// components.rs, event "components-read") turned into sightings of components, and the sightings
// into proposals, one per tile. Pure (tested from test/companion-components.test.ts): no Vue, no
// Tauri.
//
// The tooltip's title names the component with the game's "class/size/grade" prefix ("Mil/3/A
// Blizzard"); the stat lines show absolute values ("Coolant Rating: 67.50"), the stock keeps a crafted
// component's gain over the unmodified value (`CatalogStat.base`: "12.5" = +12.5 %, power pips in
// steps), so each read stat is converted; a tooltip without stat lines is a looted component (no
// stats). A tile's identity is its page and cell plus what it holds: the same tile hovered again is
// the same sighting, two equal components in two tiles are two. A sighting counts only once two
// reads in a row agree (an OCR glitch in one read books nothing).
import { norm } from "../../src/stock/material-names.ts";
import type { CatalogResponse, CatalogStat, StockAddRequest } from "../../src/webapp/api-types.ts";

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

export interface ComponentReadEvent {
  atMs: number;
  ms: number;
  width: number;
  height: number;
  tooltip: ReadTooltip | null;
  page: { index: number; total: number } | null;
  // The storage grid's cell under the mouse cursor; null outside it
  cell: { row: number; col: number } | null;
  cursor: [number, number] | null;
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
}

export interface ComponentCatalog {
  components: ComponentDef[];
  // Crafted property UUID -> its normalized names in every language and the player's pack
  statNames: Map<string, Set<string>>;
}

/** The loc keys of the stat names (for the player's language pack). */
export function statNameKeys(responses: CatalogResponse[]): string[] {
  const keys = new Set<string>();
  for (const r of responses) for (const m of r.materials) for (const s of m.stats) if (s.nameKey) keys.add(s.nameKey);
  return [...keys];
}

/** The components and stat names from the web app's catalog (each language) and the player's own texts. */
export function buildComponentCatalog(responses: CatalogResponse[], gameNames: Record<string, string>): ComponentCatalog {
  const byUuid = new Map<string, ComponentDef>();
  const statNames = new Map<string, Set<string>>();
  for (const r of responses) {
    for (const m of r.materials) {
      if (!m.component) continue;
      const def = byUuid.get(m.uuid) ?? { uuid: m.uuid, label: m.label, names: new Set<string>(), size: m.size, gradeLetter: m.gradeLetter, stats: m.stats };
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

// "Ind/1/B Guardian", "Mil/3/A JS-500", "Sth/2/B Bolt"
const PREFIX = /^[A-Za-z]{3}\/(\d+)\/([A-Z])\s+(.+)$/;

/** The components a tooltip title can mean: none, one, or several (the prefix's size and grade narrow them). */
export function findComponents(cat: ComponentCatalog, title: string): ComponentDef[] {
  const prefix = PREFIX.exec(title.trim());
  let hits = cat.components.filter((c) => c.names.has(norm(title)));
  if (!hits.length && prefix) hits = cat.components.filter((c) => c.names.has(norm(prefix[3]!)));
  if (hits.length > 1 && prefix) {
    const narrowed = hits.filter((c) => c.size === Number(prefix[1]) && c.gradeLetter === prefix[2]);
    if (narrowed.length) hits = narrowed;
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
 * no gain; null when it cannot be: no base known, no number, below the base beyond rounding, or
 * above what the blueprint can make. */
export function statFromTooltip(stat: CatalogStat, value: string): string | null {
  const v = parseNumber(value);
  if (v === null || stat.base === null || stat.base <= 0) return null;
  if (stat.kind === "multiplier") {
    const pct = Math.round((v / stat.base - 1) * 1000) / 10;
    if (pct < -0.5 || pct > stat.max + 0.05) return null;
    return pct <= 0 ? "0" : String(pct);
  }
  const steps = Math.round(v - stat.base);
  if (steps < 0 || steps > stat.max) return null;
  return String(steps);
}

export type StatsResult = { stats: Record<string, string>; unreadable: string[] };

/** The component's stats in the tooltip's lines: {property UUID: gain}, only gains; `unreadable` names
 * the stats whose line could not be turned into one. Lines of other labels are ignored. */
export function statsOf(def: ComponentDef, lines: string[], cat: ComponentCatalog): StatsResult {
  const stats: Record<string, string> = {};
  const unreadable: string[] = [];
  const fields = lines.map(parseField).filter((f): f is Field => f !== null);
  for (const s of def.stats) {
    const names = cat.statNames.get(s.uuid);
    const field = names && fields.find((f) => names.has(norm(f.label)));
    if (!field) continue;
    const value = statFromTooltip(s, field.value);
    if (value === null) unreadable.push(s.name);
    else if (value !== "0") stats[s.uuid] = value;
  }
  return { stats: Object.fromEntries(Object.entries(stats).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), unreadable };
}

// --- sightings -------------------------------------------------------------------------------------

export type ComponentProblem = "unknownComponent" | "ambiguousComponent" | "statsUnreadable";

export interface ComponentSighting {
  // page | row | col | component (or title) | stats
  key: string;
  // As the tooltip shows it
  title: string;
  componentUuid: string | null;
  // The catalog's label, else the title
  label: string;
  // The gains read off the tooltip ({} = none); null while unreadable
  stats: Record<string, string> | null;
  // The stats that could not be read
  unreadable: string[];
  page: number | null;
  row: number;
  col: number;
  atMs: number;
  problem: ComponentProblem | null;
}

/** The sighting in a read: the tooltip at the cursor's cell; null without both. */
export function sightingOf(e: ComponentReadEvent, cat: ComponentCatalog): ComponentSighting | null {
  if (!e.tooltip || !e.cell) return null;
  const title = e.tooltip.title.trim();
  const hits = findComponents(cat, title);
  const def = hits.length === 1 ? hits[0]! : null;
  const read = def ? statsOf(def, e.tooltip.lines.map((l) => l.text), cat) : { stats: {}, unreadable: [] };
  const problem: ComponentProblem | null = !hits.length ? "unknownComponent" : !def ? "ambiguousComponent" : read.unreadable.length ? "statsUnreadable" : null;
  const page = e.page?.index ?? null;
  const stats = problem ? null : read.stats;
  return {
    key: `${page ?? "?"}|${e.cell.row}|${e.cell.col}|${def?.uuid ?? norm(title)}|${stats ? JSON.stringify(stats) : "-"}`,
    title,
    componentUuid: def?.uuid ?? null,
    label: def?.label ?? title,
    stats,
    unreadable: read.unreadable,
    page,
    row: e.cell.row,
    col: e.cell.col,
    atMs: e.atMs,
    problem,
  };
}

/** The sightings of one scan session, by key. */
export class ComponentScan {
  readonly sightings = new Map<string, ComponentSighting>();
  // The last read's sighting, waiting for a second read that agrees
  private pending: ComponentSighting | null = null;

  /** Takes a read in; the sighting it added, null when nothing changed (the same tile read again, or
   * a first read still waiting for its confirmation). A tile read anew with other content replaces
   * what that tile held before (the previous sighting of that page and cell goes). */
  feed(e: ComponentReadEvent, cat: ComponentCatalog): ComponentSighting | null {
    const s = sightingOf(e, cat);
    if (!s) return null;
    if (this.sightings.has(s.key)) return null;
    if (this.pending?.key !== s.key) {
      this.pending = s;
      return null;
    }
    this.pending = null;
    for (const [key, o] of this.sightings) {
      if (o.page === s.page && o.row === s.row && o.col === s.col) this.sightings.delete(key);
    }
    this.sightings.set(s.key, s);
    return s;
  }

  clear() {
    this.sightings.clear();
    this.pending = null;
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
  stats: Record<string, string>;
}

/** One proposal per complete sighting (one piece each). */
export function proposalsOf(sightings: Iterable<ComponentSighting>): ComponentProposal[] {
  const out: ComponentProposal[] = [];
  for (const s of sightings) {
    if (s.problem || !s.componentUuid || !s.stats) continue;
    out.push({ id: s.key, componentUuid: s.componentUuid, label: s.label, stats: s.stats });
  }
  return out;
}

/** The add for a proposal: one piece, no quality, its stats, shared right away in `guildIds` (none: unshared). */
export function addRequest(p: ComponentProposal, locationUuid: string, guildIds: string[] = []): StockAddRequest {
  const req: StockAddRequest = { subjectUuid: p.componentUuid, locationUuid, quality: 0, amount: "1" };
  if (Object.keys(p.stats).length) req.stats = p.stats;
  return guildIds.length ? { ...req, guildIds } : req;
}
