// Short messages bottom right (like the web app's): done in green, refused in red.
import { ref } from "vue";
import { AppError, isConnectionError } from "./backend";
import { isKey, t } from "./i18n";

export type ToastType = "ok" | "error";
interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

export const toasts = ref<Toast[]>([]);
let next = 1;

export function toast(message: string, type: ToastType = "ok") {
  const id = next++;
  toasts.value = [...toasts.value, { id, message, type }];
  setTimeout(() => dismissToast(id), type === "error" ? 8000 : 4000);
}

export function dismissToast(id: number) {
  toasts.value = toasts.value.filter((x) => x.id !== id);
}

/** An error code as text; anything unknown is shown as it came (with the generic text). */
export function errorText(e: unknown): string {
  const code = e instanceof AppError ? e.message : String(e);
  const key = `err.${code}`;
  return isKey(key) ? t(key) : `${t("err.generic")} (${code})`;
}

/** An error as a toast; connection refusals are left to the connection state (top bar). */
export function toastError(e: unknown) {
  if (!isConnectionError(e)) toast(errorText(e), "error");
}
