<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import DataTable from "../components/DataTable.vue";
import DetailPanel from "../components/DetailPanel.vue";
import HelpTip from "../components/HelpTip.vue";
import ImportForms from "../components/ImportForms.vue";
import Icon from "../components/Icon.vue";
import { useFetch } from "../api";
import { dateTime } from "../format";
import { HELP } from "../help";
import type { Anomaly, ImportDetail, ImportRow } from "../../../src/adminapp/api-types";
import type { ColumnSpec } from "../tableColumns";

interface Counts { total: number; added: number; changed: number; unchanged: number; revived?: number; retired?: number; removed?: number }
interface Summary { entities?: Record<string, Counts>; localization?: Record<string, Counts>; warnings?: string[]; timingsMs?: Record<string, number> }

const route = useRoute();
const router = useRouter();
const list = useFetch<ImportRow[]>(() => "/imports", false);
const selected = computed(() => (route.params.id as string | undefined) || null);
const detail = useFetch<ImportDetail>(() => (selected.value ? `/imports/${selected.value}` : null), false);
const summary = computed(() => (detail.data.value?.summary ?? {}) as Summary);

// Anomalies grouped by code, in order of first appearance
const anomalyGroups = computed(() => {
  const groups = new Map<string, Anomaly[]>();
  for (const a of detail.data.value?.anomalies ?? []) groups.set(a.code, [...(groups.get(a.code) ?? []), a]);
  return [...groups];
});

const COLUMNS: ColumnSpec[] = [
  { key: "id", label: "#", width: 56 },
  { key: "importedAt", label: "Imported", width: 170 },
  { key: "game", label: "Game", width: 260 },
  { key: "anomalyCount", label: "Anomalies", width: 120, help: HELP.anomalies },
];
function valueOf(r: ImportRow, key: string): string | number {
  switch (key) {
    case "id": return r.id;
    case "importedAt": return r.importedAt;
    case "anomalyCount": return r.anomalyCount;
    default: return `${r.channel} ${r.gameBuild}`;
  }
}
const ENTITY_COLS = ["total", "added", "changed", "unchanged", "revived", "retired"] as const;
const LOC_COLS = ["total", "added", "changed", "unchanged", "removed"] as const;
</script>

<template>
  <div class="view">
    <div class="stack">
    <ImportForms @imported="list.reload()" />
    <section class="panel list-panel">
      <div class="head">
        <Icon name="imports" :size="16" />
        <span class="head-title no-grow">Catalog imports</span>
        <HelpTip :text="HELP.importList" />
        <span class="head-count">{{ list.data.value?.length ?? 0 }}</span>
      </div>
      <div v-if="list.error.value" class="empty-line">{{ list.error.value }}</div>
      <DataTable
        v-else
        storage-key="qm.columns.imports"
        :columns="COLUMNS"
        :rows="list.data.value ?? []"
        :default-sort="{ key: 'id', dir: 'desc' }"
        :row-key="(r) => String(r.id)"
        :value-of="valueOf"
        :selected="selected"
        :numeric="['id', 'anomalyCount']"
        empty-text="No imports yet"
        @select="(r) => router.push(`/imports/${r.id}`)"
      >
        <template #cell-importedAt="{ row }">{{ dateTime(row.importedAt) }}</template>
        <template #cell-game="{ row }">
          <span class="mono">{{ row.channel }} {{ row.gameBuild }}</span>
          <span v-if="row.gameLabel" class="dim"> {{ row.gameLabel }}</span>
          <span v-if="row.forced" class="tag warn">Forced</span>
        </template>
      </DataTable>
    </section>
    </div>

    <DetailPanel
      v-if="selected"
      icon="imports"
      :title="detail.data.value ? `Import #${detail.data.value.id}` : '…'"
      :technical="detail.data.value?.snapshotSha256"
      :loading="detail.loading.value && !detail.data.value"
      :error="detail.error.value"
      @close="router.push('/imports')"
    >
      <template v-if="detail.data.value">
        <section>
          <dl class="kv">
            <dt>Game</dt>
            <dd><span class="mono">{{ detail.data.value.channel }} {{ detail.data.value.gameBuild }}</span> {{ detail.data.value.gameLabel ?? "" }}</dd>
            <dt>Branch / version</dt>
            <dd class="mono">{{ detail.data.value.gameBranch }} · {{ detail.data.value.gameVersion }}</dd>
            <dt>Extracted</dt>
            <dd>{{ dateTime(detail.data.value.extractedAt) }}</dd>
            <dt>Imported</dt>
            <dd>{{ dateTime(detail.data.value.importedAt) }} <span v-if="detail.data.value.forced" class="tag warn">Forced</span></dd>
            <dt>Tools</dt>
            <dd class="mono">extractor {{ detail.data.value.extractorVersion }} · StarBreaker {{ detail.data.value.starbreakerVersion }}</dd>
          </dl>
        </section>

        <section v-if="summary.warnings?.length">
          <span class="panel-title">Warnings</span>
          <div v-for="(w, i) in summary.warnings" :key="i" class="warning"><Icon name="warning" :size="14" /> {{ w }}</div>
        </section>

        <section v-if="summary.entities">
          <span class="section-head"><span class="panel-title">Catalog</span> <HelpTip :text="HELP.importCounts" /></span>
          <table class="mini">
            <thead><tr><th></th><th v-for="c in ENTITY_COLS" :key="c" class="num">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="(counts, name) in summary.entities" :key="name">
                <td>{{ name }}</td>
                <td v-for="c in ENTITY_COLS" :key="c" class="num mono" :class="{ faint: !counts[c] }">{{ counts[c] ?? 0 }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="summary.localization">
          <span class="panel-title">Game texts</span>
          <table class="mini">
            <thead><tr><th></th><th v-for="c in LOC_COLS" :key="c" class="num">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="(counts, l) in summary.localization" :key="l">
                <td class="mono">{{ l }}</td>
                <td v-for="c in LOC_COLS" :key="c" class="num mono" :class="{ faint: !counts[c] }">{{ counts[c] ?? 0 }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <span class="section-head"><span class="panel-title">Extractor anomalies · {{ detail.data.value.anomalies.length }}</span> <HelpTip :text="HELP.anomalies" /></span>
          <div v-for="[code, items] in anomalyGroups" :key="code" class="anomaly-group">
            <div class="anomaly-code"><span class="tag warn mono">{{ code }}</span> <span class="faint">{{ items.length }}</span></div>
            <div v-for="(a, i) in items" :key="i" class="anomaly">
              <span v-if="a.record" class="mono dim">{{ a.record }}</span>
              <span>{{ a.detail }}</span>
            </div>
          </div>
        </section>

        <section v-if="summary.timingsMs">
          <span class="panel-title">Timings</span>
          <div class="mono dim timings">
            <span v-for="(ms, k) in summary.timingsMs" :key="k">{{ k }} {{ (ms / 1000).toFixed(1) }}s</span>
          </div>
        </section>
      </template>
    </DetailPanel>
  </div>
</template>

<style scoped>
.warning {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--warn);
}

.anomaly-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.anomaly-code {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.anomaly {
  display: flex;
  flex-direction: column;
  padding-left: 12px;
  font-size: 12px;
  border-left: 1px solid var(--border-dim);
}

.timings {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  font-size: 12px;
}
</style>
