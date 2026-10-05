// Who is logged in (GET /api/me), shared by all views. 401 = not logged in.
import { ref } from "vue";
import type { MeResponse } from "../../src/webapp/api-types";
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

export async function loadMe() {
  try {
    me.value = await api<MeResponse>("/me");
    status.value = "in";
  } catch (e) {
    me.value = null;
    status.value = e instanceof ApiError && e.status === 401 ? "anon" : "error";
  }
}

export async function logout() {
  const res = await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => null);
  // Only show "logged out" when the server ended the session; otherwise show what is true
  if (res?.ok) {
    me.value = null;
    status.value = "anon";
  } else await loadMe();
}
