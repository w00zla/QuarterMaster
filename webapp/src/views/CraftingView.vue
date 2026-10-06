<script setup lang="ts">
// Crafting check: a list of blueprints, each with its own material qualities and the resulting
// stats, one craft each. The math is the shared planner module (src/planner), as in the admin UI.
import { computed } from "vue";
import { computePlan, MAX_QUALITY, MIN_QUALITY } from "../../../src/planner/plan";
import type { EntryResult, PlanEntry, PlannerData } from "../../../src/planner/types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import CraftingPicker from "../components/CraftingPicker.vue";
import PlanEntryCard from "../components/PlanEntryCard.vue";
import { addToCrafting, checks, useCrafting } from "../crafting";
import { t } from "../i18n";

const uuids = computed(() => [...new Set(checks.value.map((e) => e.blueprintUuid))].sort().join(","));
const recipes = useCrafting<PlannerData>(() => (uuids.value ? `/crafting/recipes?uuids=${uuids.value}` : null));
const recipeOf = (uuid: string) => recipes.data.value?.recipes.find((r) => r.uuid === uuid);
// While a newly added blueprint loads, the previous data does not have it yet: its card waits
const results = computed(() => {
  const data = recipes.data.value;
  if (!data) return new Map<string, EntryResult>();
  return new Map(computePlan(data, checks.value.filter((e) => recipeOf(e.blueprintUuid))).entries.map((e) => [e.blueprintUuid, e]));
});

const add = addToCrafting;

function remove(entry: PlanEntry) {
  checks.value = checks.value.filter((e) => e !== entry);
}

function setQuality(entry: PlanEntry, slotIndex: number, value: number) {
  const q = Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, Math.round(value) || 0));
  entry.quality = { ...entry.quality, [slotIndex]: q };
}
</script>

<template>
  <div class="page">
    <section class="panel unclipped">
      <div class="head">
        <Icon name="crafter" :size="16" />
        <span class="head-title no-grow">{{ t("crafting.title") }}</span>
        <div class="divider head-divider" />
        <CraftingPicker class="head-picker" @add="add" />
        <div class="spacer" />
        <button type="button" class="btn outline small" :disabled="!checks.length" @click="checks = []"><Icon name="trash" :size="14" /> {{ t("crafting.clear") }}</button>
      </div>

      <div class="entries">
        <div v-if="!checks.length" class="empty-line">{{ t("crafting.empty") }}</div>
        <div v-else-if="recipes.error.value" class="empty-line">{{ recipes.error.value }}</div>
        <template v-for="entry in checks" :key="entry.blueprintUuid">
          <PlanEntryCard
            v-if="results.has(entry.blueprintUuid)"
            :result="results.get(entry.blueprintUuid)!"
            :recipe="recipeOf(entry.blueprintUuid)"
            @quality="(slot, q) => setQuality(entry, slot, q)"
            @slots="(slots) => (entry.slots = slots)"
            @remove="remove(entry)"
          />
          <div v-else-if="!recipes.loading.value && recipes.data.value" class="entry-missing">
            <span class="faint">{{ t("crafting.missing") }}</span>
            <button type="button" class="icon-btn" :title="t('crafting.remove')" @click="remove(entry)"><Icon name="trash" :size="14" /></button>
          </div>
          <div v-else-if="!recipes.error.value" class="empty-line">{{ t("common.loading") }}</div>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.entry-missing {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-control);
  font-size: 13px;
}

.entries {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.head-count {
  min-width: 7em;
}

/* Phones: the picker gets a row of its own below the title, count and Clear */
@media (max-width: 640px) {
  .head-divider {
    display: none;
  }

  .head-picker {
    order: 10;
    flex-basis: 100%;
  }
}
</style>
