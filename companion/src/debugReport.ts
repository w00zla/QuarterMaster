// What the main window tells the debug window about Game.log (event "gamelog-report" on every change and
// on "gamelog-report-request"): every blueprint unlock with how it matched the catalog, and the location
// keys of the log's location lines resolved to the selectable locations. The debug window reads the log
// itself (log_state); the catalog and the registered blueprints are only here. Likewise for the General
// tab ("general-report", "general-report-request"): the connection, the user and the catalog as loaded; the
// texts the language pack lacked only when asked ("pack-missing-request" -> "pack-missing": a long list).
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
    // Resources and items (ship components and FPS gear among them) apart, as the catalog's `kind` says
    counts: { lang: "de" | "en"; resources: number; items: number; locations: number; blueprints: number }[];
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
        counts: (["de", "en"] as const).map((lang) => {
          const resources = r[lang].materials.filter((m) => m.kind === "resource").length;
          return { lang, resources, items: r[lang].materials.length - resources, locations: r[lang].locations.length, blueprints: r[lang].blueprints.length };
        }),
        packKeys: load.packKeys,
        packFound: load.packFound,
      }
      : null,
  };
}

const publishGeneral = () => void emit("general-report", generalReport()).catch(() => undefined);

/** A loc key the language pack lacked, with what the catalog names it (English; empty when not known). */
export interface MissingText {
  key: string;
  name: string;
}

function missingTexts(): MissingText[] {
  const names = new Map<string, string>();
  for (const m of catalogResponses.value?.en.materials ?? []) {
    if (m.nameKey) names.set(m.nameKey.toLowerCase(), m.name);
    for (const s of m.stats) if (s.nameKey) names.set(s.nameKey.toLowerCase(), s.name);
  }
  for (const l of catalogResponses.value?.en.locations ?? []) if (l.nameKey) names.set(l.nameKey.toLowerCase(), l.label);
  return (catalogLoad.value?.missing ?? []).map((key) => ({ key, name: names.get(key.toLowerCase()) ?? "" }));
}

export async function watchDebugReport() {
  watch([unlockRows, autoLocation, locationUuid, syncCatalog, log], publish);
  await listen("gamelog-report-request", publish);
  watch([connected, connectionText, meName, catalogLoad], publishGeneral);
  await listen("general-report-request", publishGeneral);
  await listen("pack-missing-request", () => void emit("pack-missing", missingTexts()).catch(() => undefined));
}
