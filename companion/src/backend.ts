// The Rust side (src-tauri/src/lib.rs): config, the followed Game.log and the web app API (called from
// Rust with the configured server and token: no CORS in the way).
import { invoke } from "@tauri-apps/api/core";
import { ref } from "vue";
import type { ThumbSize } from "../../src/thumbs.ts";
import { COMPANION_API } from "../../src/webapp/api-types.ts";
import { isConnectionCode, outdatedOf, refusalOf, type Connection, type Outdated, type Paired } from "./connection.ts";
import type { OverlayDisplay } from "./overlayLayout.ts";

export interface Config {
  // Which server the app talks to: the online one (server + token) or the Quartermaster app on this PC
  connection: Connection;
  server: string;
  // The user's API token (web app profile)
  token: string;
  gameDir: string;
  // The UI language: "de", "en" or "" = the system's
  language: string;
  // The scan overlay: where in the game window it sits, its hotkeys ("Ctrl+Shift+KeyQ", "" = none)
  overlayPosition: OverlayPosition;
  // How it shows its rows: "thumbs" (the latest item as a taller top row with its thumbnail) or "compact"
  overlayDisplay: OverlayDisplay;
  hotkeyOverlay: string;
  hotkeyMode: string;
  // The tab (= the overlay's mode) switches by itself: with the screen the scan sees, with a new blueprint unlock
  autoTab: boolean;
  // The screen scan's OCR on the GPU where it can (GpuStatus), else on the CPU
  gpu: boolean;
}

// Whether the OCR can run on the GPU: ready, DirectML.dll not next to the exe, or failed in this run
// (then it goes on on the CPU); the event "ocr-gpu" brings a failure
export type GpuStatus = { state: "ready" } | { state: "missing" } | { state: "failed"; error: string };

export type OverlayPosition = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

export interface Unlock {
  // As logged (UTC, ISO)
  at: string;
  name: string;
  // Found in an old log (logbackups), not in the current Game.log
  backup: boolean;
}

export interface LocationLine {
  // As logged (UTC, ISO)
  at: string;
  key: string;
}

export interface LogState {
  path: string;
  found: boolean;
  unlocks: Unlock[];
  // The last location key Game.log named ("RR_CRU_LEO"), null when none yet
  location: string | null;
  // Every location line of the current Game.log, oldest first
  locations: LocationLine[];
  // The file as last polled (sizes in bytes); null while not found
  file: { createdMs: number | null; modifiedMs: number | null; size: number; readTo: number } | null;
}

/** A refusal: an error code (translated by the UI) or a message. */
export class AppError extends Error {}

// A refusal of the connection itself (connection.ts: shown as the connection state, not as a toast)
export const isConnectionError = (e: unknown) => e instanceof AppError && isConnectionCode(e.message);

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new AppError(String(e));
  }
}

export const getConfig = () => call<Config>("get_config");
export const setConfig = (config: Config) => call<Config>("set_config", { config });
export const logState = () => call<LogState>("log_state");
// Reading the blueprint unlocks from Game.log on or off (off drops them, on reads the log again)
export const setUnlockScan = (on: boolean) => call<void>("set_unlock_scan", { on });
// Writes the debug window's Game.log export (the log state plus the main window's report) into dir; the file's path
export const exportLogDebug = (dir: string, report: unknown) => call<string>("export_log_debug", { dir, report });
export const scanBackups = () => call<{ found: number; failed: number }>("scan_backups");
// setup = the installed app (NSIS setup), not the bare exe
export const appInfo = () => call<{ version: string; platform: "windows" | "linux"; setup: boolean }>("app_info");
export const gpuStatus = () => call<GpuStatus>("gpu_status");
// The web app of the server in use (the local app's in the local mode), in the browser
export const openWebapp = () => call<void>("open_webapp");
// The companion's releases page on GitHub, in the browser
export const openReleases = () => call<void>("open_releases");
/** The project's GitHub page in the browser (the footer's link). */
export const openRepo = () => call<void>("open_repo");
// The local app as its pairing file last said (read by the Rust side at every call in the local mode); null online
// or while it was never seen
export const getPaired = () => call<Paired | null>("paired");
// A file as the debug window shows it; size null = not there
export interface FileInfo {
  path: string;
  size: number | null;
  modifiedMs: number | null;
}
// The debug window's General tab, the app's side: server, the app's folders, the player's language pack (language null:
// user.cfg sets none, the game's English) and the catalog as kept on disk per language
export interface DebugInfo {
  server: string;
  configFile: string;
  logDir: string;
  cacheDir: string;
  gameDir: string;
  language: string | null;
  pack: FileInfo;
  catalog: { lang: string; file: FileInfo; etag: string | null }[];
}
export const debugInfo = () => call<DebugInfo>("debug_info");
export type AppFolder = "config" | "log" | "cache" | "game";
export const openFolder = (which: AppFolder) => call<void>("open_folder", { which });
// The scan: what the OCR reads from the screen capture, switched on and off by the user or the overlay. The scope says
// which screens it reads: the freight manager's warehouse (materials, items), the character inventory's storage pane
// (ship components), the refinery terminal (jobs)
export interface ScanScope {
  warehouse: boolean;
  inventory: boolean;
  refinery: boolean;
}
export const getScan = () => call<boolean>("get_scan");
export const setScan = (on: boolean, scope: ScanScope) => call<void>("set_scan", { on, ...scope });
// The screen the scan sees (event "scan-screen")
export type ScanScreen = "none" | "warehouse" | "inventory" | "refinery";
// The inventory debug window: frames with the reads, the last reads kept; a recording writes every read into a new folder below dir (its path)
export const setDebug = (on: boolean) => call<void>("set_debug", { on });
export const startDebugRecording = (dir: string) => call<string>("start_debug_recording", { dir });
export const stopDebugRecording = () => call<void>("stop_debug_recording");
// The settings window (settings.html), opened or focused
export const openSettingsWindow = () => call<void>("open_settings_window");
// The settings window's first size: its content height (logical px); the window then shows
export const fitSettingsWindow = (height: number) => call<void>("fit_settings_window", { height });
// The debug window (debug.html), opened or focused
export const openDebugWindow = () => call<void>("open_debug_window");
export const getGameSeen = () => call<boolean>("get_game_seen");
// The game window in front: only then the scan reads (event "game-front")
export const getGameFront = () => call<boolean>("get_game_front");
// The scan overlay's window (Windows only), shown while the game is in front
export const setOverlayWindow = (on: boolean) => call<void>("set_overlay", { on });
// Texts of these loc keys (lower case) in the player's active language pack (global.ini); missing keys are left out
export const gameNames = (keys: string[]) => call<Record<string, string>>("game_names", { keys });
// An item thumbnail as a data: URL (the app's cache, else the server's /thumbs/…; thumbs.ts keeps them per session)
export const thumbData = (size: ThumbSize, uuid: string, hash: string) => call<string>("thumb", { size, uuid, hash });

// Set when the server refused this app's API contract number (426: the companion is too old, 409: the server is):
// the app does no work until that changed
export const outdated = ref<Outdated | null>(null);

/** An API answer's body; refusals throw their error code (connection.ts `refusalOf`), a contract refusal also sets
 * `outdated`. */
function answer<T>(res: { status: number; body: unknown }): T {
  const refused = outdatedOf(res.status, res.body);
  if (refused) outdated.value = refused;
  const code = refusalOf(res.status, res.body);
  if (code) throw new AppError(code);
  return res.body as T;
}

/** One API call to the server in use (as the token's user online, as the local user in the app), with the API
 * contract number this build was made for (COMPANION_API, its one source). `cache`: a GET kept on disk and
 * revalidated by its ETag (Rust `server::cached_api`; the catalog). */
export async function api<T>(method: "GET" | "POST", path: string, body?: unknown, cache = false): Promise<T> {
  return answer<T>(await call("api", { apiNumber: COMPANION_API, method, path: `/api${path}`, body: body ?? null, cache }));
}

let localeRun: Promise<void> | null = null;
/** Brings the game's English texts on disk up to date with the server (GET /api/companion/locale, revalidated by
 * its ETag; the readers' English table, Rust `server::cached_text`). One run at a time. */
export function refreshLocale(): Promise<void> {
  return (localeRun ??= call<{ status: number; body: unknown }>("refresh_locale", { apiNumber: COMPANION_API })
    .then((res) => answer<void>(res))
    .finally(() => (localeRun = null)));
}
