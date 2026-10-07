<script setup lang="ts">
// One checked blueprint: slot choice, material quality per slot and the resulting stat changes.
// Changes go up as events. Nothing in the card changes its height while qualities or the slot
// choice change: a quality below the minimum shows on the slot's min Q tag, a wrong slot choice
// next to the slot count, and the stats list every stat the recipe's slots can give.
import { computed } from "vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { typeIcon } from "../../../adminapp/src/typeIcons";
import { MAX_QUALITY, MIN_QUALITY } from "../../../src/planner/plan";
import type { EntryResult, PlannerRecipe, StatResult } from "../../../src/planner/types";
import { warningOf } from "../crafting";
import { duration, unitText } from "../format";
import { t } from "../i18n";
import TypeLabel from "./TypeLabel.vue";

const props = defineProps<{ result: EntryResult; recipe: PlannerRecipe | undefined }>();
const emit = defineEmits<{ quality: [slotIndex: number, q: number]; slots: [indexes: number[]]; remove: [] }>();

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

const inputValue = (e: Event) => Number((e.target as HTMLInputElement).value);

const warnings = computed(() => props.result.warnings.map(warningOf));
const slotWarning = computed(() => warnings.value.find((w) => w.kind === "slots")?.text ?? "");
const listedWarnings = computed(() => warnings.value.filter((w) => w.kind !== "slots" && w.kind !== "belowMin"));

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
const minQuality = (s: EntryResult["slots"][number]) => Math.max(0, ...s.inputs.map((i) => i.minQuality));
</script>

<template>
  <div class="entry">
    <div class="entry-head">
      <div class="head-line">
        <Icon :name="typeIcon(recipe?.outputType)" :size="18" class="entry-icon" />
        <span class="entry-name">{{ result.name }}</span>
        <div class="spacer" />
        <button type="button" class="icon-btn" :title="t('crafting.remove')" @click="emit('remove')"><Icon name="trash" :size="14" /></button>
      </div>
      <div v-if="recipe" class="head-line tags">
        <span v-if="recipe.categoryLabel" class="tag accent">{{ recipe.categoryLabel }}</span>
        <span v-if="recipe.outputTypeLabel" class="tag">
          <TypeLabel :type="recipe.outputType" :label="recipe.outputSubTypeLabel ? `${recipe.outputTypeLabel} / ${recipe.outputSubTypeLabel}` : recipe.outputTypeLabel" :size="12" />
        </span>
        <span v-if="recipe.size !== null" class="tag" :title="t('crafting.size')">S{{ recipe.size }}</span>
        <span v-if="recipe.itemClass" class="tag">{{ recipe.itemClass }}</span>
        <span v-if="recipe.gradeLetter" class="tag">{{ t("crafting.grade", { grade: recipe.gradeLetter }) }}</span>
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
              <input
                type="range"
                :min="MIN_QUALITY"
                :max="MAX_QUALITY"
                :value="s.quality"
                :disabled="!s.selected"
                :aria-label="`${t('field.quality')} ${s.name}`"
                @input="emit('quality', s.index, inputValue($event))"
              />
              <input
                class="mono q-num"
                type="number"
                :min="MIN_QUALITY"
                :max="MAX_QUALITY"
                :value="s.quality"
                :disabled="!s.selected"
                :aria-label="`${t('field.quality')} ${s.name}`"
                @change="emit('quality', s.index, inputValue($event))"
              />
            </span>
          </div>
        </div>

        <div v-for="(w, i) in listedWarnings" :key="i" class="warning"><Icon name="warning" :size="13" /> {{ w.text }}</div>
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

    <div class="entry-foot">
      <Icon name="clock" :size="12" />
      <span>{{ t("crafting.time") }}</span>
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
  font-weight: 600;
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

/* Narrower screens: the stats go below the slots */
@media (max-width: 1100px) {
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

/* Phones: one block per slot (name, then material and amount, then quality) */
@media (max-width: 760px) {
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
}
</style>
