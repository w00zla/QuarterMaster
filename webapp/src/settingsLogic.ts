// Decisions of the settings view that need no DOM (pure: tested in test/webapp-local.test.ts).
// (No imports of i18n: the root type check and the tests load this file; the view checks `text` against the text keys.)
import type { DataUpdateState, LocalSettingsState, UexState } from "../../src/webapp/api-types.ts";

export type TagKind = "ok" | "warn" | "err" | "off";
export interface TagModel {
  kind: TagKind;
  text: "folder.found" | "folder.noGame" | "pack.active" | "pack.none" | "pack.restart" | "data.loading" | "data.upToDate"
    | "start.noConnection" | "uex.active" | "uex.off" | "uex.refused";
}

// --- game folder ---

/** What to do with the path field when it is committed (Enter, or it loses focus): apply a changed value only. */
export function gameDirChange(input: string, saved: string | null): { apply: false } | { apply: true; value: string | null } {
  const value = input.trim();
  if (value === (saved ?? "")) return { apply: false };
  return { apply: true, value: value === "" ? null : value };
}

export interface FolderView {
  tag: TagModel | null;
  /** "There is no game in this folder." */
  message: boolean;
  /** The folder is not set or not usable: the way to pick one is the primary control. */
  needsFolder: boolean;
}

/** The game folder panel's state. `rejected` = the server refused the typed path (422): the saved setting stays, but the typed one is shown as wrong. */
export function folderView(folder: LocalSettingsState["gameFolder"], rejected: boolean): FolderView {
  if (rejected) return { tag: { kind: "err", text: "folder.noGame" }, message: true, needsFolder: true };
  if (folder.state === "ok") return { tag: { kind: "ok", text: "folder.found" }, message: false, needsFolder: false };
  if (folder.state === "invalid") return { tag: { kind: "err", text: "folder.noGame" }, message: true, needsFolder: true };
  return { tag: null, message: false, needsFolder: true };
}

/** The language pack row: active, to be read at the next start (the folder changed), or none (also the game's English). */
export function packTag(pack: LocalSettingsState["languagePack"]): TagModel {
  if (pack.pending) return { kind: "warn", text: "pack.restart" };
  if (pack.state === "loaded" && pack.active) return { kind: "ok", text: "pack.active" };
  return { kind: "off", text: "pack.none" };
}

// --- game data ---

export const isBusy = (d: DataUpdateState | null) => !!d && d.phase !== "idle";

/** The game data panel's tag; none where nothing can be said (not checked since the start, no data channel). */
export function dataTag(d: DataUpdateState | null): TagModel | null {
  if (!d) return null;
  if (d.phase !== "idle") return { kind: "warn", text: "data.loading" };
  const o = d.last?.outcome;
  if (o === "offline" || o === "failed") return { kind: "warn", text: "start.noConnection" };
  if (d.installed && (o === "upToDate" || o === "installed")) return { kind: "ok", text: "data.upToDate" };
  return null;
}

/** The bold notice above every view: the newest data needs a newer app (`pack` newer), or its format is unsupported. */
export function appTooOld(d: DataUpdateState | null): boolean {
  const last = d?.last;
  if (!last) return false;
  if (last.outcome === "appTooOld") return last.pack === "newer";
  return last.outcome === "failed" && last.reason === "unsupported";
}

// --- UEX ---

export const KEY_MASK = "••••••••••••";

/** What saving the key field does: nothing (untouched or empty without a key), set it, or remove it (saved empty: confirmed first). */
export function keyDecision(value: string, keySet: boolean): "none" | "save" | "remove" {
  if (value === KEY_MASK) return "none";
  const key = value.trim();
  if (key === "") return keySet ? "remove" : "none";
  return "save";
}

export function uexTag(s: Pick<LocalSettingsState, "uexKeySet">, u: UexState | null): TagModel {
  if (!s.uexKeySet) return { kind: "off", text: "uex.off" };
  if (u?.last?.outcome === "refused") return { kind: "err", text: "uex.refused" };
  if (u?.last?.outcome === "offline") return { kind: "warn", text: "start.noConnection" };
  return { kind: "ok", text: "uex.active" };
}

export const uexRefused = (s: Pick<LocalSettingsState, "uexKeySet">, u: UexState | null) => s.uexKeySet && u?.last?.outcome === "refused";

/** The next fetch's time is only shown while one is planned (an `off` or `pulling` state has none). */
export const nextFetch = (u: UexState | null) => (u?.phase === "idle" ? u.nextPull : null);

/** The first run: there is no usable game folder, so the settings view opens by itself (once per start). */
export const firstRun = (s: Pick<LocalSettingsState, "gameFolder">) => s.gameFolder.state !== "ok";
