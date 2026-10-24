<script setup lang="ts">
// The quality a resource is mined with, once above the table: per part of the ore (the rich one, the lean
// ones) a thin bar per set of systems with the same values and below it the values with their chances in
// plain text (the rarer ones on hover). With a target (the crafting dialog) what lies below it is dimmed,
// what reaches it green, and a column per system says how often a part reaches it.
import { computed } from "vue";
import type { MiningQuality, MiningRow } from "../../../src/webapp/api-types";
import { t } from "../i18n";
import { partLabel, qualityCard, rangeText, reachText, segments } from "../mining";

const props = defineProps<{ rows: MiningRow[]; target: number | null }>();

const card = computed(() => qualityCard(props.rows));
const multiOre = computed(() => new Set(card.value.rows.map((r) => r.ore)).size > 1);
// Label column, then per system set its bar (and with a target the chance column)
const grid = computed(() => `minmax(130px, 170px) repeat(${card.value.columns.length}, minmax(0, 1fr)${props.target !== null ? " 56px" : ""})`);

// Every value of the bar (half a percent and more) with its chance; the list wraps where a column is narrow
const shownValues = (q: MiningQuality) => segments(q, props.target);
const allValues = (q: MiningQuality) => segments(q, props.target).map((s) => s.title).join(" · ");
const chance = (c: number) => (c < 0.01 ? "<1 %" : `${Math.round(c * 100)} %`);
</script>

<template>
  <div v-if="card.rows.length" class="card" :style="{ gridTemplateColumns: grid }">
    <span class="card-head">{{ t("mining.qualityTitle") }}</span>
    <template v-for="c in card.columns" :key="c">
      <span class="card-head system">{{ c }}</span>
      <span v-if="target !== null" class="card-head reach">≥ {{ target }}</span>
    </template>
    <!-- The head set apart: a line over the card's full width -->
    <span class="card-rule" />

    <template v-for="r in card.rows" :key="`${r.ore}|${r.qualityScale}`">
      <span class="part">
        <span class="part-name" :class="{ lean: r.qualityScale < 1 }">{{ multiOre ? `${r.ore} · ` : "" }}{{ partLabel(r.qualityScale) }}</span>
        <span class="faint">{{ t("mining.ofRock", { range: rangeText(r.minPercent, r.maxPercent) }) }}</span>
      </span>
      <template v-for="(q, i) in r.cells" :key="i">
        <span v-if="q" class="cell" :title="allValues(q)">
          <span class="bar">
            <span
              v-for="s in segments(q, target)"
              :key="s.value"
              class="seg"
              :class="[`t${s.tier}`, { below: s.below }]"
              :style="{ flexGrow: s.chance }"
            />
          </span>
          <span class="values">
            <span v-for="s in shownValues(q)" :key="s.value" class="value" :class="{ below: s.below, hit: target !== null && !s.below }">
              {{ s.value }} <span class="chance">{{ chance(s.chance) }}</span>
            </span>
          </span>
        </span>
        <span v-else class="cell faint">—</span>
        <span v-if="target !== null" class="reach" :class="{ never: reachText(q, target) === t('mining.never') || !q }">{{ reachText(q, target) }}</span>
      </template>
    </template>
  </div>
</template>

<style scoped>
.card {
  display: grid;
  gap: 8px 8px;
  align-items: start;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  background: var(--bg-surface);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.card-head {
  font-weight: 500;
  color: var(--text-3);
}

/* A system's block (its bar and its chance) starts with room before it; the chance sits close to its bar */
.card-head.system,
.cell {
  margin-left: 18px;
}

.card-head.system {
  color: var(--text-2);
}

.card-head.reach {
  text-align: left;
  color: var(--ok);
}

.card-head {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.card-rule {
  grid-column: 1 / -1;
  height: 1px;
  margin: -2px -14px 0;
  background: var(--border-dim);
}

.part {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.part-name {
  font-size: 13px;
  font-weight: 400;
  color: var(--text);
}

.part-name.lean {
  color: var(--text-2);
}

.cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding-top: 3px;
}

.bar {
  display: flex;
  height: 10px;
  border-radius: 3px;
  overflow: hidden;
}

/* Proportional, no minimum width (tiny values would fray the end); a hairline between segments */
.seg {
  flex-basis: 0;
  min-width: 0;
}

.seg + .seg {
  box-shadow: inset 1px 0 0 var(--bg-surface);
}

/* Below 500 grey (not usable for crafting), 500–999 the accent from dim to full, 1000 gold */
.t0 { background: var(--bg-surface-3); }
.t1 { background: color-mix(in srgb, var(--accent) 45%, var(--bg-base)); }
.t2 { background: color-mix(in srgb, var(--accent) 58%, var(--bg-base)); }
.t3 { background: color-mix(in srgb, var(--accent) 72%, var(--bg-base)); }
.t4 { background: color-mix(in srgb, var(--accent) 86%, var(--bg-base)); }
.t5 { background: var(--accent); }
.t6 { background: var(--warn); }
.seg.below { opacity: 0.25; }

/* Wraps where a column is narrow (every value on hover) */
.values {
  display: flex;
  flex-wrap: wrap;
  gap: 0 10px;
  color: var(--text-2);
}

.value {
  white-space: nowrap;
}

.chance {
  color: var(--text-3);
}

/* With a target: what reaches it green, the rest dimmed */
.value.hit {
  color: var(--ok);
}

.value.below {
  color: var(--text-3);
}

.reach {
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--ok);
  padding-top: 1px;
}

.reach.never {
  font-weight: 400;
  color: var(--text-3);
}
</style>
