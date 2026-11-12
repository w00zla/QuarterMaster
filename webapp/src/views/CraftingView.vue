<script setup lang="ts">
// Crafting check: a list of blueprints, each with its count, its own material qualities, the
// resulting stats, what the stock covers and who has the blueprint. The math is the shared planner module
// (src/planner). The stock (yours and what others share in your orgs) loads once for the view and reloads
// on stock changes; the owners (yours, your orgs' active members) on blueprint, member and profile changes.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { computePlan, MAX_QUALITY, MIN_QUALITY } from "../../../src/planner/plan";
import type { EntryResult, PlanEntry, PlannerData } from "../../../src/planner/types";
import type {
  BlueprintListResponse, BlueprintOwner, OrgBlueprintsResponse, StockBatch, StockListResponse,
} from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { api } from "../api";
import CraftingPicker from "../components/CraftingPicker.vue";
import PlanEntryCard, { type BlueprintOwners } from "../components/PlanEntryCard.vue";
import { addToCrafting, checks, useCrafting } from "../crafting";
import { clampCount, withQualityFloor } from "../../../src/planner/stock";
import { takeQuery } from "../deepLink";
import { lang, t } from "../i18n";
import { coalesced, onServerMessage } from "../realtime";
import { me } from "../session";
import { toastError } from "../toasts";

// A deep link puts its blueprint on top of the list
const linked = takeQuery("add");
if (linked && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(linked)) addToCrafting(linked);

const uuids = computed(() => [...new Set(checks.value.map((e) => e.blueprintUuid))].sort().join(","));
const recipes = useCrafting<PlannerData>(() => (uuids.value ? `/crafting/recipes?uuids=${uuids.value}` : null));
const recipeOf = (uuid: string) => recipes.data.value?.recipes.find((r) => r.uuid === uuid);
// While a newly added blueprint loads, the previous data does not have it yet: its card waits.
// Qualities below a slot's minimum (stored or default) count as the minimum.
const plan = computed(() => {
  const data = recipes.data.value;
  return data ? computePlan(data, checks.value.filter((e) => recipeOf(e.blueprintUuid)).map((e) => withQualityFloor(data, e))) : null;
});
const results = computed(() => new Map<string, EntryResult>((plan.value?.entries ?? []).map((e) => [e.blueprintUuid, e])));

// --- stock ---------------------------------------------------------------------------------
const stock = ref<StockBatch[] | null>(null);
let seq = 0;
async function loadStock() {
  const mine = ++seq;
  try {
    const r = await api<StockListResponse>(`/stock?scope=all&lang=${lang.value}`);
    if (mine === seq) stock.value = r.batches;
  } catch (e) {
    if (mine === seq) toastError(e);
  }
}
watch(lang, loadStock, { immediate: true });

// --- who has the blueprints: you, and per org its active members (null while it loads) -------
const ownMine = ref<Set<string> | null>(null);
const orgOwners = ref<Map<string, Map<string, BlueprintOwner[]>> | null>(null);
let ownSeq = 0;
async function loadOwners() {
  const mine = ++ownSeq;
  try {
    const own = new Set((await api<BlueprintListResponse>("/blueprints")).uuids);
    const byOrg = new Map<string, Map<string, BlueprintOwner[]>>();
    for (const o of me.value?.orgs ?? []) {
      const r = await api<OrgBlueprintsResponse>(`/orgs/${encodeURIComponent(o.guildId)}/blueprints`);
      byOrg.set(o.guildId, new Map(r.entries.map((e) => [e.uuid, e.owners])));
    }
    if (mine === ownSeq) [ownMine.value, orgOwners.value] = [own, byOrg];
  } catch (e) {
    if (mine === ownSeq) toastError(e);
  }
}
watch(() => me.value?.orgs, loadOwners, { immediate: true });
const ownersOf = (uuid: string): BlueprintOwners | null => {
  if (!ownMine.value || !orgOwners.value) return null;
  return {
    mine: ownMine.value.has(uuid),
    // You are not listed among an org's owners: the "you" line already says it
    orgs: (me.value?.orgs ?? []).map((o) => ({
      guildId: o.guildId, name: o.name,
      owners: (orgOwners.value!.get(o.guildId)?.get(uuid) ?? []).filter((m) => m.userId !== me.value?.userId),
    })),
  };
};

const reload = coalesced(() => void loadStock());
const reloadOwners = coalesced(() => void loadOwners());
let unsubscribe = () => {};
onMounted(() => {
  unsubscribe = onServerMessage((m) => {
    if (m.type === "stock" || m.type === "resync") reload.schedule();
    if (m.type === "blueprints" || m.type === "members" || m.type === "profile" || m.type === "resync") reloadOwners.schedule();
  });
});
onUnmounted(() => {
  unsubscribe();
  reload.cancel();
  reloadOwners.cancel();
});

const add = addToCrafting;

function remove(entry: PlanEntry) {
  checks.value = checks.value.filter((e) => e !== entry);
}

function setQuality(entry: PlanEntry, slotIndex: number, value: number) {
  const q = Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, Math.round(value) || 0));
  entry.quality = { ...entry.quality, [slotIndex]: q };
}

function setCount(entry: PlanEntry, n: number) {
  entry.count = clampCount(n);
}
</script>

<template>
  <div class="page">
    <section class="panel unclipped">
      <div class="head">
        <Icon name="crafter" :size="16" />
        <span class="head-title no-grow">{{ t("crafting.title") }}</span>
        <div class="spacer" />
      </div>

      <!-- As Mining's and Buy/Sell's: the tile's head with the view's name, then a section with its bar (label, picker, actions) -->
      <section class="section">
        <div class="section-bar">
          <Icon name="blueprint" :size="14" />
          <span class="panel-title">{{ t("crafting.check") }}</span>
          <div class="divider bar-divider" />
          <CraftingPicker class="section-picker" @add="add" />
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
            :stock="stock"
            :owners="ownersOf(entry.blueprintUuid)"
            @count="(n) => setCount(entry, n)"
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
    </section>
  </div>
</template>

<style scoped>
.entry-missing {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  background: var(--bg-base);
  font-size: 13px;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.section-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-dim);
}

.entries {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Phones: the picker gets a row of its own below the label and Clear */
@media (max-width: 640px) {
  .bar-divider {
    display: none;
  }

  .section-picker {
    order: 10;
    flex-basis: 100%;
  }
}
</style>
