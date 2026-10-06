<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import DataTable from "../components/DataTable.vue";
import DetailPanel from "../components/DetailPanel.vue";
import Dropdown from "../components/Dropdown.vue";
import HelpTip from "../components/HelpTip.vue";
import Icon from "../components/Icon.vue";
import RawJson from "../components/RawJson.vue";
import Tooltip from "../components/Tooltip.vue";
import TypeLabel from "../components/TypeLabel.vue";
import { useFetch } from "../api";
import { matches } from "../format";
import { HELP } from "../help";
import type { ItemDetail, ItemRow } from "../../../src/adminapp/api-types";
import type { ColumnSpec } from "../tableColumns";

const route = useRoute();
const router = useRouter();
const list = useFetch<ItemRow[]>(() => "/items");
const selected = computed(() => (route.params.uuid as string | undefined) || null);
const detail = useFetch<ItemDetail>(() => (selected.value ? `/items/${selected.value}` : null));

const search = ref("");
const type = ref("");
const onlyInputs = ref(false);
const showRetired = ref(false);

const typeOptions = computed(() => [
  { value: "", label: "All types" },
  ...[...new Map((list.data.value ?? []).filter((r) => r.type).map((r) => [r.type!, r.typeLabel ?? r.type!]))]
    .sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
]);

const rows = computed(() => (list.data.value ?? []).filter((r) =>
  (showRetired.value || !r.retired)
  && (!type.value || r.type === type.value)
  && (!onlyInputs.value || r.asInput > 0)
  && matches(search.value, r.name, r.className, r.typeLabel, r.subTypeLabel)));
const retiredCount = computed(() => (list.data.value ?? []).filter((r) => r.retired).length);

const COLUMNS: ColumnSpec[] = [
  { key: "name", label: "Name", width: null },
  { key: "type", label: "Type", width: 140 },
  { key: "subType", label: "Sub type", width: 120 },
  { key: "manufacturer", label: "Mfr", width: 90, help: HELP.manufacturers },
  { key: "size", label: "Size", width: 56 },
  { key: "class", label: "Class", width: 120, help: HELP.itemClass },
  { key: "grade", label: "Grade", width: 72, help: HELP.grade },
  { key: "asOutput", label: "Crafted", width: 100, help: HELP.crafted },
  { key: "asInput", label: "Ingredient", width: 116, help: HELP.ingredientIn },
  { key: "className", label: "Class", width: 300, help: HELP.key },
];

function valueOf(r: ItemRow, key: string): string | number {
  switch (key) {
    case "name": return r.name;
    case "type": return r.typeLabel ?? "";
    case "subType": return r.subTypeLabel ?? "";
    case "manufacturer": return r.manufacturer ?? "";
    case "size": return r.size ?? -1;
    case "grade": return r.gradeLetter ?? "";
    case "class": return r.itemClass ?? "";
    case "asOutput": return r.asOutput;
    case "asInput": return r.asInput;
    default: return r.className;
  }
}
</script>

<template>
  <div class="view">
    <section class="panel list-panel">
      <div class="head">
        <Icon name="item" :size="16" />
        <span class="head-title no-grow">Items</span>
        <HelpTip :text="HELP.items" />
        <div class="divider" />
        <Dropdown v-model="type" :options="typeOptions" variant="small" />
        <div class="chips">
          <button type="button" class="chip" :class="{ active: onlyInputs }" @click="onlyInputs = !onlyInputs">Ingredients</button>
          <HelpTip :text="HELP.ingredients" />
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
        storage-key="qm.columns.items"
        :columns="COLUMNS"
        :rows="rows"
        :default-sort="{ key: 'name', dir: 'asc' }"
        :row-key="(r) => r.uuid"
        :value-of="valueOf"
        :selected="selected"
        :row-class="(r) => ({ retired: r.retired })"
        :numeric="['size', 'asOutput', 'asInput']"
        @select="(r) => router.push(`/items/${r.uuid}`)"
      >
        <template #cell-type="{ row }"><TypeLabel :type="row.type" :label="row.typeLabel" /></template>
        <template #cell-size="{ row }">{{ row.size ?? "—" }}</template>
        <template #cell-grade="{ row }">{{ row.gradeLetter ?? "—" }}</template>
        <template #cell-asOutput="{ row }"><span :class="{ faint: !row.asOutput }">{{ row.asOutput }}</span></template>
        <template #cell-asInput="{ row }"><span :class="{ faint: !row.asInput }">{{ row.asInput }}</span></template>
        <template #cell-className="{ row }"><span class="mono faint">{{ row.className }}</span></template>
      </DataTable>
    </section>

    <DetailPanel
      v-if="selected"
      icon="item"
      :title="detail.data.value?.name ?? '…'"
      :technical="detail.data.value?.className"
      :loading="detail.loading.value && !detail.data.value"
      :error="detail.error.value"
      @close="router.push('/items')"
    >
      <template v-if="detail.data.value">
        <section v-if="detail.data.value.description">
          <p class="description">{{ detail.data.value.description }}</p>
        </section>
        <section>
          <dl class="kv">
            <dt>Type</dt>
            <dd>
              <TypeLabel :type="detail.data.value.type" :label="detail.data.value.typeLabel" />
              <span v-if="detail.data.value.subTypeLabel" class="dim"> / {{ detail.data.value.subTypeLabel }}</span>
              <span v-if="!detail.data.value.typeLabel">—</span>
            </dd>
            <dt>Size / class / grade</dt>
            <dd>{{ [detail.data.value.size !== null ? `S${detail.data.value.size}` : null, detail.data.value.itemClass, detail.data.value.gradeLetter ? `Grade ${detail.data.value.gradeLetter}` : null].filter(Boolean).join(" · ") || "—" }}</dd>
            <dt>Manufacturer</dt>
            <dd>
              <template v-if="detail.data.value.manufacturer">
                <Tooltip :text="detail.data.value.manufacturer.code" mono>{{ detail.data.value.manufacturer.name ?? detail.data.value.manufacturer.code ?? "—" }}</Tooltip>
              </template>
              <template v-else>—</template>
            </dd>
            <dt>Imports <HelpTip :text="HELP.imports" /></dt>
            <dd>
              first #{{ detail.data.value.firstSeenImportId }}, last #{{ detail.data.value.lastSeenImportId }}
              <span v-if="detail.data.value.retiredAt" class="tag err">Retired</span>
              <HelpTip v-if="detail.data.value.retiredAt" :text="HELP.retired" />
            </dd>
          </dl>
        </section>

        <section v-if="detail.data.value.outputOf.length">
          <span class="panel-title">Crafted by</span>
          <table class="mini">
            <tbody>
              <tr v-for="b in detail.data.value.outputOf" :key="b.uuid" class="link" @click="router.push(`/blueprints/${b.uuid}`)">
                <td><Tooltip :text="b.key" mono>{{ b.name }}</Tooltip></td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="detail.data.value.inputOf.length">
          <span class="panel-title">Ingredient in {{ detail.data.value.inputOf.length }} recipes</span>
          <table class="mini">
            <thead><tr><th>Blueprint</th><th>Slot</th><th class="num">Count</th><th class="num">Min Q</th></tr></thead>
            <tbody>
              <tr v-for="(u, i) in detail.data.value.inputOf" :key="i" class="link" @click="router.push(`/blueprints/${u.uuid}`)">
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
