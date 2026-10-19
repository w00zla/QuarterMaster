// The scan overlay in the main window (Rust: overlay.rs; its page: OverlayApp.vue). Turning it on
// switches the scan on (scan.ts), turning it off switches it off again if the overlay started it. Its
// mode is the main window's tab, one and the same. It switches by itself with the screen the scan sees
// (warehouse or character inventory: inventory; refinery terminal: refinery) and with a blueprint unlock
// Game.log adds while the app runs that is still to register (new or ambiguous: blueprints), unless the
// settings turned that off (`autoTab`); by hand with
// a click on a tab or the mode hotkey, stepping through them. Each panel
// puts its rows into `overlayRows`; the overlay gets them as one read-only view (texts in the UI
// language) on every change and when it asks. Off at every start.
import { emit, listen } from "@tauri-apps/api/event";
import { computed, reactive, ref, watch } from "vue";
import type { IconName } from "../../adminapp/src/components/Icon.vue";
import { setOverlayWindow } from "./backend";
import { unlockRows } from "./debugReport";
import { t } from "./i18n";
import { kinds, locationUuid } from "./inventorySync";
import { jobsOn, syncCatalog } from "./refinerySync";
import { scanOn, screenTab, setScanOn } from "./scan";
import { config, log, unlocksOn } from "./state";
import { toastError } from "./toasts";

// The main window's tabs (= the overlay's modes) in the order the mode hotkey steps through them;
// the last one stays for the next start
export type Tab = "inventory" | "refinery" | "unlocks";
const TAB_ORDER: Tab[] = ["inventory", "refinery", "unlocks"];
const TAB_KEY = "qm.companion.tab";
const stored = localStorage.getItem(TAB_KEY);
export const tab = ref<Tab>(TAB_ORDER.includes(stored as Tab) ? (stored as Tab) : "inventory");

export function pickTab(id: Tab) {
  tab.value = id;
  localStorage.setItem(TAB_KEY, id);
}

export const overlayOn = ref(false);
// The automatic switches are on (settings; on by default)
const autoTab = () => config.value?.autoTab !== false;
// The overlay switched the scan on (and switches it off with itself)
let startedScan = false;

/** One read-only line: a tag (its text, or only an icon), the name with an optional detail,
 * right-aligned columns. */
export interface OverlayRow {
  tag: string;
  icon?: IconName;
  cls: string;
  name: string;
  detail: string | null;
  cols: string[];
}

/** A mode in the overlay's head: its icon and count, whether it is shown, whether it cannot work (its
 * filters all off, the log missing: a warning instead of the count). */
export interface OverlayTab {
  icon: IconName;
  count: number;
  active: boolean;
  warn: boolean;
}

/** What the overlay shows: the location (in every mode), the modes, the newest rows. */
export interface OverlayView {
  place: string;
  // No location picked: the place warns
  placeMissing: boolean;
  tabs: OverlayTab[];
  rows: OverlayRow[];
  // More rows than shown
  more: boolean;
}

// The panels' rows, newest first (each panel keeps its own up to date)
export const overlayRows = reactive<Record<Tab, OverlayRow[]>>({ inventory: [], refinery: [], unlocks: [] });
// How many rows each panel's table lists (shown in its tab)
export const tabCounts = reactive<Record<Tab, number>>({ inventory: 0, refinery: 0, unlocks: 0 });
// As many as the overlay's fixed tile shows below its location line (overlay.rs: 22 px line + 8 × 20 px)
const MAX_ROWS = 8;

const ICONS: Record<Tab, IconName> = { inventory: "item", refinery: "drop", unlocks: "blueprint" };

const view = computed<OverlayView>(() => {
  const m = tab.value;
  const cannot: Record<Tab, boolean> = { inventory: !kinds.value.size, refinery: !jobsOn.value, unlocks: !unlocksOn.value || (!!log.value && !log.value.found) };
  const tabs = TAB_ORDER.map((x) => ({ icon: ICONS[x], count: tabCounts[x], active: x === m, warn: cannot[x] }));
  // The location in every mode
  const placeMissing = !locationUuid.value;
  const place = placeMissing ? t("overlay.noLocation") : (syncCatalog.value?.locations.find((l) => l.uuid === locationUuid.value)?.short ?? "?");
  const all = overlayRows[m];
  return { place, placeMissing, tabs, rows: all.slice(0, MAX_ROWS), more: all.length > MAX_ROWS };
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
  // A new unlock still to register picks the blueprints tab: only what Game.log adds while the app runs
  // (the log's unlocks at its first state count as known, the old logs' too), once matched to the catalog
  let known: Set<string> | null = null;
  watch(log, (l) => {
    if (l && !known) known = new Set(l.unlocks.map((u) => u.name));
  }, { immediate: true });
  watch(unlockRows, (rows) => {
    if (!known) return;
    for (const r of rows) {
      if (known.has(r.name) || r.state === "loading") continue;
      known.add(r.name);
      if (!r.backup && (r.state === "new" || r.state === "pick") && autoTab()) pickTab("unlocks");
    }
  });
  // The scan stopped another way (it cannot while the overlay is on, but the overlay must not switch it off later)
  watch(scanOn, (on) => {
    if (!on) startedScan = false;
  });
  await listen("overlay-request", publish);
  await listen<"toggle" | "mode">("overlay-hotkey", (e) => {
    if (e.payload === "toggle") void setOverlay(!overlayOn.value);
    else pickTab(TAB_ORDER[(TAB_ORDER.indexOf(tab.value) + 1) % TAB_ORDER.length]!);
  });
}
