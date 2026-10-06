// Config and connection state, shared by the views.
import { ref } from "vue";
import type { MeResponse } from "../../src/webapp/api-types";
import { api, getConfig, type Config } from "./backend";

export const config = ref<Config | null>(null);
// Server and token set and accepted (GET /api/me answered)
export const connected = ref(false);
// The token's user, null while unknown
export const meName = ref<string | null>(null);
// Why the last check failed (error code), null when connected or nothing set
export const connectError = ref<unknown>(null);

export async function loadConfig() {
  config.value = await getConfig();
}

/** Checks server and token with GET /api/me. */
export async function refreshConnection() {
  connected.value = false;
  meName.value = null;
  connectError.value = null;
  if (!config.value?.server || !config.value.token) return;
  try {
    meName.value = (await api<MeResponse>("GET", "/me")).name;
    connected.value = true;
  } catch (e) {
    connectError.value = e;
  }
}
