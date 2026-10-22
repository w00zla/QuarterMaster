<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import DataTable from "../components/DataTable.vue";
import DetailPanel from "../components/DetailPanel.vue";
import HelpTip from "../components/HelpTip.vue";
import Icon from "../components/Icon.vue";
import RawJson from "../components/RawJson.vue";
import { useFetch } from "../api";
import { matches } from "../format";
import { HELP } from "../help";
import type { ResourceDetail, ResourceRow } from "../../../src/adminapp/api-types";
import type { ColumnSpec } from "../tableColumns";

const route = useRoute();
const router = useRouter();
const list = useFetch<ResourceRow[]>(() => "/resources");
const selected = computed(() => (route.params.uuid as string | undefined) || null);
const detail = useFetch<ResourceDetail>(() => (selected.value ? `/resources/${selected.value}` : null));

const search = ref("");
const inRecipes = ref(false);
const showOres = ref(true);
const showRetired = ref(false);

const rows = computed(() => (list.data.value ?? []).filter((r) =>
  (showRetired.value || !r.retired)
  && (showOres.value || !r.isOre)
  && (!inRecipes.value || r.usedIn > 0)
  && matches(search.value, r.name, r.key, r.group)));
const retiredCount = computed(() => (list.data.value ?? []).filter((r) => r.retired).length);

const COLUMNS: ColumnSpec[] = [
  { key: "name", label: "Name", width: 260 },
  { key: "group", label: "Group", width: 200 },
  { key: "ore", label: "Ore", width: 56 },
  { key: "usedIn", label: "Recipes", width: 100, help: HELP.usedIn },
  { key: "boxes", label: "Box sizes (SCU)", width: 240, sortable: false, help: HELP.boxSizes },
  { key: "key", label: "Key", width: 220, help: HELP.key },
];

function valueOf(r: ResourceRow, key: string): string | number {
  switch (key) {
    case "name": return r.name;
    case "group": return r.group;
    case "ore": return r.isOre ? 1 : 0;
    case "usedIn": return r.usedIn;
    case "boxes": return r.boxSizes.join(", ");
    default: return r.key;
  }
}
</script>

<template>
  <div class="view">
    <section class="panel list-panel">
      <div class="head">
        <Icon name="resource" :size="16" />
        <span class="head-title no-grow">Materials</span>
        <HelpTip :text="HELP.resources" />
        <div class="divider" />
        <div class="chips">
          <button type="button" class="chip" :class="{ active: inRecipes }" @click="inRecipes = !inRecipes">In recipes</button>
          <HelpTip :text="HELP.inRecipes" />
          <button type="button" class="chip" :class="{ active: showOres }" @click="showOres = !showOres">Ores</button>
          <HelpTip :text="HELP.ores" />
          <template v-if="retiredCount">
            <button type="button" class="chip" :class="{ active: showRetired }" @click="showRetired = !showRetired">
              Retired <span class="count">{{ retiredCount }}</span>
            </button>
            <HelpTip :text="HELP.retired" />
          </template>
        </div>
        <span class="head-count">{{ rows.length }} / {{ list.data.value?.length ?? 0 }}</span>
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
        storage-key="qm.columns.resources"
        :columns="COLUMNS"
        :rows="rows"
        :default-sort="{ key: 'name', dir: 'asc' }"
        :row-key="(r) => r.uuid"
        :value-of="valueOf"
        :selected="selected"
        :row-class="(r) => ({ retired: r.retired })"
        :numeric="['usedIn']"
        @select="(r) => router.push(`/materials/${r.uuid}`)"
      >
        <template #cell-ore="{ row }"><span v-if="row.isOre" class="tag warn">Ore</span></template>
        <template #cell-usedIn="{ row }"><span :class="{ faint: !row.usedIn }">{{ row.usedIn }}</span></template>
        <template #cell-boxes="{ row }"><span class="mono dim">{{ row.boxSizes.join(" · ") }}</span></template>
        <template #cell-key="{ row }"><span class="mono faint">{{ row.key }}</span></template>
      </DataTable>
    </section>

    <DetailPanel
      v-if="selected"
      icon="resource"
      :title="detail.data.value?.name ?? '…'"
      :technical="detail.data.value?.key"
      :loading="detail.loading.value && !detail.data.value"
      :error="detail.error.value"
      @close="router.push('/materials')"
    >
      <template v-if="detail.data.value">
        <section v-if="detail.data.value.description">
          <p class="description">{{ detail.data.value.description }}</p>
        </section>
        <section>
          <dl class="kv">
            <dt>Group</dt>
            <dd>{{ detail.data.value.groupPath.join(" / ") || "—" }}</dd>
            <dt>Ore</dt>
            <dd>
              <template v-if="detail.data.value.isOre">
                Yes, refines to
                <RouterLink v-if="detail.data.value.refined" :to="`/materials/${detail.data.value.refined.uuid}`">{{ detail.data.value.refined.name }}</RouterLink>
              </template>
              <template v-else>No</template>
            </dd>
            <template v-if="detail.data.value.ores.length">
              <dt>Refined from</dt>
              <dd>
                <template v-for="(o, i) in detail.data.value.ores" :key="o.uuid">
                  <span v-if="i">, </span><RouterLink :to="`/materials/${o.uuid}`">{{ o.name }}</RouterLink>
                </template>
              </dd>
            </template>
            <dt>Density</dt>
            <dd>{{ detail.data.value.densityGPerCc ? `${detail.data.value.densityGPerCc} g/cm³` : "—" }}</dd>
            <dt>Box sizes <HelpTip :text="HELP.boxSizes" /></dt>
            <dd class="mono">{{ detail.data.value.boxSizes.length ? `${detail.data.value.boxSizes.join(" · ")} SCU` : "—" }}</dd>
            <dt>Imports <HelpTip :text="HELP.imports" /></dt>
            <dd>
              first #{{ detail.data.value.firstSeenImportId }}, last #{{ detail.data.value.lastSeenImportId }}
              <span v-if="detail.data.value.retiredAt" class="tag err">Retired</span>
              <HelpTip v-if="detail.data.value.retiredAt" :text="HELP.retired" />
            </dd>
          </dl>
        </section>

        <section v-if="detail.data.value.qualityBands">
          <span class="section-head"><span class="panel-title">Quality bands</span> <HelpTip :text="HELP.qualityTables" /></span>
          <table class="mini">
            <thead><tr><th>Quality</th><th class="num">Mapped value</th></tr></thead>
            <tbody>
              <tr v-for="b in detail.data.value.qualityBands" :key="b.start">
                <td class="mono">{{ b.start }}–{{ b.end }}</td>
                <td class="num mono">{{ b.mappedValue }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <span class="panel-title">Used in {{ detail.data.value.usedBy.length }} recipes</span>
          <table v-if="detail.data.value.usedBy.length" class="mini">
            <thead><tr><th>Blueprint</th><th>Slot</th><th class="num">SCU</th><th class="num">Min Q</th></tr></thead>
            <tbody>
              <tr v-for="(u, i) in detail.data.value.usedBy" :key="i" class="link" @click="router.push(`/blueprints/${u.uuid}`)">
                <td>{{ u.name }}</td>
                <td class="dim">{{ u.slot }}</td>
                <td class="num mono">{{ u.quantity }}</td>
                <td class="num mono">{{ u.minQuality }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <RawJson :value="detail.data.value.raw" />
      </template>
    </DetailPanel>
  </div>
</template>

<style scoped>
.description {
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
  white-space: pre-line;
}
</style>
