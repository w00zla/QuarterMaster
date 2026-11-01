<script lang="ts">
import type { PriceSummary, TradeResponse } from "../../../src/webapp/api-types";
import type { DropdownOption } from "./Dropdown.vue";
import { auec } from "../format";
import { t } from "../i18n";

/** UEX's averages: "⌀ Verkauf 8.120 aUEC · ⌀ Kauf 9.000 aUEC" ("" without any). */
export function averagesText(p: PriceSummary | undefined): string {
  return [
    p?.sell?.avg != null ? `⌀ ${t("trade.sell")} ${auec(p.sell.avg)}` : null,
    p?.buy?.avg != null ? `⌀ ${t("trade.buy")} ${auec(p.buy.avg)}` : null,
  ].filter(Boolean).join(" · ");
}

/** A system filter's options: "Alle Systeme" ("") and every system given, by name. */
export function systemOptionsOf(systems: Iterable<string | null>): DropdownOption[] {
  const named = [...new Set([...systems].filter((s): s is string => !!s))].sort();
  return [{ value: "", label: t("filter.allSystems") }, ...named.map((s) => ({ value: s, label: s }))];
}

/** The system filter's options for a material: the systems of its terminals on either side. */
export const systemOptions = (data: TradeResponse | null): DropdownOption[] =>
  systemOptionsOf([...(data?.buy ?? []), ...(data?.sell ?? [])].map((r) => r.system));
</script>

<script setup lang="ts">
// Where a material trades (GET /api/trade/:uuid, UEX community reports): a tab per side the terminals
// trade on ("Verkaufen": they pay, "Kaufen": they ask), each a table of every terminal; grouped by system
// (Kaufen by the terminal's name, Verkaufen best price first) The report's date in the terminal's tooltip. Items have
// no stock column (UEX reports none). Shown by the trading dialog (tabs, the system filter at their
// right) and the Kaufen/Verkaufen view (`split`: both sides as two columns, Kaufen left, an empty side
// says so; the view puts the filter in its own bar). `system`: the filter ("" = all).
import { computed, ref, watch } from "vue";
import type { TradeOffer } from "../../../src/webapp/api-types";
import DataTable from "../../../adminapp/src/components/DataTable.vue";
import type { ColumnSpec } from "../../../adminapp/src/tableColumns";
import { priceTime, uec } from "../format";
import Dropdown from "./Dropdown.vue";

const props = defineProps<{ data: TradeResponse; split?: boolean }>();
const system = defineModel<string>("system", { default: "" });

type Side = "sell" | "buy";
const side = ref<Side>("sell");
watch(() => props.data, (d) => (side.value = d.sell.length ? "sell" : "buy"), { immediate: true });

// The tabs from the unfiltered sides: the filter never makes a tab vanish
const sides = computed(() => (["sell", "buy"] as const).filter((s) => props.data[s].length));
// The tables shown: both sides side by side, else the tab's
const shown = computed<Side[]>(() => (props.split ? ["buy", "sell"] : [side.value]));
const rows = (s: Side) => (system.value ? props.data[s].filter((r) => r.system === system.value) : props.data[s]);
const hasScu = (s: Side) => props.data[s].some((r) => r.scu !== null);
const options = computed(() => systemOptions(props.data));
// A system the new data has no terminal in: back to all
watch(options, (o) => { if (system.value && !o.some((x) => x.value === system.value)) system.value = ""; }, { immediate: true });

// Two columns: narrower defaults, so both fit next to each other (own widths, apart from the dialog's)
const columns = (s: Side): ColumnSpec[] => [
  { key: "terminal", label: t("trade.col.terminal"), width: props.split ? 260 : 340 },
  { key: "price", label: t("trade.col.price"), width: 90 },
  ...(hasScu(s) ? [{ key: "scu", label: t(s === "sell" ? "trade.col.demand" : "trade.col.stock"), width: props.split ? 110 : 140 }] : []),
];

// The place first, then the shop there: "ARC-L1 Wide Forest Station – Admin" (just one when they are the same)
const terminalText = (r: TradeOffer) => (r.terminal && r.terminal !== r.location ? `${r.location} – ${r.terminal}` : r.location);
// Its tooltip adds the report's date: "ARC-L1 Wide Forest Station – Admin · Stand 09.09.2026, 14:03"
const terminalTitle = (r: TradeOffer) => `${terminalText(r)} · ${t("trade.col.date")} ${priceTime(r.date)}`;

// The bars' scale per side: its largest amount or average
const scuMax = computed(() => Object.fromEntries((["sell", "buy"] as const).map((s) =>
  [s, Math.max(1, ...props.data[s].flatMap((r) => [r.scu ?? 0, r.scuAvg ?? 0]))])) as Record<Side, number>);
const share = (s: Side, scu: number) => `${Math.min(100, (scu / scuMax.value[s]) * 100)}%`;
const scuTitle = (r: TradeOffer) =>
  [`${uec(r.scu ?? 0)} SCU`, r.scuAvg !== null ? `⌀ ${uec(r.scuAvg)} SCU` : null].filter(Boolean).join(" · ");

function valueOf(r: TradeOffer, key: string): string | number {
  switch (key) {
    case "terminal": return terminalText(r);
    case "price": return r.price;
    case "scu": return r.scu ?? -1;
    default: return "";
  }
}
</script>

<template>
  <div class="trade-body" :class="{ split }">
    <div v-if="!split" class="scope-bar">
      <button v-for="s in sides" :key="s" type="button" class="scope" :class="{ active: side === s }" @click="side = s">
        {{ t(s === "sell" ? "trade.tabSell" : "trade.tabBuy") }} · {{ rows(s).length }}
      </button>
      <div class="spacer" />
      <Dropdown v-model="system" variant="chip" :options="options" />
    </div>
    <div v-for="s in shown" :key="s" class="side">
      <div v-if="split" class="side-head">{{ t(s === "sell" ? "trade.tabSell" : "trade.tabBuy") }} · {{ rows(s).length }}</div>
      <div v-if="split && !rows(s).length" class="empty-line">{{ t("trade.noTerminals") }}</div>
      <!-- New storage keys since the date column left (2026-11-01): the new default sort applies -->
      <DataTable
        v-else
        :key="s"
        :storage-key="`qm.webapp.columns.trade-${split ? 'view' : 'dialog'}-${s}`"
        :columns="columns(s)"
        :rows="rows(s)"
        :default-sort="s === 'sell' ? { key: 'price', dir: 'desc' } : { key: 'terminal', dir: 'asc' }"
        :row-key="(r: TradeOffer) => `${r.location}|${r.terminal}|${r.system}|${r.price}|${r.date}`"
        :value-of="valueOf"
        :numeric="['price', 'scu']"
        :empty-text="t('trade.noTerminals')"
        :group-of="(r: TradeOffer) => r.system ?? '—'"
      >
        <template #cell-terminal="{ row }"><span :title="terminalTitle(row)">{{ terminalText(row) }}</span></template>
        <template #cell-price="{ row }">{{ uec(row.price) }}</template>
        <!-- A bar against the side's largest amount, a tick at the terminal's average; the figures on hover -->
        <template #cell-scu="{ row }">
          <span v-if="row.scu === null" class="dim">—</span>
          <span v-else class="scu-bar" :title="scuTitle(row)">
            <span class="fill" :style="{ width: share(s, row.scu) }" />
            <span v-if="row.scuAvg !== null" class="avg" :style="{ left: share(s, row.scuAvg) }" />
          </span>
        </template>
      </DataTable>
    </div>
  </div>
</template>

<style scoped>
.trade-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* Two columns side by side: Kaufen left, Verkaufen right; one below the other when narrow */
.trade-body.split {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

@media (max-width: 1100px) {
  .trade-body.split {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* A side's head: like a section's title */
.side-head {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

/* Every terminal: the table scrolls inside, its head stays */
.trade-body :deep(.table) {
  max-height: 55vh;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-control);
}

.trade-body :deep(.data-row) {
  cursor: default;
  user-select: text;
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
