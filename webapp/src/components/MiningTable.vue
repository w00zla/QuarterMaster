<script setup lang="ts">
// Where something is mined (rows of GET /api/mining/:uuid): a toolbar (the crafting dialog's target quality,
// then the system and method filters like the stock's), the quality card once for all places, then the
// shared DataTable (resizable, sortable) with one row per place, method and ore; its content column lists
// the rock's parts of the ore (the rich one, then the lean ones dimmed).
import { computed, shallowRef } from "vue";
import type { MiningRow } from "../../../src/webapp/api-types";
import DataTable from "../../../adminapp/src/components/DataTable.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import type { ColumnSpec, useTableColumns } from "../../../adminapp/src/tableColumns";
import { t, viewTexts } from "../i18n";
import {
  methodOptions, methodText, MINING_METHODS, miningFilter, partLabel, placeText, rangeText, rarityColor, rarityText, shareText, shown, systemOptions,
  targetOptions,
} from "../mining";
import Dropdown from "./Dropdown.vue";
import MiningQualityCard from "./MiningQualityCard.vue";
import Thumb from "./Thumb.vue";
import ViewToggle from "./ViewToggle.vue";

const props = defineProps<{ rows: MiningRow[] }>();
// The target quality (the crafting dialog); null: none, no chip
const target = defineModel<number | null>("target", { default: null });

const multiOre = computed(() => new Set(props.rows.map((r) => r.ore)).size > 1);
const visible = computed(() => props.rows.filter(shown));
const targetText = computed({
  get: () => String(target.value ?? ""),
  set: (v: string) => (target.value = Number(v)),
});

const columns = computed<ColumnSpec[]>(() => [
  { key: "place", label: t("mining.col.place"), width: 240 },
  { key: "system", label: t("mining.col.system"), width: 90 },
  { key: "method", label: t("mining.col.method"), width: 90 },
  ...(multiOre.value ? [{ key: "ore", label: t("mining.col.ore"), width: 150 }] : []),
  { key: "share", label: t("mining.col.share"), width: 130, help: t("mining.col.shareHelp") },
  { key: "content", label: t("mining.col.content"), width: 210, help: t("mining.col.contentHelp") },
]);

function valueOf(r: MiningRow, key: string): string | number {
  switch (key) {
    case "place": return placeText(r);
    case "system": return r.system ?? "";
    case "method": return MINING_METHODS.indexOf(r.method);
    case "ore": return r.ore;
    case "share": return r.share;
    case "content": return r.parts[0]?.maxPercent ?? 0;
    default: return "";
  }
}

// The full text of the cells that may be cut (a native tooltip)
const placeTitle = (r: MiningRow) =>
  [placeText(r), r.parent, r.group ? t("mining.places", { n: r.count }) : null].filter(Boolean).join(" · ");
const contentTitle = (r: MiningRow) => r.parts.map((p) => `${partLabel(p.qualityScale)}: ${rangeText(p.minPercent, p.maxPercent)}`).join(" · ");

// The frequency with the rock's rarity class (its bar's color): "18 % · Selten"
const shareTitle = (r: MiningRow) => [shareText(r), r.rarity ? rarityText(r.rarity) : null].filter(Boolean).join(" · ");

const rowKey = (r: MiningRow) => [r.ore, r.method, r.place ?? r.group, r.system].join("|");

// The table's column state (the view toggle in the toolbar); the view 'thumbs' shows the ore's thumbnail first
const table = shallowRef<{ table: ReturnType<typeof useTableColumns> } | null>(null);
const thumbView = computed(() => table.value?.table.view.value === "thumbs");
</script>

<template>
  <div class="mining">
    <div class="toolbar">
      <span v-if="target !== null" class="target">
        <Icon name="target" :size="14" />
        <Dropdown v-model="targetText" variant="small" :options="targetOptions(target)" />
      </span>
      <Dropdown v-model="miningFilter.system" variant="chip" :options="systemOptions()" />
      <Dropdown v-model="miningFilter.method" variant="chip" :options="methodOptions()" />
      <ViewToggle v-if="table?.table" :table="table.table" :texts="viewTexts()" :size="22" />
    </div>

    <div v-if="!rows.length" class="empty-line">{{ t("mining.none") }}</div>
    <template v-else>
      <MiningQualityCard :rows="visible" :target="target" />
      <DataTable
        ref="table"
        :storage-key="multiOre ? 'qm.webapp.columns.mining-ores' : 'qm.webapp.columns.mining'"
        :columns="columns"
        :rows="visible"
        :default-sort="{ key: 'share', dir: 'desc' }"
        :row-key="rowKey"
        :value-of="valueOf"
        :numeric="['share']"
        :empty-text="t('mining.noMatch')"
        thumbs
      >
        <template #cell-thumb="{ row }">
          <span class="thumb-cell"><Thumb :uuid="row.oreUuid" :hash="row.thumb" size="m" :px="48" icon="resource" :icon-size="24" /></span>
        </template>
        <template #cell-place="{ row }">
          <span class="place" :title="placeTitle(row)">
            {{ placeText(row) }}
            <span v-if="row.parent" class="faint">· {{ row.parent }}</span>
            <span v-if="row.group" class="faint">· {{ t("mining.places", { n: row.count }) }}</span>
          </span>
        </template>
        <template #cell-ore="{ row }">
          <span class="clip" :title="row.ore"><Thumb v-if="!thumbView" :uuid="row.oreUuid" :hash="row.thumb" size="s" :px="20" icon="resource" :icon-size="14" class="ore-thumb" />{{ row.ore }}</span>
        </template>
        <template #cell-system="{ row }"><span class="mono-cell clip" :title="row.system ?? undefined">{{ row.system ?? "—" }}</span></template>
        <template #cell-method="{ row }"><span class="tag">{{ methodText(row.method) }}</span></template>
        <template #cell-share="{ row }">
          <span class="share" :title="shareTitle(row)">
            <span class="bar"><i :style="{ width: `${Math.min(100, row.share)}%`, background: rarityColor(row.rarity) }" /></span>
            {{ shareText(row) }}
          </span>
        </template>
        <template #cell-content="{ row }">
          <span class="mono-cell clip" :title="contentTitle(row)">
            <template v-for="(p, i) in row.parts" :key="p.qualityScale">
              <span :class="{ faint: i > 0 }">{{ i > 0 ? " · " : "" }}{{ rangeText(p.minPercent, p.maxPercent) }}</span>
            </template>
          </span>
        </template>
      </DataTable>
    </template>
  </div>
</template>

<style scoped>
.mining {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* The target quality: a compact chip, green like what reaches it in the card */
.target {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: var(--h-chip-sm);
  box-sizing: border-box;
  padding: 0 2px 0 8px;
  border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent);
  border-radius: var(--radius-control);
  color: var(--ok);
}

/* Only the dropdown's trigger takes the chip's look; its list keeps the normal colors */
.target :deep(.dd-btn) {
  border: none;
  background: transparent;
  color: var(--ok);
}

.target :deep(.dd-btn .dd-name) {
  color: var(--ok);
  font-weight: 600;
}

.mining :deep(.table) {
  max-height: 55vh;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-control);
}

.mining :deep(.data-row) {
  cursor: default;
  user-select: text;
}

.ore-thumb {
  margin-right: 6px;
}

.place {
  display: block;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
}

.mono-cell {
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: nowrap;
}

.clip {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}

.share {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.bar {
  display: inline-block;
  width: 44px;
  height: 5px;
  border-radius: 3px;
  background: var(--bg-surface-3);
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
}
</style>
