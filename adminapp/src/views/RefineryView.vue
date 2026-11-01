<script setup lang="ts">
// Every refinery job over all users: state, station, expected yields. Read-only.
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import DataTable from "../components/DataTable.vue";
import Dropdown from "../components/Dropdown.vue";
import Icon from "../components/Icon.vue";
import Tooltip from "../components/Tooltip.vue";
import { useFetch } from "../api";
import { dateTime, matches } from "../format";
import type { RefineryJob, RefineryJobState } from "../../../src/adminapp/api-types";
import type { ColumnSpec } from "../tableColumns";

const list = useFetch<RefineryJob[]>(() => "/refinery");

const STATES: { value: RefineryJobState; label: string; tag: string }[] = [
  { value: "running", label: "Running", tag: "accent" },
  { value: "ready", label: "Ready", tag: "ok" },
  { value: "open", label: "No end", tag: "" },
];
const stateOf = (s: RefineryJobState) => STATES.find((x) => x.value === s)!;

const state = ref<RefineryJobState | "">("");
const location = ref("");
const search = ref("");

const all = computed(() => list.data.value ?? []);
const stateCounts = computed(() => Object.fromEntries(STATES.map((s) => [s.value, all.value.filter((j) => j.state === s.value).length])));
// Jobs per station, the most first: the filter's options double as the per-refinery summary
const locationOptions = computed(() => {
  const per = new Map<string, { name: string; jobs: number }>();
  for (const j of all.value) {
    const entry = per.get(j.location.uuid) ?? { name: j.location.name, jobs: 0 };
    entry.jobs++;
    per.set(j.location.uuid, entry);
  }
  return [
    { value: "", label: `All stations (${per.size})` },
    ...[...per].sort((a, b) => b[1].jobs - a[1].jobs || a[1].name.localeCompare(b[1].name))
      .map(([value, e]) => ({ value, label: `${e.name} · ${e.jobs}` })),
  ];
});

const materialsText = (j: RefineryJob) => j.materials.map((m) => `${m.name} ${m.quantity} Q${m.quality}`).join(", ");
const rows = computed(() => all.value.filter((j) =>
  (!state.value || j.state === state.value)
  && (!location.value || j.location.uuid === location.value)
  && matches(search.value, j.owner.name, j.owner.userId, j.location.name, ...j.materials.map((m) => m.name))));

const COLUMNS: ColumnSpec[] = [
  { key: "owner", label: "Owner", width: 180 },
  { key: "location", label: "Station", width: 220 },
  { key: "materials", label: "Materials", width: 300 },
  { key: "scu", label: "SCU", width: 90 },
  { key: "started", label: "Started", width: 160 },
  { key: "ends", label: "Ends", width: 160 },
  { key: "state", label: "State", width: 110 },
];

function valueOf(j: RefineryJob, key: string): string | number {
  switch (key) {
    case "owner": return j.owner.name ?? j.owner.userId;
    case "location": return j.location.name;
    case "materials": return materialsText(j);
    // Sorting only; the cell shows the exact text
    case "scu": return Number(j.scu);
    case "started": return j.startedAt ?? "";
    // Jobs without an end after the others
    case "ends": return j.endsAt ?? "~";
    default: return STATES.findIndex((s) => s.value === j.state);
  }
}
</script>

<template>
  <div class="view">
    <section class="panel list-panel">
      <div class="head">
        <Icon name="drop" :size="16" />
        <span class="head-title no-grow">Refinery</span>
        <div class="divider" />
        <div class="chips">
          <button
            v-for="s in STATES"
            :key="s.value"
            type="button"
            class="chip"
            :class="{ active: state === s.value }"
            @click="state = state === s.value ? '' : s.value"
          >
            {{ s.label }} <span class="count">{{ stateCounts[s.value] }}</span>
          </button>
        </div>
        <Dropdown v-model="location" :options="locationOptions" variant="small" />
        <span class="head-count">{{ rows.length }} / {{ all.length }}</span>
        <div class="spacer" />
        <div class="search">
          <Icon name="search" :size="14" />
          <input v-model="search" placeholder="Find…" />
          <button v-if="search" type="button" class="clear" title="Clear" @click="search = ''">
            <Icon name="close" :size="12" />
          </button>
        </div>
      </div>
      <div v-if="list.error.value" class="empty-line">{{ list.error.value }}</div>
      <div v-else-if="list.loading.value && !list.data.value" class="empty-line">Loading…</div>
      <DataTable
        v-else
        storage-key="qm.columns.refinery"
        :columns="COLUMNS"
        :rows="rows"
        :default-sort="{ key: 'ends', dir: 'asc' }"
        :row-key="(j) => j.jobId"
        :value-of="valueOf"
        :numeric="['scu']"
        empty-text="No refinery jobs"
      >
        <template #cell-owner="{ row }">
          <RouterLink :to="`/users/${row.owner.userId}`">
            <Tooltip :text="row.owner.userId" mono>
              <span v-if="row.owner.name">{{ row.owner.name }}</span>
              <span v-else class="mono">{{ row.owner.userId }}</span>
            </Tooltip>
          </RouterLink>
        </template>
        <template #cell-location="{ row }">
          <span>{{ row.location.name }}</span>
          <Tooltip v-if="!row.atRefinery" text="Not at a UEX refinery">
            <span class="tag warn no-refinery">No refinery</span>
          </Tooltip>
        </template>
        <template #cell-materials="{ row }"><span class="dim">{{ materialsText(row) }}</span></template>
        <template #cell-scu="{ row }"><span class="mono">{{ row.scu }}</span></template>
        <template #cell-started="{ row }"><span :class="{ faint: !row.startedAt }">{{ dateTime(row.startedAt) }}</span></template>
        <template #cell-ends="{ row }"><span :class="{ faint: !row.endsAt }">{{ dateTime(row.endsAt) }}</span></template>
        <template #cell-state="{ row }"><span class="tag" :class="stateOf(row.state).tag">{{ stateOf(row.state).label }}</span></template>
      </DataTable>
    </section>
  </div>
</template>

<style scoped>
.no-refinery {
  margin-left: 6px;
}
</style>
