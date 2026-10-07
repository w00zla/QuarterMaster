// Short messages after an action (done, refused), and notices of actions from the bot and the
// companion app that stay until dismissed; rendered by components/Toasts.vue in App.vue.
import { ref } from "vue";
import { ApiError } from "./api";
import { isKey, t } from "./i18n";
import { loadMe } from "./session";

export type ToastType = "ok" | "error" | "info";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  // Notices: a title line above, a detail line below; they stay until dismissed
  title?: string;
  detail?: string;
  sticky?: boolean;
}

// Notices kept at most (the oldest go first)
const MAX_NOTICES = 5;

export const toasts = ref<Toast[]>([]);
let nextId = 1;

export function toast(message: string, type: ToastType = "ok") {
  const id = nextId++;
  toasts.value.push({ id, message, type });
  // Errors stay longer: they explain what to do
  setTimeout(() => dismissToast(id), type === "error" ? 8000 : 4000);
}

/** A notice that stays until dismissed (actions from the bot and the companion app). */
export function notify(title: string, message: string, detail = "") {
  const notices = toasts.value.filter((x) => x.sticky);
  const drop = new Set(notices.slice(0, Math.max(0, notices.length - MAX_NOTICES + 1)).map((x) => x.id));
  toasts.value = [...toasts.value.filter((x) => !drop.has(x.id)), { id: nextId++, message, type: "info", title, detail, sticky: true }];
}

export function dismissToast(id: number) {
  toasts.value = toasts.value.filter((x) => x.id !== id);
}

/** The text for a failed request: the server's error code, else the generic one. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const key = `err.${e.message}`;
    return isKey(key) ? t(key) : t("err.generic");
  }
  return t("error.backend");
}

/** Shows a failed request as a toast; a lost session takes the user to the login screen. */
export function toastError(e: unknown) {
  toast(errorText(e), "error");
  if (e instanceof ApiError && e.status === 401) void loadMe();
}
