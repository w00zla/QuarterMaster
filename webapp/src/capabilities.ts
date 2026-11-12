// What the server offers (GET /api/capabilities, asked before anything else): the login variant, orgs, UEX and the installed
// game version. Reactive; refreshed after a data install, when the UEX key changes and now and then (local.ts).
import { computed, ref } from "vue";
import type { Capabilities } from "../../src/webapp/api-types";
import { api } from "./api";
import { traitsOf } from "./navigation";

export const capabilities = ref<Capabilities | null>(null);

// What follows from the capabilities, named for what it means (navigation.ts `traitsOf`): the views ask these, never the
// login variant itself
const traits = computed(() => traitsOf(capabilities.value));
/** The app runs on the user's PC: own settings, data updates, app version, the start tile (`/api/local/*`). */
export const localApp = computed(() => traits.value.localApp);
/** Exactly one user: no "who" and no "source" anywhere. */
export const singleUser = computed(() => traits.value.singleUser);
/** The header across the full width with the side bar below it (else the top bar). */
export const sideLayout = computed(() => traits.value.sideLayout);
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
