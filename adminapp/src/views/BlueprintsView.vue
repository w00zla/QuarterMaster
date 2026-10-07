<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import DataTable from "../components/DataTable.vue";
import DetailPanel from "../components/DetailPanel.vue";
import Dropdown from "../components/Dropdown.vue";
import HelpTip from "../components/HelpTip.vue";
import Icon from "../components/Icon.vue";
import RawJson from "../components/RawJson.vue";
import Tooltip from "../components/Tooltip.vue";
import TypeLabel from "../components/TypeLabel.vue";
import { useFetch } from "../api";
import { duration, matches, quantity } from "../format";
import { HELP } from "../help";
import type { BlueprintDetail, BlueprintModifier, BlueprintRow } from "../../../src/adminapp/api-types";
import type { ColumnSpec } from "../tableColumns";

const route = useRoute();
const router = useRouter();
const list = useFetch<BlueprintRow[]>(() => "/blueprints");
const selected = computed(() => (route.params.uuid as string | undefined) || null);
const detail = useFetch<BlueprintDetail>(() => (selected.value ? `/blueprints/${selected.value}` : null));

const search = ref("");
// Filter chain: category group -> item type -> size; each list only offers what the previous choice leaves
const group = ref("");
const type = ref("");
const size = ref("");
const showRetired = ref(false);

/** Dropdown options from value -> label pairs, sorted by label, after an "all" entry. */
function options(pairs: [string | null, string | null][], all: string, byValue = false) {
  const unique = [...new Map(pairs.filter((p): p is [string, string | null] => !!p[0]).map(([v, l]) => [v, l ?? v]))];
  unique.sort((a, b) => (byValue ? Number(a[0]) - Number(b[0]) : a[1].localeCompare(b[1])));
  return [{ value: "", label: all }, ...unique.map(([value, label]) => ({ value, label }))];
}
const active = computed(() => (list.data.value ?? []).filter((r) => showRetired.value || !r.retired));
// Blueprints without an output type are a choice of their own (type keys never look like this)
const NO_TYPE = "-";
const typeOf = (r: BlueprintRow) => r.outputType ?? NO_TYPE;
const inGroup = computed(() => active.value.filter((r) => !group.value || r.categoryGroup === group.value));
const inType = computed(() => inGroup.value.filter((r) => !type.value || typeOf(r) === type.value));
const groupOptions = computed(() => options(active.value.map((r) => [r.categoryGroup, r.categoryLabel]), "All categories"));
const typeOptions = computed(() => options(inGroup.value.map((r) => [typeOf(r), r.outputType ? r.outputTypeLabel : "(none)"]), "All types"));
const sizeOptions = computed(() => options(inType.value.map((r) => [r.size === null ? null : String(r.size), r.size === null ? null : `S${r.size}`]), "All sizes", true));
// A narrower choice that the wider one no longer offers is dropped
watch(group, () => { if (!typeOptions.value.some((o) => o.value === type.value)) type.value = ""; });
watch([group, type], () => { if (!sizeOptions.value.some((o) => o.value === size.value)) size.value = ""; });

const rows = computed(() => inType.value.filter((r) =>
  (!size.value || String(r.size) === size.value)
  && matches(search.value, r.name, r.key, r.outputClass, r.outputTypeLabel, r.categoryLabel)));
const retiredCount = computed(() => (list.data.value ?? []).filter((r) => r.retired).length);

const COLUMNS: ColumnSpec[] = [
  { key: "name", label: "Name", width: null },
  { key: "category", label: "Category", width: 170, help: HELP.categories },
  { key: "type", label: "Type", width: 150 },
  { key: "size", label: "Size", width: 56 },
  { key: "class", label: "Class", width: 120, help: HELP.itemClass },
  { key: "grade", label: "Grade", width: 72, help: HELP.grade },
  { key: "manufacturer", label: "Mfr", width: 90, help: HELP.manufacturerCode },
  { key: "craft", label: "Craft time", width: 100 },
  { key: "slots", label: "Slots", width: 84, help: HELP.slots },
  { key: "key", label: "Key", width: 300, help: HELP.key },
];

function valueOf(r: BlueprintRow, key: string): string | number {
  switch (key) {
    case "name": return r.name;
    case "type": return r.outputTypeLabel ?? "";
    case "manufacturer": return r.manufacturer ?? "";
    case "size": return r.size ?? -1;
    case "grade": return r.gradeLetter ?? "";
    case "class": return r.itemClass ?? "";
    case "category": return r.categoryLabel ?? "";
    case "craft": return r.craftSeconds ?? -1;
    case "slots": return r.slotCount;
    default: return r.key;
  }
}

function modifierRange(range: BlueprintModifier["ranges"][number]): string {
  const v = range.values;
  const bounds = `${range.startQuality}–${range.endQuality}`;
  if (range.type === "Linear") return `${bounds}: ×${v.modifierAtStart} → ×${v.modifierAtEnd}`;
  if (range.type === "LinearIntegerAdditive") return `${bounds}: ${signed(v.additiveModifierAtStart)} → ${signed(v.additiveModifierAtEnd)}`;
  return `${bounds}: ${JSON.stringify(v)}`;
}
const signed = (n: number | undefined) => (n === undefined ? "?" : n >= 0 ? `+${n}` : String(n));
const inputLink = (kind: string, uuid: string) => `/${kind === "resource" ? "resources" : "items"}/${uuid}`;
</script>

<template>
  <div class="view">
    <section class="panel list-panel">
      <div class="head">
        <Icon name="blueprint" :size="16" />
        <span class="head-title no-grow">Blueprints</span>
        <div class="divider" />
        <Dropdown v-model="group" :options="groupOptions" variant="small" />
        <Dropdown v-model="type" :options="typeOptions" variant="small" />
        <Dropdown v-model="size" :options="sizeOptions" variant="small" />
        <div class="chips">
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
        storage-key="qm.columns.blueprints"
        :columns="COLUMNS"
        :rows="rows"
        :default-sort="{ key: 'name', dir: 'asc' }"
        :row-key="(r) => r.uuid"
        :value-of="valueOf"
        :selected="selected"
        :row-class="(r) => ({ retired: r.retired })"
        :numeric="['size', 'craft', 'slots']"
        @select="(r) => router.push(`/blueprints/${r.uuid}`)"
      >
        <template #cell-name="{ row }">
          {{ row.name }}
          <span v-if="row.isDefault" class="tag accent">Default</span>
          <span v-if="row.retired" class="tag err">Retired</span>
        </template>
        <template #cell-type="{ row }"><TypeLabel :type="row.outputType" :label="row.outputTypeLabel" /></template>
        <template #cell-craft="{ row }">{{ duration(row.craftSeconds) }}</template>
        <template #cell-size="{ row }">{{ row.size ?? "—" }}</template>
        <template #cell-grade="{ row }">{{ row.gradeLetter ?? "—" }}</template>
        <template #cell-key="{ row }"><span class="mono faint">{{ row.key }}</span></template>
      </DataTable>
    </section>

    <DetailPanel
      v-if="selected"
      icon="blueprint"
      :title="detail.data.value?.name ?? '…'"
      :technical="detail.data.value?.key"
      :loading="detail.loading.value && !detail.data.value"
      :error="detail.error.value"
      @close="router.push('/blueprints')"
    >
      <template v-if="detail.data.value">
        <section>
          <dl class="kv">
            <template v-if="detail.data.value.output">
              <dt>Output</dt>
              <dd>
                <Tooltip :text="detail.data.value.output.className" mono>
                  <RouterLink :to="`/items/${detail.data.value.output.uuid}`">{{ detail.data.value.output.name }}</RouterLink>
                </Tooltip>
              </dd>
              <dt>Type</dt>
              <dd>
                <TypeLabel :type="detail.data.value.output.type" :label="detail.data.value.output.typeLabel" />
                <span v-if="detail.data.value.output.subTypeLabel" class="dim"> / {{ detail.data.value.output.subTypeLabel }}</span>
                <span v-if="!detail.data.value.output.typeLabel">—</span>
              </dd>
              <dt>Size / class / grade</dt>
              <dd>{{ [detail.data.value.output.size !== null ? `S${detail.data.value.output.size}` : null, detail.data.value.output.itemClass, detail.data.value.output.gradeLetter ? `Grade ${detail.data.value.output.gradeLetter}` : null].filter(Boolean).join(" · ") || "—" }}</dd>
              <dt>Manufacturer</dt>
              <dd>{{ detail.data.value.output.manufacturer ?? "—" }}</dd>
            </template>
            <template v-else>
              <dt>Output</dt>
              <dd class="faint">none in the game data</dd>
            </template>
            <dt>Category</dt>
            <dd><Tooltip :text="detail.data.value.category" mono>{{ detail.data.value.categoryLabel ?? "—" }}</Tooltip></dd>
            <dt>Default</dt>
            <dd>{{ detail.data.value.isDefault ? "Yes, every player has it" : "No" }}</dd>
            <dt>Imports <HelpTip :text="HELP.imports" /></dt>
            <dd>
              first #{{ detail.data.value.firstSeenImportId }}, last #{{ detail.data.value.lastSeenImportId }}
              <span v-if="detail.data.value.retiredAt" class="tag err">Retired</span>
              <HelpTip v-if="detail.data.value.retiredAt" :text="HELP.retired" />
            </dd>
          </dl>
        </section>

        <section v-for="tier in detail.data.value.tiers" :key="tier.index">
          <div class="tier-head">
            <span class="panel-title">Recipe{{ detail.data.value.tiers.length > 1 ? ` · tier ${tier.index + 1}` : "" }}</span>
            <HelpTip :text="HELP.recipe" />
            <span class="tag"><Icon name="clock" :size="12" /> {{ duration(tier.craftSeconds) }}</span>
            <template v-if="tier.requiredSlots < tier.slots.length">
              <span class="tag warn">{{ tier.requiredSlots }} of {{ tier.slots.length }} slots</span>
              <HelpTip :text="HELP.slotsRequired" />
            </template>
          </div>
          <div v-for="slot in tier.slots" :key="slot.index" class="slot">
            <div class="slot-head">
              <Tooltip :text="slot.key" mono><span class="slot-name">{{ slot.name ?? slot.key }}</span></Tooltip>
            </div>
            <div v-for="input in slot.inputs" :key="input.uuid" class="input">
              <RouterLink :to="inputLink(input.kind, input.uuid)">{{ input.name }}</RouterLink>
              <span class="mono">{{ quantity(input) }}</span>
              <span v-if="input.minQuality > 1" class="tag">min Q {{ input.minQuality }}</span>
            </div>
            <div v-if="!slot.inputs.length" class="faint">No inputs</div>
            <div v-for="m in slot.modifiers" :key="m.propertyUuid" class="modifier">
              <span class="dim">{{ m.property?.name ?? m.property?.key ?? m.propertyUuid }}</span>
              <span v-for="(r, i) in m.ranges" :key="i" class="mono faint">{{ modifierRange(r) }}</span>
            </div>
          </div>
        </section>

        <RawJson :value="detail.data.value.raw" />
      </template>
    </DetailPanel>
  </div>
</template>

<style scoped>
.tier-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.slot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--radius-control);
  border: 1px solid var(--border-dim);
}

.slot-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.slot-name {
  font-weight: 600;
}

.slot-head .mono {
  font-size: 11px;
}

.input {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.modifier {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12px;
}
</style>
