<script setup lang="ts">
// Mining providers (spawn tables of planets, moons and asteroid fields) with their places, and per
// provider what each method yields there.
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import DataTable from "../components/DataTable.vue";
import DetailPanel from "../components/DetailPanel.vue";
import HelpTip from "../components/HelpTip.vue";
import Icon from "../components/Icon.vue";
import { useFetch } from "../api";
import { matches } from "../format";
import { HELP } from "../help";
import type { MiningMethod, MiningProviderDetail, MiningProviderRow } from "../../../src/adminapp/api-types";
import type { ColumnSpec } from "../tableColumns";

const route = useRoute();
const router = useRouter();
const list = useFetch<MiningProviderRow[]>(() => "/mining");
const selected = computed(() => (route.params.uuid as string | undefined) || null);
const detail = useFetch<MiningProviderDetail>(() => (selected.value ? `/mining/${selected.value}` : null));

const METHODS: Array<[MiningMethod, string]> = [["ship", "Ship"], ["roc", "ROC"], ["fps", "FPS"]];
const methodLabel = (m: MiningMethod) => METHODS.find(([k]) => k === m)?.[1] ?? m;

const search = ref("");
// Methods to show (all by default)
const methods = ref<MiningMethod[]>(["ship", "roc", "fps"]);
const toggle = (m: MiningMethod) => (methods.value = methods.value.includes(m) ? methods.value.filter((x) => x !== m) : [...methods.value, m]);

const rows = computed(() => (list.data.value ?? []).filter((r) =>
  r.methods.some((m) => methods.value.includes(m))
  && matches(search.value, r.key, ...r.places.map((p) => p.name), ...r.systems)));

// Many places (asteroid bases, QV stations): the first ones and the count
const placesText = (r: MiningProviderRow) =>
  r.places.length > 3 ? `${r.places.slice(0, 2).map((p) => p.name).join(", ")} +${r.places.length - 2}` : r.places.map((p) => p.name).join(", ");

const COLUMNS: ColumnSpec[] = [
  { key: "places", label: "Places", width: 300, help: HELP.miningPlaces },
  { key: "systems", label: "System", width: 120 },
  { key: "methods", label: "Methods", width: 170 },
  { key: "resources", label: "Resources", width: 110 },
  { key: "key", label: "Key", width: 240, help: HELP.key },
];

function valueOf(r: MiningProviderRow, key: string): string | number {
  switch (key) {
    case "places": return placesText(r);
    case "systems": return r.systems.join(", ");
    case "methods": return r.methods.join(",");
    case "resources": return r.resources;
    default: return r.key;
  }
}

const pct = (n: number) => n.toLocaleString("en", { maximumFractionDigits: 1 });
</script>

<template>
  <div class="view">
    <section class="panel list-panel">
      <div class="head">
        <Icon name="pickaxe" :size="16" />
        <span class="head-title no-grow">Mining</span>
        <HelpTip :text="HELP.mining" />
        <div class="divider" />
        <div class="chips">
          <button v-for="[m, label] in METHODS" :key="m" type="button" class="chip" :class="{ active: methods.includes(m) }" @click="toggle(m)">
            {{ label }}
          </button>
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
      <div v-else-if="!list.data.value?.length" class="empty-line">No mining data: import a snapshot of version 5 or newer</div>
      <DataTable
        v-else
        storage-key="qm.columns.mining"
        :columns="COLUMNS"
        :rows="rows"
        :default-sort="{ key: 'places', dir: 'asc' }"
        :row-key="(r) => r.uuid"
        :value-of="valueOf"
        :selected="selected"
        :numeric="['resources']"
        @select="(r) => router.push(`/mining/${r.uuid}`)"
      >
        <template #cell-places="{ row }">{{ placesText(row) }}</template>
        <template #cell-systems="{ row }"><span class="dim">{{ row.systems.join(", ") || "—" }}</span></template>
        <template #cell-methods="{ row }">
          <span class="tags"><span v-for="m in row.methods" :key="m" class="tag">{{ methodLabel(m) }}</span></span>
        </template>
        <template #cell-key="{ row }"><span class="mono faint">{{ row.key }}</span></template>
      </DataTable>
    </section>

    <DetailPanel
      v-if="selected"
      icon="pickaxe"
      :title="detail.data.value ? placesText(detail.data.value) : '…'"
      :technical="detail.data.value?.key"
      :loading="detail.loading.value && !detail.data.value"
      :error="detail.error.value"
      @close="router.push('/mining')"
    >
      <template v-if="detail.data.value">
        <section>
          <dl class="kv">
            <dt>System</dt>
            <dd>{{ detail.data.value.systems.join(", ") || "—" }}</dd>
            <dt>Methods</dt>
            <dd>{{ detail.data.value.methods.map(methodLabel).join(", ") }}</dd>
          </dl>
        </section>

        <section>
          <span class="section-head"><span class="panel-title">Yields</span> <HelpTip :text="HELP.miningYields" /></span>
          <table class="mini">
            <thead>
              <tr><th>Method</th><th>Resource</th><th>Item</th><th class="num">Factor</th><th class="num">Rocks</th><th class="num">Content</th><th>Rarity</th><th>Quality</th></tr>
            </thead>
            <tbody>
              <tr v-for="(m, i) in detail.data.value.mineables" :key="i">
                <td><span class="tag">{{ methodLabel(m.method) }}</span></td>
                <td><RouterLink :to="`/materials/${m.resource.uuid}`">{{ m.resource.name }}</RouterLink></td>
                <td>
                  <RouterLink v-if="m.item" :to="`/items/${m.item.uuid}`">{{ m.item.name }}</RouterLink>
                  <span v-else class="faint">—</span>
                </td>
                <td class="num mono" :class="{ faint: m.qualityScale === 1 }">×{{ m.qualityScale }}</td>
                <td class="num mono">{{ pct(m.share * 100) }} %</td>
                <td class="num mono">{{ pct(m.minPercent) }}–{{ pct(m.maxPercent) }} %</td>
                <td><span v-if="m.rarity" class="dim">{{ m.rarity }}</span><span v-else class="faint">—</span></td>
                <td class="mono">
                  <template v-if="m.quality">
                    <template v-if="m.quality.values.length">
                      <span v-for="v in m.quality.values" :key="v.value" class="qv">{{ v.value }} <span class="faint">{{ pct(v.chance * 100) }} %</span></span>
                    </template>
                    <template v-else>{{ m.quality.min }}–{{ m.quality.max }}</template>
                  </template>
                  <span v-else class="faint">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <span class="panel-title">{{ detail.data.value.places.length }} places</span>
          <table class="mini">
            <thead><tr><th>Place</th><th>System</th><th>Key</th></tr></thead>
            <tbody>
              <tr v-for="p in detail.data.value.places" :key="p.uuid">
                <td>{{ p.name }}</td>
                <td class="dim">{{ p.system ?? "—" }}</td>
                <td class="mono faint">{{ p.key }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </DetailPanel>
  </div>
</template>

<style scoped>
.tags {
  display: inline-flex;
  gap: 4px;
}

.qv + .qv {
  margin-left: 8px;
}
</style>
