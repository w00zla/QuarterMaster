<script setup lang="ts">
// Crafting: a list of blueprints, each with its own material qualities and
// the resulting stats, one craft each (no totals). The math is the shared planner
// module (src/planner), the same code the bot will use.
import { computed } from "vue";
import BlueprintPicker from "../components/BlueprintPicker.vue";
import HelpTip from "../components/HelpTip.vue";
import Icon from "../components/Icon.vue";
import PlanEntryCard from "../components/PlanEntryCard.vue";
import { useFetch } from "../api";
import { HELP } from "../help";
import { checks } from "../plan";
import { computePlan, MAX_QUALITY, MIN_QUALITY } from "../../../src/planner/plan";
import type { PlanEntry, PlannerData } from "../../../src/planner/types";

const uuids = computed(() => [...new Set(checks.value.map((e) => e.blueprintUuid))].sort().join(","));
const recipes = useFetch<PlannerData>(() => (uuids.value ? `/planner/recipes?uuids=${uuids.value}` : null));
const recipeOf = (uuid: string) => recipes.data.value?.recipes.find((r) => r.uuid === uuid);
// While a newly added blueprint loads, the previous data does not have it yet: its card waits
const results = computed(() => {
  const data = recipes.data.value;
  if (!data) return new Map();
  return new Map(computePlan(data, checks.value.filter((e) => recipeOf(e.blueprintUuid))).entries.map((e) => [e.blueprintUuid, e]));
});

/** Newest on top; a blueprint already in the list just moves up. */
function add(uuid: string) {
  const existing = checks.value.find((e) => e.blueprintUuid === uuid);
  checks.value = [existing ?? { blueprintUuid: uuid, count: 1 }, ...checks.value.filter((e) => e.blueprintUuid !== uuid)];
}

function remove(entry: PlanEntry) {
  checks.value = checks.value.filter((e) => e !== entry);
}

function setQuality(entry: PlanEntry, slotIndex: number, value: number) {
  const q = Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, Math.round(value) || 0));
  entry.quality = { ...entry.quality, [slotIndex]: q };
}
</script>

<template>
  <div class="view">
    <section class="panel list-panel">
      <div class="head">
        <Icon name="crafter" :size="16" />
        <span class="head-title no-grow">Crafting</span>
        <HelpTip :text="HELP.planner" />
        <div class="divider" />
        <BlueprintPicker @add="add" />
        <span class="head-count">{{ checks.length }} blueprints</span>
        <div class="spacer" />
        <button type="button" class="btn outline small" :disabled="!checks.length" @click="checks = []">Clear</button>
      </div>

      <div class="entries">
        <div v-if="!checks.length" class="empty-line">Pick blueprints to check what they need</div>
        <div v-else-if="recipes.error.value" class="empty-line">{{ recipes.error.value }}</div>
        <template v-for="entry in checks" :key="entry.blueprintUuid">
          <PlanEntryCard
            v-if="results.has(entry.blueprintUuid)"
            :entry="entry"
            :result="results.get(entry.blueprintUuid)"
            :recipe="recipeOf(entry.blueprintUuid)"
            @quality="(slot, q) => setQuality(entry, slot, q)"
            @slots="(slots) => (entry.slots = slots)"
            @remove="remove(entry)"
          />
          <div v-else-if="!recipes.loading.value && recipes.data.value" class="entry-missing">
            <span class="faint">A blueprint that is not in the catalog</span>
            <button type="button" class="icon-btn" title="Remove" @click="remove(entry)"><Icon name="trash" :size="14" /></button>
          </div>
          <div v-else class="empty-line">Loading…</div>
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
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

</style>
