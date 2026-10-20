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
// quality and column, and a certain read replaces it. A sighting counts once two reads in a row of
// the same hovered tile produced the same key (an OCR glitch in one read, "56" for "561", books
// nothing; right after a move the game may still show the previous tile's tooltip, for one read so
// far: that read disagrees with the next).
import { findMaterial, type MaterialNames } from "../../src/stock/material-names.ts";
import type { StockAddRequest, StockBatch } from "../../src/webapp/api-types.ts";
import type { ComponentRead } from "./components.ts";
import type { Overview } from "./refinery.ts";

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
  // null: no warehouse grid in the frame (or the frame was read as the character inventory)
  grid: ReadGrid | null;
  // The character inventory's read; null when the frame was read as the warehouse
  components: ComponentRead | null;
  // The mouse cursor in frame pixels, if known
  cursor: [number, number] | null;
  // Every text the OCR detected
  boxes: ReadBox[];
  // While debugging: the frame as a JPEG data URL (1280 px wide)
  frame: string | null;
  // A refinery read (only while debugging; the sync gets "refinery-overview"): overview, terminal without work orders, nothing
  refinery: { kind: "overview" | "terminal" | "nothing"; overview: Overview | null } | null;
}

// --- sightings -------------------------------------------------------------------------------------

export type Unit = "SCU" | "pcs";

// "component": a ship component, which only the components scan (the character inventory) books
// amountFlicker: the same stack confirmed with two counts, one a digit short of the other ("X1"/"X10")
export type SightingProblem = "unknownMaterial" | "component" | "noQuality" | "noAmount" | "amountFlicker";

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

/** Where the hovered tile sits in the frame (its centre) and the grid's pitch; null without one. */
function hoveredSpot(e: InventoryReadEvent): { x: number; y: number; px: number; py: number } | null {
  const tile = e.grid?.tiles.find((t) => t.hovered);
  if (!e.grid || !tile) return null;
  return { x: (tile.rect.x0 + tile.rect.x1) / 2, y: (tile.rect.y0 + tile.rect.y1) / 2, px: e.grid.pitchX, py: e.grid.pitchY };
}

/** The sightings of one scan session, by key. */
export class InventoryScan {
  readonly sightings = new Map<string, Sighting>();
  // The last read's sighting, waiting for a second read that agrees
  private pending: Sighting | null = null;
  // The last read's hovered tile: the two agreeing reads must be of one tile (right after a move the
  // game may still show the previous tile's tooltip, for one read so far). By its place in the
  // frame, not its row: the grid is fitted per frame, a partly visible top row shifts the rows
  private lastSpot: { x: number; y: number } | null = null;

  /** Takes a read in; the sighting it added or changed, null when nothing changed (the same stack
   * read again, a first read still waiting for its confirmation, or one `accept` turns down). An
   * uncertain count merges into a certain read of the same material, quality and column, and a
   * certain read replaces an uncertain one. */
  feed(e: InventoryReadEvent, cat: InventoryCatalog, accept: (s: Sighting) => boolean = () => true): Sighting | null {
    const spot = hoveredSpot(e);
    const last = this.lastSpot;
    const stayed = !!spot && !!last && Math.abs(spot.x - last.x) < spot.px / 2 && Math.abs(spot.y - last.y) < spot.py / 2;
    this.lastSpot = spot;
    // On another tile than the read before: whatever waited was another tile's
    if (!stayed) this.pending = null;
    const s = sightingOf(e, cat);
    if (!s || !accept(s)) return null;
    if (this.sightings.has(s.key)) return null;
    // Two reads in a row of one tile must agree
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
    // A count whose digit got lost in some reads ("X1" and "X10" of one stack, both confirmed): neither
    // is booked
    const lostDigit = (a: string, b: string) => a !== b && (a.startsWith(b) || b.startsWith(a));
    for (const o of this.sightings.values()) {
      if (s.unit === "pcs" && o.unit === "pcs" && same(o) && o.amount !== null && s.amount !== null && lostDigit(o.amount, s.amount)) {
        o.problem = "amountFlicker";
        s.problem = "amountFlicker";
      }
    }
    this.sightings.set(s.key, s);
    return s;
  }

  clear() {
    this.sightings.clear();
    this.pending = null;
    this.lastSpot = null;
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
  const stored = storedAt(batches, locationUuid);
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

/** Your stored stock at the location per material and quality ("<uuid>:<quality>" -> micro units). */
function storedAt(batches: StockBatch[], locationUuid: string): Map<string, bigint> {
  const stored = new Map<string, bigint>();
  for (const b of batches) {
    if (b.state !== "stored" || !b.canChange || b.locationUuid !== locationUuid) continue;
    const id = `${b.subjectUuid}:${b.quality}`;
    stored.set(id, (stored.get(id) ?? 0n) + toMicro(b.quantity));
  }
  return stored;
}

/** The proposals (newest first, as listed) the stored stock at the location already holds: per
 * material and quality the ones registered here first, then the earliest seen, each as long as what is
 * stored still covers its amount; the others are new. A registered one always counts. */
export function inStockOf(proposals: Proposal[], batches: StockBatch[], locationUuid: string, registered: ReadonlySet<string>): Set<string> {
  const left = storedAt(batches, locationUuid);
  // Stable: the registered first, each part oldest first
  const order = [...proposals].reverse().sort((a, b) => Number(registered.has(b.id)) - Number(registered.has(a.id)));
  const out = new Set<string>();
  for (const p of order) {
    const id = `${p.materialUuid}:${p.quality}`;
    const have = left.get(id) ?? 0n;
    const need = toMicro(p.amount);
    if (!registered.has(p.id) && have < need) continue;
    out.add(p.id);
    left.set(id, have > need ? have - need : 0n);
  }
  return out;
}

/** The add for a proposal, shared right away in `guildIds` (none: unshared). */
export function addRequest(p: Proposal, locationUuid: string, guildIds: string[] = []): StockAddRequest {
  const req: StockAddRequest = { subjectUuid: p.materialUuid, locationUuid, quality: p.quality, amount: p.amount };
  return guildIds.length ? { ...req, guildIds } : req;
}
