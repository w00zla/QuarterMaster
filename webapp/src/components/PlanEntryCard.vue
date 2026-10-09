<script setup lang="ts">
// One checked blueprint: count, slot choice, material quality per slot (never below the slot's
// minimum), the resulting stat changes and, below, what of it the stock covers. Changes go up as
// events. Nothing in the card changes its height while qualities or the slot choice change: a
// wrong slot choice shows next to the slot count, and the stats list every stat the recipe's slots
// can give.
import { computed } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { typeIcon } from "../../../adminapp/src/typeIcons";
import { MAX_QUALITY, MIN_QUALITY } from "../../../src/planner/plan";
import type { EntryResult, PlannerRecipe, StatResult } from "../../../src/planner/types";
import type { StockBatch } from "../../../src/webapp/api-types";
import { craftingUi, toggleIn, warningText } from "../crafting";
import { clampCount, coverageOf, MAX_COUNT, MIN_COUNT, needsOf } from "../craftingStock";
import { duration, qty, unitText } from "../format";
import { t } from "../i18n";
import { me } from "../session";
import CoverageTag from "./CoverageTag.vue";
import StockBatchList from "./StockBatchList.vue";
import TypeLabel from "./TypeLabel.vue";

// stock: everything you can see (null while it loads)
const props = defineProps<{ result: EntryResult; recipe: PlannerRecipe | undefined; stock: StockBatch[] | null }>();
const emit = defineEmits<{ quality: [slotIndex: number, q: number]; slots: [indexes: number[]]; count: [n: number]; remove: [] }>();

const choosesSlots = computed(() => !!props.recipe && props.recipe.requiredSlots < props.result.slots.length);

function toggleSlot(slotIndex: number) {
  if (!props.recipe) return;
  const set = new Set(props.result.slots.filter((s) => s.selected).map((s) => s.index));
  if (set.has(slotIndex)) set.delete(slotIndex);
  else {
    // Keep exactly N chosen: picking another slot drops the oldest choice
    if (set.size >= props.recipe.requiredSlots) set.delete([...set][0]!);
    set.add(slotIndex);
  }
  emit("slots", [...set]);
}

/** A typed or dragged value, clamped; the control shows the clamped value right away. */
function clamped(e: Event, min: number, max: number): number {
  const el = e.target as HTMLInputElement;
  const n = Math.min(max, Math.max(min, Math.round(Number(el.value)) || min));
  if (el.value !== String(n)) el.value = String(n);
  return n;
}

const setQuality = (s: EntryResult["slots"][number], e: Event) => emit("quality", s.index, clamped(e, minQuality(s), MAX_QUALITY));
const setCount = (e: Event) => emit("count", clamped(e, MIN_COUNT, MAX_COUNT));
const step = (by: number) => emit("count", clampCount(props.result.count + by));

// The stock part: each card on its own (nothing reserved across cards), open by default
const stockOpen = computed(() => !craftingUi.stockClosed.includes(props.result.blueprintUuid));
const coverages = computed(() => needsOf(props.result).map((n) => coverageOf(n, props.stock ?? [], me.value?.userId ?? null)));

const slotWarning = computed(() => {
  const w = props.result.warnings.find((w) => w.code === "slots");
  return w ? warningText(w) : "";
});
const listedWarnings = computed(() =>
  props.result.warnings.filter((w) => w.code !== "slots" && w.code !== "belowMin").map(warningText),
);

// Every stat a slot of the recipe can give, in the planner's order; one not given by the chosen
// slots shows as a dash. A per-slot line is reserved where several slots give the stat.
const statRows = computed(() => {
  const given = new Map(props.result.stats.map((s) => [s.propertyUuid, s]));
  const rows = new Map<string, { propertyUuid: string; name: string; stat: StatResult | undefined; slots: number }>();
  for (const slot of props.recipe?.slots ?? []) {
    for (const m of slot.modifiers) {
      if (!m.ranges.length) continue;
      const row = rows.get(m.propertyUuid) ?? { propertyUuid: m.propertyUuid, name: m.name, stat: given.get(m.propertyUuid), slots: 0 };
      row.slots++;
      rows.set(m.propertyUuid, row);
    }
  }
  return [...rows.values()];
});

function statText(s: StatResult | undefined): string {
  if (!s) return "—";
  if (s.kind === "additive") return `${s.value >= 0 ? "+" : ""}${s.value}`;
  const pct = (s.value - 1) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}
const statClass = (s: StatResult | undefined) => (!s || s.favorable === null ? "neutral" : s.favorable ? "good" : "bad");
const slotName = (index: number) => props.result.slots.find((s) => s.index === index)?.name ?? String(index);
const perSlotText = (s: StatResult | undefined) => !s || s.perSlot.length < 2 ? "" :
  s.perSlot.map((p) => `${slotName(p.slotIndex)}: ${s.kind === "additive" ? p.value : `×${p.value.toFixed(3)}`}`).join(" · ");
const unit = (kind: string) => unitText(kind === "resource" ? "SCU" : "pcs");
const minQuality = (s: EntryResult["slots"][number]) => Math.max(MIN_QUALITY, ...s.inputs.map((i) => i.minQuality));
</script>

<template>
  <div class="entry">
    <div class="entry-head">
      <div class="head-line">
        <Icon :name="typeIcon(recipe?.outputType)" :size="18" class="entry-icon" />
        <span class="entry-name">{{ result.name }}</span>
        <div class="spacer" />
        <span class="count">
          <button type="button" class="icon-btn" :title="t('crafting.less')" :disabled="result.count <= MIN_COUNT" @click="step(-1)"><Icon name="minus" :size="14" /></button>
          <input class="mono q-num count-num" type="number" :min="MIN_COUNT" :max="MAX_COUNT" :value="result.count" :aria-label="t('crafting.count')" :title="t('crafting.count')" @change="setCount" />
          <button type="button" class="icon-btn" :title="t('crafting.more')" :disabled="result.count >= MAX_COUNT" @click="step(1)"><Icon name="plus" :size="14" /></button>
        </span>
        <div class="divider" />
        <button type="button" class="icon-btn" :title="t('crafting.remove')" @click="emit('remove')"><Icon name="trash" :size="14" /></button>
      </div>
      <div v-if="recipe" class="head-line tags">
        <span v-if="recipe.categoryLabel" class="meta">{{ recipe.categoryLabel }}</span>
        <span v-if="recipe.outputTypeLabel" class="meta">
          <TypeLabel :type="recipe.outputType" :label="recipe.outputSubTypeLabel ? `${recipe.outputTypeLabel} / ${recipe.outputSubTypeLabel}` : recipe.outputTypeLabel" :size="11" />
        </span>
        <span v-if="recipe.size !== null" class="meta" :title="t('crafting.size')">S{{ recipe.size }}</span>
        <span v-if="recipe.itemClass" class="meta">{{ recipe.itemClass }}</span>
        <span v-if="recipe.gradeLetter" class="meta">{{ t("crafting.grade", { grade: recipe.gradeLetter }) }}</span>
        <span v-if="recipe.isDefault" class="tag ok">{{ t("crafting.default") }}</span>
        <span v-if="recipe.retired" class="tag err">{{ t("crafting.retired") }}</span>
      </div>
    </div>

    <div class="entry-body">
      <div class="main-col">
        <div v-if="choosesSlots" class="note">
          <span class="tag warn">{{ t("crafting.slotsOf", { n: recipe!.requiredSlots, m: result.slots.length }) }}</span>
          <span class="note-warn" :title="slotWarning || undefined">
            <template v-if="slotWarning"><Icon name="warning" :size="13" /> {{ slotWarning }}</template>
          </span>
        </div>
        <div class="slots">
          <div class="slot-row head-row">
            <span class="panel-title">{{ t("crafting.slot") }}</span>
            <span class="panel-title">{{ t("field.material") }}</span>
            <span class="panel-title amount-col">{{ t("field.amount") }}</span>
            <span class="panel-title quality-title">{{ t("field.quality") }}</span>
          </div>
          <div v-for="s in result.slots" :key="s.index" class="slot-row" :class="{ off: !s.selected }">
            <span class="slot-name">
              <input v-if="choosesSlots" type="checkbox" :checked="s.selected" @change="toggleSlot(s.index)" />
              {{ s.name }}
            </span>
            <span class="slot-inputs">
              <span v-for="inp in s.inputs" :key="inp.uuid">{{ inp.name }}</span>
              <span v-if="!s.inputs.length" class="faint">{{ t("crafting.noInputs") }}</span>
            </span>
            <span class="slot-inputs amount-col">
              <span v-for="inp in s.inputs" :key="inp.uuid" class="mono">{{ inp.total }} {{ unit(inp.kind) }}</span>
            </span>
            <span class="quality">
              <span class="min-q">
                <span v-if="minQuality(s) > 1" class="tag" :class="{ err: s.belowMinQuality }">{{ t("crafting.minQ", { q: minQuality(s) }) }}</span>
              </span>
              <!-- The track keeps the full scale (slots stay comparable); it stops at the minimum -->
              <input
                type="range"
                :min="MIN_QUALITY"
                :max="MAX_QUALITY"
                :value="s.quality"
                :disabled="!s.selected"
                :aria-label="`${t('field.quality')} ${s.name}`"
                @input="setQuality(s, $event)"
              />
              <input
                class="mono q-num"
                type="number"
                :min="minQuality(s)"
                :max="MAX_QUALITY"
                :value="s.quality"
                :disabled="!s.selected"
                :aria-label="`${t('field.quality')} ${s.name}`"
                @change="setQuality(s, $event)"
              />
            </span>
          </div>
        </div>

        <div v-for="(w, i) in listedWarnings" :key="i" class="warning"><Icon name="warning" :size="13" /> {{ w }}</div>
      </div>

      <!-- Stats on the right, apart from the slots -->
      <div v-if="statRows.length" class="stats">
        <span class="section-head"><span class="panel-title">{{ t("crafting.stats") }}</span></span>
        <div v-for="st in statRows" :key="st.propertyUuid" class="stat">
          <span class="stat-name">{{ st.name }}</span>
          <span class="mono stat-value" :class="statClass(st.stat)">{{ statText(st.stat) }}</span>
          <span v-if="st.slots > 1" class="faint per-slot">{{ perSlotText(st.stat) }}</span>
        </div>
      </div>
    </div>

    <div class="stock-part">
      <button type="button" class="stock-toggle" :aria-expanded="stockOpen" @click="toggleIn(craftingUi.stockClosed, result.blueprintUuid)">
        <Icon :name="stockOpen ? 'chevron-down' : 'chevron-right'" :size="14" />
        <Icon name="type-crate" :size="14" />
        <span class="panel-title">{{ t("crafting.stock") }}</span>
      </button>
      <div v-if="stockOpen" class="needs">
        <div v-for="c in coverages" :key="`${c.need.kind}:${c.need.uuid}`" class="need">
          <div class="need-line">
            <span class="need-name">{{ c.need.name }}</span>
            <span class="mono need-total" :title="t('crafting.need')">{{ qty(c.need.total, c.unit) }}</span>
            <span class="need-tag"><CoverageTag :coverage="c" :loading="!stock" /></span>
          </div>
          <StockBatchList :rows="c.batches" />
        </div>
        <div v-if="!coverages.length" class="faint">—</div>
      </div>
    </div>

    <div class="entry-foot">
      <Icon name="clock" :size="12" />
      <span>{{ t("crafting.time") }}</span>
      <span class="mono">{{ duration(result.craftSeconds) }}</span>
    </div>
  </div>
</template>

<style scoped>
/* A card of its own: darker than the panel, with a framed head; its parts share one inner padding.
   The layout follows the card's width. */
.entry {
  container-type: inline-size;
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  background: var(--bg-base);
  overflow: hidden;
}

.entry-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px 12px;
  background: var(--bg-surface-2);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.head-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.head-line.tags {
  flex-wrap: wrap;
}

.entry-icon {
  flex-shrink: 0;
  color: var(--text-2);
}

.entry-name {
  min-width: 0;
  font-weight: 600;
  color: var(--text);
  font-size: 18px;
  overflow-wrap: anywhere;
}

/* The count between its buttons, tight */
.count {
  display: flex;
  align-items: center;
  gap: 5px;
}

.count .icon-btn {
  margin: 0;
}

/* Just wide enough for two digits */
.q-num.count-num {
  width: 2.5ch;
  padding: 0;
  background: none;
}

/* The blueprint's facts (category, type, size, class, grade) as chips, like the filter chips but not
   clickable; states (default, retired) stay tags */
.meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border: 1px solid rgba(173, 211, 235, 0.35);
  border-radius: var(--radius-control);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.entry-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-top: 1px solid var(--border-dim);
  font-size: 12px;
  color: var(--text-3);
}

.entry-foot .mono {
  color: var(--text-2);
}

/* The stock part: one block per material (need line, then its batches), set into the card: darker
   than the card body, not one more of the blue surfaces (the footer's top line closes it) */
.stock-part {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px 14px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, #000 35%, var(--bg-base));
}

.stock-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--text-3);
  cursor: pointer;
}

.stock-toggle:hover {
  color: var(--text);
}

.needs {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
}

.need {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* The material's line, underlined also when nobody holds it (the first batch below draws no line) */
.need-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 12ch 15ch;
  gap: 12px;
  align-items: center;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border-dim);
}

.need-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text);
}

.need-total {
  text-align: right;
  color: var(--text);
}

.need-tag {
  display: flex;
  justify-content: flex-end;
}

.q-num {
  width: 52px;
  height: 24px;
  border: none;
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
  color: var(--text);
  font-size: 13px;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
  appearance: textfield;
}

.q-num::-webkit-inner-spin-button {
  -webkit-appearance: none;
}

.entry-body {
  display: flex;
  gap: 24px;
  padding: 14px 16px 16px;
}

.main-col {
  flex: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.note {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 20px;
  min-width: 0;
}

.note-warn {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  color: var(--warn);
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* One grid for all rows (rows are display: contents): material and amount columns
   size to their content, quality follows at a fixed distance; free space stays at
   the far right of the card. */
.slots {
  display: grid;
  grid-template-columns: 180px max-content max-content 340px;
  gap: 4px 12px;
  align-items: center;
  font-size: 13px;
}

.slot-row {
  display: contents;
}

.slot-row.off > * {
  opacity: 0.45;
}

.slot-name {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
}

.slot-name input {
  accent-color: var(--accent);
}

.amount-col {
  padding: 0 24px 0 8px;
}

.slot-inputs {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.slot-inputs > span {
  display: flex;
  align-items: center;
  gap: 6px;
}

.slot-inputs > span:not(.faint) {
  color: var(--text);
}

.quality {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quality input[type="range"] {
  flex: 1;
  min-width: 0;
  accent-color: var(--accent);
}

.min-q {
  width: 72px;
  flex-shrink: 0;
}

.quality-title {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
}

.stats {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 20px;
  border-left: 1px solid var(--border-dim);
}

.stat {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 12px;
  align-items: baseline;
  font-size: 13px;
}

.stat-name {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat-value {
  text-align: right;
}

.stat-value.good {
  color: var(--ok);
}

.stat-value.bad {
  color: var(--err);
}

.stat-value.neutral {
  color: var(--text-2);
}

/* One line, reserved even while only one slot gives the stat */
.per-slot {
  grid-column: 1 / -1;
  min-height: 1.4em;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Narrower cards: the stats go below the slots */
@container (max-width: 1040px) {
  .entry-body {
    flex-direction: column;
  }

  .stats {
    width: auto;
    padding: 12px 0 0;
    border-left: none;
    border-top: 1px solid var(--border-dim);
  }
}

/* Phone-wide cards: one block per slot (name, then material and amount, then quality) */
@container (max-width: 700px) {
  .main-col {
    flex: 1;
  }

  .slots {
    grid-template-columns: minmax(0, 1fr) max-content;
    gap: 4px 12px;
  }

  .slot-row.head-row {
    display: none;
  }

  .slot-name,
  .quality {
    grid-column: 1 / -1;
  }

  .slot-name {
    margin-top: 8px;
  }

  .amount-col {
    padding: 0;
    text-align: right;
  }

  .slot-inputs.amount-col > span {
    justify-content: flex-end;
  }

  .need-line {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 12px;
  }
}
</style>
