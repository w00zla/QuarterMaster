// What the main window tells the debug window about Game.log (event "gamelog-report" on every change and
// on "gamelog-report-request"): every blueprint unlock with how it matched the catalog, and the location
// keys of the log's location lines resolved to the selectable locations. The debug window reads the log
// itself (log_state); the catalog and the registered blueprints are only here. Likewise for the General
// tab ("general-report", "general-report-request"): the connection, the user and the catalog as loaded.
import { emit, listen } from "@tauri-apps/api/event";
import { ref, watch } from "vue";
import { autoLocation, locationUuid } from "./inventorySync";
import { catalogLoad, catalogResponses, syncCatalog } from "./refinerySync";
import { connected, connectionText, log, meName } from "./state";

export type UnlockState = "loading" | "owned" | "default" | "unknown" | "new" | "pick";

export interface UnlockRow {
  name: string;
  // As logged (UTC, ISO)
  at: string;
  backup: boolean;
  state: UnlockState;
  // The matched catalog blueprints' labels
  labels: string[];
}

export interface GamelogReport {
  // Whether the catalog is loaded (without it nothing is matched or resolved yet)
  catalog: boolean;
  unlocks: UnlockRow[];
  autoLocation: boolean;
  // The picked location's short name, null when none
  picked: string | null;
  // The log's location keys (lower case) -> the selectable location's short name (missing: not selectable)
  locations: Record<string, string>;
}

// Every unlock, set by the unlocks panel (its rows before it hides registered and default ones); the
// overlay's tab switch reads it too (overlay.ts)
export const unlockRows = ref<UnlockRow[]>([]);

function report(): GamelogReport {
  const all = syncCatalog.value?.locations ?? [];
  const keys = new Set((log.value?.locations ?? []).map((l) => l.key.toLowerCase()));
  return {
    catalog: !!syncCatalog.value,
    unlocks: unlockRows.value,
    autoLocation: autoLocation.value,
    picked: all.find((l) => l.uuid === locationUuid.value)?.short ?? null,
    locations: Object.fromEntries(all.filter((l) => keys.has(l.key.toLowerCase())).map((l) => [l.key.toLowerCase(), l.short])),
  };
}

const publish = () => void emit("gamelog-report", report()).catch(() => undefined);

export interface GeneralReport {
  connected: boolean;
  // "Connection successful" or why not (the UI language)
  connection: string;
  user: string | null;
  // The catalog as loaded (null: not yet): when, its entries per language, the language pack's texts found of those asked
  catalog: {
    atMs: number;
    counts: { lang: "de" | "en"; materials: number; locations: number; blueprints: number }[];
    packKeys: number;
    packFound: number;
  } | null;
}

function generalReport(): GeneralReport {
  const load = catalogLoad.value;
  const r = catalogResponses.value;
  return {
    connected: connected.value,
    connection: connectionText.value,
    user: meName.value,
    catalog: load && r
      ? {
        atMs: load.atMs,
        counts: (["de", "en"] as const).map((lang) => ({ lang, materials: r[lang].materials.length, locations: r[lang].locations.length, blueprints: r[lang].blueprints.length })),
        packKeys: load.packKeys,
        packFound: load.packFound,
      }
      : null,
  };
}

const publishGeneral = () => void emit("general-report", generalReport()).catch(() => undefined);

export async function watchDebugReport() {
  watch([unlockRows, autoLocation, locationUuid, syncCatalog, log], publish);
  await listen("gamelog-report-request", publish);
  watch([connected, connectionText, meName, catalogLoad], publishGeneral);
  await listen("general-report-request", publishGeneral);
}
