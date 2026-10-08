// Crafting planner logic: material totals and quality-dependent stat modifiers.
// Pure and dependency-free, so the server, the web UI and the bot run the same code.
import type {
  Material, ModifierRange, PlanEntry, PlannerData, PlannerModifier, PlannerRecipe, PlanResult, PlanWarning, SlotResult, StatResult,
} from './types.ts';

export const MIN_QUALITY = 0;
export const MAX_QUALITY = 1000;

// --- exact decimals ------------------------------------------------------------------
// Quantities are decimal strings ("0.0075"); sums and products stay exact as integers of
// millionths (more than enough: the smallest recipe amount is 0.005 SCU).

const SCALE = 1_000_000n;

export function toMicros(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid decimal "${value}"`);
  const micros = BigInt(m[2]!) * SCALE + BigInt((m[3] ?? '').padEnd(6, '0'));
  return m[1] ? -micros : micros;
}

export function formatMicros(micros: bigint): string {
  const sign = micros < 0n ? '-' : '';
  const abs = micros < 0n ? -micros : micros;
  const fraction = (abs % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${abs / SCALE}${fraction ? `.${fraction}` : ''}`;
}

// --- modifiers -----------------------------------------------------------------------

export interface ModifierValue {
  kind: 'multiplier' | 'additive';
  value: number;
}

const clampQuality = (q: number) => Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, Math.round(q)));

/** Modifier at a quality; null for unknown range types or a quality outside every range. */
export function modifierAt(ranges: ModifierRange[], quality: number): ModifierValue | null {
  const q = clampQuality(quality);
  // Ranges are integer-bounded (0–500, 501–1000) and the quality is an integer
  const range = ranges.find((r) => q >= r.startQuality && q <= r.endQuality);
  if (!range) return null;
  const span = range.endQuality - range.startQuality;
  const t = span > 0 ? (q - range.startQuality) / span : 0;
  const lerp = (a: number | undefined, b: number | undefined) =>
    a === undefined || b === undefined ? null : a + (b - a) * t;
  if (range.type === 'Linear') {
    const v = lerp(range.values.modifierAtStart, range.values.modifierAtEnd);
    return v === null ? null : { kind: 'multiplier', value: v };
  }
  if (range.type === 'LinearIntegerAdditive') {
    const v = lerp(range.values.additiveModifierAtStart, range.values.additiveModifierAtEnd);
    return v === null ? null : { kind: 'additive', value: Math.round(v) };
  }
  return null;
}

const NEUTRAL = { multiplier: 1, additive: 0 } as const;

/**
 * Combines one stat's modifiers from several slots.
 * ASSUMPTION (unverified in game): multipliers multiply, additive steps add up.
 */
export function combine(kind: 'multiplier' | 'additive', values: number[]): number {
  return kind === 'multiplier' ? values.reduce((a, b) => a * b, 1) : values.reduce((a, b) => a + b, 0);
}

/** +1 when higher quality raises the stat, -1 when it lowers it, 0 when flat or unknown. */
function qualityDirection(modifier: PlannerModifier): number {
  const low = modifierAt(modifier.ranges, MIN_QUALITY);
  const high = modifierAt(modifier.ranges, MAX_QUALITY);
  return low && high ? Math.sign(high.value - low.value) : 0;
}

// --- plan ------------------------------------------------------------------------------

/** A warning in English (the admin UI's language). */
export function warningText(w: PlanWarning): string {
  switch (w.code) {
    case 'slots': return `${w.required} of ${w.total} slots must be chosen; using the first ${w.required}`;
    case 'retired': return 'This blueprint is no longer in the game data';
    case 'alternatives': return `Slot ${w.slot} offers alternatives; using the first`;
    case 'belowMin': return `Quality ${w.quality} is below the minimum for slot ${w.slot}`;
    case 'unsupported': return `Stat ${w.stat}: unsupported modifier in slot ${w.slot}`;
  }
}

/** Slot indexes used for a recipe: the chosen ones when valid, otherwise the first N. */
export function selectedSlots(recipe: PlannerRecipe, chosen: number[] | undefined, warnings: PlanWarning[]): Set<number> {
  const all = recipe.slots.map((s) => s.index);
  if (recipe.requiredSlots >= all.length) return new Set(all);
  if (chosen) {
    const valid = [...new Set(chosen)].filter((i) => all.includes(i));
    if (valid.length === recipe.requiredSlots) return new Set(valid);
    warnings.push({ code: 'slots', required: recipe.requiredSlots, total: all.length });
  }
  return new Set(all.slice(0, recipe.requiredSlots));
}

export function computePlan(data: PlannerData, entries: PlanEntry[]): PlanResult {
  const recipes = new Map(data.recipes.map((r) => [r.uuid, r]));
  const materials = new Map<string, Material & { micros: bigint }>();
  const result: PlanResult = { entries: [], materials: [], craftSeconds: 0, warnings: [] };

  for (const entry of entries) {
    const recipe = recipes.get(entry.blueprintUuid);
    if (!recipe) {
      result.warnings.push({ code: 'notInCatalog', blueprintUuid: entry.blueprintUuid });
      continue;
    }
    const count = Math.max(0, Math.floor(entry.count));
    const warnings: PlanWarning[] = [];
    if (recipe.retired) warnings.push({ code: 'retired' });
    const selected = selectedSlots(recipe, entry.slots, warnings);

    const slots: SlotResult[] = [];
    const statParts = new Map<string, { modifier: PlannerModifier; kind: ModifierValue['kind']; perSlot: { slotIndex: number; value: number }[] }>();
    for (const slot of recipe.slots) {
      const isSelected = selected.has(slot.index);
      const quality = clampQuality(entry.quality?.[slot.index] ?? data.defaultQuality);
      // A slot takes `requiredCount` of its inputs; alternatives do not occur in the game data yet
      const inputs = slot.inputs.slice(0, Math.max(1, slot.requiredCount));
      if (slot.inputs.length > inputs.length) warnings.push({ code: 'alternatives', slot: slot.name });
      const belowMinQuality = inputs.some((i) => quality < i.minQuality);
      if (isSelected && belowMinQuality) warnings.push({ code: 'belowMin', quality, slot: slot.name });
      slots.push({
        index: slot.index,
        key: slot.key,
        name: slot.name,
        selected: isSelected,
        quality,
        inputs: inputs.map((i) => ({ ...i, total: formatMicros(toMicros(i.quantity) * BigInt(count)) })),
        belowMinQuality,
      });
      if (!isSelected) continue;

      for (const input of inputs) {
        const id = `${input.kind}:${input.uuid}`;
        const micros = toMicros(input.quantity) * BigInt(count);
        const m = materials.get(id) ?? {
          kind: input.kind, uuid: input.uuid, key: input.key, name: input.name, total: '0', minQuality: 0, usedBy: [], micros: 0n,
        };
        m.micros += micros;
        m.minQuality = Math.max(m.minQuality, input.minQuality);
        m.usedBy.push({ blueprintUuid: recipe.uuid, name: recipe.name, count, total: formatMicros(micros) });
        materials.set(id, m);
      }
      for (const modifier of slot.modifiers) {
        // The game data leaves some modifiers without a curve: no effect
        if (modifier.ranges.length === 0) continue;
        const v = modifierAt(modifier.ranges, quality);
        if (!v) {
          warnings.push({ code: 'unsupported', stat: modifier.name, slot: slot.name });
          continue;
        }
        const part = statParts.get(modifier.propertyUuid) ?? { modifier, kind: v.kind, perSlot: [] };
        part.perSlot.push({ slotIndex: slot.index, value: v.value });
        statParts.set(modifier.propertyUuid, part);
      }
    }

    const stats: StatResult[] = [...statParts.values()].map(({ modifier, kind, perSlot }) => {
      const value = combine(kind, perSlot.map((p) => p.value));
      const direction = qualityDirection(modifier);
      const delta = Math.sign(value - NEUTRAL[kind]);
      return {
        propertyUuid: modifier.propertyUuid,
        key: modifier.key,
        name: modifier.name,
        unit: modifier.unit,
        kind,
        value,
        perSlot,
        favorable: direction === 0 || delta === 0 ? null : delta === direction,
      };
    });

    const craftSeconds = recipe.craftSeconds * count;
    result.craftSeconds += craftSeconds;
    result.entries.push({ blueprintUuid: recipe.uuid, name: recipe.name, count, craftSeconds, slots, stats, warnings });
  }

  result.materials = [...materials.values()]
    .map(({ micros, ...m }) => ({ ...m, total: formatMicros(micros) }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'resource' ? -1 : 1));
  return result;
}
