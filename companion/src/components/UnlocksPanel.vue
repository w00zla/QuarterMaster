<script setup lang="ts">
// The blueprint unlocks from Game.log (and, on request, the old logs), matched to the catalog and
// compared with the user's registered blueprints, newest first: registered and default ones dimmed, the
// counts only the unregistered ones (also those not in the catalog), the overlay all of them like the list. New ones are registered one by one right away
// (ambiguous ones after picking the variant) or all at once after a confirmation. In the head after the
// count the filter "Unlocks" (off: Game.log's unlocks are not read, state.ts), then the old logs' scan
// progress while it runs; each row with the same icon-only badge and the crafted item's thumbnail (in front of
// the name, or in the display "thumbs", ViewToggle next to the column chooser, larger in a column of its own).
// The log itself is followed in state.ts (the top bar shows whether it is found).
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BlueprintListResponse, OkResponse } from "../../../src/webapp/api-types";
import ColumnHead from "../../../adminapp/src/components/ColumnHead.vue";
import Icon from "../../../adminapp/src/components/Icon.vue";
import Tooltip from "../../../adminapp/src/components/Tooltip.vue";
import { useTableColumns, type ColumnSpec, type TableView } from "../../../adminapp/src/tableColumns";
import ColumnsButton from "../../../webapp/src/components/ColumnsButton.vue";
import ViewToggle from "../../../webapp/src/components/ViewToggle.vue";
import ConfirmDialog, { type ConfirmButton } from "../../../webapp/src/components/ConfirmDialog.vue";
import { scanBackups } from "../backend";
import { unlockRows, type UnlockState } from "../debugReport";
import { columnsTexts, langRef, t, viewTexts, type Key } from "../i18n";
import { buildIndex, matchUnlock, normalizeName, type CatalogEntry } from "../match";
import { overlayRows, tabCounts, type OverlayRow } from "../overlay";
import { catalogResponses } from "../refinerySync";
import { api, connected, loadLog, log, toggleUnlocks, unlocksOn } from "../state";
import { thumbRef, type ThumbRef } from "../thumbs";
import { toast, toastError } from "../toasts";
import Thumb from "./Thumb.vue";

type RowState = UnlockState;
interface Row {
  name: string;
  at: string;
  backup: boolean;
  state: RowState;
  candidates: CatalogEntry[];
  // Every catalog match, default ones included (the debug window lists them)
  matches: CatalogEntry[];
}

// The shared catalog's blueprints (refinerySync.ts), the UI language first
const catalogs = computed(() => {
  const r = catalogResponses.value;
  return r ? (langRef.value === "de" ? [r.de, r.en] : [r.en, r.de]).map((c) => c.blueprints) : [];
});
const index = computed(() => buildIndex(catalogs.value));
// Magazine blueprints are left out of the catalog (consumables): their unlocks are not listed at all
// (an older server sends none)
const magazines = computed(() => {
  const r = catalogResponses.value;
  return new Set(r ? [r.de, r.en].flatMap((c) => c.magazineBlueprints ?? []).map(normalizeName) : []);
});
// Labels in the UI language ("Name · S3 · B Industrial · CHCO")
const labels = computed(() => new Map((catalogs.value[0] ?? []).map((b) => [b.uuid, b.label])));
// The crafted item's thumbnail per blueprint
const thumbs = computed(() => new Map((catalogs.value[0] ?? []).map((b) => [b.uuid, thumbRef(b.outputUuid, b.thumb)])));
const owned = ref(new Set<string>());
// Picked candidates of ambiguous rows, rows being registered one by one (by logged name)
const picked = ref<Record<string, string>>({});
const pending = ref(new Set<string>());
const busy = ref(false);
const scanning = ref(false);
// Full scan progress in log files (Rust event scan-progress), null until the first report
const progress = ref<{ done: number; total: number } | null>(null);
const progressPct = computed(() => (progress.value?.total ? (progress.value.done / progress.value.total) * 100 : 0));
const confirming = ref(false);

async function loadOwned() {
  owned.value = new Set((await api<BlueprintListResponse>("GET", "/blueprints")).uuids);
}

const allRows = computed<Row[]>(() => (log.value?.unlocks ?? [])
  .filter((u) => !magazines.value.has(normalizeName(u.name)) || index.value.has(normalizeName(u.name)))
  .map((u) => {
    const all = matchUnlock(u.name, index.value);
    // Default blueprints are never registered (everyone has them)
    const candidates = all.filter((c) => !c.isDefault);
    // Without the catalog yet (thin line) nothing is "not in catalog"
    const state: RowState = !catalogResponses.value ? "loading"
      : !all.length ? "unknown"
      : all.some((c) => owned.value.has(c.uuid)) ? "owned"
      : !candidates.length ? "default"
      : candidates.length === 1 ? "new" : "pick";
    return { name: u.name, at: u.at, backup: u.backup, state, candidates, matches: all };
  })
  .sort((a, b) => b.at.localeCompare(a.at)));
// Every unlock; registered and default ones dimmed
const rows = allRows;
// The rows not registered (new, ambiguous, not in the catalog: the game unlocked it all the same): the counts
const openRows = computed(() => rows.value.filter((r) => r.state === "new" || r.state === "pick" || r.state === "unknown"));

/** The thumbnail of the item a row's blueprint crafts: the picked or registered one, else the first match;
 * none without a match (not in the catalog). */
function thumbOf(row: Row): ThumbRef | null {
  const uuid = (row.state === "pick" ? picked.value[row.name] : undefined)
    ?? row.matches.find((c) => owned.value.has(c.uuid))?.uuid ?? row.candidates[0]?.uuid ?? row.matches[0]?.uuid;
  return uuid ? (thumbs.value.get(uuid) ?? null) : null;
}

// The scan overlay shows every unlock, newest first: the ones to register (new, ambiguous) with their tag,
// the others dimmed with the blueprint icon only (the state texts are too wide for the tile)
watchEffect(() => {
  overlayRows.unlocks = rows.value.map((r): OverlayRow => r.state === "new" || r.state === "pick"
    ? { tag: t(r.state === "new" ? "state.new" : "state.pick"), cls: r.state === "new" ? "ok" : "warn", name: r.name, detail: null, cols: [], thumb: thumbOf(r) }
    : { tag: "", icon: "blueprint", cls: "", name: r.name, detail: null, cols: [], dim: true, thumb: thumbOf(r) });
  tabCounts.unlocks = openRows.value.length;
});

/** The blueprint a row would register, null when none. */
function selection(row: Row): string | null {
  if (row.state === "new") return row.candidates[0]!.uuid;
  if (row.state === "pick") return picked.value[row.name] ?? null;
  return null;
}
// What "Register all" registers: every new row, every ambiguous one with a picked variant
const selected = computed(() => [...new Set(rows.value.map(selection).filter((u): u is string => u !== null))]);

/** Registers one row's blueprint right away. */
async function registerOne(row: Row) {
  const uuid = selection(row);
  if (!uuid || pending.value.has(row.name)) return;
  pending.value = new Set(pending.value).add(row.name);
  try {
    await api<OkResponse>("POST", "/blueprints/add", { uuid });
    toast(t("unlocks.addedOne", { name: labels.value.get(uuid) ?? row.name }));
    await loadOwned();
  } catch (e) {
    toastError(e);
  } finally {
    const next = new Set(pending.value);
    next.delete(row.name);
    pending.value = next;
  }
}

const confirmButtons = computed<ConfirmButton[]>(() => [
  { label: t("common.cancel"), kind: "outline", value: "cancel" },
  { label: t("unlocks.add"), kind: "primary", value: "add", icon: "check", disabled: busy.value },
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
  progress.value = null;
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
// Local time as "2026-10-07 14:05" in every language
const pad = (n: number) => String(n).padStart(2, "0");
function when(at: string): string {
  if (!at) return "";
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const label = (c: CatalogEntry) => labels.value.get(c.uuid) ?? c.name;
// The debug window lists every unlock
watchEffect(() => {
  unlockRows.value = allRows.value.map((r) => ({ name: r.name, at: r.at, backup: r.backup, state: r.state, labels: r.matches.map(label) }));
});
// Why registering is locked (on the disabled controls)
const lockTip = computed(() => (connected.value ? null : t("conn.off")));

// The status column is as wide as its widest content in the UI language (state texts, the
// Register button, the candidate select's placeholder plus its padding and arrow next to its
// button), measured once the font is loaded
const SELECT_EXTRA = 44;
const BUTTON_EXTRA = 42; // small button: padding, border, icon, gap
const ICON_BUTTON = 24 + 6; // icon button and gap
const statusWidth = ref(150);
async function measureStatus() {
  await document.fonts.ready;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return;
  const family = getComputedStyle(document.body).fontFamily;
  ctx.font = `13px ${family}`;
  const texts = (["loading", "owned", "default", "unknown"] as const).map((s) => ctx.measureText(t(stateKey(s))).width);
  const pick = ctx.measureText(t("unlocks.pick")).width + SELECT_EXTRA + ICON_BUTTON;
  ctx.font = `600 12px ${family}`;
  const button = ctx.measureText(t("unlocks.add")).width + BUTTON_EXTRA;
  ctx.font = `600 11px ${family}`;
  // Its title and the display toggle's and column chooser's buttons after it
  const head = ctx.measureText(t("col.state").toUpperCase()).width * 1.1 + 2 * COLUMNS_BUTTON;
  statusWidth.value = Math.ceil(Math.max(...texts, pick, button, head));
}
const COLUMNS_BUTTON = 16 + 4;

// The table's columns (widths and the hidden ones kept; no sorting: the newest first), like the web app's
// tables: the blueprint takes the room left, the unlock time resizes, the status (the actions, with the
// column chooser in its head) is as wide as its widest content. The display "thumbs" puts the thumbnail
// column first (`view` mirrors the table's, which owns it)
const view = ref<TableView>("compact");
const columns = computed<ColumnSpec[]>(() => [
  ...(view.value === "thumbs" ? [{ key: "thumb", label: "", width: 48, fixed: true, sortable: false }] : []),
  { key: "kind", label: "", title: t("col.kind"), width: 16, fixed: true, sortable: false, hideable: true },
  { key: "name", label: t("col.blueprint"), width: 120, sortable: false, fill: true },
  { key: "at", label: t("col.at"), width: 170, sortable: false, hideable: true },
  { key: "state", label: t("col.state"), width: statusWidth.value, fixed: true, sortable: false },
]);
// The compact rows' column gap (.table.compact in App.vue)
const table = useTableColumns("qm.companion.unlocks.columns", columns, { key: "at", dir: "desc" }, 8);
watch(table.view, (v) => (view.value = v), { immediate: true });
const shown = computed(() => new Set(table.columns.value.map((c) => c.key)));
const cols = computed(() => ({ "--cols": table.template.value, "--cols-min": `${table.minWidth.value}px` }));

let unlisten: UnlistenFn | undefined;
onMounted(async () => {
  unlisten = await listen<{ done: number; total: number }>("scan-progress", (e) => (progress.value = e.payload));
  void measureStatus();
});
onUnmounted(() => {
  unlisten?.();
});
// The registered blueprints: once connected (again)
watch(connected, (c) => {
  if (c) loadOwned().catch(toastError);
}, { immediate: true });
</script>

<template>
  <section class="panel unlocks">
    <div class="head">
      <span class="head-title no-grow">{{ t("unlocks.title") }} <span class="head-count">{{ openRows.length }}</span></span>
      <!-- What the scan detects: off, Game.log's unlocks are not read -->
      <div class="chips filter">
        <Tooltip :text="t(unlocksOn ? 'filter.on' : 'filter.off')">
          <button type="button" class="chip" :class="{ active: unlocksOn }" :aria-pressed="unlocksOn" @click="toggleUnlocks">
            <Icon name="blueprint" :size="12" /> {{ t("unlocks.kind") }}
            <Icon :name="unlocksOn ? 'check' : 'close'" :size="12" />
          </button>
        </Tooltip>
      </div>
      <!-- The old logs' scan in the room between the chip and the buttons (nothing moves) -->
      <div v-if="scanning" class="scan">
        <span>{{ t("unlocks.scanning", { done: progress?.done ?? 0, total: progress?.total ?? "…" }) }}</span>
        <div class="bar"><div class="fill" :style="{ width: `${progressPct}%` }" /></div>
      </div>
      <span v-else class="spacer" />
      <button type="button" class="btn small outline" :disabled="scanning || !unlocksOn" @click="scan">
        <Icon name="history" :size="14" /> {{ t("unlocks.scan") }}
      </button>
      <Tooltip :text="lockTip">
        <button type="button" class="btn small primary" :disabled="!connected || !selected.length || busy" @click="confirming = true">
          <Icon name="check" :size="14" /> {{ t("unlocks.addAll") }}
        </button>
      </Tooltip>
    </div>
    <div v-if="!rows.length" class="empty-line">{{ t("unlocks.empty") }}</div>
    <!-- The web app's table, compact (App.vue): the columns always fit its width (measured on it) -->
    <div v-else class="table compact" :class="{ thumbs: view === 'thumbs' }" :ref="table.observe" :style="cols">
      <ColumnHead :columns="table.columns.value" :sort="table.sort.value" @resize="table.startResize" @reset="table.resetWidth">
        <template #col-state>
          <span class="spacer" /><ViewToggle :table="table" :texts="viewTexts()" /><ColumnsButton :table="table" :texts="columnsTexts()" />
        </template>
      </ColumnHead>
      <div v-for="row in rows" :key="row.name" class="row item" :class="{ done: row.state !== 'new' && row.state !== 'pick' }">
        <Thumb v-if="view === 'thumbs'" :item="thumbOf(row)" size="m" :px="48" />
        <span v-if="shown.has('kind')" class="tag kind"><Icon name="blueprint" :size="11" /></span>
        <span class="name" :title="row.candidates.length === 1 ? label(row.candidates[0]!) : row.name"><Thumb v-if="view === 'compact'" :item="thumbOf(row)" size="s" :px="18" class="lead" />{{ row.name }}</span>
        <span v-if="shown.has('at')" class="faint">{{ when(row.at) }}</span>
        <span class="state-cell">
          <Tooltip v-if="row.state === 'new'" :text="lockTip">
            <button type="button" class="btn small outline" :disabled="!connected || busy || pending.has(row.name)" @click="registerOne(row)">
              <Icon name="check" :size="14" /> {{ t("unlocks.add") }}
            </button>
          </Tooltip>
          <span v-else-if="row.state === 'pick'" class="pick-line">
            <Tooltip :text="lockTip">
              <select v-model="picked[row.name]" class="input pick" :disabled="!connected">
                <option :value="undefined">{{ t("unlocks.pick") }}</option>
                <option v-for="c in row.candidates" :key="c.uuid" :value="c.uuid">{{ label(c) }}</option>
              </select>
            </Tooltip>
            <Tooltip :text="lockTip ?? t('unlocks.add')">
              <button
                type="button"
                class="icon-btn"
                :disabled="!connected || busy || !picked[row.name] || pending.has(row.name)"
                @click="registerOne(row)"
              >
                <Icon name="check" :size="14" />
              </button>
            </Tooltip>
          </span>
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

/* The filter in the head after the count, like the inventory's: one chip, on = solid with a check, off =
   dashed and dimmed with an x */
.filter {
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.filter .chip {
  height: 22px;
  gap: 4px;
  padding: 0 8px;
  font-size: 11px;
  border-style: dashed;
  color: var(--text-3);
}

.filter .chip.active {
  border-style: solid;
  border-color: color-mix(in srgb, var(--text-2) 45%, transparent);
  background: color-mix(in srgb, var(--text-2) 14%, transparent);
  color: var(--text-2);
}

/* The row's icon-only badge, hardly wider than its icon */
.tag.kind {
  height: 16px;
  padding: 0 1px;
}


/* The full scan's progress in place of the title (no layout change in the head) */
.scan {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-2);
}

.bar {
  height: 4px;
  border-radius: 2px;
  background: var(--bg-surface-2);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
  transition: width 0.15s ease-out;
}

/* Compact rows (App.vue .table.compact): controls 24 px high */
.row.item {
  min-height: 24px;
}

.row.item .btn.small,
.row.item .icon-btn {
  height: 24px;
}

.row.item .icon-btn {
  width: 24px;
}

.row.item > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Only what can still be registered stands out */
.row:not(.done) .name {
  font-weight: 600;
}

.row.done {
  color: var(--text-3);
}

/* An ambiguous row: the variant select takes the room left of its Register button */
.pick-line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pick-line > :deep(.tip-anchor:first-child) {
  flex: 1;
  min-width: 0;
}

.pick {
  width: 100%;
  height: 24px;
}

/* Disabled controls swallow the mouse in some webviews: let the tooltip's anchor get it */
:disabled {
  pointer-events: none;
}
</style>
