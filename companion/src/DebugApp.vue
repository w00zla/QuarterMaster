<script setup lang="ts">
// The inventory scan's debug window (opened from the settings; remote troubleshooting): the last
// read with the frame and its overlays (OCR boxes yellow, tiles green, the hovered one white, the
// read cells blue, the tooltip magenta), the read's facts, every tile and cell, every OCR box, and an
// export of the last reads (frames as PNG, reads as JSON, an info file) into a folder the user picks.
// Frames travel with the reads only while this window is open (the Rust side's debug flag, set here
// and dropped by the Rust side when the window is destroyed); the export holds what was read while
// it was. Open at any time; without a running scan it waits.
import { computed, onMounted, ref, shallowRef } from "vue";
import { emit, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Icon from "../../adminapp/src/components/Icon.vue";
import { exportInventoryDebug, getConfig, getScan, setDebug, type ScanMode } from "./backend";
import { applyLangSetting, t } from "./i18n";
import type { InventoryReadEvent, ReadRect, Sighting } from "./inventory";
import { errorText, toast, toastError } from "./toasts";
import Toasts from "./components/Toasts.vue";

const read = shallowRef<InventoryReadEvent | null>(null);
const scanMode = ref<ScanMode>("off");
const exporting = ref(false);
// The main window's sightings (sent on every change and on request)
const sightings = ref<Sighting[]>([]);
const tab = ref<"read" | "sightings">("read");

const applyLanguage = async () => applyLangSetting((await getConfig()).language);

onMounted(async () => {
  try {
    await applyLanguage();
    await listen("config-changed", () => void applyLanguage().catch(() => undefined));
    await setDebug(true);
    scanMode.value = await getScan();
    await listen<InventoryReadEvent>("inventory-read", (e) => (read.value = e.payload));
    await listen<ScanMode>("scan-changed", (e) => (scanMode.value = e.payload));
    await listen<Sighting[]>("inventory-sightings", (e) => (sightings.value = e.payload));
    await emit("inventory-sightings-request");
  } catch (e) {
    toast(errorText(e), "error");
  }
});

const grid = computed(() => read.value?.grid ?? null);
const hovered = computed(() => grid.value?.tiles.find((x) => x.hovered) ?? null);
// The overlay draws in frame pixels; the SVG scales with the image
const viewBox = computed(() => (read.value ? `0 0 ${read.value.width} ${read.value.height}` : "0 0 1 1"));
const stroke = computed(() => (read.value ? Math.max(2, Math.round(read.value.height / 400)) : 2));
const rectAttrs = (r: ReadRect) => ({ x: r.x0, y: r.y0, width: Math.max(1, r.x1 - r.x0), height: Math.max(1, r.y1 - r.y0) });
const time = (ms: number) => new Date(ms).toLocaleTimeString();
const PROBLEM = { unknownMaterial: "inventory.unknown", component: "inventory.component", noQuality: "inventory.noQuality", noAmount: "inventory.noAmount" } as const;
const amount = (s: Sighting) => (s.amount === null ? "–" : s.unit === "SCU" ? `${s.amount} SCU` : t("inventory.pieces", { n: s.amount })) + (s.amountUncertain ? "?" : "");

async function exportReads() {
  exporting.value = true;
  try {
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    const folder = await exportInventoryDebug(dir);
    toast(t("debug.exported", { path: folder }));
  } catch (e) {
    toastError(e);
  } finally {
    exporting.value = false;
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
      <button type="button" class="btn small primary" :disabled="exporting || !read" @click="exportReads">
        <Icon name="copy" :size="14" /> {{ t("debug.export") }}
      </button>
    </div>
    <nav class="tabs">
      <button type="button" class="tab" :class="{ active: tab === 'read' }" @click="tab = 'read'">{{ t("debug.tab.read") }}</button>
      <button type="button" class="tab" :class="{ active: tab === 'sightings' }" @click="tab = 'sightings'">{{ t("inventory.sightings", { n: sightings.length }) }}</button>
    </nav>
    <main v-if="tab === 'sightings'" class="content">
      <div v-if="!sightings.length" class="empty-line">{{ t("debug.noSightings") }}</div>
      <template v-else>
        <div class="srow table-head">
          <span>{{ t("col.material") }}</span>
          <span class="num">{{ t("col.quality") }}</span>
          <span class="num">{{ t("col.amount") }}</span>
          <span>{{ t("col.cell") }}</span>
          <span>{{ t("col.state") }}</span>
        </div>
        <div v-for="s in sightings" :key="s.key" class="srow" :class="{ problem: s.problem }">
          <span class="text">{{ s.name }}</span>
          <span class="num">{{ s.quality ?? "–" }}</span>
          <span class="num">{{ amount(s) }}</span>
          <span class="num">r{{ s.row + 1 }} c{{ s.col + 1 }}</span>
          <span class="text">{{ s.problem ? t(PROBLEM[s.problem]) : s.materialUuid ? t("debug.resolved") : "" }}</span>
        </div>
      </template>
    </main>
    <main v-else class="content">
      <div v-if="!read" class="empty-line">{{ t(scanMode === "inventory" ? "debug.waiting" : "debug.noScan") }}</div>
      <template v-else>
        <div class="facts">
          <span>{{ time(read.atMs) }}</span>
          <span class="num">{{ read.ms }} ms</span>
          <span class="num">{{ read.width }}×{{ read.height }}</span>
          <span v-if="grid">{{ t("debug.grid", { cols: grid.cols.length, rows: grid.rows.length, px: Math.round(grid.pitchX), py: Math.round(grid.pitchY) }) }} · {{ t("debug.tiles", { n: grid.tiles.length }) }}</span>
          <span v-else class="tag warn">{{ t("debug.noTerminal") }}</span>
          <span class="num">{{ t("debug.boxes", { n: read.boxes.length }) }}</span>
        </div>
        <div v-if="grid?.tooltip" class="facts">
          <span class="tag">{{ t("debug.tooltip") }}</span>
          <span>{{ grid.tooltip.name }} · {{ grid.tooltip.quality ?? "–" }} · {{ grid.tooltip.scu ?? "–" }} SCU</span>
          <span v-if="hovered" class="tag ok">{{ t("debug.hovered", { row: hovered.row + 1, col: hovered.col + 1 }) }}</span>
          <span v-else class="tag warn">{{ t("debug.noHover") }}</span>
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
          </svg>
        </div>
        <div v-else class="empty-line">{{ t("debug.noFrame") }}</div>
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

.srow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 48px 96px 64px minmax(0, 1fr);
  gap: 8px;
  line-height: 1.6;
}

.srow.problem .text:first-child {
  color: var(--warn, #d9a441);
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
</style>
