<script lang="ts">
import { ref } from "vue";
// The picked scope survives switching tabs
const lastScope = ref("personal");
</script>

<script setup lang="ts">
// Stock: personal or one org's, grouped by material (alphabetical), best quality first within. Changes
// go through BatchDialog (confirmed); adding through StockAddForm; "Find" searches one material.
import { computed, onMounted, onUnmounted, watch } from "vue";
import type { StockBatch, StockListResponse } from "../../../src/webapp/api-types";
import Dropdown from "../components/Dropdown.vue";
import InfoTip from "../components/InfoTip.vue";
import { typeIcon } from "../../../adminapp/src/typeIcons";
import { materials } from "../catalog";
import RangeSlider from "../components/RangeSlider.vue";
import ColumnHead from "../../../adminapp/src/components/ColumnHead.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { sortRows, useTableColumns, type ColumnSpec } from "../../../adminapp/src/tableColumns";
import { api } from "../api";
import BatchDialog, { type BatchAction } from "../components/BatchDialog.vue";
import StockAddForm from "../components/StockAddForm.vue";
import StockFind from "../components/StockFind.vue";
import { compareBatches, Q_TIER_MAX, qMark, qTier, qty, tierMark, tierQualities } from "../format";
import { lang, t } from "../i18n";
import { ensureMembers, memberLabel, members, orgOf, writable } from "../orgs";
import { coalesced, onServerMessage } from "../realtime";
import { me } from "../session";
import { toastError } from "../toasts";

const scope = lastScope;
const data = ref<StockListResponse | null>(null);
const holder = ref("");
const materialText = ref("");
const locationFilter = ref("");
// Quality filter in tiers (qTier)
const qualityLow = ref(0);
const qualityHigh = ref(Q_TIER_MAX);
// Adding in a panel below the head: the form, then its own confirmation
const showAdd = ref(false);

function added() {
  showAdd.value = false;
  void load();
}
const showFind = ref(false);
const dialog = ref<{ batch: StockBatch; action: BatchAction } | null>(null);

const org = computed(() => (scope.value === "personal" ? undefined : orgOf(scope.value)));
const orgWritable = computed(() => writable(org.value));

// Left the org (or it went away): back to personal stock
watch(() => me.value?.orgs, () => {
  if (scope.value !== "personal" && !org.value) scope.value = "personal";
}, { immediate: true });

watch(scope, (s) => {
  holder.value = "";
  locationFilter.value = "";
  if (s !== "personal") ensureMembers(s);
});

let seq = 0;
async function load() {
  const mine = ++seq;
  const query = scope.value === "personal"
    ? "scope=personal"
    : `scope=org&guildId=${encodeURIComponent(scope.value)}${holder.value ? `&holder=${encodeURIComponent(holder.value)}` : ""}`;
  try {
    // lang: material and location names (the server reads it, the contract does not list it yet)
    const r = await api<StockListResponse>(`/stock?${query}&lang=${lang.value}`);
    if (mine === seq) data.value = r;
  } catch (e) {
    if (mine === seq) toastError(e);
  }
}

watch([scope, holder], () => {
  data.value = null;
  void load();
}, { immediate: true });
watch(lang, load);

const reload = coalesced(() => void load());
let unsubscribe = () => {};
onMounted(() => {
  if (scope.value !== "personal") ensureMembers(scope.value);
  unsubscribe = onServerMessage((m) => {
    if (m.type === "resync") reload.schedule();
    else if (m.type === "stock" && (m.scope === "personal" ? scope.value === "personal" : m.guildId === scope.value)) reload.schedule();
  });
});
onUnmounted(() => {
  unsubscribe();
  reload.cancel();
});

const filtered = computed(() => {
  const words = materialText.value.toLowerCase().split(/\s+/).filter(Boolean);
  return (data.value?.batches ?? []).filter((b) =>
    (!locationFilter.value || b.locationUuid === locationFilter.value)
    && qTier(b.quality) >= qualityLow.value && qTier(b.quality) <= qualityHigh.value
    && words.every((w) => `${b.material} ${b.location}`.toLowerCase().includes(w)));
});

// --- the table: one group per material (header with the total), its batches below ------------
const columns = computed<ColumnSpec[]>(() => [
  { key: "material", label: t("stock.col.material"), width: 200 },
  { key: "quality", label: t("stock.col.quality"), width: 130 },
  { key: "amount", label: t("stock.col.amount"), width: 120 },
  { key: "location", label: t("stock.col.location"), width: 280 },
  ...(org.value ? [{ key: "holder", label: t("stock.col.holder"), width: 180 }] : []),
  { key: "state", label: t("stock.col.state"), width: 110 },
  { key: "actions", label: "", width: 104, sortable: false, fixed: true, sep: true },
]);
const cols = useTableColumns("qm.webapp.columns.stock", columns, { key: "quality", dir: "desc" });

function valueOf(b: StockBatch, key: string): string | number {
  switch (key) {
    case "material": return b.material;
    case "quality": return b.quality;
    case "amount": return Number(b.quantity);
    case "location": return b.location;
    case "holder": return b.holderName ?? "";
    case "state": return b.state === "refining" ? t("stock.refining") : "";
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
  for (const b of data.value?.batches ?? []) seen.set(b.locationUuid, b.location);
  return [
    { value: "", label: t("stock.allLocations") },
    ...[...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, lang.value)),
  ];
});

const holderOptions = computed(() => [
  { value: "", label: t("stock.allHolders") },
  ...(org.value ? members[org.value.guildId] ?? [] : []).map((m) => ({ value: m.userId, label: memberLabel(m) })),
]);

const materialIcon = (uuid: string) => {
  const m = materials.value.get(uuid);
  return m?.kind === "item" ? typeIcon(m.type) : "resource";
};

// The server decides (canChange); org stock is also off while the org is read-only
const canChange = (b: StockBatch) => b.canChange && (b.designation === "personal" || writable(orgOf(b.guildId)));

function open(batch: StockBatch, action: BatchAction) {
  dialog.value = { batch, action };
}
</script>

<template>
  <div class="page">
    <section class="panel unclipped">
      <div class="head">
        <Icon name="type-crate" :size="16" />
        <span class="head-title no-grow">{{ t("nav.stock") }}</span>
        <div class="chips">
          <button type="button" class="chip" :class="{ active: scope === 'personal' }" @click="scope = 'personal'"><Icon name="user" :size="14" /> {{ t("stock.personal") }}</button>
          <button v-for="o in me?.orgs ?? []" :key="o.guildId" type="button" class="chip" :class="{ active: scope === o.guildId }" @click="scope = o.guildId">
            <Icon name="users" :size="14" /> {{ o.name }}
          </button>
        </div>
        <span class="spacer" />
        <button type="button" class="btn small outline" :class="{ on: showFind }" @click="showFind = !showFind">
          <Icon name="search" :size="14" /> {{ t("stock.find") }}
        </button>
        <button type="button" class="btn small primary" @click="showAdd = !showAdd">
          <Icon :name="showAdd ? 'close' : 'plus'" :size="14" /> {{ t("stock.add") }}
        </button>
      </div>
      <div v-if="org && !orgWritable" class="readonly warning">
        <Icon name="warning" :size="14" />
        <span>{{ t("stock.readOnlyHint") }} {{ t(org.botPresent ? "home.rosterStale" : "home.botMissingHint") }}</span>
      </div>
    </section>

    <section v-if="showAdd" class="panel unclipped">
      <div class="head"><Icon name="plus" :size="16" /><span class="head-title">{{ t("stock.addTitle") }}</span></div>
      <StockAddForm :target="scope === 'personal' ? null : scope" @done="added" />
    </section>

    <section v-if="showFind" class="panel unclipped">
      <div class="head"><Icon name="search" :size="16" /><span class="head-title">{{ t("stock.findTitle") }}</span></div>
      <StockFind :guild-id="scope === 'personal' ? null : scope" />
    </section>

    <section class="panel unclipped">
      <div class="filters">
        <label class="search">
          <Icon name="search" :size="14" />
          <input v-model="materialText" type="text" :placeholder="t('filter.text')" />
          <button v-if="materialText" type="button" class="clear" @click="materialText = ''"><Icon name="close" :size="12" /></button>
        </label>
        <Dropdown v-model="locationFilter" variant="chip" :options="locationOptions" />
        <Dropdown v-if="org" v-model="holder" variant="chip" :options="holderOptions" />
        <RangeSlider v-model:low="qualityLow" v-model:high="qualityHigh" :min="0" :max="Q_TIER_MAX" :step="1" :format="tierMark" :detail="tierQualities" :label="t('field.quality')" />
        <span class="spacer" />
        <span class="head-count">{{ filtered.length }} / {{ data?.batches.length ?? 0 }}</span>
      </div>

      <div v-if="!data" class="empty-line">{{ t("common.loading") }}</div>
      <div v-else-if="!data.batches.length" class="empty-line">{{ t("stock.empty") }}</div>
      <div v-else class="table" :style="{ '--cols': cols.template.value, '--cols-min': `${cols.minWidth.value}px` }">
        <ColumnHead :columns="columns" :sort="cols.sort.value" @sort="cols.toggleSort" @resize="cols.startResize" @reset="cols.resetWidth" />
        <div v-if="!groups.length" class="empty-line">{{ t("stock.noMatch") }}</div>
        <template v-for="g in groups" :key="g.uuid">
          <!-- The material's row: its name, and its total under the amounts -->
          <div class="row data-row group-row">
            <span class="group-name">
              <Icon :name="materialIcon(g.uuid)" :size="15" class="type-icon" />
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
            <span v-if="org" class="cell">{{ b.holderName }}</span>
            <span><span v-if="b.state === 'refining'" class="tag warn">{{ t("stock.refining") }}</span></span>
            <span class="sep actions">
              <template v-if="canChange(b)">
                <button type="button" class="icon-btn" :title="t('stock.remove')" @click="open(b, 'remove')"><Icon name="trash" :size="15" /></button>
                <button type="button" class="icon-btn" :title="t('stock.move')" :disabled="b.state !== 'stored'" @click="open(b, 'move')"><Icon name="arrow-right" :size="15" /></button>
                <button type="button" class="icon-btn" :title="t('stock.adjust')" @click="open(b, 'adjust')"><Icon name="edit" :size="15" /></button>
              </template>
            </span>
          </div>
        </template>
      </div>
    </section>

    <BatchDialog v-if="dialog" :key="dialog.batch.id" :batch="dialog.batch" :action="dialog.action" @close="dialog = null" @done="load" />
  </div>
</template>

<style scoped>
/* A material: its name and total over the whole row */
.group-row {
  background: var(--bg-surface-2);
}

/* A material's own row: name and total stand out */
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

/* Rows look like the blueprint table's (same .data-row type), without the click cursor */
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



.readonly {
  padding: 10px 16px;
  align-items: flex-start;
}

.btn.on {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
