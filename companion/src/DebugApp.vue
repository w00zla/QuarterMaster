<script setup lang="ts">
// The inventory scan's debug window (opened from the settings; remote troubleshooting): the last
// read with the frame and its overlays (OCR boxes yellow; the warehouse: tiles green, the hovered one
// white, the read cells blue, the tooltip magenta; the character inventory: the tooltip and its lines
// magenta, the cursor's cell white), the read's facts, every tile and cell or every tooltip line,
// every OCR box, the sightings of both scans, and an export of the last reads (frames as PNG, reads
// as JSON, an info file) into a folder the user picks.
// Frames travel with the reads only while this window is open (the Rust side's debug flag, set here
// and dropped by the Rust side when the window is destroyed); the export holds what was read while
// it was. Open at any time; without a running scan it waits.
import { computed, onMounted, ref, shallowRef } from "vue";
import { emit, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Icon from "../../adminapp/src/components/Icon.vue";
import { getConfig, getScan, setDebug, startDebugRecording, stopDebugRecording, type ScanMode } from "./backend";
import { applyLangSetting, t } from "./i18n";
import type { ComponentSighting } from "./components";
import type { InventoryReadEvent, ReadRect, Sighting } from "./inventory";
import type { Kind, SightingsReport } from "./inventorySync";
import { errorText, toast, toastError } from "./toasts";
import Toasts from "./components/Toasts.vue";

const read = shallowRef<InventoryReadEvent | null>(null);
const scanMode = ref<ScanMode>("off");
// The recording's folder while one runs
const recording = ref<string | null>(null);
const busy = ref(false);
// The main window's sightings of both scans (sent on every change and on request)
const report = ref<SightingsReport>({ materials: [], components: [], registered: [], dismissed: [] });
const tab = ref<"read" | "sightings">("read");
// The sightings table's kind filter (this window's own)
const KINDS: Kind[] = ["mats", "items", "comps"];
const kinds = ref(new Set<Kind>(KINDS));
function toggleKind(kind: Kind) {
  const next = new Set(kinds.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  if (next.size) kinds.value = next;
}

const applyLanguage = async () => applyLangSetting((await getConfig()).language);

onMounted(async () => {
  try {
    await applyLanguage();
    await listen("config-changed", () => void applyLanguage().catch(() => undefined));
    await setDebug(true);
    scanMode.value = await getScan();
    await listen<InventoryReadEvent>("inventory-read", (e) => (read.value = e.payload));
    await listen<ScanMode>("scan-changed", (e) => (scanMode.value = e.payload));
    await listen<SightingsReport>("inventory-sightings", (e) => (report.value = e.payload));
    await emit("inventory-sightings-request");
  } catch (e) {
    toast(errorText(e), "error");
  }
});

const grid = computed(() => read.value?.grid ?? null);
const comp = computed(() => read.value?.components ?? null);
const hovered = computed(() => grid.value?.tiles.find((x) => x.hovered) ?? null);
// The overlay draws in frame pixels; the SVG scales with the image
const viewBox = computed(() => (read.value ? `0 0 ${read.value.width} ${read.value.height}` : "0 0 1 1"));
const stroke = computed(() => (read.value ? Math.max(2, Math.round(read.value.height / 400)) : 2));
const rectAttrs = (r: ReadRect) => ({ x: r.x0, y: r.y0, width: Math.max(1, r.x1 - r.x0), height: Math.max(1, r.y1 - r.y0) });
const time = (ms: number) => new Date(ms).toLocaleTimeString();
const PROBLEM = { unknownMaterial: "inventory.unknown", component: "inventory.component", noQuality: "inventory.noQuality", noAmount: "inventory.noAmount" } as const;
const COMPONENT_PROBLEM = { unknownComponent: "components.unknown", ambiguousComponent: "components.ambiguous", statsUnreadable: "components.statsUnreadable" } as const;
const amount = (s: Sighting) => (s.amount === null ? "–" : s.unit === "SCU" ? `${s.amount} SCU` : t("inventory.pieces", { n: s.amount })) + (s.amountUncertain ? "?" : "");
// A component sighting's stats as read ({property UUID: gain}: the UUIDs' first part, the window has no catalog)
const componentStats = (s: ComponentSighting) => s.readStats.map((k) => `${k.slice(0, 8)} ${s.stats?.[k] ?? "±0"}`).join(" · ") || t("components.noStats");

// One table for both scans: source (the freight manager's warehouse or the character inventory), kind,
// what was read, where, and why it is no proposal (or that it is one, was registered or discarded)
interface Row {
  key: string;
  source: "FE" | "INV";
  kind: Kind;
  name: string;
  quality: string;
  amount: string;
  cell: string;
  state: string;
  problem: boolean;
  atMs: number;
}
const stateOf = (key: string, problem: string | null): { state: string; problem: boolean } => {
  if (problem) return { state: problem, problem: true };
  if (report.value.registered.includes(key)) return { state: t("debug.state.registered"), problem: false };
  if (report.value.dismissed.includes(key)) return { state: t("debug.state.dismissed"), problem: false };
  return { state: t("debug.state.open"), problem: false };
};
// A tile's units, 1-based: "2" or "2–3" (a wide tile)
const units = (col: number, span: number) => (span > 1 ? `${col + 1}–${col + span}` : `${col + 1}`);
const rows = computed<Row[]>(() => {
  const materials = report.value.materials.map((s): Row => ({
    key: s.key, source: "FE", kind: s.unit === "SCU" ? "mats" : "items", name: s.name, quality: String(s.quality ?? "–"), amount: amount(s),
    cell: `r${s.row + 1} c${s.col + 1}`, ...stateOf(s.key, s.problem ? t(PROBLEM[s.problem]) : null), atMs: s.atMs,
  }));
  const components = report.value.components.map((s): Row => ({
    key: s.key, source: "INV", kind: "comps", name: s.label, quality: "–", amount: s.problem ? "–" : componentStats(s),
    cell: `${s.page ?? "?"}/ r${s.row + 1} c${units(s.col, s.span)}`,
    ...stateOf(s.key, s.problem ? `${t(COMPONENT_PROBLEM[s.problem])}${s.unreadable.length ? `: ${s.unreadable.join(", ")}` : ""}` : null), atMs: s.atMs,
  }));
  return [...materials, ...components].filter((r) => kinds.value.has(r.kind)).sort((a, b) => b.atMs - a.atMs);
});
const total = computed(() => report.value.materials.length + report.value.components.length);

/** Starts a recording into a folder the user picks (every read as PNG + JSON until stopped), or stops it. */
async function toggleRecording() {
  busy.value = true;
  try {
    if (recording.value) {
      await stopDebugRecording();
      toast(t("debug.recordingStopped", { path: recording.value }));
      recording.value = null;
      return;
    }
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    recording.value = await startDebugRecording(dir);
    toast(t("debug.recordingTo", { path: recording.value }));
  } catch (e) {
    toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="debug">
    <div class="bar">
      <Icon name="log" :size="16" />
      <span class="title">{{ t("debug.title") }}</span>
      <span class="tag" :class="scanMode === 'inventory' ? 'ok' : ''">{{ t(scanMode === "inventory" ? "scan.inventory" : scanMode === "refinery" ? "scan.refinery" : "scan.off") }}</span>
      <div class="spacer" />
      <button type="button" class="btn small" :class="recording ? 'primary' : 'outline'" :disabled="busy" :title="recording ?? undefined" @click="toggleRecording">
        <Icon :name="recording ? 'close' : 'file'" :size="14" /> {{ t(recording ? "debug.recording" : "debug.record") }}
      </button>
    </div>
    <nav class="tabs">
      <button type="button" class="tab" :class="{ active: tab === 'read' }" @click="tab = 'read'">{{ t("debug.tab.read") }}</button>
      <button type="button" class="tab" :class="{ active: tab === 'sightings' }" @click="tab = 'sightings'">{{ t("inventory.sightings", { n: total }) }}</button>
    </nav>
    <main v-if="tab === 'sightings'" class="content">
      <div class="chips filter">
        <span class="filter-label">{{ t("debug.show") }}</span>
        <button v-for="k in KINDS" :key="k" type="button" class="chip" :class="{ active: kinds.has(k) }" @click="toggleKind(k)">{{ t(`inventory.kind.${k}`) }}</button>
      </div>
      <div v-if="!total" class="empty-line">{{ t("debug.noSightings") }}</div>
      <template v-else>
        <div class="srow table-head">
          <span>{{ t("col.source") }}</span>
          <span>{{ t("col.material") }}</span>
          <span class="num">{{ t("col.quality") }}</span>
          <span>{{ t("col.amount") }}</span>
          <span>{{ t("col.cell") }}</span>
          <span>{{ t("col.state") }}</span>
        </div>
        <div v-for="r in rows" :key="r.key" class="srow" :class="{ problem: r.problem }">
          <span class="tag" :class="r.source === 'FE' ? 'ok' : 'accent'">{{ r.source }}</span>
          <span class="text">{{ r.name }}</span>
          <span class="num">{{ r.quality }}</span>
          <span class="text">{{ r.amount }}</span>
          <span class="num">{{ r.cell }}</span>
          <span class="text">{{ r.state }}</span>
        </div>
      </template>
    </main>
    <main v-else class="content">
      <div v-if="!read" class="empty-line">{{ t(scanMode === "inventory" ? "debug.waiting" : "debug.noScan") }}</div>
      <template v-else>
        <div class="facts">
          <span>{{ time(read.atMs) }}</span>
          <span v-if="grid">{{ t("debug.grid", { cols: grid.cols.length, rows: grid.rows.length, px: Math.round(grid.pitchX), py: Math.round(grid.pitchY) }) }} · {{ t("debug.tiles", { n: grid.tiles.length }) }}</span>
          <span v-else-if="comp && (comp.page || comp.tooltip)">{{ comp.page ? t("debug.page", { i: comp.page.index, n: comp.page.total }) : t("debug.noPage") }}</span>
          <span v-else class="tag warn">{{ t("debug.noTerminal") }}</span>
          <span class="num">{{ t("debug.boxes", { n: read.boxes.length }) }}</span>
          <!-- The read's duration and the frame's size at the right edge -->
          <span class="num right">{{ read.ms }} ms</span>
          <span class="num">{{ read.width }}×{{ read.height }}</span>
        </div>
        <div v-if="grid?.tooltip" class="facts">
          <span class="tag">{{ t("debug.tooltip") }}</span>
          <span>{{ grid.tooltip.name }} · {{ grid.tooltip.quality ?? "–" }} · {{ grid.tooltip.scu ?? "–" }} SCU</span>
          <span v-if="hovered" class="tag ok">{{ t("debug.hovered", { row: hovered.row + 1, col: hovered.col + 1 }) }}</span>
          <span v-else class="tag warn">{{ t("debug.noHover") }}</span>
        </div>
        <div v-if="!grid && comp" class="facts">
          <span class="tag">{{ t("debug.tooltip") }}</span>
          <span>{{ comp.tooltip ? `${comp.tooltip.title} · ${t("debug.lines", { n: comp.tooltip.lines.length })}` : t("debug.noTooltip") }}</span>
          <span v-if="comp.cell" class="tag ok">{{ t("debug.cell", { row: comp.cell.row + 1, col: units(comp.cell.col, comp.cell.span) }) }}</span>
          <span v-else class="tag warn">{{ t("debug.noCell") }}</span>
        </div>
        <div v-if="read.frame" class="frame">
          <img :src="read.frame" alt="" />
          <svg :viewBox="viewBox" preserveAspectRatio="none">
            <rect v-for="(b, i) in read.boxes" :key="`b${i}`" v-bind="rectAttrs(b.rect)" fill="none" stroke="#ffdc00" :stroke-width="stroke" />
            <template v-if="grid">
              <rect v-for="(c, i) in grid.cells" :key="`c${i}`" v-bind="rectAttrs(c.rect)" fill="none" stroke="#00c8ff" :stroke-width="stroke" />
              <rect v-for="(x, i) in grid.tiles" :key="`t${i}`" v-bind="rectAttrs(x.rect)" fill="none" :stroke="x.hovered ? '#ffffff' : '#00ff50'" :stroke-width="stroke * 1.5" />
              <rect v-if="grid.tooltip" v-bind="rectAttrs(grid.tooltip.rect)" fill="none" stroke="#ff50ff" :stroke-width="stroke * 1.5" />
            </template>
            <template v-if="comp">
              <rect v-if="comp.cell" v-bind="rectAttrs(comp.cell.rect)" fill="none" stroke="#ffffff" :stroke-width="stroke * 1.5" />
              <template v-if="comp.tooltip">
                <rect v-for="(l, i) in comp.tooltip.lines" :key="`l${i}`" v-bind="rectAttrs(l.rect)" fill="none" stroke="#ff50ff" :stroke-width="stroke" />
                <rect v-bind="rectAttrs(comp.tooltip.rect)" fill="none" stroke="#ff50ff" :stroke-width="stroke * 1.5" />
              </template>
            </template>
          </svg>
        </div>
        <div v-else class="empty-line">{{ t("debug.noFrame") }}</div>
        <details v-if="comp?.tooltip" class="more">
          <summary>{{ t("debug.lines", { n: comp.tooltip.lines.length }) }}</summary>
          <div class="row">
            <span class="num">{{ Math.round(comp.tooltip.rect.x0) }}, {{ Math.round(comp.tooltip.rect.y0) }}</span>
            <span class="text">{{ comp.tooltip.title }}</span>
            <span class="text dim">title</span>
          </div>
          <div v-for="(l, i) in comp.tooltip.lines" :key="i" class="row">
            <span class="num">{{ Math.round(l.rect.x0) }}, {{ Math.round(l.rect.y0) }}</span>
            <span class="text">{{ l.text }}</span>
            <span />
          </div>
        </details>
        <template v-if="grid?.tiles.length">
          <div class="sub-head">{{ t("debug.tiles", { n: grid.tiles.length }) }}</div>
          <div v-for="x in grid.tiles" :key="`${x.row}:${x.col}`" class="row" :class="{ hovered: x.hovered }">
            <span class="num">r{{ x.row + 1 }} c{{ x.col + 1 }}</span>
            <span class="text">Q {{ x.quality ?? "–" }}{{ x.qualityAmbiguous ? "?" : "" }} · x{{ x.count ?? "–" }}{{ x.countUncertain ? "?" : "" }}</span>
            <span class="text dim">"{{ x.qualityText }}" · "{{ x.badgeText }}"</span>
          </div>
        </template>
        <details v-if="grid?.cells.length" class="more">
          <summary>{{ t("debug.cells", { n: grid.cells.length }) }}</summary>
          <div v-for="(c, i) in grid.cells" :key="i" class="row">
            <span class="num">r{{ c.row + 1 }} c{{ c.col + 1 }} {{ c.kind }}</span>
            <span class="text">{{ c.text || "—" }}</span>
            <span class="num">{{ c.score.toFixed(2) }}</span>
          </div>
        </details>
        <details class="more">
          <summary>{{ t("debug.boxes", { n: read.boxes.length }) }}</summary>
          <div v-for="(b, i) in read.boxes" :key="i" class="row">
            <span class="num">{{ Math.round(b.rect.x0) }}, {{ Math.round(b.rect.y0) }}</span>
            <span class="text">{{ b.text }}</span>
            <span class="num">{{ b.score.toFixed(2) }}</span>
          </div>
        </details>
      </template>
    </main>
    <Toasts />
  </div>
</template>

<style scoped>
.debug {
  display: flex;
  flex-direction: column;
  height: 100vh;
  font-size: 12px;
  color: var(--text-2);
}

.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  flex-shrink: 0;
  padding: 0 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-dim);
}

.title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}

.spacer {
  flex: 1;
}

/* The tab bar below the title bar, like the web app's */
.tabs {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  padding: 6px 16px 0;
  border-bottom: 1px solid var(--border-dim);
}

.tab {
  padding: 6px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-2);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent, currentColor);
}

/* The sightings: source, name, quality, amount or stats, page and cell, state */
.srow {
  display: grid;
  grid-template-columns: 40px minmax(0, 1.2fr) 44px minmax(0, 1fr) 84px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  line-height: 1.6;
}

.srow .tag {
  justify-self: start;
}

.srow.problem .text:last-child {
  color: var(--warn, #d9a441);
}

.filter {
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.filter-label {
  color: var(--text-2);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.filter .chip {
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
}

.table-head {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.frame {
  position: relative;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-panel);
  overflow: hidden;
}

.frame img {
  display: block;
  width: 100%;
  height: auto;
}

.frame svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.sub-head,
.more summary {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.more summary {
  cursor: pointer;
}

.row {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
  line-height: 1.35;
}

.row.hovered {
  color: var(--text);
}

.text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dim {
  opacity: 0.7;
}

.num {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.facts .right {
  margin-left: auto;
}
</style>
