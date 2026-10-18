// The inventory scan: what the OCR read off the freight manager's warehouse (Rust: inventory.rs,
// event "inventory-read") turned into sightings of stacks, and the sightings into proposals, one
// per stack (nothing is summed up). Pure (tested from test/companion-inventory.test.ts): no Vue, no
// Tauri.
//
// A sighting needs the tooltip of the hovered tile (the name, for materials the chip's quality and
// the stack's SCU) and that tile (the column, the badge's count). A stack's identity is its content
// in its column: material (or name), quality, amount and column; scrolling only moves tiles
// vertically, so a tile hovered again after a scroll is the same sighting, while equal stacks in
// different columns stay apart (equal stacks in one column collapse: a known limit). A read whose
// count badge had no digits is uncertain: it merges with a certain read of the same material,
// quality and column, and a certain read replaces it. A sighting counts only once two reads in a row
// produced the same key (an OCR glitch in one read, "56" for "561", books nothing).
import { findMaterial, type MaterialNames } from "../../src/stock/material-names.ts";
import type { StockAddRequest, StockBatch } from "../../src/webapp/api-types.ts";

// --- what the OCR sends ------------------------------------------------------------------------------

export interface ReadRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ReadTile {
  rect: ReadRect;
  col: number;
  row: number;
  // null: no quality text (an item, or hidden by the tooltip)
  quality: number | null;
  qualityAmbiguous: boolean;
  // The badge's count; null when unreadable
  count: number | null;
  // The badge read "X" without digits (taken as 1)
  countUncertain: boolean;
  hovered: boolean;
  qualityText: string;
  badgeText: string;
}

export interface ReadTooltip {
  name: string;
  quality: number | null;
  // The stack's amount in SCU (SCU materials; "0.001" for one piece of an item material)
  scu: string | null;
  x: number;
  y: number;
  rect: ReadRect;
}

export interface ReadCell {
  row: number;
  col: number;
  kind: "badge" | "quality";
  rect: ReadRect;
  text: string;
  score: number;
}

export interface ReadGrid {
  tiles: ReadTile[];
  tooltip: ReadTooltip | null;
  cells: ReadCell[];
  cols: number[];
  rows: number[];
  pitchX: number;
  pitchY: number;
}

export interface ReadBox {
  rect: ReadRect;
  text: string;
  score: number;
}

export interface InventoryReadEvent {
  atMs: number;
  // The read's duration
  ms: number;
  width: number;
  height: number;
  // null: no warehouse grid in the frame
  grid: ReadGrid | null;
  // Every text the OCR detected
  boxes: ReadBox[];
  // While debugging: the frame as a JPEG data URL (1280 px wide)
  frame: string | null;
}

// --- sightings -------------------------------------------------------------------------------------

export type Unit = "SCU" | "pcs";

// "component": a ship component, which only the components scan (the character inventory) books
export type SightingProblem = "unknownMaterial" | "component" | "noQuality" | "noAmount";

export interface Sighting {
  // col | material (or normalized name) | quality | amount
  key: string;
  // The last read's cell
  row: number;
  col: number;
  // As the tooltip shows it
  name: string;
  // null when the name is not in the catalog
  materialUuid: string | null;
  // The chip's, else the tile's; null for items without one (open: what to book them with)
  quality: number | null;
  // SCU (decimal text) for SCU materials, the badge's count for the rest; null when neither was read
  amount: string | null;
  unit: Unit;
  // The count came from a badge read without digits
  amountUncertain: boolean;
  atMs: number;
  // Why it yields no proposal
  problem: SightingProblem | null;
}

/** What the sightings need from the catalog. */
export interface InventoryCatalog {
  // Every bookable material (resources and items) by name in every language and the player's pack
  materials: MaterialNames;
  // Material UUID -> its unit
  units: Map<string, Unit>;
  // The ship components among them (never booked from the warehouse)
  components: Set<string>;
}

/** The sighting in a read: the tooltip's item at the hovered tile; null without both. */
export function sightingOf(e: InventoryReadEvent, cat: InventoryCatalog): Sighting | null {
  const grid = e.grid;
  if (!grid?.tooltip) return null;
  const tile = grid.tiles.find((t) => t.hovered);
  if (!tile) return null;
  const tip = grid.tooltip;
  const materialUuid = findMaterial(cat.materials, tip.name);
  const unit: Unit = (materialUuid && cat.units.get(materialUuid)) || "pcs";
  const quality = tip.quality ?? tile.quality;
  const amount = unit === "SCU" ? tip.scu : tile.count === null ? null : String(tile.count);
  const problem: SightingProblem | null = !materialUuid ? "unknownMaterial" : cat.components.has(materialUuid) ? "component" : quality === null ? "noQuality" : amount === null ? "noAmount" : null;
  const amountUncertain = unit === "pcs" && tile.countUncertain;
  return {
    key: sightingKey(tile.col, materialUuid ?? tip.name.trim().toUpperCase(), quality, amount),
    row: tile.row,
    col: tile.col,
    name: tip.name.trim(),
    materialUuid,
    quality,
    amount,
    unit,
    amountUncertain,
    atMs: e.atMs,
    problem,
  };
}

const sightingKey = (col: number, material: string, quality: number | null, amount: string | null) => `${col}|${material}|${quality ?? "-"}|${amount ?? "-"}`;

/** The sightings of one scan session, by key. */
export class InventoryScan {
  readonly sightings = new Map<string, Sighting>();
  // The last read's sighting, waiting for a second read that agrees
  private pending: Sighting | null = null;

  /** Takes a read in; the sighting it added or changed, null when nothing changed (the same stack
   * read again, or a first read still waiting for its confirmation). An uncertain count merges into
   * a certain read of the same material, quality and column, and a certain read replaces an
   * uncertain one. */
  feed(e: InventoryReadEvent, cat: InventoryCatalog): Sighting | null {
    const s = sightingOf(e, cat);
    if (!s) return null;
    if (this.sightings.has(s.key)) return null;
    // Two reads in a row must agree
    if (this.pending?.key !== s.key) {
      this.pending = s;
      return null;
    }
    this.pending = null;
    const same = (o: Sighting) => o.col === s.col && o.quality === s.quality && (o.materialUuid ?? o.name.toUpperCase()) === (s.materialUuid ?? s.name.toUpperCase());
    const twin = [...this.sightings.values()].find((o) => same(o) && (o.amountUncertain || s.amountUncertain));
    if (twin) {
      // The certain one stays (or comes in)
      if (!twin.amountUncertain && s.amountUncertain) return null;
      this.sightings.delete(twin.key);
    }
    this.sightings.set(s.key, s);
    return s;
  }

  clear() {
    this.sightings.clear();
    this.pending = null;
  }

  /** Newest first. */
  list(): Sighting[] {
    return [...this.sightings.values()].sort((a, b) => b.atMs - a.atMs);
  }
}

// --- amounts (exact: micro units as BigInt, like the planner) ----------------------------------------

const MICRO = 1_000_000n;

/** "0.263" -> 263000n; up to 6 decimals, comma or point. */
export function toMicro(text: string): bigint {
  const t = text.trim().replace(",", ".");
  const parts = t.split(".");
  if (parts.length > 2) throw new Error(`not an amount: ${text}`);
  const [whole, frac = ""] = parts;
  if (!/^\d+$/.test(whole || "0") || !/^\d*$/.test(frac) || frac.length > 6) throw new Error(`not an amount: ${text}`);
  return BigInt(whole || "0") * MICRO + BigInt((frac + "000000").slice(0, 6));
}

/** 263000n -> "0.263" (no trailing zeros). */
export function fromMicro(v: bigint): string {
  const whole = v / MICRO;
  const frac = (v % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

// --- proposals -------------------------------------------------------------------------------------

export interface Proposal {
  // The sighting's key
  id: string;
  materialUuid: string;
  quality: number;
  unit: Unit;
  // This stack's amount
  amount: string;
  amountUncertain: boolean;
  // What the user's stored stock at the location already holds of this material and quality
  stored: string;
}

/** One proposal per complete sighting, with the stock's total of that material and quality at the
 * location for the user to judge (your own stored batches; shared ones are yours too). */
export function proposalsOf(sightings: Iterable<Sighting>, batches: StockBatch[], locationUuid: string): Proposal[] {
  const stored = new Map<string, bigint>();
  for (const b of batches) {
    if (b.state !== "stored" || !b.canChange || b.locationUuid !== locationUuid) continue;
    const id = `${b.subjectUuid}:${b.quality}`;
    stored.set(id, (stored.get(id) ?? 0n) + toMicro(b.quantity));
  }
  const out: Proposal[] = [];
  for (const s of sightings) {
    if (s.problem || !s.materialUuid || s.quality === null || s.amount === null) continue;
    out.push({
      id: s.key,
      materialUuid: s.materialUuid,
      quality: s.quality,
      unit: s.unit,
      amount: s.amount,
      amountUncertain: s.amountUncertain,
      stored: fromMicro(stored.get(`${s.materialUuid}:${s.quality}`) ?? 0n),
    });
  }
  return out;
}

/** The add for a proposal, shared right away in `guildIds` (none: unshared). */
export function addRequest(p: Proposal, locationUuid: string, guildIds: string[] = []): StockAddRequest {
  const req: StockAddRequest = { subjectUuid: p.materialUuid, locationUuid, quality: p.quality, amount: p.amount };
  return guildIds.length ? { ...req, guildIds } : req;
}
