// The Rust side (src-tauri/src/lib.rs): config, the followed Game.log and the web app API (called from
// Rust with the configured server and token: no CORS in the way).
import { invoke } from "@tauri-apps/api/core";
import { ref } from "vue";
import type { ThumbSize } from "../../src/thumbs.ts";
import type { CompanionOutdated, CompanionPlatform } from "../../src/webapp/api-types.ts";
import type { OverlayDisplay } from "./overlayLayout.ts";

export interface Config {
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

// Codes that mean the connection itself is refused (shown as the connection state, not as a toast)
const CONNECTION_CODES = new Set(["noServer", "noToken", "invalidServer", "insecureServer", "invalidToken", "network", "companionOutdated"]);
export const isConnectionError = (e: unknown) => e instanceof AppError && CONNECTION_CODES.has(e.message);

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
// updater = the installed app (setup), which updates itself (installUpdate); the standalone exe downloads the zip
export const appInfo = () => call<{ version: string; platform: CompanionPlatform; updater: boolean }>("app_info");
export const gpuStatus = () => call<GpuStatus>("gpu_status");
export const downloadUpdate = (url: string, dest: string) => call<void>("download_update", { url, dest });
// Ends the app when it worked (the setup starts the new version)
export const installUpdate = () => call<void>("install_update");
export const openWebapp = () => call<void>("open_webapp");
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

// Set when the server refused this version (426): the app does no work until updated
export const outdated = ref<CompanionOutdated | null>(null);

/** One web app API call as the token's user; refusals throw their error code. `cache`: a GET kept on disk and
 * revalidated by its ETag (Rust `server::cached_api`; the catalog). */
export async function api<T>(method: "GET" | "POST", path: string, body?: unknown, cache = false): Promise<T> {
  const res = await call<{ status: number; body: unknown }>("api", { method, path: `/api${path}`, body: body ?? null, cache });
  if (res.status === 426) {
    outdated.value = res.body as CompanionOutdated;
    throw new AppError("companionOutdated");
  }
  if (res.status >= 400) {
    const code = (res.body as { error?: string } | null)?.error;
    throw new AppError(code ?? `HTTP ${res.status}`);
  }
  return res.body as T;
}
