<script setup lang="ts">
// History: what you did and what others did to your data (stock, refinery, blueprints), newest
// first, with where it came from (bot, web app, companion app). 100 per page, "Load more" fetches
// older ones; reloads when your stock or blueprints change. Filters (source, category, action, who)
// run on the server, so the pages continue within them.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { HistoryEntry, HistoryResponse } from "../../../src/webapp/api-types";
import ColumnHead from "../../../adminapp/src/components/ColumnHead.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import { sortRows, useTableColumns, type ColumnSpec } from "../../../adminapp/src/tableColumns";
import { api } from "../api";
import Dropdown from "../components/Dropdown.vue";
import { actionLabel, actionText, categoryText, detailsText, personText, sourceText, when } from "../history";
import { lang, t } from "../i18n";
import { coalesced, onServerMessage } from "../realtime";
import { me } from "../session";
import { toastError } from "../toasts";

const entries = ref<HistoryEntry[] | null>(null);
const sourceFilter = ref("");
const categoryFilter = ref("");
// "category.action"
const actionFilter = ref("");
const byFilter = ref("");

const ACTIONS: Record<HistoryEntry["category"], string[]> = {
  stock: ["add", "remove", "adjust", "move", "split", "merge", "share", "unshare", "give"],
  refinery: ["start", "done", "remove", "adjust"],
  blueprint: ["add", "remove"],
};
const sourceOptions = computed(() => [
  { value: "", label: t("history.allSources") },
  ...(["bot", "webapp", "companion"] as const).map((s) => ({ value: s, label: t(`history.source.${s}`) })),
]);
const categoryOptions = computed(() => [
  { value: "", label: t("filter.allCategories") },
  ...(["stock", "refinery", "blueprint"] as const).map((c) => ({ value: c, label: t(`history.category.${c}`) })),
]);
// The chosen category's actions, else all of them with their category
const actionOptions = computed(() => [
  { value: "", label: t("history.allActions") },
  ...(Object.entries(ACTIONS) as Array<[HistoryEntry["category"], string[]]>)
    .filter(([c]) => !categoryFilter.value || c === categoryFilter.value)
    .flatMap(([c, actions]) => actions.map((a) => ({
      value: `${c}.${a}`,
      label: categoryFilter.value ? actionLabel(c, a) : `${t(`history.category.${c}`)} · ${actionLabel(c, a)}`,
    }))),
]);
const byOptions = computed(() => [
  { value: "", label: t("history.allPeople") },
  { value: "me", label: t("history.byMe") },
  { value: "others", label: t("history.byOthers") },
]);
// An action of another category than the chosen one goes
watch(categoryFilter, (c) => {
  if (c && actionFilter.value && !actionFilter.value.startsWith(`${c}.`)) actionFilter.value = "";
});

const filtered = computed(() => Boolean(sourceFilter.value || categoryFilter.value || actionFilter.value || byFilter.value));

/** The query of the filters (an action brings its category). */
function query(): string {
  const [actionCategory, action] = actionFilter.value ? actionFilter.value.split(".") : [];
  const params = new URLSearchParams({ lang: lang.value });
  if (sourceFilter.value) params.set("source", sourceFilter.value);
  const category = categoryFilter.value || actionCategory;
  if (category) params.set("category", category);
  if (action) params.set("action", action);
  if (byFilter.value) params.set("by", byFilter.value);
  return params.toString();
}
const more = ref(false);
const loadingMore = ref(false);

let seq = 0;
/** The newest page again (keeps nothing older: a reload starts over). */
async function load() {
  const mine = ++seq;
  try {
    const r = await api<HistoryResponse>(`/history?${query()}`);
    if (mine !== seq) return;
    entries.value = r.entries;
    more.value = r.more;
  } catch (e) {
    if (mine === seq) toastError(e);
  }
}

async function loadMore() {
  const last = entries.value?.at(-1);
  if (!last || loadingMore.value) return;
  loadingMore.value = true;
  const mine = seq;
  try {
    const r = await api<HistoryResponse>(`/history?${query()}&before=${last.id}`);
    if (mine !== seq) return;
    entries.value = [...entries.value!, ...r.entries];
    more.value = r.more;
  } catch (e) {
    toastError(e);
  } finally {
    loadingMore.value = false;
  }
}

watch([lang, sourceFilter, categoryFilter, actionFilter, byFilter], load);

const reload = coalesced(() => void load());
let unsubscribe = () => {};
onMounted(() => {
  void load();
  unsubscribe = onServerMessage((m) => {
    if (m.type === "resync" || m.type === "stock" || (m.type === "blueprints" && m.userId === me.value?.userId)) reload.schedule();
  });
});
onUnmounted(() => {
  unsubscribe();
  reload.cancel();
});

const columns = computed<ColumnSpec[]>(() => [
  { key: "at", label: t("history.col.at"), width: 140 },
  { key: "source", label: t("history.col.source"), width: 110 },
  { key: "category", label: t("history.col.category"), width: 110 },
  { key: "action", label: t("history.col.action"), width: 120 },
  { key: "actor", label: t("history.col.actor"), width: 120 },
  { key: "target", label: t("history.col.target"), width: 220 },
  { key: "details", label: t("history.col.details"), width: 260, sortable: false },
]);
const cols = useTableColumns("qm.webapp.columns.history", columns, { key: "at", dir: "desc" });

function valueOf(e: HistoryEntry, key: string): string | number {
  switch (key) {
    case "at": return e.id;
    case "source": return sourceText(e);
    case "category": return categoryText(e);
    case "action": return actionText(e);
    case "actor": return personText(e.actor);
    case "target": return e.target;
    default: return "";
  }
}
const rows = computed(() => sortRows(entries.value ?? [], cols.sort.value, valueOf, (a, b) => b.id - a.id));
</script>

<template>
  <div class="page">
    <section class="panel unclipped">
      <div class="head">
        <Icon name="history" :size="16" />
        <span class="head-title">{{ t("history.title") }}</span>
      </div>
      <div class="filters">
        <Dropdown v-model="sourceFilter" variant="chip" :options="sourceOptions" />
        <Dropdown v-model="categoryFilter" variant="chip" :options="categoryOptions" />
        <Dropdown v-model="actionFilter" variant="chip" :options="actionOptions" />
        <Dropdown v-model="byFilter" variant="chip" :options="byOptions" />
      </div>
      <div v-if="!entries" class="empty-line">{{ t("common.loading") }}</div>
      <div v-else-if="!entries.length" class="empty-line">{{ t(filtered ? "stock.noMatch" : "history.none") }}</div>
      <div v-else class="table" :ref="cols.observe" :style="{ '--cols': cols.template.value, '--cols-min': `${cols.minWidth.value}px` }">
        <ColumnHead :columns="columns" :sort="cols.sort.value" @sort="cols.toggleSort" @resize="cols.startResize" @reset="cols.resetWidth" />
        <div v-for="e in rows" :key="e.id" class="row data-row">
          <span class="cell mono">{{ when(e.at) }}</span>
          <span class="cell">{{ sourceText(e) }}</span>
          <span class="cell">{{ categoryText(e) }}</span>
          <span class="cell">{{ actionText(e) }}</span>
          <span class="cell" :class="{ faint: e.actor.userId === me?.userId }">{{ personText(e.actor) }}</span>
          <span class="cell target">{{ e.target }}</span>
          <span class="cell" :title="detailsText(e)">{{ detailsText(e) }}</span>
        </div>
        <div v-if="more" class="more">
          <button type="button" class="btn small outline" :disabled="loadingMore" @click="loadMore">
            <Icon name="chevron-down" :size="14" /> {{ t("history.more") }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.data-row {
  cursor: default;
  user-select: text;
}

.cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target {
  font-weight: 600;
}

.faint {
  color: var(--text-3);
}

.more {
  display: flex;
  justify-content: center;
  padding: 12px;
}
</style>
