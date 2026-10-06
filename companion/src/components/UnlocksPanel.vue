<script setup lang="ts">
// The blueprint unlocks from Game.log (and, on request, the old logs), matched to the catalog and
// compared with the user's registered blueprints; new ones are registered after a confirmation.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BlueprintListResponse, CatalogBlueprint, CatalogResponse, OkResponse } from "../../../src/webapp/api-types";
import Icon from "../../../adminapp/src/components/Icon.vue";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import { api, logState, scanBackups, type LogState } from "../backend";
import { lang, t, type Key } from "../i18n";
import { buildIndex, matchUnlock, type CatalogEntry } from "../match";
import { connected } from "../state";
import { toast, toastError } from "../toasts";

type RowState = "owned" | "default" | "unknown" | "new" | "pick";
interface Row {
  name: string;
  at: string;
  state: RowState;
  candidates: CatalogEntry[];
}

const log = ref<LogState | null>(null);
const index = ref(new Map<string, CatalogEntry[]>());
// Labels in the UI language ("Name · S3 · B Industrial · CHCO")
const labels = ref(new Map<string, string>());
const owned = ref(new Set<string>());
// Unticked new rows, picked candidates of ambiguous ones (by logged name)
const excluded = ref(new Set<string>());
const picked = ref<Record<string, string>>({});
const busy = ref(false);
const scanning = ref(false);
const confirming = ref(false);

async function loadLog() {
  try {
    log.value = await logState();
  } catch (e) {
    toastError(e);
  }
}

async function loadCatalog() {
  if (!connected.value) return;
  try {
    const langs = lang === "de" ? (["de", "en"] as const) : (["en", "de"] as const);
    const catalogs: CatalogBlueprint[][] = [];
    for (const l of langs) catalogs.push((await api<CatalogResponse>("GET", `/catalog?lang=${l}`)).blueprints);
    index.value = buildIndex(catalogs);
    labels.value = new Map(catalogs[0]!.map((b) => [b.uuid, b.label]));
    await loadOwned();
  } catch (e) {
    toastError(e);
  }
}

async function loadOwned() {
  owned.value = new Set((await api<BlueprintListResponse>("GET", "/blueprints")).uuids);
}

const rows = computed<Row[]>(() => (log.value?.unlocks ?? [])
  .map((u) => {
    const all = matchUnlock(u.name, index.value);
    // Default blueprints are never registered (everyone has them)
    const candidates = all.filter((c) => !c.isDefault);
    const state: RowState = !all.length ? "unknown"
      : all.some((c) => owned.value.has(c.uuid)) ? "owned"
      : !candidates.length ? "default"
      : candidates.length === 1 ? "new" : "pick";
    return { name: u.name, at: u.at, state, candidates };
  })
  .sort((a, b) => b.at.localeCompare(a.at)));

/** The blueprint a row would register, null when none. */
function selection(row: Row): string | null {
  if (row.state === "new") return excluded.value.has(row.name) ? null : row.candidates[0]!.uuid;
  if (row.state === "pick") return picked.value[row.name] ?? null;
  return null;
}
const selected = computed(() => [...new Set(rows.value.map(selection).filter((u): u is string => u !== null))]);

function toggle(row: Row) {
  const next = new Set(excluded.value);
  if (next.has(row.name)) next.delete(row.name);
  else next.add(row.name);
  excluded.value = next;
}

const confirmButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("unlocks.add"), kind: "primary", value: "add", icon: "plus", disabled: busy.value },
]);

async function register(value: string) {
  if (value !== "add") return void (confirming.value = false);
  busy.value = true;
  let done = 0;
  try {
    for (const uuid of selected.value) {
      await api<OkResponse>("POST", "/blueprints/add", { uuid });
      done++;
    }
  } catch (e) {
    toastError(e);
  } finally {
    if (done) toast(t("unlocks.added", { n: done }));
    busy.value = false;
    confirming.value = false;
    await loadOwned().catch(toastError);
  }
}

async function scan() {
  scanning.value = true;
  try {
    const result = await scanBackups();
    toast(t("unlocks.scanned", { n: result.found }));
    if (result.failed) toast(t("unlocks.scanFailed", { n: result.failed }), "error");
    await loadLog();
  } catch (e) {
    toastError(e);
  } finally {
    scanning.value = false;
  }
}

const stateKey = (s: RowState) => `state.${s}` as Key;
const when = (at: string) => (at ? new Date(at).toLocaleString(lang) : "");
const label = (c: CatalogEntry) => labels.value.get(c.uuid) ?? c.name;

let unlisten: UnlistenFn | undefined;
onMounted(async () => {
  unlisten = await listen("log-changed", () => void loadLog());
  await loadLog();
  await loadCatalog();
});
onUnmounted(() => unlisten?.());
watch(connected, () => void loadCatalog());
</script>

<template>
  <section class="panel unlocks">
    <div class="head">
      <Icon name="blueprint" :size="16" />
      <span class="head-title">{{ t("unlocks.title") }}</span>
      <span v-if="log && !log.found" class="missing" :title="log.path"><Icon name="warning" :size="14" /> {{ t("log.missing") }}</span>
      <button type="button" class="btn small outline" :disabled="scanning" @click="scan">
        <Icon name="history" :size="14" /> {{ t("unlocks.scan") }}
      </button>
      <button type="button" class="btn small primary" :disabled="!connected || !selected.length || busy" @click="confirming = true">
        <Icon name="plus" :size="14" /> {{ t("unlocks.add") }}
      </button>
    </div>
    <div v-if="!rows.length" class="empty-line">{{ t("unlocks.empty") }}</div>
    <div v-else class="table">
      <div class="row cols-head">
        <span />
        <span>{{ t("col.blueprint") }}</span>
        <span>{{ t("col.at") }}</span>
        <span>{{ t("col.state") }}</span>
      </div>
      <div v-for="row in rows" :key="row.name" class="row item" :class="{ done: row.state !== 'new' && row.state !== 'pick' }">
        <span>
          <input v-if="row.state === 'new'" type="checkbox" :checked="!excluded.has(row.name)" :disabled="!connected" @change="toggle(row)" />
        </span>
        <span class="name" :title="row.candidates.length === 1 ? label(row.candidates[0]!) : row.name">{{ row.name }}</span>
        <span class="faint">{{ when(row.at) }}</span>
        <span>
          <select v-if="row.state === 'pick'" v-model="picked[row.name]" class="input pick" :disabled="!connected">
            <option :value="undefined">{{ t("unlocks.pick") }}</option>
            <option v-for="c in row.candidates" :key="c.uuid" :value="c.uuid">{{ label(c) }}</option>
          </select>
          <template v-else>{{ t(stateKey(row.state)) }}</template>
        </span>
      </div>
    </div>
    <ConfirmDialog
      v-if="confirming"
      :title="t('unlocks.confirmAdd', { n: selected.length })"
      icon="plus"
      :buttons="confirmButtons"
      @choose="register"
    />
  </section>
</template>

<style scoped>
.unlocks {
  flex: 1;
}

.table {
  --cols: 20px minmax(0, 1fr) 170px 240px;
  --cols-min: 0;
}

.row.item {
  min-height: 30px;
}

.row.item > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.done {
  color: var(--text-3);
}

.pick {
  width: 100%;
  height: var(--h-chip-sm);
}

.missing {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--warn);
  font-size: 12px;
}
</style>
