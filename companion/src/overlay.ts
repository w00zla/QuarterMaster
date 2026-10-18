// The scan overlay in the main window (Rust: overlay.rs; its page: OverlayApp.vue). The overlay's
// mode is the main window's tab. While the overlay is on, it runs the scan of that tab: the
// inventory scan once a location is picked, none for the refinery (not offered yet) and the
// blueprints (Game.log); the panels' Scan buttons are locked meanwhile. Turning it off stops the
// scan. Each panel puts its rows into `overlayRows`; the overlay gets them as one read-only view
// (texts in the UI language) on every change and when it asks. The hotkeys (Rust event
// "overlay-hotkey") switch it on and off and step through the tabs. Off at every start.
import { emit, listen } from "@tauri-apps/api/event";
import { computed, reactive, ref, watch } from "vue";
import type { IconName } from "../../adminapp/src/components/Icon.vue";
import { setOverlayWindow } from "./backend";
import { t, type Key } from "./i18n";
import { KIND_CLASS, KIND_ICON, KINDS, kinds, locationUuid, startInventoryScan } from "./inventorySync";
import { preparing, syncCatalog } from "./refinerySync";
import { gameSeen, scanMode, stopScan } from "./scan";
import { log } from "./state";
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

/** A tag: a state, or one of the kinds the inventory scan detects. */
export interface OverlayState {
  cls: "" | "ok" | "warn" | "accent";
  icon: IconName;
  text: string;
}

/** What the overlay shows: the panel's title, tags (inventory: the kinds detected; else the state),
 * the newest rows (or why there are none). */
export interface OverlayView {
  // The mode
  title: string;
  // How many rows the panel lists (more than the tile shows)
  count: number;
  // The inventory's location, after the count
  place: string | null;
  tags: OverlayState[];
  rows: OverlayRow[];
  more: string | null;
  empty: string;
}

// The panels' rows, newest first (each panel keeps its own up to date)
export const overlayRows = reactive<Record<Tab, OverlayRow[]>>({ inventory: [], refinery: [], unlocks: [] });
// How many rows each panel's table lists (shown in its tab)
export const tabCounts = reactive<Record<Tab, number>>({ inventory: 0, refinery: 0, unlocks: 0 });
// As many as the overlay's fixed tile shows
const MAX_ROWS = 6;

// The scan session: off (neutral), getting ready (catalog, game language), running without the game
// (yellow), running with the game (green)
export const scanState = computed<OverlayState>(() => {
  const s = scanMode.value === "off"
    ? ({ cls: "", icon: "eye-off", label: "scan.off" } as const)
    : preparing.value
      ? ({ cls: "", icon: "clock", label: "scan.preparing" } as const)
      : gameSeen.value
        ? ({ cls: "ok", icon: "eye", label: scanMode.value === "inventory" ? "scan.inventory" : "scan.refinery" } as const)
        : ({ cls: "warn", icon: "warning", label: "scan.noGame" } as const);
  return { cls: s.cls, icon: s.icon, text: t(s.label) };
});

const TITLES: Record<Tab, Key> = { inventory: "inventory.title", refinery: "refinery.title", unlocks: "unlocks.title" };

const view = computed<OverlayView>(() => {
  const mode = tab.value;
  const all = overlayRows[mode];
  const location = syncCatalog.value?.locations.find((l) => l.uuid === locationUuid.value)?.short;
  const title = t(TITLES[mode]);
  let tags = [scanState.value];
  let empty = t("refinery.empty");
  if (mode === "inventory") {
    // That it scans goes without saying; what it detects does not (icons only, like the rows' badges)
    tags = locationUuid.value
      ? KINDS.filter((k) => kinds.value.has(k)).map((k) => ({ cls: KIND_CLASS[k], icon: KIND_ICON[k], text: "" }))
      : [{ cls: "warn", icon: "warning", text: t("overlay.noLocation") }];
    empty = t(locationUuid.value ? "overlay.hover" : "overlay.pickLocation");
  } else if (mode === "unlocks") {
    tags = [log.value?.found ? { cls: "ok", icon: "check", text: t("log.found") } : { cls: "warn", icon: "warning", text: t("log.missing") }];
    empty = t("overlay.noUnlocks");
  }
  const more = all.length > MAX_ROWS ? t("overlay.more", { n: all.length - MAX_ROWS }) : null;
  return { title, count: all.length, place: mode === "inventory" ? (location ?? null) : null, tags, rows: all.slice(0, MAX_ROWS), more, empty };
});

const publish = () => {
  if (overlayOn.value) void emit("overlay-view", view.value).catch(() => undefined);
};

/** The scan the overlay wants (inventory: once a location is picked), started or stopped; `fresh`
 * clears the inventory's earlier sightings. */
async function syncScan(fresh: boolean) {
  const want = overlayOn.value && tab.value === "inventory" && locationUuid.value ? "inventory" : "off";
  if (scanMode.value === want) return;
  if (want === "inventory") await startInventoryScan(fresh);
  else await stopScan();
}

/** Switches the overlay on (a new scan session for the tab) or off: hiding it always stops the scan,
 * also when its window cannot be closed. */
export async function setOverlay(on: boolean) {
  if (!on) {
    overlayOn.value = false;
    await stopScan();
  }
  try {
    await setOverlayWindow(on);
    if (!on) return;
    overlayOn.value = true;
    // The page may have asked before this was on
    publish();
    await syncScan(true);
  } catch (e) {
    toastError(e);
  }
}

export async function watchOverlay() {
  watch(view, publish);
  watch([tab, locationUuid], () => {
    if (overlayOn.value) void syncScan(false);
  });
  await listen("overlay-request", publish);
  await listen<"toggle" | "mode">("overlay-hotkey", (e) => {
    if (e.payload === "toggle") void setOverlay(!overlayOn.value);
    else pickTab(TAB_ORDER[(TAB_ORDER.indexOf(tab.value) + 1) % TAB_ORDER.length]!);
  });
}
