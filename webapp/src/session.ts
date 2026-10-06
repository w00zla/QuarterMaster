// Who is logged in (GET /api/me), shared by all views. 401 = not logged in.
import { ref } from "vue";
import type { MeResponse, OkResponse, ProfileRequest } from "../../src/webapp/api-types";
import { api, ApiError } from "./api";

export const me = ref<MeResponse | null>(null);
export const status = ref<"loading" | "anon" | "in" | "error">("loading");

// Result of the last Discord login (?login=failed|denied), read once at startup
const params = new URLSearchParams(window.location.search);
export const loginNotice = ref<"failed" | "denied" | null>(
  params.get("login") === "failed" ? "failed" : params.get("login") === "denied" ? "denied" : null,
);
if (params.has("login")) {
  // Built from the full URL: a path like //evil.com taken as a relative URL would point off-site
  const url = new URL(window.location.href);
  url.searchParams.delete("login");
  window.history.replaceState(null, "", url);
}

let loading: Promise<void> | null = null;
let again = false;
let freshTimer: ReturnType<typeof setTimeout> | undefined;

/** (Re)loads /api/me. Calls while a load runs collapse into one more load after it. */
export function loadMe(): Promise<void> {
  if (loading) {
    again = true;
    return loading;
  }
  loading = (async () => {
    do {
      again = false;
      await fetchMe();
    } while (again);
    loading = null;
  })();
  return loading;
}

async function fetchMe() {
  try {
    me.value = await api<MeResponse>("/me");
    status.value = "in";
  } catch (e) {
    me.value = null;
    status.value = e instanceof ApiError && e.status === 401 ? "anon" : "error";
  }
  // The bot's minute beat is not announced: ask again when an org's roster would turn stale
  clearTimeout(freshTimer);
  const due = (me.value?.orgs ?? []).filter((o) => o.rosterFresh).map((o) => o.rosterFreshForMs);
  if (due.length) freshTimer = setTimeout(() => void loadMe(), Math.min(...due) + 1000);
}

export async function logout() {
  const res = await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => null);
  // Only show "logged out" when the server ended the session; otherwise show what is true
  if (res?.ok) {
    me.value = null;
    status.value = "anon";
  } else await loadMe();
}

/** Saves profile fields (RSI handle, language) and reloads /api/me; throws ApiError when refused. */
export async function saveProfile(body: ProfileRequest) {
  await api<OkResponse>("/profile", { method: "POST", body });
  // The realtime 'me' message would reload it too; not waiting for it keeps the UI in step if the socket is down
  await loadMe();
}
