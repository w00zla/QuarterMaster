<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import DataTable from "../components/DataTable.vue";
import DetailPanel from "../components/DetailPanel.vue";
import HelpTip from "../components/HelpTip.vue";
import Icon from "../components/Icon.vue";
import { useFetch } from "../api";
import { dateTime, sourceTag } from "../format";
import { HELP } from "../help";
import { lang } from "../lang";
import type { LocKeyDetail, LocSearch, LocSearchRow, LocSource } from "../../../src/adminapp/api-types";
import type { ColumnSpec } from "../tableColumns";

const route = useRoute();
const router = useRouter();
const sources = useFetch<LocSource[]>(() => "/localization/sources", false);
const selected = computed(() => (route.params.key as string | undefined) || null);
const detail = useFetch<LocKeyDetail>(() => (selected.value ? `/localization/keys/${encodeURIComponent(selected.value)}` : null), false);

// The search runs on the server (90k+ texts); debounced while typing
const search = ref("");
const query = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
watch(search, (s) => {
  clearTimeout(timer);
  timer = setTimeout(() => (query.value = s.trim()), 250);
});
const results = useFetch<LocSearch>(() => (query.value ? `/localization/search?q=${encodeURIComponent(query.value)}&limit=500` : null));

const langSources = computed(() => (sources.data.value ?? []).filter((s) => s.lang === lang.value));

const SOURCE_COLUMNS: ColumnSpec[] = [
  { key: "lang", label: "Lang", width: 80 },
  { key: "source", label: "Source", width: 160 },
  { key: "priority", label: "Priority", width: 80 },
  { key: "keyCount", label: "Texts", width: 80 },
  { key: "importedAt", label: "Imported", width: 160 },
  { key: "origin", label: "Origin", width: 320 },
];
const sourceValue = (s: LocSource, key: string): string | number => {
  const v = s[key as keyof LocSource];
  return typeof v === "number" ? v : String(v);
};

const RESULT_COLUMNS: ColumnSpec[] = [
  { key: "key", label: "Key", width: 340 },
  { key: "value", label: "Text", width: 480 },
  { key: "source", label: "Source", width: 120 },
];
const resultValue = (r: LocSearchRow, key: string) => r[key as keyof LocSearchRow];
</script>

<template>
  <div class="view">
    <div class="stack">
      <section class="panel sources">
        <div class="head">
          <Icon name="texts" :size="16" />
          <span class="head-title no-grow">Sources</span>
          <HelpTip :text="HELP.sources" />
          <span class="head-count">highest priority wins per text</span>
        </div>
        <DataTable
          storage-key="qm.columns.locsources"
          :columns="SOURCE_COLUMNS"
          :rows="sources.data.value ?? []"
          :default-sort="{ key: 'priority', dir: 'desc' }"
          :row-key="(s) => `${s.source}\u0000${s.lang}`"
          :value-of="sourceValue"
          :row-class="(s) => ({ current: s.lang === lang })"
          :numeric="['priority', 'keyCount']"
          empty-text="No texts imported"
          @select="(s) => (lang = s.lang)"
        >
          <template #cell-source="{ row }">
            <span class="tag" :class="sourceTag(row.source)">{{ row.source }}</span>
            <HelpTip v-if="row.source === 'app'" :text="HELP.appSource" />
          </template>
          <template #cell-importedAt="{ row }">{{ dateTime(row.importedAt) }}</template>
          <template #cell-origin="{ row }"><span class="mono faint" :title="row.origin">{{ row.origin }}</span></template>
        </DataTable>
      </section>

      <section class="panel list-panel results">
        <div class="head">
          <Icon name="search" :size="16" />
          <span class="head-title no-grow">Search</span>
          <HelpTip :text="HELP.textSearch" />
          <span class="head-count">
            <template v-if="results.data.value">{{ results.data.value.rows.length }} of {{ results.data.value.total }} in</template>
            <span class="mono">{{ lang }}</span>
            <template v-if="langSources.length"> · {{ langSources.map((s) => s.source).join(" > ") }}</template>
          </span>
          <div class="spacer" />
          <div class="search wide">
            <Icon name="search" :size="14" />
            <input v-model="search" placeholder="Key or text…" />
            <button v-if="search" type="button" class="clear" title="Clear" @click="search = ''">
              <Icon name="close" :size="12" />
            </button>
          </div>
        </div>
        <div v-if="!query" class="empty-line">Search keys and texts of the selected language</div>
        <div v-else-if="results.error.value" class="empty-line">{{ results.error.value }}</div>
        <DataTable
          v-else
          storage-key="qm.columns.locsearch"
          :columns="RESULT_COLUMNS"
          :rows="results.data.value?.rows ?? []"
          :default-sort="{ key: 'key', dir: 'asc' }"
          :row-key="(r) => r.key"
          :value-of="resultValue"
          :selected="selected"
          @select="(r) => router.push(`/texts/${encodeURIComponent(r.key)}`)"
        >
          <template #cell-key="{ row }"><span class="mono">{{ row.key }}</span></template>
          <template #cell-source="{ row }"><span class="tag" :class="sourceTag(row.source)">{{ row.source }}</span></template>
        </DataTable>
      </section>
    </div>

    <DetailPanel
      v-if="selected"
      icon="texts"
      :title="selected"
      :loading="detail.loading.value && !detail.data.value"
      :error="detail.error.value"
      @close="router.push('/texts')"
    >
      <template v-if="detail.data.value">
        <div v-if="!detail.data.value.values.length" class="empty-line">No texts for this key</div>
        <section v-for="v in detail.data.value.values" :key="`${v.lang}\u0000${v.source}`" class="value" :class="{ shadowed: !v.effective }">
          <div class="value-head">
            <span class="mono lang">{{ v.lang }}</span>
            <span class="tag" :class="sourceTag(v.source)">{{ v.source }}</span>
            <HelpTip v-if="v.source === 'app'" :text="HELP.appSource" />
            <span class="faint">priority {{ v.priority }}</span>
            <template v-if="v.effective">
              <span class="tag ok">Effective</span>
              <HelpTip :text="HELP.effective" />
            </template>
          </div>
          <p class="text">{{ v.value }}</p>
        </section>
      </template>
    </DetailPanel>
  </div>
</template>

<style scoped>
.sources {
  max-height: 40%;
}

.sources :deep(.data-row.current) {
  color: var(--accent);
}

.search.wide {
  width: 320px;
}

.value {
  gap: 6px;
}

.value.shadowed {
  opacity: 0.55;
}

.value-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.lang {
  width: 56px;
  color: var(--text-2);
}

.text {
  margin: 0;
  font-size: 13px;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
</style>
