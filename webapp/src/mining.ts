// Mining (GET /api/mining): the filters shared by the Bergbau view and the dialog, and the texts of a row.
import { reactive, ref } from "vue";
import type { MiningMethod, MiningQuality, MiningRow } from "../../src/webapp/api-types";
import { t, type Key } from "./i18n";

const MINING_SYSTEMS = ["Stanton", "Pyro", "Nyx"] as const;
export const MINING_METHODS: MiningMethod[] = ["ship", "roc", "fps"];

// The Bergbau view's pick (a mined resource), kept for the session
export const miningPick = ref<string | null>(null);

// The system and method shown ("": all); kept for the session
export const miningFilter = reactive({ system: "", method: "" as MiningMethod | "" });

export const shown = (r: MiningRow) =>
  (!miningFilter.system || r.system === miningFilter.system) && (!miningFilter.method || r.method === miningFilter.method);

// The filters' options, like the stock's ("All systems", then each)
export const systemOptions = () => [{ value: "", label: t("filter.allSystems") }, ...MINING_SYSTEMS.map((s) => ({ value: s, label: s }))];
export const methodOptions = () => [{ value: "", label: t("filter.allMethods") }, ...MINING_METHODS.map((m) => ({ value: m, label: methodText(m) }))];

export const methodText = (m: MiningMethod) => t(`mining.method.${m}` as Key);

// A rock's rarity class as its frequency bar's color (the tag colors: grey, green, blue, cyan, gold); none: the accent
const RARITY_COLOR: Record<string, string> = {
  common: "var(--text-3)", uncommon: "var(--ok)", rare: "var(--accent)", epic: "var(--live)", legendary: "var(--warn)",
};
export const rarityColor = (r: string | null) => (r && RARITY_COLOR[r]) || "var(--accent)";
export const rarityText = (r: string) => t(`mining.rarity.${r}` as Key);

export const placeText = (r: MiningRow) => (r.group ? t(`mining.group.${r.group}` as Key) : r.place ?? "—");

const percent = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
export const shareText = (r: MiningRow) => `${percent(r.share)} %`;
export const rangeText = (min: number, max: number) => `${percent(min)}–${percent(max)} %`;
const chanceText = (c: number) => (c < 0.01 ? "<1 %" : `${Math.round(c * 100)} %`);

// A lean part's quality factor: "×0,49"
const scaleText = (scale: number) => `×${scale.toLocaleString(undefined, { maximumFractionDigits: 3 })}`;
export const partLabel = (scale: number) => (scale >= 1 ? t("mining.part.rich") : t("mining.part.lean", { f: scaleText(scale) }));

// --- the quality card: the quality once per part and system (it differs only by system) -------------

export interface QualityCard {
  // One column per set of systems with the same values ("Stanton · Nyx", "Pyro")
  columns: string[];
  rows: Array<{ ore: string; qualityScale: number; minPercent: number; maxPercent: number; cells: Array<MiningQuality | null> }>;
}

/** The card of the shown rows: its parts (ore and factor, the rich one first) × the systems' distributions. */
export function qualityCard(rows: MiningRow[]): QualityCard {
  const parts = new Map<string, { ore: string; qualityScale: number; minPercent: number; maxPercent: number; bySystem: Map<string, MiningQuality | null> }>();
  for (const r of rows) {
    for (const p of r.parts) {
      const key = `${r.ore}|${p.qualityScale}`;
      const e = parts.get(key) ?? { ore: r.ore, qualityScale: p.qualityScale, minPercent: p.minPercent, maxPercent: p.maxPercent, bySystem: new Map() };
      e.minPercent = Math.min(e.minPercent, p.minPercent);
      e.maxPercent = Math.max(e.maxPercent, p.maxPercent);
      if (!e.bySystem.has(r.system ?? "—")) e.bySystem.set(r.system ?? "—", p.quality);
      parts.set(key, e);
    }
  }
  const list = [...parts.values()].sort((a, b) => a.ore.localeCompare(b.ore) || b.qualityScale - a.qualityScale);
  // Systems with the same values for every part share a column
  const order = (s: string) => ((MINING_SYSTEMS as readonly string[]).indexOf(s) + 1 || 99);
  const systems = [...new Set(list.flatMap((p) => [...p.bySystem.keys()]))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const columns = new Map<string, string[]>();
  for (const s of systems) {
    const sig = JSON.stringify(list.map((p) => p.bySystem.get(s) ?? null));
    columns.set(sig, [...(columns.get(sig) ?? []), s]);
  }
  const firsts = [...columns.values()].map((c) => c[0]!);
  return {
    columns: [...columns.values()].map((c) => c.join(" · ")),
    rows: list.map((p) => ({ ore: p.ore, qualityScale: p.qualityScale, minPercent: p.minPercent, maxPercent: p.maxPercent, cells: firsts.map((s) => p.bySystem.get(s) ?? null) })),
  };
}

export interface Segment { value: number; chance: number; title: string; tier: number; below: boolean }

/**
 * A distribution's bar segments: the tier for the color (0 below 500, 1–5 per hundred, 6 at 1000), value and
 * chance as the title; below the target when one is given. Without bands (no
 * values) the range's two ends as equal parts.
 */
export function segments(q: MiningQuality, target: number | null): Segment[] {
  const values = q.values.length ? q.values : [...new Set([q.min, q.max])].map((value, _i, all) => ({ value, chance: 1 / all.length }));
  return values.filter((v) => v.chance >= 0.005).map((v) => ({
    value: v.value,
    chance: v.chance,
    title: `${v.value}: ${chanceText(v.chance)}`,
    tier: v.value < 500 ? 0 : v.value >= 1000 ? 6 : Math.min(5, Math.floor((v.value - 500) / 100) + 1),
    below: target !== null && v.value < target,
  }));
}

/** The chance a part reaches the target: "54 %", "<1 %", "nie". */
export function reachText(q: MiningQuality | null, target: number): string {
  if (!q) return "—";
  const c = q.values.length ? q.values.filter((v) => v.value >= target).reduce((s, v) => s + v.chance, 0) : (q.max >= target ? 1 : 0);
  return c <= 0 ? t("mining.never") : chanceText(c);
}

// The target's choices: every 50 from 500, and the given one
export const targetOptions = (current: number) =>
  [...new Set([current, ...Array.from({ length: 11 }, (_, i) => 500 + i * 50)])].sort((a, b) => a - b)
    .map((q) => ({ value: String(q), label: t("mining.target", { q }) }));
