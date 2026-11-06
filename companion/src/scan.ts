// The scan (Rust: ocrwatch.rs): one for the freight manager's warehouse, the character inventory and the
// refinery terminal; the worker finds the screen itself (event "scan-screen"). The user switches it in the
// scan row; the overlay switches it on with itself and off again only when it started it. Its scope follows
// the panels' filters: a screen none of whose kinds is on is not read. Starting clears the inventory's
// earlier sightings and loads the catalog and the stored stock. While it runs, the screen capture tells
// whether the game runs (event "game-seen"). Off at every start.
import { listen } from "@tauri-apps/api/event";
import { computed, ref, watch } from "vue";
import type { IconName } from "./components/Icon.vue";
import { getGameFront, getGameSeen, getScan, setScan, type ScanScope, type ScanScreen } from "./backend";
import { t } from "./i18n";
import { kinds, loadStock, locationUuid, resetSightings } from "./inventorySync";
import { ensureCatalog, jobsOn, preparing } from "./refinerySync";
import { toastError } from "./toasts";

export const scanOn = ref(false);
// The screen the scan sees ("none" while off)
export const screen = ref<ScanScreen>("none");
// Star Citizen runs (seen by the screen capture while the scan runs)
export const gameSeen = ref(false);
// Its window is in front: only then the scan reads (else it is idle, its screen left)
export const gameFront = ref(false);

// What the filters leave the scan to read
export const scope = computed<ScanScope>(() => ({
  warehouse: kinds.value.has("mats") || kinds.value.has("items"),
  inventory: kinds.value.has("comps") || kinds.value.has("fps"),
  refinery: jobsOn.value,
}));
const scopeEmpty = computed(() => !scope.value.warehouse && !scope.value.inventory && !scope.value.refinery);

// The panel tab the reads of the screen in view go to (the overlay's mode follows it), else null
export const screenTab = computed(() => (screen.value === "refinery" ? "refinery" : screen.value === "warehouse" ? "stock" : screen.value === "inventory" ? "comps" : null));

/** Switches the scan on (a fresh start: the inventory's earlier sightings go) or off. */
export async function setScanOn(on: boolean) {
  if (on && !scanOn.value) {
    resetSightings();
    try {
      await ensureCatalog();
      await loadStock();
    } catch (e) {
      toastError(e);
    }
  }
  try {
    await setScan(on, scope.value);
    scanOn.value = await getScan();
  } catch (e) {
    toastError(e);
  }
}

/** A tag: its colour class, icon and text. */
export interface StateTag {
  cls: "" | "ok" | "warn" | "accent" | "app";
  icon: IconName;
  text: string;
}

// What the scan does, in one tag: off (neutral), getting ready (catalog, game language), without the game,
// idle while the game is not in front (neutral), without anything to read, waiting for a screen, a screen
// that needs the location, reading a screen (green)
export const scanState = computed<StateTag>(() => {
  const s = !scanOn.value
    ? ({ cls: "", icon: "eye-off", label: "scan.off" } as const)
    : preparing.value
      ? ({ cls: "", icon: "clock", label: "scan.preparing" } as const)
      : !gameSeen.value
        ? ({ cls: "warn", icon: "warning", label: "scan.noGame" } as const)
        : !gameFront.value
          ? ({ cls: "", icon: "eye-off", label: "scan.notInFront" } as const)
        : scopeEmpty.value
          ? ({ cls: "warn", icon: "warning", label: "scan.nothing" } as const)
          : screen.value === "none"
            ? ({ cls: "", icon: "eye", label: "scan.waiting" } as const)
            : screen.value !== "refinery" && !locationUuid.value
              ? ({ cls: "warn", icon: "warning", label: "scan.noLocation" } as const)
              : screen.value === "warehouse"
                ? ({ cls: "ok", icon: "item", label: "scan.warehouse" } as const)
                : screen.value === "inventory"
                  ? ({ cls: "ok", icon: "gear", label: "scan.inventory" } as const)
                  : ({ cls: "ok", icon: "drop", label: "scan.refinery" } as const);
  return { cls: s.cls, icon: s.icon, text: t(s.label) };
});

export async function watchScan() {
  scanOn.value = await getScan();
  gameSeen.value = await getGameSeen();
  gameFront.value = await getGameFront();
  await listen<boolean>("game-seen", (e) => {
    gameSeen.value = e.payload;
  });
  await listen<boolean>("game-front", (e) => {
    gameFront.value = e.payload;
  });
  await listen<ScanScreen>("scan-screen", (e) => {
    screen.value = e.payload;
  });
  await listen<boolean>("scan-changed", (e) => {
    scanOn.value = e.payload;
    if (!e.payload) screen.value = "none";
  });
  // A filter changed while it runs: the next frame reads with the new scope
  watch(scope, (s) => {
    if (scanOn.value) setScan(true, s).catch(toastError);
  });
}
