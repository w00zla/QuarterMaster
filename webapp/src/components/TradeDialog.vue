<script setup lang="ts">
// Where a material trades (GET /api/trade/:uuid, UEX community reports): a tab per side the terminals
// trade on ("Verkaufen": they pay, "Kaufen": they ask), each a table of every terminal, best price first;
// UEX's averages in the head. Items have no stock column (UEX reports none).
import { computed, ref } from "vue";
import type { TradeOffer, TradeResponse } from "../../../src/webapp/api-types";
import DataTable from "../../../adminapp/src/components/DataTable.vue";
import type { ColumnSpec } from "../../../adminapp/src/tableColumns";
import { api } from "../api";
import { shortDate, uec } from "../format";
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
  { key: "terminal", label: t("trade.col.terminal"), width: 240 },
  { key: "system", label: t("trade.col.system"), width: 90 },
  { key: "price", label: t("trade.col.price"), width: 90 },
  ...(hasScu.value ? [{ key: "scu", label: t(side.value === "sell" ? "trade.col.demand" : "trade.col.stock"), width: 140 }] : []),
  { key: "date", label: t("trade.col.date"), width: 70 },
]);

function valueOf(r: TradeOffer, key: string): string | number {
  switch (key) {
    case "terminal": return r.terminal;
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
          :row-key="(r: TradeOffer) => `${r.terminal}|${r.system}|${r.price}|${r.date}`"
          :value-of="valueOf"
          :numeric="['price', 'scu', 'date']"
        >
          <template #cell-system="{ row }">{{ row.system ?? "—" }}</template>
          <template #cell-price="{ row }">{{ uec(row.price) }}</template>
          <template #cell-scu="{ row }">
            {{ row.scu === null ? "—" : uec(row.scu) }}<span v-if="side === 'sell' && row.scuAvg !== null" class="dim"> · ⌀ {{ uec(row.scuAvg) }}</span>
          </template>
          <template #cell-date="{ row }">{{ shortDate(row.date) }}</template>
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
</style>
