<script setup lang="ts">
// Where a material trades (GET /api/trade/:uuid, UEX community reports): a tab per side the terminals
// trade on ("Verkaufen": they pay, "Kaufen": they ask), each a table of every terminal, best price first;
// UEX's averages in the head. Items have no stock column (UEX reports none).
import { computed, ref } from "vue";
import type { TradeOffer, TradeResponse } from "../../../src/webapp/api-types";
import DataTable from "../../../adminapp/src/components/DataTable.vue";
import type { ColumnSpec } from "../../../adminapp/src/tableColumns";
import { api } from "../api";
import { priceTime, uec } from "../format";
import { t } from "../i18n";
import { toastError } from "../toasts";
import ConfirmDialog, { type ConfirmButton } from "./ConfirmDialog.vue";

const props = defineProps<{ uuid: string; name: string }>();
const emit = defineEmits<{ close: [] }>();

type Side = "sell" | "buy";
const data = ref<TradeResponse | null>(null);
const side = ref<Side>("sell");

void api<TradeResponse>(`/trade/${props.uuid}`).then((r) => {
  data.value = r;
  if (!r.sell.length) side.value = "buy";
}).catch((e: unknown) => {
  toastError(e);
  emit("close");
});

const sides = computed(() => (["sell", "buy"] as const).filter((s) => data.value?.[s].length));
const rows = computed(() => data.value?.[side.value] ?? []);
const hasScu = computed(() => rows.value.some((r) => r.scu !== null));

const columns = computed<ColumnSpec[]>(() => [
  { key: "terminal", label: t("trade.col.terminal"), width: 300 },
  { key: "system", label: t("trade.col.system"), width: 90 },
  { key: "price", label: t("trade.col.price"), width: 90 },
  ...(hasScu.value ? [{ key: "scu", label: t(side.value === "sell" ? "trade.col.demand" : "trade.col.stock"), width: 140 }] : []),
  { key: "date", label: t("trade.col.date"), width: 140 },
]);

// The place first, then the shop there: "ARC-L1 Wide Forest Station – Admin" (just one when they are the same)
const terminalText = (r: TradeOffer) => (r.terminal && r.terminal !== r.location ? `${r.location} – ${r.terminal}` : r.location);

// The bars' scale: the tab's largest amount or average
const scuMax = computed(() => Math.max(1, ...rows.value.flatMap((r) => [r.scu ?? 0, r.scuAvg ?? 0])));
const share = (scu: number) => `${Math.min(100, (scu / scuMax.value) * 100)}%`;
const scuTitle = (r: TradeOffer) =>
  [`${uec(r.scu ?? 0)} SCU`, r.scuAvg !== null ? `⌀ ${uec(r.scuAvg)} SCU` : null].filter(Boolean).join(" · ");

function valueOf(r: TradeOffer, key: string): string | number {
  switch (key) {
    case "terminal": return terminalText(r);
    case "system": return r.system ?? "";
    case "price": return r.price;
    case "scu": return r.scu ?? -1;
    case "date": return Date.parse(r.date);
    default: return "";
  }
}

const averages = computed(() => {
  const p = data.value?.prices;
  return [
    p?.sell?.avg != null ? `⌀ ${t("trade.sell")} ${uec(p.sell.avg)}` : null,
    p?.buy?.avg != null ? `⌀ ${t("trade.buy")} ${uec(p.buy.avg)}` : null,
  ].filter(Boolean).join(" · ");
});

const buttons = computed<ConfirmButton[]>(() => [{ label: t("common.close"), kind: "outline", value: "close" }]);
</script>

<template>
  <ConfirmDialog :title="name" :subtitle="t('trade.button')" icon="list" :buttons="buttons" xl @choose="emit('close')">
    <template #head><span class="averages">{{ averages }}</span></template>
    <div class="trade-body">
      <div v-if="!data" class="empty-line">{{ t("common.loading") }}</div>
      <template v-else>
        <div class="scope-bar">
          <button v-for="s in sides" :key="s" type="button" class="scope" :class="{ active: side === s }" @click="side = s">
            {{ t(s === "sell" ? "trade.tabSell" : "trade.tabBuy") }} · {{ data[s].length }}
          </button>
        </div>
        <DataTable
          :key="side"
          :storage-key="`qm.webapp.columns.trade-${side}`"
          :columns="columns"
          :rows="rows"
          :default-sort="{ key: 'price', dir: side === 'sell' ? 'desc' : 'asc' }"
          :row-key="(r: TradeOffer) => `${r.location}|${r.terminal}|${r.system}|${r.price}|${r.date}`"
          :value-of="valueOf"
          :numeric="['price', 'scu', 'date']"
        >
          <template #cell-system="{ row }"><span class="system">{{ row.system ?? "—" }}</span></template>
          <template #cell-price="{ row }">{{ uec(row.price) }}</template>
          <!-- A bar against the tab's largest amount, a tick at the terminal's average; the figures on hover -->
          <template #cell-scu="{ row }">
            <span v-if="row.scu === null" class="dim">—</span>
            <span v-else class="scu-bar" :title="scuTitle(row)">
              <span class="fill" :style="{ width: share(row.scu) }" />
              <span v-if="row.scuAvg !== null" class="avg" :style="{ left: share(row.scuAvg) }" />
            </span>
          </template>
          <template #cell-date="{ row }"><span class="date">{{ priceTime(row.date) }}</span></template>
        </DataTable>
      </template>
    </div>
  </ConfirmDialog>
</template>

<style scoped>
.averages {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

.trade-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Every terminal: the table scrolls inside the dialog, its head stays */
.trade-body :deep(.table) {
  max-height: 55vh;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-control);
}

.trade-body :deep(.data-row) {
  cursor: default;
  user-select: text;
}

/* The system in the mono face, set apart from the terminal's name */
.system {
  font-family: var(--font-mono);
  font-size: 12px;
}

/* The report's time: background information */
.date {
  color: var(--text-3);
  font-size: 12px;
}

/* Demand / stock as a bar: the track the full cell, the fill this terminal, a tick its average */
.scu-bar {
  position: relative;
  display: block;
  width: 100%;
  height: 8px;
  border-radius: 4px;
  background: var(--bg-surface-2);
  overflow: hidden;
}

.scu-bar .fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 70%, transparent);
}

.scu-bar .avg {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--text);
  opacity: 0.6;
}
</style>
