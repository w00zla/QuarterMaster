// Crafting against stock: what a checked blueprint needs, matched against the stock you can see
// (yours and what others share in your orgs). Pure, shared by the web app and the bot: no Vue, no
// server code. Amounts stay exact (the planner's micro units).
import { formatMicros, MAX_QUALITY, MIN_QUALITY, toMicros } from "./plan.ts";
import type { EntryResult, PlanEntry, PlannerData, PlannerSlot } from "./types.ts";

export const MIN_COUNT = 1;
export const MAX_COUNT = 99;

/** A plan entry's count: whole crafts, 1–99. */
export const clampCount = (n: number) => Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(n) || MIN_COUNT));

/** The strictest minimum quality of a slot's inputs (the ones the planner uses). */
const slotMinQuality = (slot: PlannerSlot) =>
  Math.max(MIN_QUALITY, ...slot.inputs.slice(0, Math.max(1, slot.requiredCount)).map((i) => i.minQuality));

/**
 * The entry as the planner gets it: every slot's quality set and never below the slot's minimum
 * (a stored or default quality below it is raised), the count within 1–99.
 */
export function withQualityFloor(data: PlannerData, entry: PlanEntry): PlanEntry {
  const recipe = data.recipes.find((r) => r.uuid === entry.blueprintUuid);
  if (!recipe) return entry;
  const quality: Record<number, number> = {};
  for (const slot of recipe.slots) {
    const q = Math.min(MAX_QUALITY, entry.quality?.[slot.index] ?? data.defaultQuality);
    quality[slot.index] = Math.max(q, slotMinQuality(slot));
  }
  return { ...entry, count: clampCount(entry.count), quality };
}

export interface Need {
  kind: "resource" | "item";
  uuid: string;
  name: string;
  // Total for the entry's count, exact decimal text
  total: string;
  // The target: the highest quality among the material's selected slots
  quality: number;
}

/** What an entry needs: the inputs of its selected slots, one per material, in order of first use. */
export function needsOf(entry: EntryResult): Need[] {
  const by = new Map<string, { need: Need; micros: bigint }>();
  for (const slot of entry.slots) {
    if (!slot.selected) continue;
    for (const input of slot.inputs) {
      const id = `${input.kind}:${input.uuid}`;
      const row = by.get(id) ?? { need: { kind: input.kind, uuid: input.uuid, name: input.name, total: "0", quality: slot.quality }, micros: 0n };
      row.micros += toMicros(input.total);
      row.need.quality = Math.max(row.need.quality, slot.quality);
      by.set(id, row);
    }
  }
  return [...by.values()].map(({ need, micros }) => ({ ...need, total: formatMicros(micros) }));
}

/** What the check reads of a batch (the web app's `StockBatch` has these fields). */
export interface CoverBatch {
  kind: "resource" | "item";
  subjectUuid: string;
  location: string;
  state: "stored" | "refining";
  quality: number;
  // Exact decimal text
  quantity: string;
  holderUserId: string;
}

export interface Coverage<B extends CoverBatch = CoverBatch> {
  need: Need;
  unit: "SCU" | "pcs";
  // What is missing ("0" when covered)
  missing: string;
  covered: boolean;
  // The material's stored batches at or above the target quality (refining never): your own first,
  // then best quality first
  batches: B[];
}

const compareMicros = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** A need against the stock: the stored batches of the material at or above the target quality. */
export function coverageOf<B extends CoverBatch>(need: Need, stock: readonly B[], meId: string | null): Coverage<B> {
  const own = (b: B) => b.holderUserId === meId;
  const batches = stock
    .filter((b) => b.subjectUuid === need.uuid && b.kind === need.kind && b.state === "stored" && b.quality >= need.quality)
    .sort((a, b) => Number(own(b)) - Number(own(a)) || b.quality - a.quality
      || compareMicros(toMicros(b.quantity), toMicros(a.quantity)) || a.location.localeCompare(b.location));
  const available = batches.reduce((sum, b) => sum + toMicros(b.quantity), 0n);
  const missing = toMicros(need.total) - available;
  return {
    need,
    unit: need.kind === "resource" ? "SCU" : "pcs",
    missing: formatMicros(missing > 0n ? missing : 0n),
    covered: missing <= 0n,
    batches,
  };
}
