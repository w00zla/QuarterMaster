<script setup lang="ts">
// Stored stock over all users, one row per subject, split like the user web app (Resources, Gear); the detail
// lists who holds it. Read-only.
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import DataTable from "../components/DataTable.vue";
import DetailPanel from "../components/DetailPanel.vue";
import Icon from "../components/Icon.vue";
import Tooltip from "../components/Tooltip.vue";
import TypeLabel from "../components/TypeLabel.vue";
import { useFetch } from "../api";
import { matches } from "../format";
import type { StockGroup, StockRow, StockSubject } from "../../../src/adminapp/api-types";
import type { ColumnSpec } from "../tableColumns";

type Tab = "resources" | "gear";

const route = useRoute();
const router = useRouter();
const list = useFetch<StockRow[]>(() => "/stock");
// ?subject=resource:<uuid> / item:<uuid>
const selected = computed(() => (typeof route.query.subject === "string" && route.query.subject) || null);
const detail = useFetch<StockSubject>(() => {
  const [kind, uuid] = selected.value?.split(":") ?? [];
  return kind && uuid ? `/stock/${kind}/${uuid}` : null;
});
const keyOf = (s: { kind: string; uuid: string }) => `${s.kind}:${s.uuid}`;
const select = (s: StockRow) => router.push({ query: { subject: keyOf(s) } });

const tab = ref<Tab>("resources");
const search = ref("");
const tabOf = (s: StockRow): Tab => (s.group === "gear" ? "gear" : "resources");
// A link to a subject opens the tab it is in
watch([selected, () => list.data.value], () => {
  const s = list.data.value?.find((r) => keyOf(r) === selected.value);
  if (s) tab.value = tabOf(s);
}, { immediate: true });
const counts = computed(() => {
  const all = list.data.value ?? [];
  return { resources: all.filter((s) => tabOf(s) === "resources").length, gear: all.filter((s) => tabOf(s) === "gear").length };
});
const rows = computed(() => (list.data.value ?? []).filter((s) =>
  tabOf(s) === tab.value && matches(search.value, s.name, s.typeLabel, groupLabel(s.group, s.gear))));

const groupLabel = (group: StockGroup, gear: StockRow["gear"]) =>
  group === "gear" ? (gear === "fps" ? "FPS gear" : "Ship component") : group === "harvestable" ? "Harvestable" : "Resource";
const qualityRange = (min: number | null, max: number | null) => (min === null ? "—" : min === max ? String(min) : `${min}–${max}`);

const RESOURCE_COLUMNS: ColumnSpec[] = [
  { key: "name", label: "Name", width: 240 },
  { key: "group", label: "Group", width: 120 },
  { key: "total", label: "Total", width: 120 },
  { key: "batches", label: "Batches", width: 90 },
  { key: "owners", label: "Owners", width: 90 },
  { key: "shared", label: "Shared", width: 90 },
  { key: "orgs", label: "Orgs", width: 80 },
  { key: "quality", label: "Quality", width: 110 },
];
const GEAR_COLUMNS: ColumnSpec[] = [
  { key: "name", label: "Name", width: 240 },
  { key: "type", label: "Type", width: 160 },
  { key: "group", label: "Kind", width: 130 },
  { key: "total", label: "Total", width: 100 },
  { key: "batches", label: "Batches", width: 90 },
  { key: "owners", label: "Owners", width: 90 },
  { key: "shared", label: "Shared", width: 90 },
  { key: "orgs", label: "Orgs", width: 80 },
  { key: "withStats", label: "With stats", width: 100 },
];
const NUMERIC = ["total", "batches", "owners", "shared", "orgs", "withStats"];

function valueOf(s: StockRow, key: string): string | number {
  switch (key) {
    case "name": return s.name;
    case "group": return groupLabel(s.group, s.gear);
    case "type": return s.typeLabel ?? "";
    // Sorting only; the cell shows the exact text
    case "total": return Number(s.total);
    case "batches": return s.batches;
    case "owners": return s.owners;
    case "shared": return s.shared;
    case "orgs": return s.orgs;
    case "quality": return s.maxQuality ?? -1;
    default: return s.withStats;
  }
}
</script>

<template>
  <div class="view">
    <section class="panel list-panel">
      <div class="head">
        <Icon name="stock" :size="16" />
        <span class="head-title no-grow">Stock</span>
        <div class="divider" />
        <div class="chips">
          <button type="button" class="chip" :class="{ active: tab === 'resources' }" @click="tab = 'resources'">
            Resources <span class="count">{{ counts.resources }}</span>
          </button>
          <button type="button" class="chip" :class="{ active: tab === 'gear' }" @click="tab = 'gear'">
            Gear <span class="count">{{ counts.gear }}</span>
          </button>
        </div>
        <span class="head-count">{{ rows.length }} / {{ counts[tab] }}</span>
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
        v-else-if="tab === 'resources'"
        storage-key="qm.columns.stock.resources"
        :columns="RESOURCE_COLUMNS"
        :rows="rows"
        :default-sort="{ key: 'name', dir: 'asc' }"
        :row-key="keyOf"
        :value-of="valueOf"
        :selected="selected"
        :numeric="NUMERIC"
        empty-text="No stock"
        @select="select"
      >
        <template #cell-group="{ row }"><span class="dim">{{ groupLabel(row.group, row.gear) }}</span></template>
        <template #cell-total="{ row }"><span class="mono">{{ row.total }} {{ row.unit }}</span></template>
        <template #cell-shared="{ row }"><span :class="{ faint: !row.shared }">{{ row.shared }}</span></template>
        <template #cell-orgs="{ row }"><span :class="{ faint: !row.orgs }">{{ row.orgs }}</span></template>
        <template #cell-quality="{ row }"><span class="mono">{{ qualityRange(row.minQuality, row.maxQuality) }}</span></template>
      </DataTable>
      <DataTable
        v-else
        storage-key="qm.columns.stock.gear"
        :columns="GEAR_COLUMNS"
        :rows="rows"
        :default-sort="{ key: 'name', dir: 'asc' }"
        :row-key="keyOf"
        :value-of="valueOf"
        :selected="selected"
        :numeric="NUMERIC"
        empty-text="No gear"
        @select="select"
      >
        <template #cell-type="{ row }"><TypeLabel :type="row.type" :label="row.typeLabel" /></template>
        <template #cell-group="{ row }"><span class="dim">{{ groupLabel(row.group, row.gear) }}</span></template>
        <template #cell-total="{ row }"><span class="mono">{{ row.total }}</span></template>
        <template #cell-shared="{ row }"><span :class="{ faint: !row.shared }">{{ row.shared }}</span></template>
        <template #cell-orgs="{ row }"><span :class="{ faint: !row.orgs }">{{ row.orgs }}</span></template>
        <template #cell-withStats="{ row }"><span :class="{ faint: !row.withStats }">{{ row.withStats }}</span></template>
      </DataTable>
    </section>

    <DetailPanel
      v-if="selected"
      :icon="detail.data.value?.group === 'gear' ? 'gear' : detail.data.value?.group === 'harvestable' ? 'item' : 'resource'"
      :title="detail.data.value?.name ?? '…'"
      :technical="detail.data.value?.uuid"
      :loading="detail.loading.value && !detail.data.value"
      :error="detail.error.value"
      @close="router.push({ query: {} })"
    >
      <template v-if="detail.data.value">
        <section>
          <dl class="kv">
            <dt>Group</dt>
            <dd>{{ groupLabel(detail.data.value.group, detail.data.value.gear) }}</dd>
            <template v-if="detail.data.value.typeLabel">
              <dt>Type</dt>
              <dd><TypeLabel :type="detail.data.value.type" :label="detail.data.value.typeLabel" /></dd>
            </template>
          </dl>
        </section>

        <section>
          <span class="panel-title">Holders</span>
          <table v-if="detail.data.value.holders.length" class="mini">
            <thead>
              <tr>
                <th>Owner</th>
                <th>Location</th>
                <th class="num">Amount</th>
                <th v-if="detail.data.value.group !== 'gear'" class="num">Quality</th>
                <th>Shared in</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="h in detail.data.value.holders" :key="h.batchId">
                <tr>
                  <td>
                    <RouterLink :to="`/users/${h.owner.userId}`">
                      <Tooltip :text="h.owner.userId" mono>
                        <span v-if="h.owner.name">{{ h.owner.name }}</span>
                        <span v-else class="mono">{{ h.owner.userId }}</span>
                      </Tooltip>
                    </RouterLink>
                  </td>
                  <td class="dim">{{ h.location }}</td>
                  <td class="num">
                    <span v-if="h.state === 'refining'" class="tag accent">Refining</span>
                    <span v-if="h.lot" class="tag">Lot</span>
                    <span class="mono">{{ h.quantity }} {{ detail.data.value.unit }}</span>
                  </td>
                  <td v-if="detail.data.value.group !== 'gear'" class="num mono">{{ h.quality }}</td>
                  <td :class="h.orgs.length ? 'dim' : 'faint'">{{ h.orgs.join(", ") || "—" }}</td>
                </tr>
                <tr v-if="h.stats.length" class="stats">
                  <td colspan="5" class="dim">{{ h.stats.map((s) => `${s.name} ${s.value}`).join(" · ") }}</td>
                </tr>
              </template>
            </tbody>
          </table>
          <div v-else class="faint">None</div>
        </section>
      </template>
    </DetailPanel>
  </div>
</template>

<style scoped>
.mini td .tag {
  margin-right: 6px;
}

/* The stats belong to the batch above: no line between them. */
.mini tr:has(+ tr.stats) td {
  border-bottom: none;
}

.mini tr.stats td {
  padding-top: 0;
  font-size: 12px;
}
</style>
