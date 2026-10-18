// Ship component stats: what a crafted component's stat can be, from its blueprint's modifiers, and
// how a stored value reads. Pure: shared by the server (catalog, booking check) and the web app.
// A stat is stored like the crafting check shows it: a multiplier as its change in percent ("12.5" =
// +12.5 %, one decimal), additive steps as a whole number ("1" = +1 power pip).
import type { ModifierRange } from '../planner/types.ts';

export interface StatBounds {
  kind: 'multiplier' | 'additive';
  // In the stored unit: percent change (multiplier) or steps (additive); min is always 0 (only improvements)
  min: number;
  max: number;
}

// One decimal of a percent; rounded up, so the edge stays inside
const up = (x: number) => Math.ceil(x * 10 - 1e-9) / 10;

/** The modifier values of one slot's ranges, with their kind; null for unknown or mixed types. */
function slotSpan(ranges: ModifierRange[]): { kind: StatBounds['kind']; min: number; max: number } | null {
  const kinds = new Set(ranges.map((r) => r.type));
  if (kinds.size !== 1) return null;
  const [type] = kinds;
  const keys = type === 'Linear' ? ['modifierAtStart', 'modifierAtEnd'] : type === 'LinearIntegerAdditive' ? ['additiveModifierAtStart', 'additiveModifierAtEnd'] : null;
  if (!keys) return null;
  const values = ranges.flatMap((r) => keys.map((k) => r.values[k])).filter((v): v is number => typeof v === 'number');
  if (!values.length) return null;
  return { kind: type === 'Linear' ? 'multiplier' : 'additive', min: Math.min(...values), max: Math.max(...values) };
}

/**
 * What one stat can be on a component crafted from one blueprint: `slots` = per slot the ranges of
 * this stat there. Slots combine as in the crafting check (ASSUMPTION, unverified in game: multipliers
 * multiply, steps add up). Only improvements count (decided 2026-10-18: a crafted component is never
 * recorded worse than a looted one, so the bounds start at no change). Null when nothing can improve
 * it (a flat range) or the data is unknown.
 */
export function statBounds(slots: ModifierRange[][]): StatBounds | null {
  const spans = slots.map(slotSpan);
  if (!spans.length || spans.some((s) => !s) || new Set(spans.map((s) => s!.kind)).size !== 1) return null;
  const kind = spans[0]!.kind;
  const max = kind === 'multiplier' ? up((spans.reduce((a, s) => a * s!.max, 1) - 1) * 100) : spans.reduce((a, s) => a + s!.max, 0);
  return max > 0 ? { kind, min: 0, max } : null;
}

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
