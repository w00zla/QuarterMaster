<script setup lang="ts">
// One checked blueprint: slot choice, material quality per slot and the
// resulting stat changes. Changes go up as events.
import { RouterLink } from "vue-router";
import HelpTip from "./HelpTip.vue";
import Icon from "./Icon.vue";
import TypeLabel from "./TypeLabel.vue";
import { typeIcon } from "../typeIcons";
import { duration } from "../format";
import { HELP } from "../help";
import { MAX_QUALITY, MIN_QUALITY } from "../../../src/planner/plan";
import type { EntryResult, PlanEntry, PlannerRecipe, StatResult } from "../../../src/planner/types";

const props = defineProps<{ entry: PlanEntry; result: EntryResult | undefined; recipe: PlannerRecipe | undefined }>();
const emit = defineEmits<{ quality: [slotIndex: number, q: number]; slots: [indexes: number[]]; remove: [] }>();

const choosesSlots = () => !!props.recipe && !!props.result && props.recipe.requiredSlots < props.result.slots.length;

function toggleSlot(slotIndex: number) {
  if (!props.recipe || !props.result) return;
  const set = new Set(props.result.slots.filter((s) => s.selected).map((s) => s.index));
  if (set.has(slotIndex)) set.delete(slotIndex);
  else {
    // Keep exactly N chosen: picking another slot drops the oldest choice
    if (set.size >= props.recipe.requiredSlots) set.delete([...set][0]!);
    set.add(slotIndex);
  }
  emit("slots", [...set]);
}

const inputValue = (e: Event) => Number((e.target as HTMLInputElement).value);

function statText(s: StatResult): string {
  if (s.kind === "additive") return `${s.value >= 0 ? "+" : ""}${s.value}`;
  const pct = (s.value - 1) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}
const statClass = (s: StatResult) => (s.favorable === null ? "neutral" : s.favorable ? "good" : "bad");
const slotName = (index: number) => props.result?.slots.find((s) => s.index === index)?.name ?? String(index);
const perSlotText = (s: StatResult) =>
  s.perSlot.map((p) => `${slotName(p.slotIndex)}: ${s.kind === "additive" ? p.value : `×${p.value.toFixed(3)}`}`).join(" · ");
const unit = (kind: string) => (kind === "resource" ? "SCU" : "pcs");
const minQuality = (s: EntryResult["slots"][number]) => Math.max(0, ...s.inputs.map((i) => i.minQuality));
</script>

<template>
  <div class="entry">
    <div class="entry-head">
      <div class="head-line">
        <Icon :name="typeIcon(recipe?.outputType)" :size="18" class="entry-icon" />
        <RouterLink class="entry-name" :to="`/blueprints/${entry.blueprintUuid}`">{{ result?.name ?? "Loading…" }}</RouterLink>
        <div class="spacer" />
        <button type="button" class="icon-btn" title="Remove" @click="emit('remove')"><Icon name="trash" :size="14" /></button>
      </div>
      <div v-if="recipe" class="head-line">
        <span v-if="recipe.categoryLabel" class="tag accent">{{ recipe.categoryLabel }}</span>
        <span v-if="recipe.outputTypeLabel" class="tag">
          <TypeLabel :type="recipe.outputType" :label="recipe.outputSubTypeLabel ? `${recipe.outputTypeLabel} / ${recipe.outputSubTypeLabel}` : recipe.outputTypeLabel" :size="12" />
        </span>
        <span v-if="recipe.size !== null" class="tag" title="Size">S{{ recipe.size }}</span>
        <span v-if="recipe.itemClass" class="tag">{{ recipe.itemClass }}</span>
        <span v-if="recipe.gradeLetter" class="tag">Grade {{ recipe.gradeLetter }}</span>
        <span v-if="recipe.manufacturer" class="tag" title="Manufacturer">{{ recipe.manufacturer }}</span>
        <span v-if="recipe.isDefault" class="tag ok">Default</span>
        <span v-if="recipe.retired" class="tag err">Retired</span>
      </div>
    </div>

    <div v-if="result" class="entry-body">
      <div class="main-col">
        <div v-if="choosesSlots()" class="note">
          <span class="tag warn">{{ recipe!.requiredSlots }} of {{ result.slots.length }} slots</span>
          <HelpTip :text="HELP.chooseSlots" />
        </div>
        <div class="slots">
          <div class="slot-row">
            <span class="panel-title">Slot</span>
            <span class="panel-title">Material</span>
            <span class="panel-title amount">Amount</span>
            <span class="panel-title quality-title">Quality <HelpTip :text="HELP.quality" /></span>
          </div>
          <div v-for="s in result.slots" :key="s.index" class="slot-row" :class="{ off: !s.selected }">
            <span class="slot-name">
              <input v-if="choosesSlots()" type="checkbox" :checked="s.selected" @change="toggleSlot(s.index)" />
              {{ s.name }}
            </span>
            <span class="slot-inputs">
              <span v-for="inp in s.inputs" :key="inp.uuid">
                <RouterLink :to="`/${inp.kind === 'resource' ? 'resources' : 'items'}/${inp.uuid}`">{{ inp.name }}</RouterLink>
              </span>
              <span v-if="!s.inputs.length" class="faint">No inputs</span>
            </span>
            <span class="slot-inputs amount">
              <span v-for="inp in s.inputs" :key="inp.uuid" class="mono">{{ inp.total }} {{ unit(inp.kind) }}</span>
            </span>
            <span class="quality">
              <span class="min-q">
                <span v-if="minQuality(s) > 1" class="tag" :class="{ err: s.belowMinQuality }">min Q {{ minQuality(s) }}</span>
              </span>
              <input
                type="range"
                :min="MIN_QUALITY"
                :max="MAX_QUALITY"
                :value="s.quality"
                :disabled="!s.selected"
                @input="emit('quality', s.index, inputValue($event))"
              />
              <input
                class="mono q-num"
                type="number"
                :min="MIN_QUALITY"
                :max="MAX_QUALITY"
                :value="s.quality"
                :disabled="!s.selected"
                @change="emit('quality', s.index, inputValue($event))"
              />
            </span>
          </div>
        </div>

        <div v-for="(w, i) in result.warnings" :key="i" class="warning"><Icon name="warning" :size="13" /> {{ w }}</div>
      </div>

      <!-- Stats on the right, apart from the slots -->
      <div v-if="result.stats.length" class="stats">
        <span class="section-head"><span class="panel-title">Stats</span> <HelpTip :text="HELP.planStats" /></span>
        <div v-for="st in result.stats" :key="st.propertyUuid" class="stat">
          <span class="stat-name">{{ st.name }}</span>
          <span class="mono stat-value" :class="statClass(st)">{{ statText(st) }}</span>
          <span v-if="st.perSlot.length > 1" class="faint per-slot">{{ perSlotText(st) }}</span>
        </div>
      </div>
    </div>

    <div v-if="result" class="entry-foot">
      <Icon name="clock" :size="12" />
      <span>Crafting time</span>
      <span class="mono">{{ duration(result.craftSeconds) }}</span>
    </div>
  </div>
</template>

<style scoped>
.entry {
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-control);
}

.entry-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px 12px;
  font-size: 13px;
}

.head-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.entry-icon {
  flex-shrink: 0;
  color: var(--text-2);
}

.entry-name {
  font-weight: 600;
  color: var(--text);
  font-size: 18px;
}

.entry-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-top: 1px solid var(--border-dim);
  font-size: 12px;
  color: var(--text-2);
}

.q-num {
  width: 52px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: center;
  outline: none;
  -moz-appearance: textfield;
}

.q-num::-webkit-inner-spin-button {
  -webkit-appearance: none;
}

.entry-body {
  display: flex;
  gap: 20px;
  padding: 4px 12px 12px;
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
  gap: 6px;
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
  font-weight: 600;
}

.slot-name input {
  accent-color: var(--accent);
}

.amount {
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

.quality {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quality input[type="range"] {
  flex: 1;
  accent-color: var(--accent);
}

.q-num {
  background: var(--bg-surface-2);
  border-radius: var(--radius-control);
  height: 24px;
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

.per-slot {
  grid-column: 1 / -1;
  font-size: 11px;
}
</style>
