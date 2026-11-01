<script lang="ts">
import { ref } from "vue";

// The pick (a material or item), kept for the session
const tradePick = ref<string | null>(null);
// The system filter, kept for the session like the pick (it narrows the places too)
const tradeSystem = ref("");
// The picked place ("<system>|<location>"), kept for the session
const placePick = ref<string | null>(null);
</script>

<script setup lang="ts">
// Kaufen/Verkaufen, the item finder: pick anything UEX has a price for (GET /api/trade/items, per visit and
// language; shop items too, not only what can be booked), see its info card as a tile and where it trades
// (GET /api/trade/:uuid), both sides as two columns. Below, "Nach Ort": pick a station, city or outpost
// (GET /api/trade/places) and see everything its shops trade (GET /api/trade/place), grouped by shop.
import { computed, watch } from "vue";
import type {
  MaterialInfo, TradeItem, TradeItemsResponse, TradePlace, TradePlaceOffer, TradePlaceResponse, TradePlacesResponse, TradeResponse,
} from "../../../src/webapp/api-types";
import DataTable from "../../../adminapp/src/components/DataTable.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import type { ColumnSpec } from "../../../adminapp/src/tableColumns";
import { typeIcon } from "../../../adminapp/src/typeIcons";
import { api } from "../api";
import { materials } from "../catalog";
import Dropdown from "../components/Dropdown.vue";
import { loadInfo } from "../components/InfoCard.vue";
import InfoTile from "../components/InfoTile.vue";
import InfoTip from "../components/InfoTip.vue";
import Picker from "../components/Picker.vue";
import TradeTables, { averagesText, systemOptions, systemOptionsOf } from "../components/TradeTables.vue";
import { uec } from "../format";
import { lang, t } from "../i18n";
import { materialThumb } from "../thumbs";
import { toastError } from "../toasts";

const items = ref<TradeItem[] | null>(null);
const places = ref<TradePlace[] | null>(null);
const result = ref<TradeResponse | null>(null);
// The pick's info card (the hover card's content): null while it loads, false when it failed (no tile then)
const info = ref<MaterialInfo | false | null>(null);
const placeOffers = ref<TradePlaceOffer[] | null>(null);

watch(lang, async () => {
  try {
    items.value = (await api<TradeItemsResponse>(`/trade/items?lang=${lang.value}`)).items;
  } catch (e) {
    toastError(e);
  }
}, { immediate: true });
void api<TradePlacesResponse>("/trade/places").then((r) => (places.value = r.places)).catch(toastError);

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
// The icon without a thumbnail: the item's type, else a resource
const itemIcon = (uuid: string) => {
  const i = byUuid.value.get(uuid);
  return i?.kind === "item" ? typeIcon(i.type) : "resource";
};
// Tile and tables appear together: nothing moves when one of them arrives later
const ready = computed(() => result.value !== null && info.value !== null);

// --- Nach Ort ---------------------------------------------------------------------------------------
const placeKey = (p: TradePlace) => `${p.system ?? ""}|${p.location}`;
const placeOptions = computed(() => (places.value ?? []).filter((p) => !tradeSystem.value || p.system === tradeSystem.value)
  .map((p) => ({ value: placeKey(p), label: p.location, hint: p.system ?? undefined })));
// The place filter's systems: those with places
const placeSystemOptions = computed(() => systemOptionsOf((places.value ?? []).map((p) => p.system)));

let placeSeq = 0;
watch(placePick, async (key) => {
  const mine = ++placeSeq;
  placeOffers.value = null;
  if (!key) return;
  const [system, ...rest] = key.split("|");
  const query = new URLSearchParams({ location: rest.join("|"), ...(system ? { system } : {}) });
  try {
    const r = await api<TradePlaceResponse>(`/trade/place?${query}`);
    if (mine === placeSeq) placeOffers.value = r.offers;
  } catch (e) {
    if (mine === placeSeq) toastError(e);
  }
}, { immediate: true });
// A place the system filter hides: no longer picked
watch(tradeSystem, () => {
  if (placePick.value && !placeOptions.value.some((o) => o.value === placePick.value)) placePick.value = null;
});

const placeColumns = computed<ColumnSpec[]>(() => [
  { key: "item", label: t("trade.col.item"), width: 280 },
  { key: "type", label: t("trade.col.type"), width: 180 },
  { key: "buy", label: t("trade.tabBuy"), width: 100 },
  { key: "sell", label: t("trade.tabSell"), width: 100 },
]);
const offerName = (o: TradePlaceOffer) => { const i = byUuid.value.get(o.uuid); return i ? itemLabel(i) : o.uuid; };
function placeValue(o: TradePlaceOffer, key: string): string | number {
  switch (key) {
    case "item": return offerName(o);
    case "type": return byUuid.value.get(o.uuid)?.typeLabel ?? "";
    case "buy": return o.buy ?? -1;
    case "sell": return o.sell ?? -1;
    default: return "";
  }
}
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

      <!-- Nach Ort: was die Shops eines Orts handeln, je Shop gruppiert -->
      <section class="section">
        <div class="section-bar">
          <Icon name="locate" :size="14" />
          <span class="panel-title">{{ t("trade.byPlace") }}</span>
          <div class="divider bar-divider" />
          <Picker v-model="placePick" class="section-picker" :options="placeOptions" :placeholder="t('trade.pickPlace')" strong />
          <Dropdown v-model="tradeSystem" variant="chip" :options="placeSystemOptions" />
        </div>
        <div v-if="!placePick" class="empty-line">{{ t("trade.placeEmpty") }}</div>
        <div v-else-if="!placeOffers || !items" class="empty-line">{{ t("common.loading") }}</div>
        <DataTable
          v-else
          class="place-table"
          storage-key="qm.webapp.columns.trade-place"
          :columns="placeColumns"
          :rows="placeOffers"
          :default-sort="{ key: 'item', dir: 'asc' }"
          :row-key="(o: TradePlaceOffer) => `${o.shop}|${o.uuid}`"
          :value-of="placeValue"
          :numeric="['buy', 'sell']"
          :empty-text="t('trade.noOffers')"
          :group-of="(o: TradePlaceOffer) => o.shop"
        >
          <template #cell-item="{ row }">
            <InfoTip kind="material" :uuid="row.uuid"><span class="item-name"><Icon :name="itemIcon(row.uuid)" :size="14" class="item-icon" />{{ offerName(row) }}</span></InfoTip>
          </template>
          <template #cell-type="{ row }"><span class="dim">{{ byUuid.get(row.uuid)?.typeLabel ?? "—" }}</span></template>
          <template #cell-buy="{ row }"><span :class="{ dim: row.buy === null }">{{ row.buy === null ? "—" : uec(row.buy) }}</span></template>
          <template #cell-sell="{ row }"><span :class="{ dim: row.sell === null }">{{ row.sell === null ? "—" : uec(row.sell) }}</span></template>
        </DataTable>
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

.section-picker {
  width: 320px;
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

/* A place's offers: the table scrolls inside, its head stays (as the terminal tables) */
.place-table {
  max-height: 60vh;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-control);
}

.place-table :deep(.data-row) {
  cursor: default;
  user-select: text;
}

.item-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.item-icon {
  flex-shrink: 0;
  opacity: 0.8;
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
