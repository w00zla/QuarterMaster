// Ship component stats: what a crafted component's stat can be, from its blueprint's modifiers, and
// how a stored value reads. Pure: shared by the server (catalog, booking check) and the web app.
// A stat is stored like the crafting check shows it: a multiplier as its change in percent ("12.5" =
// +12.5 %, one decimal), additive steps as a whole number ("1" = +1 power pip).
import type { ModifierRange } from '../planner/types.ts';

export interface StatBounds {
  kind: 'multiplier' | 'additive';
  // In the stored unit: percent change (multiplier) or steps (additive), from no change to the best:
  // min is 0 when the best is a gain, max is 0 when it is a drop (recoil, quantum fuel burn)
  min: number;
  max: number;
}

// One decimal of a percent, rounded away from 0, so the edge (rounded the same way) stays inside
const outward = (x: number) => Math.sign(x) * Math.ceil(Math.abs(x) * 10 - 1e-9) / 10;

/** One slot's modifier at Q1000 (the end of its highest range), with its kind; null for unknown or mixed types. */
function slotBest(ranges: ModifierRange[]): { kind: StatBounds['kind']; value: number } | null {
  const kinds = new Set(ranges.map((r) => r.type));
  if (kinds.size !== 1) return null;
  const [type] = kinds;
  const key = type === 'Linear' ? 'modifierAtEnd' : type === 'LinearIntegerAdditive' ? 'additiveModifierAtEnd' : null;
  const top = ranges.reduce<ModifierRange | null>((a, r) => (!a || r.endQuality > a.endQuality ? r : a), null);
  const value = key && top ? top.values[key] : undefined;
  if (typeof value !== 'number') return null;
  return { kind: type === 'Linear' ? 'multiplier' : 'additive', value };
}

/**
 * What one stat can be on a component crafted from one blueprint: `slots` = per slot the ranges of
 * this stat there. Slots combine as in the crafting check (ASSUMPTION, unverified in game: multipliers
 * multiply, steps add up). Only improvements count (decided 2026-10-18: a crafted component is never
 * recorded worse than a looted one, so the bounds start at no change). The improvement is what Q1000
 * makes of it (decided 2026-10-22): a gain for most stats, a drop for recoil (1.4 at Q0, 0.6 at Q1000)
 * and quantum fuel burn. Null when nothing can improve it (a flat range) or the data is unknown. A
 * slot without any range changes nothing (decided 2026-10-22: most armor's "Panel Covering" names the
 * damage mitigation with `valueRanges: [null]`; it no longer hides the other slot's range).
 */
export function statBounds(slots: ModifierRange[][]): StatBounds | null {
  const best = slots.filter((s) => s.length).map(slotBest);
  if (!best.length || best.some((s) => !s) || new Set(best.map((s) => s!.kind)).size !== 1) return null;
  const kind = best[0]!.kind;
  const change = kind === 'multiplier' ? outward((best.reduce((a, s) => a * s!.value, 1) - 1) * 100) : best.reduce((a, s) => a + s!.value, 0);
  if (change === 0) return null;
  return change > 0 ? { kind, min: 0, max: change } : { kind, min: change, max: 0 };
}

/** The best a stat can be (max for a gain, min for a drop). */
export const statBest = (bounds: StatBounds): number => (bounds.min < 0 ? bounds.min : bounds.max);

/** Bounds of a stat over several blueprints of one component: the widest; null if they disagree on the kind. */
export function unionBounds(all: StatBounds[]): StatBounds | null {
  if (!all.length || new Set(all.map((b) => b.kind)).size !== 1) return null;
  return { kind: all[0]!.kind, min: Math.min(...all.map((b) => b.min)), max: Math.max(...all.map((b) => b.max)) };
}

/**
 * A typed stat value as stored ("12.5", "-3", "1"), or null when it does not fit: a multiplier takes
 * one decimal at most, steps whole numbers, both within the bounds.
 */
export function statValue(bounds: StatBounds, text: string): string | null {
  const t = text.trim().replace(',', '.');
  const ok = bounds.kind === 'multiplier' ? /^[+-]?\d{1,4}(\.\d)?$/.test(t) : /^[+-]?\d{1,4}$/.test(t);
  if (!ok) return null;
  const n = Number(t);
  if (n < bounds.min || n > bounds.max) return null;
  // "+0", "-0.0", "05" → "0"
  return String(n === 0 ? 0 : n);
}

/** A stored value as shown: "+12.5 %", "−3 %" (multiplier), "+1" (steps). */
export function statValueText(kind: StatBounds['kind'], value: string): string {
  const n = Number(value);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
  const abs = kind === 'multiplier' ? Math.abs(n).toFixed(1) : String(Math.abs(n));
  return kind === 'multiplier' ? `${sign}${abs} %` : `${sign}${abs}`;
}

/**
 * Stored stats with their names in the order of `named` (a component's stats from the catalog):
 * "Coolant Rating +5.0 % · Power Pips +1"; a stat the catalog no longer lists shows "? 5"; "" without.
 */
export function statsText(named: { uuid: string; name: string; kind: StatBounds['kind'] }[], stats: Record<string, string> | null): string {
  if (!stats) return '';
  const known = named.filter((s) => s.uuid in stats).map((s) => `${s.name} ${statValueText(s.kind, stats[s.uuid]!)}`);
  const other = Object.keys(stats).filter((k) => !named.some((s) => s.uuid === k)).map((k) => `? ${stats[k]}`);
  return [...known, ...other].join(' · ');
}
