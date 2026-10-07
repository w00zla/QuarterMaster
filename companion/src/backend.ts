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
}

export interface Unlock {
  // As logged (UTC, ISO)
  at: string;
  name: string;
}

export interface LogState {
  path: string;
  found: boolean;
  unlocks: Unlock[];
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

// Set when the server refused this version (426): the app does no work until updated
export const outdated = ref<CompanionOutdated | null>(null);

/** One web app API call as the token's user; refusals throw their error code. */
export async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await call<{ status: number; body: unknown }>("api", { method, path: `/api${path}`, body: body ?? null });
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
