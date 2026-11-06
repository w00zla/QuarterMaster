<script setup lang="ts">
// The debug window's OCR scan tab. "Last read": the frame with its overlays (OCR boxes yellow; the
// warehouse: tiles green, the hovered one white, the read cells blue, the tooltip magenta; the character
// inventory: the tooltip and its lines magenta, the cursor's tile white; its height can be dragged) and a
// legend, the read's key figures, then per screen the grid and tooltip, every tile, every tooltip line or
// every work order, and the read cells and OCR boxes (each table collapsible, the last two collapsed). "Detections": the main window's sightings of both scans in one
// table. "Record data" writes every read into a folder the user picks.
// Frames travel with the reads only while the debug window is open (the Rust side's debug flag, set here
// and dropped by the Rust side when the window is destroyed); a recording holds what was read while it
// was. Without a running scan it waits.
import { computed, onMounted, reactive, ref, shallowRef } from "vue";
import { emit, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Icon from "../shared/ui/adminapp/components/Icon.vue";
import { getScan, setDebug, startDebugRecording, stopDebugRecording, type ScanScreen } from "../backend";
import { t } from "../i18n";
import { norm } from "../shared/lib/stock/material-names.ts";
import { parseField, type ComponentSighting } from "../components";
import type { InventoryReadEvent, ReadRect, Sighting } from "../inventory";
import type { Kind, SightingsReport } from "../inventorySync";
import { errorText, toast, toastError } from "../toasts";

const read = shallowRef<InventoryReadEvent | null>(null);
const scanOn = ref(false);
// The screen the scan sees (known from its next change on)
const screen = ref<ScanScreen>("none");
const SCREEN_TEXT = { none: "scan.waiting", warehouse: "scan.warehouse", inventory: "scan.inventory", refinery: "scan.refinery" } as const;
// The recording's folder while one runs
const recording = ref<string | null>(null);
const busy = ref(false);
// The main window's sightings of both scans (sent on every change and on request)
const report = ref<SightingsReport>({ materials: [], components: [], registered: [], dismissed: [], locations: {}, statNames: [], filtered: {} });
const view = ref<"read" | "sightings">("read");
// The detections table's kind filter (this window's own)
const KINDS: Kind[] = ["mats", "items", "comps", "fps"];
const kinds = ref(new Set<Kind>(KINDS));
function toggleKind(kind: Kind) {
  const next = new Set(kinds.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  if (next.size) kinds.value = next;
}

onMounted(async () => {
  try {
    await setDebug(true);
    scanOn.value = await getScan();
    await listen<InventoryReadEvent>("inventory-debug", (e) => (read.value = e.payload));
    await listen<boolean>("scan-changed", (e) => {
      scanOn.value = e.payload;
      if (!e.payload) screen.value = "none";
    });
    await listen<ScanScreen>("scan-screen", (e) => (screen.value = e.payload));
    await listen<SightingsReport>("inventory-sightings", (e) => (report.value = e.payload));
    await emit("inventory-sightings-request");
  } catch (e) {
    toast(errorText(e), "error");
  }
});

const grid = computed(() => read.value?.grid ?? null);
const comp = computed(() => (read.value?.components && (read.value.components.page || read.value.components.tooltip) ? read.value.components : null));
const refinery = computed(() => (read.value?.refinery?.kind === "overview" || read.value?.refinery?.kind === "terminal" ? read.value.refinery : null));
// What the read saw
const readScreen = computed<ScanScreen>(() => (grid.value ? "warehouse" : comp.value ? "inventory" : refinery.value ? "refinery" : "none"));
const hovered = computed(() => grid.value?.tiles.find((x) => x.hovered) ?? null);

// The overlay draws in frame pixels; the SVG scales with the image
const viewBox = computed(() => (read.value ? `0 0 ${read.value.width} ${read.value.height}` : "0 0 1 1"));
const stroke = computed(() => (read.value ? Math.max(2, Math.round(read.value.height / 400)) : 2));
const rectAttrs = (r: ReadRect) => ({ x: r.x0, y: r.y0, width: Math.max(1, r.x1 - r.x0), height: Math.max(1, r.y1 - r.y0) });
const COLOR = { box: "#ffdc00", cell: "#00c8ff", tile: "#00ff50", hovered: "#ffffff", tooltip: "#ff50ff" } as const;
// The legend: the overlays this screen draws
const legend = computed(() => {
  const box = { color: COLOR.box, text: t("debug.boxes") };
  if (readScreen.value === "warehouse") {
    return [box, { color: COLOR.cell, text: t("debug.cells") }, { color: COLOR.tile, text: t("debug.tiles") }, { color: COLOR.hovered, text: t("debug.hovered") }, { color: COLOR.tooltip, text: t("debug.tooltip") }];
  }
  if (readScreen.value === "inventory") return [box, { color: COLOR.hovered, text: t("debug.cursorTile") }, { color: COLOR.tooltip, text: t("debug.lines") }];
  return [box];
});

const time = (ms: number) => new Date(ms).toLocaleTimeString();
// On the GPU or why not: off in the settings, DirectML.dll missing, failed (with the error)
const gpuWhy = (o: InventoryReadEvent["ocr"]) => {
  if (o.gpu) return t("debug.gpu.on");
  if (!o.setting) return t("debug.gpu.off");
  return o.status.state === "failed" ? t("debug.gpu.failed", { error: o.status.error }) : t(`debug.gpu.${o.status.state}`);
};
const pos = (r: ReadRect) => `${Math.round(r.x0)}, ${Math.round(r.y0)}`;
const size = (r: ReadRect) => `${Math.round(r.x1 - r.x0)}×${Math.round(r.y1 - r.y0)}`;
// A tile, 1-based: "r2 c3", a wide one "r2 c3–4"
const rc = (row: number, col: number, span = 1) => t("debug.rc", { r: row + 1, c: span > 1 ? `${col + 1}–${col + span}` : col + 1 });

// The read's key figures: time, duration, the OCR (models, their time; on the GPU or why not), how long the cursor had rested at the grab, frame, screen, then per screen, then the OCR boxes
const facts = computed(() => {
  const r = read.value;
  if (!r) return [];
  const list = [
    { k: t("debug.k.time"), v: time(r.atMs) },
    { k: t("debug.k.duration"), v: `${r.ms} ms` },
    { k: "OCR", v: `${r.ocr.models.join(" + ") || "–"} · ${r.ocr.ms} ms` },
    { k: "GPU", v: gpuWhy(r.ocr) },
    { k: t("debug.k.rest"), v: `${r.capture.restMs} ms` },
    { k: t("debug.k.frame"), v: `${r.width}×${r.height}` },
    { k: t("debug.k.screen"), v: t(`debug.screen.${readScreen.value}`) },
  ];
  if (grid.value) list.push({ k: t("debug.tiles"), v: String(grid.value.tiles.length) });
  if (comp.value) list.push({ k: t("debug.k.page"), v: comp.value.page ? `${comp.value.page.index}/${comp.value.page.total}` : "–" });
  if (refinery.value) {
    list.push({ k: t("debug.k.station"), v: refinery.value.overview?.station ?? "–" });
    list.push({ k: t("debug.k.orders"), v: String(refinery.value.overview?.orders.length ?? 0) });
  }
  list.push({ k: t("debug.boxes"), v: String(r.boxes.length) });
  return list;
});

// The tooltip lines with what the component scan makes of them: a stat (its label one of the catalog's stat
// names, as statsOf matches), another field ("Label: value"), or text (the description)
const statNames = computed(() => new Set(report.value.statNames));
const LINE_KIND = { stat: { key: "debug.line.stat", cls: "accent" }, field: { key: "debug.line.field", cls: "" }, text: { key: "debug.line.text", cls: "" } } as const;
const tooltipLines = computed(() => (comp.value?.tooltip?.lines ?? []).map((l) => {
  const field = parseField(l.text);
  const kind = !field ? "text" : statNames.value.has(norm(field.label)) ? "stat" : "field";
  return { ...l, kind: LINE_KIND[kind] };
}));

// Scores below this are marked (likely misreads)
const LOW_SCORE = 0.6;

// Which tables are open, kept across reads (a panel that comes and goes with the screen opens as left)
const opened = reactive({ tiles: true, lines: true, orders: true, cells: false, boxes: false });
const onToggle = (key: keyof typeof opened, e: Event) => (opened[key] = (e.target as HTMLDetailsElement).open);

// The detections: one table for both scans: source (the freight manager's warehouse or the character
// inventory), what was read, where, and why it is no proposal (a user filter took it, with its term, or a
// problem; or that it is one, was registered or discarded)
const PROBLEM = { unknownMaterial: "inventory.unknown", component: "inventory.component", noQuality: "inventory.noQuality", noAmount: "inventory.noAmount", amountFlicker: "inventory.amountFlicker" } as const;
const COMPONENT_PROBLEM = { unknownComponent: "components.unknown", ambiguousComponent: "components.ambiguous", statsUnreadable: "components.statsUnreadable" } as const;
const amount = (s: Sighting) => (s.amount === null ? "–" : s.unit === "SCU" ? `${s.amount} SCU` : t("inventory.pieces", { n: s.amount })) + (s.amountUncertain ? "?" : "");
// A component sighting's stats as read ({property UUID: gain}: the UUIDs' first part, the window has no catalog)
// A stack's count first ("2× "), then the stats read
const componentStats = (s: ComponentSighting) => `${s.count > 1 ? `${s.count}× ` : ""}${s.readStats.map((k) => `${k.slice(0, 8)} ${s.stats?.[k] ?? "±0"}`).join(" · ") || t("components.noStats")}`;

interface Row {
  key: string;
  source: "FE" | "INV";
  kind: Kind;
  name: string;
  quality: string;
  amount: string;
  location: string;
  cell: string;
  state: string;
  stateClass: string;
  why: string;
  atMs: number;
}
const stateOf = (key: string, problem: string | null) => {
  const filter = report.value.filtered[key];
  if (filter) return { state: t("filters.filtered"), stateClass: "", why: filter };
  if (problem) return { state: t("debug.state.problem"), stateClass: "warn", why: problem };
  if (report.value.registered.includes(key)) return { state: t("debug.state.registered"), stateClass: "ok", why: "" };
  if (report.value.dismissed.includes(key)) return { state: t("debug.state.dismissed"), stateClass: "", why: "" };
  return { state: t("debug.state.open"), stateClass: "accent", why: "" };
};
const locationName = (uuid: string) => report.value.locations[uuid] ?? "?";
const rows = computed<Row[]>(() => {
  const materials = report.value.materials.map((s): Row => ({
    key: s.key, source: "FE", kind: s.unit === "SCU" ? "mats" : "items", name: s.name, quality: String(s.quality ?? "–"), amount: amount(s),
    location: locationName(s.locationUuid), cell: rc(s.row, s.col), ...stateOf(s.key, s.problem ? t(PROBLEM[s.problem]) : null), atMs: s.atMs,
  }));
  const components = report.value.components.map((s): Row => ({
    key: s.key, source: "INV", kind: s.fps ? "fps" : "comps", name: s.label, quality: "–", amount: s.problem ? "–" : componentStats(s),
    location: locationName(s.locationUuid), cell: `${s.page ?? "?"}/ ${rc(s.row, s.col, s.span)}`,
    ...stateOf(s.key, s.problem ? `${t(COMPONENT_PROBLEM[s.problem])}${s.unreadable.length ? `: ${s.unreadable.join(", ")}` : ""}` : null), atMs: s.atMs,
  }));
  return [...materials, ...components].filter((r) => kinds.value.has(r.kind)).sort((a, b) => b.atMs - a.atMs);
});
const total = computed(() => report.value.materials.length + report.value.components.length);

/** Starts a recording into a folder the user picks (every read as JPEG + JSON until stopped), or stops it. */
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
  <section class="pane">
    <div class="sub">
      <div class="seg">
        <button type="button" :class="{ active: view === 'read' }" @click="view = 'read'">{{ t("debug.view.read") }}</button>
        <button type="button" :class="{ active: view === 'sightings' }" @click="view = 'sightings'">{{ t("debug.view.sightings") }} <span class="cnt">{{ total }}</span></button>
      </div>
      <span class="tag" :class="scanOn && screen !== 'none' ? 'ok' : ''">{{ t(scanOn ? SCREEN_TEXT[screen] : "scan.off") }}</span>
      <template v-if="view === 'sightings'">
        <button v-for="k in KINDS" :key="k" type="button" class="chip" :class="{ active: kinds.has(k) }" @click="toggleKind(k)">{{ t(`inventory.kind.${k}`) }}</button>
      </template>
      <div class="spacer" />
      <button type="button" class="btn small" :class="recording ? 'primary' : 'outline'" :disabled="busy" :title="recording ?? undefined" @click="toggleRecording">
        <Icon :name="recording ? 'close' : 'file'" :size="14" />
        <!-- Both texts in one place, the other one hidden: the button keeps its width -->
        <span class="swap">
          <span :class="{ hidden: recording }">{{ t("debug.record") }}</span>
          <span :class="{ hidden: !recording }">{{ t("debug.recording") }}</span>
        </span>
      </button>
    </div>

    <main v-if="view === 'sightings'" class="content">
      <div v-if="!total" class="empty-line">{{ t("debug.noSightings") }}</div>
      <div v-else class="panel">
        <table>
          <colgroup>
            <col style="width: 52px" />
            <col />
            <col style="width: 64px" />
            <col />
            <col style="width: 120px" />
            <col style="width: 96px" />
            <col />
            <col style="width: 72px" />
          </colgroup>
          <thead>
            <tr>
              <th>{{ t("col.source") }}</th>
              <th>{{ t("debug.col.name") }}</th>
              <th class="num">{{ t("col.quality") }}</th>
              <th>{{ t("debug.col.amountStats") }}</th>
              <th>{{ t("col.location") }}</th>
              <th>{{ t("col.cell") }}</th>
              <th>{{ t("col.state") }}</th>
              <th class="num">{{ t("debug.col.time") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.key">
              <td><span class="tag" :class="r.source === 'FE' ? 'ok' : 'accent'">{{ r.source }}</span></td>
              <td class="white">{{ r.name }}</td>
              <td class="num">{{ r.quality }}</td>
              <td class="mono">{{ r.amount }}</td>
              <td>{{ r.location }}</td>
              <td class="mono">{{ r.cell }}</td>
              <td><span class="tag" :class="r.stateClass">{{ r.state }}</span> <span class="warn-text">{{ r.why }}</span></td>
              <td class="num">{{ time(r.atMs) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>

    <main v-else class="content">
      <div v-if="!read" class="empty-line">{{ t(scanOn ? "debug.waiting" : "debug.noScan") }}</div>
      <template v-else>
        <!-- First, of the frame's aspect until its height is dragged (the image then fits in, centred):
             what changes below does not move it -->
        <div class="frame" :style="{ aspectRatio: `${read.width} / ${read.height}` }">
          <template v-if="read.frame">
            <img :src="read.frame" alt="" />
            <svg :viewBox="viewBox">
              <rect v-for="(b, i) in read.boxes" :key="`b${i}`" v-bind="rectAttrs(b.rect)" fill="none" :stroke="COLOR.box" :stroke-width="stroke" />
              <template v-if="grid">
                <rect v-for="(c, i) in grid.cells" :key="`c${i}`" v-bind="rectAttrs(c.rect)" fill="none" :stroke="COLOR.cell" :stroke-width="stroke" />
                <rect v-for="(x, i) in grid.tiles" :key="`t${i}`" v-bind="rectAttrs(x.rect)" fill="none" :stroke="x.hovered ? COLOR.hovered : COLOR.tile" :stroke-width="stroke * 1.5" />
                <rect v-if="grid.tooltip" v-bind="rectAttrs(grid.tooltip.rect)" fill="none" :stroke="COLOR.tooltip" :stroke-width="stroke * 1.5" />
              </template>
              <template v-if="comp">
                <rect v-if="comp.cell" v-bind="rectAttrs(comp.cell.rect)" fill="none" :stroke="COLOR.hovered" :stroke-width="stroke * 1.5" />
                <template v-if="comp.tooltip">
                  <rect v-for="(l, i) in comp.tooltip.lines" :key="`l${i}`" v-bind="rectAttrs(l.rect)" fill="none" :stroke="COLOR.tooltip" :stroke-width="stroke" />
                  <rect v-bind="rectAttrs(comp.tooltip.rect)" fill="none" :stroke="COLOR.tooltip" :stroke-width="stroke * 1.5" />
                </template>
              </template>
            </svg>
          </template>
          <div v-else class="empty-line">{{ t("debug.noFrame") }}</div>
        </div>
        <div class="legend">
          <span v-for="l in legend" :key="l.text"><span class="swatch" :style="{ borderColor: l.color }" />{{ l.text }}</span>
        </div>
        <div class="strip">
          <div v-for="f in facts" :key="f.k"><span class="k">{{ f.k }}</span><span class="v">{{ f.v }}</span></div>
        </div>

        <!-- The warehouse: grid and tooltip, every tile -->
        <template v-if="grid">
          <div class="two">
            <section class="panel">
              <div class="ph">{{ t("debug.grid") }}</div>
              <div class="kv">
                <span class="kk">{{ t("debug.grid") }}</span><span class="vv">{{ grid.cols.length }}×{{ grid.rows.length }}</span>
                <span class="kk">{{ t("debug.k.pitch") }}</span><span class="vv">{{ Math.round(grid.pitchX) }}×{{ Math.round(grid.pitchY) }} px</span>
                <span class="kk">{{ t("debug.tiles") }}</span><span class="vv">{{ grid.tiles.length }}</span>
                <span class="kk">{{ t("debug.cells") }}</span><span class="vv">{{ grid.cells.length }}</span>
              </div>
            </section>
            <section class="panel">
              <div class="ph">{{ t("debug.tooltip") }}</div>
              <div v-if="!grid.tooltip" class="empty-line">{{ t("debug.noTooltip") }}</div>
              <div v-else class="kv">
                <span class="kk">{{ t("debug.k.name") }}</span><span class="vv">{{ grid.tooltip.name }}</span>
                <span class="kk">{{ t("col.quality") }}</span><span class="vv">{{ grid.tooltip.quality ?? "–" }}</span>
                <span class="kk">{{ t("debug.k.scu") }}</span><span class="vv">{{ grid.tooltip.scu ?? "–" }}</span>
                <span class="kk">{{ t("debug.hovered") }}</span>
                <span><span class="tag" :class="hovered ? 'ok' : 'warn'">{{ hovered ? rc(hovered.row, hovered.col) : t("debug.none") }}</span></span>
              </div>
            </section>
          </div>
          <details v-if="grid.tiles.length" class="panel" :open="opened.tiles" @toggle="onToggle('tiles', $event)">
            <summary class="ph"><Icon name="chevron-right" :size="12" class="chev" /> {{ t("debug.tiles") }} <span class="cnt">{{ grid.tiles.length }}</span></summary>
            <table>
              <colgroup>
                <col style="width: 80px" />
                <col style="width: 90px" />
                <col style="width: 90px" />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th>{{ t("debug.tile") }}</th>
                  <th class="num">{{ t("col.quality") }}</th>
                  <th class="num">{{ t("debug.col.count") }}</th>
                  <th>{{ t("debug.col.qualityText") }}</th>
                  <th>{{ t("debug.col.badgeText") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="x in grid.tiles" :key="`${x.row}:${x.col}`" :class="{ hl: x.hovered }">
                  <td class="mono">{{ rc(x.row, x.col) }}</td>
                  <td class="num">{{ x.quality ?? "–" }}<span v-if="x.qualityAmbiguous" class="warn-text">?</span></td>
                  <td class="num">{{ x.count ?? "–" }}<span v-if="x.countUncertain" class="warn-text">?</span></td>
                  <td class="mono">"{{ x.qualityText }}"</td>
                  <td class="mono">"{{ x.badgeText }}"</td>
                </tr>
              </tbody>
            </table>
          </details>
        </template>

        <!-- The character inventory: cursor and tooltip, every tooltip line -->
        <template v-if="comp">
          <div class="two">
            <section class="panel">
              <div class="ph">{{ t("debug.cursor") }}</div>
              <div class="kv">
                <span class="kk">{{ t("debug.k.page") }}</span><span class="vv">{{ comp.page ? `${comp.page.index}/${comp.page.total}` : "–" }}</span>
                <span class="kk">{{ t("debug.tile") }}</span>
                <span><span class="tag" :class="comp.cell ? 'ok' : 'warn'">{{ comp.cell ? rc(comp.cell.row, comp.cell.col, comp.cell.span) : t("debug.none") }}</span></span>
              </div>
            </section>
            <section class="panel">
              <div class="ph">{{ t("debug.tooltip") }}</div>
              <div v-if="!comp.tooltip" class="empty-line">{{ t("debug.noTooltip") }}</div>
              <div v-else class="kv">
                <span class="kk">{{ t("debug.k.title") }}</span><span class="vv">{{ comp.tooltip.title }}</span>
                <span class="kk">{{ t("debug.lines") }}</span><span class="vv">{{ comp.tooltip.lines.length }}</span>
              </div>
            </section>
          </div>
          <details v-if="comp.tooltip" class="panel" :open="opened.lines" @toggle="onToggle('lines', $event)">
            <summary class="ph"><Icon name="chevron-right" :size="12" class="chev" /> {{ t("debug.lines") }} <span class="cnt">{{ comp.tooltip.lines.length }}</span></summary>
            <table>
              <colgroup>
                <col style="width: 110px" />
                <col />
                <col style="width: 80px" />
              </colgroup>
              <thead>
                <tr>
                  <th class="num">{{ t("debug.col.position") }}</th>
                  <th>{{ t("debug.col.text") }}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td class="num">{{ pos(comp.tooltip.rect) }}</td>
                  <td class="mono white">{{ comp.tooltip.title }}</td>
                  <td><span class="tag ok">{{ t("debug.k.title") }}</span></td>
                </tr>
                <tr v-for="(l, i) in tooltipLines" :key="i">
                  <td class="num">{{ pos(l.rect) }}</td>
                  <td class="mono white">{{ l.text }}</td>
                  <td><span class="tag" :class="l.kind.cls">{{ t(l.kind.key) }}</span></td>
                </tr>
              </tbody>
            </table>
          </details>
        </template>

        <!-- The refinery: every work order with its rows as read -->
        <div v-if="refinery?.overview?.orders.length" class="two">
          <details v-for="(o, i) in refinery.overview.orders" :key="i" class="panel" :open="opened.orders" @toggle="onToggle('orders', $event)">
            <summary class="ph">
              <Icon name="chevron-right" :size="12" class="chev" />
              {{ t("debug.order", { n: i + 1 }) }}
              <span class="tag" :class="o.status === 'completed' ? 'ok' : 'accent'">{{ t(`debug.order.${o.status}`) }}</span>
              <span class="right">{{ o.seconds !== null ? `${o.seconds} s` : "–" }}</span>
            </summary>
            <table>
              <colgroup>
                <col />
                <col style="width: 76px" />
                <col style="width: 96px" />
              </colgroup>
              <thead>
                <tr>
                  <th>{{ t("col.material") }}</th>
                  <th class="num">{{ t("col.quality") }}</th>
                  <th class="num">{{ t("debug.col.yield") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, j) in o.rows" :key="j">
                  <td class="white">{{ r.name }}</td>
                  <td class="num">{{ r.quality ?? "–" }}</td>
                  <td class="num">{{ r.yieldCscu ?? "–" }}</td>
                </tr>
              </tbody>
            </table>
          </details>
        </div>

        <details v-if="grid?.cells.length" class="panel" :open="opened.cells" @toggle="onToggle('cells', $event)">
          <summary class="ph"><Icon name="chevron-right" :size="12" class="chev" /> {{ t("debug.cells") }} <span class="cnt">{{ grid.cells.length }}</span></summary>
          <table>
            <colgroup>
              <col style="width: 80px" />
              <col style="width: 80px" />
              <col />
              <col style="width: 70px" />
            </colgroup>
            <thead>
              <tr>
                <th>{{ t("debug.tile") }}</th>
                <th>{{ t("debug.col.kind") }}</th>
                <th>{{ t("debug.col.text") }}</th>
                <th class="num">{{ t("debug.col.score") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(c, i) in grid.cells" :key="i">
                <td class="mono">{{ rc(c.row, c.col) }}</td>
                <td>{{ c.kind }}</td>
                <td class="mono white">{{ c.text || "—" }}</td>
                <td class="num" :class="{ 'warn-text': c.score < LOW_SCORE }">{{ c.score.toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
        </details>
        <details class="panel" :open="opened.boxes" @toggle="onToggle('boxes', $event)">
          <summary class="ph"><Icon name="chevron-right" :size="12" class="chev" /> {{ t("debug.boxes") }} <span class="cnt">{{ read.boxes.length }}</span></summary>
          <table>
            <colgroup>
              <col style="width: 110px" />
              <col style="width: 90px" />
              <col style="width: 70px" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th class="num">{{ t("debug.col.position") }}</th>
                <th class="num">{{ t("debug.col.size") }}</th>
                <th class="num">{{ t("debug.col.score") }}</th>
                <th>{{ t("debug.col.text") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(b, i) in read.boxes" :key="i">
                <td class="num">{{ pos(b.rect) }}</td>
                <td class="num">{{ size(b.rect) }}</td>
                <td class="num" :class="{ 'warn-text': b.score < LOW_SCORE }">{{ b.score.toFixed(2) }}</td>
                <td class="mono white">{{ b.text }}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </template>
    </main>
  </section>
</template>

<style scoped>
/* A box of the frame's aspect, kept also while no frame is there; its height can be dragged at the
   bottom right corner (the image and its overlays then fit in, centred). Its border inside the width:
   else it is 2 px wider than the content and the content scrolls sideways */
.frame {
  position: relative;
  flex-shrink: 0;
  box-sizing: border-box;
  width: 100%;
  min-height: 80px;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-panel);
  overflow: hidden;
  resize: vertical;
  background: var(--bg-base);
}

.frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.frame svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}


.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  flex-shrink: 0;
  font-size: 11px;
}

.swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 5px;
  border: 2px solid;
  vertical-align: -1px;
}
</style>
