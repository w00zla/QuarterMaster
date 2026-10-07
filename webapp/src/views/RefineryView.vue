<script setup lang="ts">
// Refinery: your running jobs (personal batches in state refining), grouped by ore like the stock
// table, with its filters; start one, finish one. Jobs are always personal, so this works the same
// without any org.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { StockBatch, StockListResponse } from "../../../src/webapp/api-types";
import ColumnHead from "../../../adminapp/src/components/ColumnHead.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { sortRows, useTableColumns, type ColumnSpec } from "../../../adminapp/src/tableColumns";
import { api } from "../api";
import BatchDialog from "../components/BatchDialog.vue";
import ConfirmDialog, { type ConfirmButton } from "../components/ConfirmDialog.vue";
import Dropdown from "../components/Dropdown.vue";
import InfoTip from "../components/InfoTip.vue";
import RangeSlider from "../components/RangeSlider.vue";
import StockAddForm from "../components/StockAddForm.vue";
import { methods, signedBonus, yieldValue } from "../catalog";
import { compareBatches, hm, qMark, qty } from "../format";
import { lang, t } from "../i18n";
import { onServerMessage } from "../realtime";
import { toastError } from "../toasts";

const data = ref<StockListResponse | null>(null);
const materialText = ref("");
const locationFilter = ref("");
const qualityLow = ref(0);
const qualityHigh = ref(1000);
// "Start job" as a dialog: the form, then its own confirmation
const showStart = ref(false);
const startForm = ref<InstanceType<typeof StockAddForm> | null>(null);
const startButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("refinery.start"), kind: "primary", value: "start", icon: "drop", form: "refinery-start", disabled: !startForm.value?.ready },
]);

function started() {
  showStart.value = false;
  void load();
}
const finishing = ref<StockBatch | null>(null);

let seq = 0;
async function load() {
  const mine = ++seq;
  try {
    const r = await api<StockListResponse>(`/stock?scope=personal&lang=${lang.value}`);
    if (mine === seq) data.value = r;
  } catch (e) {
    if (mine === seq) toastError(e);
  }
}

watch(lang, load);

// The remaining times count down on their own
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | undefined;

let unsubscribe = () => {};
onMounted(() => {
  tick = setInterval(() => (now.value = Date.now()), 30_000);
  void load();
  unsubscribe = onServerMessage((m) => {
    if (m.type === "resync" || (m.type === "stock" && m.scope === "personal")) void load();
  });
});
onUnmounted(() => {
  unsubscribe();
  clearInterval(tick);
});

const jobs = computed(() => (data.value?.batches ?? []).filter((b) => b.state === "refining"));

const filtered = computed(() => {
  const words = materialText.value.toLowerCase().split(/\s+/).filter(Boolean);
  return jobs.value.filter((b) =>
    (!locationFilter.value || b.locationUuid === locationFilter.value)
    && b.quality >= qualityLow.value && b.quality <= qualityHigh.value
    && words.every((w) => `${b.material} ${b.location}`.toLowerCase().includes(w)));
});

// --- the table: one group per ore (header with the total), its jobs below ----------------------
const columns = computed<ColumnSpec[]>(() => [
  { key: "material", label: t("stock.col.material"), width: 200 },
  { key: "quality", label: t("stock.col.quality"), width: 130 },
  { key: "amount", label: t("stock.col.amount"), width: 120 },
  { key: "location", label: t("stock.col.location"), width: 240 },
  { key: "bonus", label: t("refinery.col.bonus"), width: 90 },
  { key: "method", label: t("refinery.col.method"), width: 170 },
  { key: "expected", label: t("refinery.col.expected"), width: 110 },
  { key: "ready", label: t("refinery.col.ready"), width: 130 },
  { key: "actions", label: "", width: 56, sortable: false, fixed: true, sep: true },
]);
const cols = useTableColumns("qm.webapp.columns.refinery", columns, { key: "quality", dir: "desc" });

function valueOf(b: StockBatch, key: string): string | number {
  switch (key) {
    case "material": return b.material;
    case "quality": return b.quality;
    case "amount": return Number(b.quantity);
    case "location": return b.location;
    // No UEX value sorts below every reported one
    case "bonus": return yieldValue(b.locationUuid, b.subjectUuid) ?? -Infinity;
    case "method": return methodName(b);
    case "expected": return Number(b.refine?.expectedYield ?? -1);
    // Jobs without an end sort after every timed one
    case "ready": return b.refine?.endsAt ? Date.parse(b.refine.endsAt) : Infinity;
    default: return "";
  }
}

const groups = computed(() => {
  const by = new Map<string, StockBatch[]>();
  for (const b of filtered.value) by.set(b.subjectUuid, [...(by.get(b.subjectUuid) ?? []), b]);
  const { key, dir } = cols.sort.value;
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: { material: string }, b: { material: string }) => a.material.localeCompare(b.material, lang.value);
  return [...by.values()]
    .map((rows) => ({
      uuid: rows[0]!.subjectUuid, material: rows[0]!.material, unit: rows[0]!.unit,
      // Ores only exist as refinery jobs: the material's total is the jobs' total
      total: data.value?.totals[rows[0]!.subjectUuid] ?? "0",
      rows: sortRows(rows, cols.sort.value, valueOf, compareBatches),
    }))
    // Groups follow the material and amount columns (by name, by total); otherwise alphabetical
    .sort((a, b) => key === "material" ? sign * byName(a, b)
      : key === "amount" ? sign * (Number(a.total) - Number(b.total)) || byName(a, b)
      : byName(a, b));
});

const locationOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const b of jobs.value) seen.set(b.locationUuid, b.location);
  return [
    { value: "", label: t("stock.allLocations") },
    ...[...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, lang.value)),
  ];
});

const methodName = (b: StockBatch) => (b.refine?.method ? methods.value.get(b.refine.method)?.name ?? b.refine.method : "");

/** null: no end recorded; "" ready; else the time left */
function left(b: StockBatch): string | null {
  if (!b.refine?.endsAt) return null;
  const ms = Date.parse(b.refine.endsAt) - now.value;
  return ms <= 0 ? "" : t("refinery.in", { t: hm(ms / 1000) });
}

const endsTitle = (b: StockBatch) => (b.refine?.endsAt ? new Date(b.refine.endsAt).toLocaleString(lang.value) : "");

const bonusText = (b: StockBatch) => {
  const v = yieldValue(b.locationUuid, b.subjectUuid);
  return v === undefined ? "" : `${signedBonus(v)} %`;
};
</script>

<template>
  <div class="page">
    <section class="panel">
      <div class="head">
        <Icon name="drop" :size="16" />
        <span class="head-title">{{ t("refinery.jobs") }}</span>
        <button type="button" class="btn small primary" @click="showStart = true">
          <Icon name="plus" :size="14" /> {{ t("refinery.start") }}
        </button>
      </div>
    </section>

    <section class="panel unclipped">
      <div class="filters">
        <label class="search">
          <Icon name="search" :size="14" />
          <input v-model="materialText" type="text" :placeholder="t('filter.text')" />
          <button v-if="materialText" type="button" class="clear" @click="materialText = ''"><Icon name="close" :size="12" /></button>
        </label>
        <Dropdown v-model="locationFilter" variant="chip" :options="locationOptions" />
        <RangeSlider v-model:low="qualityLow" v-model:high="qualityHigh" :min="0" :max="1000" label="Q" />
        <span class="spacer" />
        <span class="head-count">{{ filtered.length }} / {{ jobs.length }}</span>
      </div>

      <div v-if="!data" class="empty-line">{{ t("common.loading") }}</div>
      <div v-else-if="!jobs.length" class="empty-line">{{ t("refinery.none") }}</div>
      <div v-else class="table" :style="{ '--cols': cols.template.value, '--cols-min': `${cols.minWidth.value}px` }">
        <ColumnHead :columns="columns" :sort="cols.sort.value" @sort="cols.toggleSort" @resize="cols.startResize" @reset="cols.resetWidth" />
        <div v-if="!groups.length" class="empty-line">{{ t("stock.noMatch") }}</div>
        <template v-for="g in groups" :key="g.uuid">
          <!-- The ore's row: its name, and its total under the amounts -->
          <div class="row data-row group-row">
            <span class="group-name">
              <Icon name="resource" :size="15" class="type-icon" />
              <InfoTip kind="material" :uuid="g.uuid">{{ g.material }}</InfoTip>
            </span>
            <span />
            <span class="num group-total">{{ qty(g.total, g.unit) }}</span>
            <span v-for="c in columns.length - 3" :key="c" :class="{ sep: c === columns.length - 3 }" />
          </div>
          <div v-for="b in g.rows" :key="b.id" class="row data-row batch-row">
            <span />
            <span class="num"><span class="qcell"><span>{{ qMark(b.quality) }}</span><span>{{ b.quality }}</span></span></span>
            <span class="num">{{ qty(b.quantity, b.unit) }}</span>
            <span class="cell">{{ b.location }}</span>
            <span class="num">{{ bonusText(b) }}</span>
            <span class="cell">{{ methodName(b) }}</span>
            <span class="num">{{ b.refine?.expectedYield ? qty(b.refine.expectedYield, "SCU") : "" }}</span>
            <span :title="endsTitle(b)">
              <span v-if="left(b) === ''" class="tag ok">{{ t("refinery.readyNow") }}</span>
              <template v-else>{{ left(b) }}</template>
            </span>
            <span class="sep actions">
              <button type="button" class="icon-btn" :title="t('refinery.done')" @click="finishing = b"><Icon name="check" :size="15" /></button>
            </span>
          </div>
        </template>
      </div>
    </section>

    <ConfirmDialog v-if="showStart" :title="t('refinery.start')" icon="drop" :buttons="startButtons" @choose="showStart = false">
      <StockAddForm ref="startForm" refinery form-id="refinery-start" class="flush" @done="started" />
    </ConfirmDialog>

    <BatchDialog v-if="finishing" :key="finishing.id" :batch="finishing" action="done" @close="finishing = null" @done="load" />
  </div>
</template>

<style scoped>
/* As in the stock table: an ore's name and total over the whole row */
.group-row {
  background: var(--bg-surface-2);
}

.group-name {
  display: flex;
  align-items: center;
  gap: 8px;
}

.type-icon {
  flex-shrink: 0;
  opacity: 0.8;
}

.group-name,
.group-total {
  font-size: 14px;
  font-weight: 600;
}

.data-row {
  cursor: default;
  user-select: text;
}

.cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  justify-content: flex-end;
  gap: 6px;
}
</style>
