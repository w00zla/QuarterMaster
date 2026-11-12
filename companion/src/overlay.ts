// The scan overlay in the main window (Rust: overlay.rs; its page: OverlayApp.vue). Turning it on
// switches the scan on (scan.ts), turning it off switches it off again if the overlay started it. Its
// mode is the main window's tab, one and the same. It switches by itself with the screen the scan sees
// (warehouse: stock; character inventory: comps; refinery terminal: refinery; the signature scan: mining) and with a blueprint unlock
// Game.log adds while the app runs that is still to register (new or ambiguous: blueprints), unless the
// settings turned that off (`autoTab`); by hand with
// a click on a tab or the mode hotkey, stepping through them (which never switches the scan mode: only the
// Bergbau panel's chip and the scan mode hotkey do). Each panel
// puts its rows into `overlayRows`; the overlay gets them as one read-only view (texts in the UI
// language, thumbnail references) on every change and when it asks, laid out for the configured display
// (overlayLayout.ts); with each thing detected (detections.ts) its location line flashes.
// Off at every start.
import { emit, listen } from "@tauri-apps/api/event";
import { computed, reactive, ref, watch } from "vue";
import type { IconName } from "../../adminapp/src/components/Icon.vue";
import { setOverlayWindow } from "./backend";
import { unlockRows } from "./debugReport";
import { detected, detections } from "./detections";
import { t } from "./i18n";
import { kinds, locationUuid } from "./inventorySync";
import { signatureOn, toggleSignature } from "./mining";
import { overlayLayout, type OverlayDisplay } from "./overlayLayout";
import { jobsOn, syncCatalog } from "./refinerySync";
import { scanOn, screenTab, setScanOn } from "./scan";
import { config, log, unlocksOn } from "./state";
import type { ThumbRef } from "./thumbs";
import { toastError } from "./toasts";

// The main window's tabs (= the overlay's modes) in the order the mode hotkey steps through them;
// the last one stays for the next start (the former "inventory" tab: stock)
export type Tab = "comps" | "stock" | "refinery" | "mining" | "unlocks";
const TAB_ORDER: Tab[] = ["comps", "stock", "refinery", "mining", "unlocks"];
const TAB_KEY = "qm.companion.tab";
const stored = localStorage.getItem(TAB_KEY);
export const tab = ref<Tab>(TAB_ORDER.includes(stored as Tab) ? (stored as Tab) : "stock");

export function pickTab(id: Tab) {
  tab.value = id;
  localStorage.setItem(TAB_KEY, id);
}

export const overlayOn = ref(false);
// The automatic switches are on (settings; on by default)
const autoTab = () => config.value?.autoTab !== false;
// The overlay switched the scan on (and switches it off with itself)
let startedScan = false;

/** One read-only line: a tag (none when empty), the name with an optional detail,
 * right-aligned columns. */
export interface OverlayRow {
  tag: string;
  cls: string;
  name: string;
  detail: string | null;
  cols: string[];
  // Registered or in stock already: dimmed like in the panel
  dim?: boolean;
  // The item's thumbnail (the display "thumbs" shows it); none = without
  thumb?: ThumbRef | null;
  // In place of the detail: its parts, each after its icon (the signatures' resources after the mining method's)
  parts?: { text: string; icon: IconName | null }[];
}

/** A mode in the overlay's head: its icon and count, whether it is shown, whether the scan leaves it out (its
 * filters all off, the other scan mode: drawn greyed), whether it cannot work (the log missing: a warning instead of
 * the count). */
export interface OverlayTab {
  icon: IconName;
  count: number;
  active: boolean;
  off: boolean;
  warn: boolean;
}

/** What the overlay shows: the location (in every mode), the modes, the newest rows (the display "thumbs":
 * the newest as a top row of its own, the others below). */
export interface OverlayView {
  display: OverlayDisplay;
  top: OverlayRow | null;
  place: string;
  // No location picked: the place warns
  placeMissing: boolean;
  tabs: OverlayTab[];
  rows: OverlayRow[];
  // More rows than shown
  more: boolean;
  // Counts up with each detection (detections.ts); the page flashes the location when it changes
  flash: number;
  // How see-through the tile is, in percent (settings, shared with the signature overlay)
  transparency: number;
}

// The panels' rows, newest first (each panel keeps its own up to date)
export const overlayRows = reactive<Record<Tab, OverlayRow[]>>({ stock: [], comps: [], unlocks: [], refinery: [], mining: [] });
// How many rows each panel's table lists (shown in its tab)
export const tabCounts = reactive<Record<Tab, number>>({ stock: 0, comps: 0, unlocks: 0, refinery: 0, mining: 0 });

// Like the web app's navigation
export const TAB_ICONS: Record<Tab, IconName> = { stock: "type-crate", comps: "gear", unlocks: "blueprint", refinery: "drop", mining: "pickaxe" };

const view = computed<OverlayView>(() => {
  const m = tab.value;
  // Left out: the filters all off; the terminals while the signature scan runs, the signatures while it does not
  const signature = signatureOn.value;
  const off: Record<Tab, boolean> = {
    stock: signature || (!kinds.value.has("mats") && !kinds.value.has("items")),
    comps: signature || (!kinds.value.has("comps") && !kinds.value.has("fps")),
    unlocks: !unlocksOn.value,
    refinery: signature || !jobsOn.value,
    mining: !signature,
  };
  const logMissing = !!log.value && !log.value.found;
  const tabs = TAB_ORDER.map((x) => ({ icon: TAB_ICONS[x], count: tabCounts[x], active: x === m, off: off[x], warn: x === "unlocks" && unlocksOn.value && logMissing }));
  // The location in every mode
  const placeMissing = !locationUuid.value;
  const place = placeMissing ? t("overlay.noLocation") : (syncCatalog.value?.locations.find((l) => l.uuid === locationUuid.value)?.short ?? "?");
  // As many as the overlay's fixed tile shows below its location line
  const display: OverlayDisplay = config.value?.overlayDisplay === "compact" ? "compact" : "thumbs";
  // The refinery and the signatures have no single newest item with a thumbnail: rows only
  const layout = overlayLayout(display, m === "refinery" || m === "mining");
  const all = overlayRows[m];
  const top = layout.top ? (all[0] ?? null) : null;
  const rest = layout.top ? all.slice(1) : all;
  return {
    display, top, place, placeMissing, tabs, rows: rest.slice(0, layout.rows), more: rest.length > layout.rows, flash: detections.value,
    transparency: config.value?.overlayTransparency ?? 18,
  };
});

const publish = () => {
  if (overlayOn.value) void emit("overlay-view", view.value).catch(() => undefined);
};

/** Switches the overlay on (with the scan, if it is off) or off (the scan with it, if the overlay
 * started it; also when its window cannot be closed). */
export async function setOverlay(on: boolean) {
  if (!on) {
    overlayOn.value = false;
    if (startedScan) await setScanOn(false);
    startedScan = false;
  }
  try {
    await setOverlayWindow(on);
    if (!on) return;
    overlayOn.value = true;
    if (screenTab.value && autoTab()) pickTab(screenTab.value);
    // The page may have asked before this was on
    publish();
    if (!scanOn.value) {
      startedScan = true;
      await setScanOn(true);
    }
  } catch (e) {
    toastError(e);
  }
}

export async function watchOverlay() {
  watch(view, publish);
  // The tab follows the screen the scan sees (nothing in view: it stays)
  watch(screenTab, (s) => {
    if (s && autoTab()) pickTab(s);
  });
  // A new unlock still to register picks the blueprints tab and flashes: only what Game.log adds while
  // the app runs (the log's unlocks at its first state count as known, the old logs' too), once matched
  // to the catalog
  let known: Set<string> | null = null;
  watch(log, (l) => {
    if (l && !known) known = new Set(l.unlocks.map((u) => u.name));
  }, { immediate: true });
  watch(unlockRows, (rows) => {
    if (!known) return;
    for (const r of rows) {
      if (known.has(r.name) || r.state === "loading") continue;
      known.add(r.name);
      if (r.backup || (r.state !== "new" && r.state !== "pick")) continue;
      detected();
      if (autoTab()) pickTab("unlocks");
    }
  });
  // The scan stopped another way (it cannot while the overlay is on, but the overlay must not switch it off later)
  watch(scanOn, (on) => {
    if (!on) startedScan = false;
  });
  await listen("overlay-request", publish);
  await listen<"toggle" | "mode" | "scanMode">("overlay-hotkey", (e) => {
    if (e.payload === "toggle") void setOverlay(!overlayOn.value);
    else if (e.payload === "scanMode") toggleSignature();
    else pickTab(TAB_ORDER[(TAB_ORDER.indexOf(tab.value) + 1) % TAB_ORDER.length]!);
  });
}
