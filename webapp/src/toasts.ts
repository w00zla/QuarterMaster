// Short messages after an action (done, refused); rendered by components/Toasts.vue in App.vue.
import { ref } from "vue";
import { ApiError } from "./api";
import { isKey, t } from "./i18n";
import { loadMe } from "./session";

export type ToastType = "ok" | "error";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

export const toasts = ref<Toast[]>([]);
let nextId = 1;

export function toast(message: string, type: ToastType = "ok") {
  const id = nextId++;
  toasts.value.push({ id, message, type });
  // Errors stay longer: they explain what to do
  setTimeout(() => dismissToast(id), type === "error" ? 8000 : 4000);
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
