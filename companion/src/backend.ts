// The Rust side (src-tauri/src/lib.rs): config, the followed Game.log and the web app API (called from
// Rust with the configured server and token: no CORS in the way).
import { invoke } from "@tauri-apps/api/core";
import { ref } from "vue";
import type { CompanionOutdated, CompanionPlatform } from "../../src/webapp/api-types";

export interface Config {
  server: string;
  // The user's API token (web app profile)
  token: string;
  gameDir: string;
  // The UI language: "de", "en" or "" = the system's
  language: string;
  // The scan overlay: where in the game window it sits, its hotkeys ("Ctrl+Shift+KeyQ", "" = none)
  overlayPosition: OverlayPosition;
  hotkeyOverlay: string;
  hotkeyMode: string;
}

export type OverlayPosition = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

export interface Unlock {
  // As logged (UTC, ISO)
  at: string;
  name: string;
}

export interface LogState {
  path: string;
  found: boolean;
  unlocks: Unlock[];
  // The last location key Game.log named ("RR_CRU_LEO"), null when none yet
  location: string | null;
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
export const scanBackups = () => call<{ found: number; failed: number }>("scan_backups");
export const appInfo = () => call<{ version: string; platform: CompanionPlatform }>("app_info");
export const downloadUpdate = (url: string, dest: string) => call<void>("download_update", { url, dest });
export const openWebapp = () => call<void>("open_webapp");
// The scan session: what the OCR reads from the screen capture, started and stopped by the user
// "inventory" = the freight manager's warehouse (materials, items) and the character inventory's storage pane (ship components)
export type ScanMode = "off" | "inventory" | "refinery";
export const getScan = () => call<ScanMode>("get_scan");
export const setScan = (mode: ScanMode) => call<void>("set_scan", { mode });
// The inventory debug window: frames with the reads, the last reads kept; a recording writes every read into a new folder below dir (its path)
export const setDebug = (on: boolean) => call<void>("set_debug", { on });
export const startDebugRecording = (dir: string) => call<string>("start_debug_recording", { dir });
export const stopDebugRecording = () => call<void>("stop_debug_recording");
// The debug window (debug.html), opened or focused
export const openDebugWindow = () => call<void>("open_debug_window");
export const getGameSeen = () => call<boolean>("get_game_seen");
// The scan overlay's window (Windows only), shown while the game is in front
export const setOverlayWindow = (on: boolean) => call<void>("set_overlay", { on });
// Texts of these loc keys (lower case) in the player's active language pack (global.ini); missing keys are left out
export const gameNames = (keys: string[]) => call<Record<string, string>>("game_names", { keys });

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
