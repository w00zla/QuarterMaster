<script lang="ts">
import { ref } from "vue";

// The pick (a material or item), kept for the session
const tradePick = ref<string | null>(null);
// The system filter, kept for the session like the pick
const tradeSystem = ref("");
</script>

<script setup lang="ts">
// Kaufen/Verkaufen, the item finder: pick anything UEX has a price for (GET /api/trade/items, per visit and
// language; shop items too, not only what can be booked), see its info card as a tile and where it trades
// (GET /api/trade/:uuid), both sides as two columns.
import { computed, watch } from "vue";
import type { MaterialInfo, TradeItem, TradeItemsResponse, TradeResponse } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { typeIcon } from "../../../adminapp/src/typeIcons";
import { api } from "../api";
import { materials } from "../catalog";
import Dropdown from "../components/Dropdown.vue";
import { loadInfo } from "../components/InfoCard.vue";
import InfoTile from "../components/InfoTile.vue";
import Picker from "../components/Picker.vue";
import TradeTables, { averagesText, systemOptions } from "../components/TradeTables.vue";
import { lang, t } from "../i18n";
import { materialThumb } from "../thumbs";
import { toastError } from "../toasts";

const items = ref<TradeItem[] | null>(null);
const result = ref<TradeResponse | null>(null);
// The pick's info card (the hover card's content): null while it loads, false when it failed (no tile then)
const info = ref<MaterialInfo | false | null>(null);

watch(lang, async () => {
  try {
    items.value = (await api<TradeItemsResponse>(`/trade/items?lang=${lang.value}`)).items;
  } catch (e) {
    toastError(e);
  }
}, { immediate: true });

const byUuid = computed(() => new Map((items.value ?? []).map((i) => [i.uuid, i])));
// Bookable components by their catalog label (unique: size and grade where names repeat), the rest by name;
// the type as the hint
const itemLabel = (i: TradeItem) => (i.bookable ? materials.value.get(i.uuid)?.label : undefined) ?? i.name;
const options = computed(() => (items.value ?? []).map((i) => ({ value: i.uuid, label: itemLabel(i), hint: i.typeLabel ?? undefined }))
  .sort((a, b) => a.label.localeCompare(b.label, lang.value)));

let seq = 0;
watch([tradePick, lang], async () => {
  const mine = ++seq;
  result.value = null;
  info.value = null;
  if (!tradePick.value) return;
  loadInfo("material", tradePick.value).then((i) => i as MaterialInfo, () => false as const)
    .then((i) => { if (mine === seq) info.value = i; });
  try {
    const r = await api<TradeResponse>(`/trade/${tradePick.value}`);
    if (mine === seq) result.value = r;
  } catch (e) {
    if (mine === seq) toastError(e);
  }
}, { immediate: true });

const averages = computed(() => averagesText(result.value?.prices));
// The tile's icon without a thumbnail: the item's type, else a resource
const itemIcon = (uuid: string) => {
  const i = byUuid.value.get(uuid);
  return i?.kind === "item" ? typeIcon(i.type) : "resource";
};
// Tile and tables appear together: nothing moves when one of them arrives later
const ready = computed(() => result.value !== null && info.value !== null);
</script>

<template>
  <div class="page">
    <section class="panel unclipped">
      <div class="head">
        <Icon name="trade" :size="16" />
        <span class="head-title no-grow">{{ t("trade.title") }}</span>
        <div class="spacer" />
      </div>

      <section class="section">
        <div class="section-bar">
          <Icon name="list" :size="14" />
          <span class="panel-title">{{ t("trade.prices") }}</span>
          <div class="divider bar-divider" />
          <Picker v-model="tradePick" class="section-picker" :options="options" :placeholder="t('trade.pick')" strong />
          <Dropdown v-model="tradeSystem" variant="chip" :options="systemOptions(result)" />
          <div class="spacer" />
          <span v-if="averages" class="averages">{{ averages }}</span>
        </div>
        <div v-if="!tradePick" class="empty-line">{{ t("trade.empty") }}</div>
        <div v-else-if="!ready" class="empty-line">{{ t("common.loading") }}</div>
        <template v-else>
          <InfoTile v-if="info" class="tile-box" :thumb="materialThumb(tradePick)" :icon="itemIcon(tradePick)" :info="info" />
          <TradeTables v-if="result" v-model:system="tradeSystem" :data="result" split />
        </template>
      </section>
    </section>
  </div>
</template>

<style scoped>
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

/* The view's main input: ~30 % wider than before (320 -> 416 px), like Bergbau's and Crafting's */
.section-picker {
  width: 416px;
  max-width: 100%;
}

/* The pick's info tile above the tables: set off like a stat tile */
.tile-box {
  padding: 12px 14px;
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
}

.averages {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

/* Phones: the picker gets a row of its own below the label */
@media (max-width: 640px) {
  .bar-divider {
    display: none;
  }

  .section-picker {
    flex-basis: 100%;
    width: auto;
  }
}
</style>
