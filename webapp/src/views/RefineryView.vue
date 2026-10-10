<script setup lang="ts">
// Refinery: your running jobs, one group per work order (station, time left, the refined materials with
// their expected yields below it), with the stock table's filters; start one, finish one or remove one
// (always the whole work order). Jobs are always personal, so this works the same without any org.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { OkResponse, RefineryRemoveRequest, StockBatch, StockListResponse } from "../../../src/webapp/api-types";
import { formatMicros, toMicros } from "../../../src/planner/plan";
import ColumnHead from "../../../adminapp/src/components/ColumnHead.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { sortRows, useTableColumns, type ColumnSpec } from "../../../adminapp/src/tableColumns";
import { api } from "../api";
import ConfirmDialog, { type ConfirmButton } from "../components/ConfirmDialog.vue";
import Dropdown from "../components/Dropdown.vue";
import InfoTip from "../components/InfoTip.vue";
import RangeSlider from "../components/RangeSlider.vue";
import RefineryDoneDialog from "../components/RefineryDoneDialog.vue";
import RefineryStartForm from "../components/RefineryStartForm.vue";
import RefineryTimeDialog from "../components/RefineryTimeDialog.vue";
import { signedBonus, yieldValue } from "../catalog";
import { compareBatches, hm, Q_TIER_MAX, qMark, qText, qTier, qty, tierMark, tierQualities } from "../format";
import { lang, t } from "../i18n";
import { coalesced, onServerMessage } from "../realtime";
import { toast, toastError } from "../toasts";

const data = ref<StockListResponse | null>(null);
const materialText = ref("");
const locationFilter = ref("");
// Quality filter in tiers (qTier)
const qualityLow = ref(0);
const qualityHigh = ref(Q_TIER_MAX);
// "Start job" in a panel below the head
const showStart = ref(false);

function started() {
  showStart.value = false;
  void load();
}
// The batches of the job being finished
const finishing = ref<StockBatch[] | null>(null);
// The job waiting for the remove confirmation
const removing = ref<Job | null>(null);
const busy = ref(false);
// The job whose time left is being set
const timing = ref<{ jobId: string; location: string; endsAt: string | null } | null>(null);

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

const reload = coalesced(() => void load());
let unsubscribe = () => {};
onMounted(() => {
  tick = setInterval(() => (now.value = Date.now()), 30_000);
  void load();
  unsubscribe = onServerMessage((m) => {
    if (m.type === "resync" || (m.type === "stock" && m.scope === "personal")) reload.schedule();
  });
});
onUnmounted(() => {
  unsubscribe();
  reload.cancel();
  clearInterval(tick);
});

const batches = computed(() => (data.value?.batches ?? []).filter((b) => b.state === "refining" && b.refine));

interface Job {
  id: string;
  location: string;
  locationUuid: string;
  endsAt: string | null;
  // Every batch of the job (finishing and removing take them all), and those the filters let through
  all: StockBatch[];
  rows: StockBatch[];
  // Sum of the expected yields
  total: string;
}

const jobs = computed(() => {
  const by = new Map<string, StockBatch[]>();
  for (const b of batches.value) by.set(b.refine!.jobId, [...(by.get(b.refine!.jobId) ?? []), b]);
  return [...by].map(([id, all]): Job => {
    const b = all[0]!;
    return {
      id, location: b.location, locationUuid: b.locationUuid, endsAt: b.refine!.endsAt, all, rows: all,
      total: formatMicros(all.reduce((sum, x) => sum + toMicros(x.quantity), 0n)),
    };
  });
});

const filtered = computed(() => {
  const words = materialText.value.toLowerCase().split(/\s+/).filter(Boolean);
  return jobs.value
    .filter((j) => !locationFilter.value || j.locationUuid === locationFilter.value)
    .map((j) => ({
      ...j,
      rows: j.all.filter((b) => qTier(b.quality) >= qualityLow.value && qTier(b.quality) <= qualityHigh.value
        && words.every((w) => `${b.material} ${b.location}`.toLowerCase().includes(w))),
    }))
    .filter((j) => j.rows.length);
});

// --- the table: one group per job (station, total yield, time left), its materials below -----------
const columns = computed<ColumnSpec[]>(() => [
  { key: "material", label: t("refinery.col.job"), width: 240 },
  { key: "quality", label: t("stock.col.quality"), width: 130 },
  { key: "amount", label: t("refinery.col.expected"), width: 120 },
  { key: "bonus", label: t("refinery.col.bonus"), width: 90 },
  { key: "ready", label: t("refinery.col.ready"), width: 130 },
  { key: "actions", label: "", width: 110, sortable: false, fixed: true, sep: true },
]);
const cols = useTableColumns("qm.webapp.columns.refinery", columns, { key: "ready", dir: "asc" });

function rowValue(b: StockBatch, key: string): string | number {
  switch (key) {
    case "material": return b.material;
    case "quality": return b.quality;
    case "amount": return Number(b.quantity);
    // No UEX value sorts below every reported one
    case "bonus": return yieldValue(b.locationUuid, b.subjectUuid) ?? -Infinity;
    default: return "";
  }
}

function jobValue(j: Job, key: string): string | number {
  switch (key) {
    case "material": return j.location;
    case "amount": return Number(j.total);
    // Jobs without an end sort after every timed one
    default: return j.endsAt ? Date.parse(j.endsAt) : Infinity;
  }
}

const groups = computed(() => {
  const { key, dir } = cols.sort.value;
  const sign = dir === "asc" ? 1 : -1;
  // Job columns order the jobs; material columns order the materials within each job (jobs then by time left)
  const jobKey = ["material", "amount", "ready"].includes(key) ? key : "ready";
  const jobSign = jobKey === key ? sign : 1;
  const cmp = (a: string | number, b: string | number) => (typeof a === "string" ? a.localeCompare(String(b), lang.value) : a - Number(b));
  return filtered.value
    .map((j) => ({ ...j, rows: sortRows(j.rows, cols.sort.value, rowValue, compareBatches) }))
    .sort((a, b) => jobSign * cmp(jobValue(a, jobKey), jobValue(b, jobKey)) || a.id.localeCompare(b.id));
});

const locationOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const j of jobs.value) seen.set(j.locationUuid, j.location);
  return [
    { value: "", label: t("stock.allLocations") },
    ...[...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, lang.value)),
  ];
});

/** null: no end recorded; "" ready; else the time left */
function left(j: Job): string | null {
  if (!j.endsAt) return null;
  const ms = Date.parse(j.endsAt) - now.value;
  return ms <= 0 ? "" : t("refinery.in", { t: hm(ms / 1000) });
}

const endsTitle = (j: Job) => (j.endsAt ? new Date(j.endsAt).toLocaleString(lang.value) : "");

const removeButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("common.confirm"), kind: "danger", value: "confirm", disabled: busy.value },
]);

async function chooseRemove(value: string) {
  const j = removing.value;
  if (value !== "confirm" || !j) {
    removing.value = null;
    return;
  }
  if (busy.value) return;
  busy.value = true;
  try {
    const body: RefineryRemoveRequest = { jobId: j.id, rows: j.all.map((b) => ({ batchId: b.id, expected: b.quantity })) };
    await api<OkResponse>("/refinery/remove", { method: "POST", body });
    toast(t("refinery.removed", { what: `${j.all.map((b) => b.material).join(", ")} · ${j.location}` }));
    void load();
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
    removing.value = null;
  }
}

const bonusText = (b: StockBatch) => {
  const v = yieldValue(b.locationUuid, b.subjectUuid);
  return v === undefined ? "" : `${signedBonus(v)} %`;
};
</script>

<template>
  <div class="page">
    <section class="panel unclipped">
      <div class="head">
        <Icon name="drop" :size="16" />
        <span class="head-title">{{ t("refinery.jobs") }}</span>
        <button type="button" class="btn small primary" @click="showStart = !showStart">
          <Icon :name="showStart ? 'close' : 'plus'" :size="14" /> {{ t("refinery.start") }}
        </button>
      </div>
      <div v-if="showStart" class="add-area">
        <div class="head"><Icon name="plus" :size="16" /><span class="head-title">{{ t("refinery.start") }}</span></div>
        <RefineryStartForm @done="started" />
      </div>
      <div class="filters">
        <label class="search">
          <Icon name="search" :size="14" />
          <input v-model="materialText" type="text" :placeholder="t('filter.text')" />
          <button v-if="materialText" type="button" class="clear" @click="materialText = ''"><Icon name="close" :size="12" /></button>
        </label>
        <Dropdown v-model="locationFilter" variant="chip" :options="locationOptions" />
        <RangeSlider v-model:low="qualityLow" v-model:high="qualityHigh" :min="0" :max="Q_TIER_MAX" :step="1" :format="tierMark" :detail="tierQualities" :label="t('field.quality')" />
        <span class="spacer" />
        <span class="head-count">{{ filtered.length }} / {{ jobs.length }}</span>
      </div>

      <div v-if="!data" class="empty-line">{{ t("common.loading") }}</div>
      <div v-else-if="!jobs.length" class="empty-line">{{ t("refinery.none") }}</div>
      <div v-else class="table" :ref="cols.observe" :style="{ '--cols': cols.template.value, '--cols-min': `${cols.minWidth.value}px` }">
        <ColumnHead :columns="columns" :sort="cols.sort.value" @sort="cols.toggleSort" @resize="cols.startResize" @reset="cols.resetWidth" />
        <div v-if="!groups.length" class="empty-line">{{ t("stock.noMatch") }}</div>
        <template v-for="j in groups" :key="j.id">
          <!-- The job's row: station, total yield, time left, finishing or removing it -->
          <div class="row data-row group-row">
            <span class="group-name">
              <Icon name="drop" :size="15" class="type-icon" />
              <span class="cell">{{ j.location }}</span>
            </span>
            <span />
            <span class="num group-total">{{ qty(j.total, "SCU") }}</span>
            <span />
            <span :title="endsTitle(j)">
              <span v-if="left(j) === ''" class="tag ok">{{ t("refinery.readyNow") }}</span>
              <span v-else-if="left(j) === null" class="dim">{{ t("refinery.durationOpen") }}</span>
              <template v-else>{{ left(j) }}</template>
            </span>
            <span class="sep actions">
              <button type="button" class="icon-btn" :title="t('refinery.setTime')" @click="timing = { jobId: j.id, location: j.location, endsAt: j.endsAt }"><Icon name="clock" :size="15" /></button>
              <button type="button" class="icon-btn" :title="t('refinery.done')" @click="finishing = j.all"><Icon name="check" :size="15" /></button>
              <button type="button" class="icon-btn" :title="t('refinery.remove')" @click="removing = j"><Icon name="trash" :size="15" /></button>
            </span>
          </div>
          <div v-for="b in j.rows" :key="b.id" class="row data-row batch-row">
            <span class="material-name">
              <Icon name="resource" :size="14" class="type-icon" />
              <InfoTip kind="material" :uuid="b.subjectUuid">{{ b.material }}</InfoTip>
            </span>
            <span class="num"><span class="qcell"><span>{{ qMark(b.quality) }}</span><span>{{ b.quality }}</span></span></span>
            <span class="num">{{ qty(b.quantity, b.unit) }}</span>
            <span class="num">{{ bonusText(b) }}</span>
            <span />
            <span class="sep" />
          </div>
        </template>
      </div>
    </section>

    <RefineryDoneDialog v-if="finishing" :batches="finishing" @close="finishing = null" @done="load" />
    <RefineryTimeDialog v-if="timing" v-bind="timing" @close="timing = null" />
    <ConfirmDialog v-if="removing" :title="t('refinery.removeTitle')" :subtitle="removing.location" icon="trash" :buttons="removeButtons" @choose="chooseRemove">
      <div class="summary">
        <span v-for="b in removing.all" :key="b.id">{{ b.material }} · {{ qty(b.quantity, b.unit) }} · {{ qText(b.quality) }}</span>
      </div>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
/* The work order over its ores: station, totals, time left */
.group-row {
  background: var(--bg-surface-2);
  color: var(--text-2);
}

.group-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* A material of the job, indented below it */
.material-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding-left: 22px;
  font-size: 13px;
  font-weight: 500;
}

.type-icon {
  flex-shrink: 0;
  opacity: 0.8;
}

/* As the stock table's material rows, only in the quieter colour and the station not bold */
.group-name,
.group-total {
  font-size: 14px;
  font-weight: 600;
}

.group-name {
  font-weight: 500;
}

/* The action buttons must not make the row taller than the stock table's material rows */
.group-row .icon-btn {
  margin-block: -4px;
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
