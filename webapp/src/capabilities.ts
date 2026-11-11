// What the server offers (GET /api/capabilities, asked before anything else): the login variant, orgs, UEX and the installed
// game version. Reactive; refreshed after a data install, when the UEX key changes and now and then (local.ts).
import { computed, ref } from "vue";
import type { Capabilities } from "../../src/webapp/api-types";
import { api } from "./api";

export const capabilities = ref<Capabilities | null>(null);

/** No login at all: the singleuser variant (settings view, start tile, no user). */
export const loginNone = computed(() => capabilities.value?.login === "none");
/** Orgs exist (the online variant). Until the capabilities are known the online behaviour applies. */
export const orgsOn = computed(() => capabilities.value?.orgs ?? true);
/** UEX trading data is offered. */
export const uexOn = computed(() => capabilities.value?.uex ?? true);
/** The installed game version for the top bar's chip; null while none is installed. */
export const gameLabel = computed(() => capabilities.value?.game?.label ?? null);

/** Loads the capabilities; false when the server did not answer (the caller tries again). */
export async function loadCapabilities(): Promise<boolean> {
  try {
    capabilities.value = await api<Capabilities>("/capabilities");
    return true;
  } catch {
    return false;
  }
}
