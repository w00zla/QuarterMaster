<script setup lang="ts">
// Catalog and localization imports from an uploaded file. Always a dry run first;
// "Import" only becomes available once the dry run of exactly this file and these
// options passed. Safeguard overrides need a new dry run.
import { computed, inject, onBeforeUnmount, reactive, ref, watch } from "vue";
import HelpTip from "./HelpTip.vue";
import Icon from "./Icon.vue";
import { postFile } from "../api";
import { HELP } from "../help";
import type { CatalogImportResponse, LocImportResponse, Meta } from "../../../src/adminapp/api-types";

const emit = defineEmits<{ imported: [] }>();
const meta = inject<{ value: Meta }>("meta");
const reloadMeta = inject<() => Promise<void>>("reloadMeta");

const ENTITY_COLS = ["total", "added", "changed", "unchanged", "revived", "retired"] as const;
const TEXT_COLS = ["total", "added", "changed", "unchanged", "removed"] as const;

/**
 * A running request's state for the progress line: the upload's share (XHR), then the seconds the
 * server has been working on it (no progress from there: the import is one transaction).
 */
function useProgress() {
  const state = reactive({ busy: false, dryRun: true, upload: 0, seconds: 0 });
  let timer: ReturnType<typeof setInterval> | undefined;
  let uploadedAt = 0;
  const stop = () => {
    clearInterval(timer);
    state.busy = false;
  };
  onBeforeUnmount(stop);
  return {
    state,
    start(dryRun: boolean) {
      Object.assign(state, { busy: true, dryRun, upload: 0, seconds: 0 });
      uploadedAt = 0;
      clearInterval(timer);
      timer = setInterval(() => {
        if (uploadedAt) state.seconds = Math.floor((Date.now() - uploadedAt) / 1000);
      }, 1000);
    },
    onUpload(share: number) {
      state.upload = share;
      if (share >= 1 && !uploadedAt) uploadedAt = Date.now();
    },
    stop,
  };
}

// --- catalog ---
const catalogFile = ref<File | null>(null);
const force = ref(false);
const allowDowngrade = ref(false);
const catalogRun = useProgress();
const catalogBusy = computed(() => catalogRun.state.busy);
const catalogError = ref("");
const catalogResult = ref<CatalogImportResponse | null>(null);
// A passed dry run is only valid for the file and options it ran with
const catalogReady = ref(false);
watch([catalogFile, force, allowDowngrade], () => {
  catalogReady.value = false;
});

async function runCatalog(dryRun: boolean) {
  if (!catalogFile.value) return;
  catalogRun.start(dryRun);
  catalogError.value = "";
  try {
    const r = await postFile<CatalogImportResponse>("/import/catalog", {
      dryRun: dryRun ? 1 : 0, force: force.value ? 1 : 0, allowDowngrade: allowDowngrade.value ? 1 : 0,
    }, catalogFile.value, catalogRun.onUpload);
    catalogResult.value = r;
    catalogReady.value = dryRun && r.status === "dry-run";
    if (r.status === "imported") {
      await reloadMeta?.();
      emit("imported");
    }
  } catch (e) {
    catalogResult.value = null;
    catalogError.value = e instanceof Error ? e.message : String(e);
  } finally {
    catalogRun.stop();
  }
}

// --- localization ---
const locFile = ref<File | null>(null);
const source = ref("");
const locLang = ref("de");
const priority = ref("");
const locForce = ref(false);
const locRun = useProgress();
const locBusy = computed(() => locRun.state.busy);
const locError = ref("");
const locResult = ref<LocImportResponse | null>(null);
const locReady = ref(false);
watch([locFile, source, locLang, priority, locForce], () => {
  locReady.value = false;
});
const langs = computed(() => meta?.value.langs ?? []);

async function runLoc(dryRun: boolean) {
  if (!locFile.value) return;
  locRun.start(dryRun);
  locError.value = "";
  try {
    const r = await postFile<LocImportResponse>("/import/localization", {
      source: source.value.trim(), lang: locLang.value.trim(), priority: priority.value.trim(),
      name: locFile.value.name, dryRun: dryRun ? 1 : 0, force: locForce.value ? 1 : 0,
    }, locFile.value, locRun.onUpload);
    locResult.value = r;
    locReady.value = dryRun && r.status === "dry-run";
    if (r.status === "imported") await reloadMeta?.();
  } catch (e) {
    locResult.value = null;
    locError.value = e instanceof Error ? e.message : String(e);
  } finally {
    locRun.stop();
  }
}

const fileOf = (e: Event) => (e.target as HTMLInputElement).files?.[0] ?? null;
const STATUS: Record<string, { text: string; cls: string }> = {
  "dry-run": { text: "Dry run passed: nothing written yet", cls: "ok" },
  "imported": { text: "Imported", cls: "ok" },
  "noop": { text: "Nothing to do: identical data already imported", cls: "" },
  "blocked": { text: "Blocked by safeguards", cls: "err" },
};
const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;
</script>

<template>
  <section class="panel imports">
    <div class="head">
      <Icon name="imports" :size="16" />
      <span class="head-title no-grow">New import</span>
      <HelpTip :text="HELP.newImport" />
    </div>
    <div class="forms">
      <!-- catalog snapshot -->
      <div class="form">
        <span class="section-head"><span class="panel-title">Catalog snapshot</span> <HelpTip :text="HELP.catalogImport" /></span>
        <div class="row">
          <label class="btn outline small file">
            <Icon name="file" :size="14" /> {{ catalogFile ? "Change file" : "Choose snapshot…" }}
            <input type="file" accept=".gz,.json,application/gzip,application/json" @change="catalogFile = fileOf($event)" />
          </label>
          <span class="mono dim name">{{ catalogFile?.name ?? "" }}</span>
        </div>
        <div class="row">
          <label class="check"><input v-model="force" type="checkbox" /> Force <HelpTip :text="HELP.forceImport" /></label>
          <label class="check"><input v-model="allowDowngrade" type="checkbox" /> Allow downgrade <HelpTip :text="HELP.allowDowngrade" /></label>
        </div>
        <div class="row">
          <button type="button" class="btn outline small" :disabled="!catalogFile || catalogBusy" @click="runCatalog(true)">Dry run</button>
          <button type="button" class="btn primary small" :disabled="!catalogReady || catalogBusy" @click="runCatalog(false)">Import</button>
          <span v-if="catalogBusy" class="progress">
            <span class="spinner" />
            <template v-if="catalogRun.state.upload < 1">
              Uploading <span class="mono">{{ Math.floor(catalogRun.state.upload * 100) }} %</span>
              <span class="bar"><span :style="{ width: `${catalogRun.state.upload * 100}%` }" /></span>
            </template>
            <template v-else>{{ catalogRun.state.dryRun ? "Dry run" : "Importing" }} · <span class="mono">{{ catalogRun.state.seconds }} s</span></template>
          </span>
        </div>
        <div v-if="catalogError" class="error">{{ catalogError }}</div>
        <div v-if="catalogResult" class="result">
          <div class="status">
            <span class="tag" :class="STATUS[catalogResult.status]?.cls">{{ STATUS[catalogResult.status]?.text }}</span>
            <span v-if="catalogResult.importId" class="faint">#{{ catalogResult.importId }}</span>
          </div>
          <div class="dim small">
            <span class="mono">{{ catalogResult.game.channel }} {{ catalogResult.game.build }}</span>
            {{ catalogResult.game.label ?? "" }} · {{ catalogResult.anomalyCount }} anomalies
            <template v-if="catalogResult.lastImport"> · last import #{{ catalogResult.lastImport.id }} (build {{ catalogResult.lastImport.gameBuild }})</template>
          </div>
          <div v-for="v in catalogResult.violations" :key="v.code" class="warning err"><Icon name="warning" :size="13" /> {{ v.message }}</div>
          <div v-for="(w, i) in catalogResult.warnings" :key="i" class="warning"><Icon name="warning" :size="13" /> {{ w }}</div>
          <table class="mini">
            <thead><tr><th></th><th v-for="c in ENTITY_COLS" :key="c" class="num">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="(counts, name) in catalogResult.entities" :key="name">
                <td>{{ name }}</td>
                <td v-for="c in ENTITY_COLS" :key="c" class="num mono" :class="{ faint: !counts[c] }">{{ counts[c] }}</td>
              </tr>
            </tbody>
          </table>
          <details>
            <summary class="dim small">Game texts per language</summary>
            <table class="mini">
              <thead><tr><th></th><th v-for="c in TEXT_COLS" :key="c" class="num">{{ c }}</th></tr></thead>
              <tbody>
                <tr v-for="(counts, l) in catalogResult.localization" :key="l">
                  <td class="mono">{{ l }}</td>
                  <td v-for="c in TEXT_COLS" :key="c" class="num mono" :class="{ faint: !counts[c] }">{{ counts[c] }}</td>
                </tr>
              </tbody>
            </table>
          </details>
        </div>
      </div>

      <div class="form-divider" />

      <!-- localization file -->
      <div class="form">
        <span class="section-head"><span class="panel-title">Localization file</span> <HelpTip :text="HELP.locImport" /></span>
        <div class="row">
          <label class="btn outline small file">
            <Icon name="file" :size="14" /> {{ locFile ? "Change file" : "Choose global.ini…" }}
            <input type="file" accept=".ini,text/plain" @change="locFile = fileOf($event)" />
          </label>
          <span class="mono dim name">{{ locFile?.name ?? "" }}</span>
        </div>
        <div class="row">
          <label class="field">Source <input v-model="source" class="input mono" placeholder="e.g. community-de" /></label>
          <label class="field">Language
            <input v-model="locLang" class="input mono short" list="qm-langs" />
            <datalist id="qm-langs"><option v-for="l in langs" :key="l" :value="l" /></datalist>
          </label>
          <label class="field">Priority <input v-model="priority" class="input mono short" placeholder="100" /></label>
          <label class="check"><input v-model="locForce" type="checkbox" /> Force <HelpTip :text="HELP.forceImport" /></label>
        </div>
        <div class="row">
          <button type="button" class="btn outline small" :disabled="!locFile || !source.trim() || !locLang.trim() || locBusy" @click="runLoc(true)">Dry run</button>
          <button type="button" class="btn primary small" :disabled="!locReady || locBusy" @click="runLoc(false)">Import</button>
          <span v-if="locBusy" class="progress">
            <span class="spinner" />
            <template v-if="locRun.state.upload < 1">
              Uploading <span class="mono">{{ Math.floor(locRun.state.upload * 100) }} %</span>
              <span class="bar"><span :style="{ width: `${locRun.state.upload * 100}%` }" /></span>
            </template>
            <template v-else>{{ locRun.state.dryRun ? "Dry run" : "Importing" }} · <span class="mono">{{ locRun.state.seconds }} s</span></template>
          </span>
        </div>
        <div v-if="locError" class="error">{{ locError }}</div>
        <div v-if="locResult" class="result">
          <div class="status"><span class="tag" :class="STATUS[locResult.status]?.cls">{{ STATUS[locResult.status]?.text }}</span></div>
          <div class="dim small">
            {{ locResult.file.keys.toLocaleString() }} keys, {{ locResult.file.placeholders }} placeholders skipped
            <template v-if="locResult.file.appKeys"> · {{ locResult.file.appKeys }} app keys skipped</template>
            · priority {{ locResult.priority }}
            <template v-if="locResult.previous"> (was {{ locResult.previous.priority }}, {{ locResult.previous.keyCount.toLocaleString() }} texts)</template>
          </div>
          <div v-if="locResult.knownToGame !== null && locResult.gameKeys" class="dim small">
            {{ pct(locResult.knownToGame, locResult.texts.total) }} of its keys exist in the game ·
            covers {{ pct(locResult.knownToGame, locResult.gameKeys) }} of the game's texts
            <template v-if="locResult.wins !== null"> · wins for {{ locResult.wins.toLocaleString() }} texts</template>
          </div>
          <div v-for="v in locResult.violations" :key="v.code" class="warning err"><Icon name="warning" :size="13" /> {{ v.message }}</div>
          <div v-for="(w, i) in locResult.warnings" :key="i" class="warning"><Icon name="warning" :size="13" /> {{ w }}</div>
          <table class="mini">
            <thead><tr><th v-for="c in TEXT_COLS" :key="c" class="num">{{ c }}</th></tr></thead>
            <tbody>
              <tr><td v-for="c in TEXT_COLS" :key="c" class="num mono" :class="{ faint: !locResult.texts[c] }">{{ locResult.texts[c] }}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.imports {
  flex-shrink: 0;
}

.forms {
  display: flex;
  gap: 20px;
  padding: 12px 16px 16px;
}

.form {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form-divider {
  width: 1px;
  background: var(--border-dim);
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.file {
  position: relative;
  overflow: hidden;
}

.file input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check,
.field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
}

.check input {
  accent-color: var(--accent);
}

.input {
  height: var(--h-chip-sm);
  width: 150px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-control);
  background: var(--bg-surface-2);
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.input.short {
  width: 70px;
}

.progress {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
}

.spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--bg-surface-3);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2.4s;
  }
}

.bar {
  width: 120px;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-surface-3);
  overflow: hidden;
}

.bar > span {
  display: block;
  height: 100%;
  background: var(--accent);
}

.error {
  color: var(--err);
  font-size: 13px;
  white-space: pre-wrap;
}

.result {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.small {
  font-size: 12px;
}

.warning.err {
  color: var(--err);
}

details summary {
  cursor: pointer;
}
</style>
