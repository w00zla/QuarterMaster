<script lang="ts">
import type { CatalogStat } from "../../../src/webapp/api-types";

/** A slider's value as stored: one decimal for a percent, whole steps. */
export const statText = (s: CatalogStat, value: number) => (s.kind === "multiplier" ? value.toFixed(1) : String(Math.round(value)));

/** The sliders' values as a batch's stats: only changes (all at ±0 = {}). */
export const statsOf = (defs: CatalogStat[], values: Record<string, number>): Record<string, string> =>
  Object.fromEntries(defs.filter((s) => (values[s.uuid] ?? 0) !== 0).map((s) => [s.uuid, statText(s, values[s.uuid]!)]));

/** Slider values from a batch's stats (the ones it lacks start at ±0). */
export const valuesOf = (stats: Record<string, string> | null): Record<string, number> =>
  Object.fromEntries(Object.entries(stats ?? {}).map(([k, v]) => [k, Number(v)]));
</script>

<script setup lang="ts">
// A component's stats: one slider per stat its blueprint can improve, from ±0 (looted, or crafted
// without a gain) at the left to the best at the right (a drop like recoil the same way, its values
// negative); name and value above each. `values` is filled by the sliders.
import { statValueText } from "../format";

defineProps<{ defs: CatalogStat[] }>();
const values = defineModel<Record<string, number>>({ required: true });

const valueOf = (s: CatalogStat) => values.value[s.uuid] ?? 0;
// A drop's slider runs over the amount (0 … 36 for −36 %)
const sign = (s: CatalogStat) => (s.min < 0 ? -1 : 1);
const set = (s: CatalogStat, e: Event) =>
  (values.value = { ...values.value, [s.uuid]: sign(s) * Number((e.target as HTMLInputElement).value) || 0 });
</script>

<template>
  <div class="stats-row">
    <label v-for="s in defs" :key="s.uuid" class="field stat-field">
      <span class="stat-head"><span>{{ s.name }}</span><span class="stat-value mono">{{ statValueText(s.kind, statText(s, valueOf(s))) }}</span></span>
      <input type="range" min="0" :max="sign(s) * (s.min < 0 ? s.min : s.max)" :step="s.kind === 'multiplier' ? 0.1 : 1" :value="sign(s) * valueOf(s)" @input="set(s, $event)" />
    </label>
  </div>
</template>

<style scoped>
/* The stats over the whole width, the sliders laid out like form fields */
.stats-row {
  grid-column: 1 / -1;
  display: grid;
  /* At most two side by side (each at least half the row less the gap), one when narrower than 2 × 160px */
  grid-template-columns: repeat(auto-fill, minmax(min(100%, max(160px, calc((100% - 20px) / 2))), 1fr));
  gap: 12px 20px;
  align-items: start;
}

/* Name and value above the slider, larger than the other field labels: the values are what is read here */
.stat-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
}

.stat-value {
  font-size: 13px;
  color: var(--text);
}

.stat-field input[type="range"] {
  width: 100%;
  accent-color: var(--accent);
}
</style>
