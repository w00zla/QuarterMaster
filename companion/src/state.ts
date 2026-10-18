// Config, connection and Game.log state, shared by the views. The connection state follows every
// API call (see api below) and is re-checked while it is down.
import { computed, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import type { MeResponse } from "../../src/webapp/api-types";
import { api as backendApi, getConfig, isConnectionError, logState, outdated, type Config, type LogState } from "./backend";
import { applyLangSetting, t } from "./i18n";
import { errorText, toastError } from "./toasts";

// Re-check interval while not connected
const RETRY_MS = 30_000;

export const config = ref<Config | null>(null);
// Server and token set and accepted (GET /api/me answered)
export const connected = ref(false);
// The token's user (Discord name and avatar as of the login that created the token), null while unknown
export const meName = ref<string | null>(null);
export const meAvatar = ref<string | null>(null);
// The user's active orgs (the inventory scan offers to share registered stacks in them)
export const meOrgs = ref<MeResponse["orgs"]>([]);
// Why the connection is down (error code), null when connected or nothing checked yet
export const connectError = ref<unknown>(null);
// The followed Game.log and its unlocks
export const log = ref<LogState | null>(null);

/** The connection as one line ("Connection successful" or why not). */
export const connectionText = computed(() => (connected.value ? t("conn.ok")
  : connectError.value ? errorText(connectError.value) : t("conn.off")));

/** Takes a config in (loaded or saved) and applies its language. */
export function applyConfig(c: Config) {
  config.value = c;
  applyLangSetting(c.language);
}

export async function loadConfig() {
  applyConfig(await getConfig());
}

/** One web app API call; a refusal of the connection itself (server, token, version) marks it down. */
export async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  try {
    return await backendApi<T>(method, path, body);
  } catch (e) {
    if (isConnectionError(e)) {
      connected.value = false;
      connectError.value = e;
    }
    throw e;
  }
}

/** Checks server and token with GET /api/me (also clears an update hint the server dropped). */
export async function refreshConnection() {
  if (!config.value?.server || !config.value.token) {
    connected.value = false;
    meName.value = null;
    meAvatar.value = null;
    connectError.value = config.value?.server ? "noToken" : "noServer";
    return;
  }
  try {
    const me = await api<MeResponse>("GET", "/me");
    meName.value = me.name;
    meAvatar.value = me.avatarUrl;
    meOrgs.value = me.orgs;
    connectError.value = null;
    outdated.value = null;
    connected.value = true;
  } catch (e) {
    connected.value = false;
    connectError.value = e;
  }
}

/** Re-checks the connection every RETRY_MS while it is down, and whenever the window gets focus. */
export function watchConnection() {
  setInterval(() => {
    if (!connected.value) void refreshConnection();
  }, RETRY_MS);
  window.addEventListener("focus", () => void refreshConnection());
}

export async function loadLog() {
  try {
    log.value = await logState();
  } catch (e) {
    toastError(e);
  }
}

/** Follows the Rust side's log changes (new unlocks, Game.log found or gone). */
export async function watchLog() {
  await listen("log-changed", () => void loadLog());
  await loadLog();
}
