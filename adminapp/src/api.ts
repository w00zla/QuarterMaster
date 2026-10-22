// Fetch wrapper for the admin API (same origin; the browser handles basic auth).
import { ref, watch, type Ref } from "vue";
import { lang } from "./lang";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  // The path may carry its own query (?uuids=…); params are merged into it
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(res.status, res.status === 404 ? "Not found" : `Request failed (${res.status})`);
  return (await res.json()) as T;
}

/**
 * Sends a file as raw body to a writing endpoint; throws the server's error message. XHR instead of fetch:
 * only XHR reports the upload's progress (`onUpload` gets 0…1).
 */
export function postFile<T>(
  path: string, params: Record<string, string | number | undefined>, file: Blob, onUpload?: (share: number) => void,
): Promise<T> {
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    // The custom header marks the request as coming from this UI (CSRF protection on the server)
    xhr.setRequestHeader("X-Quartermaster", "1");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (onUpload) {
      xhr.upload.onprogress = (e) => e.lengthComputable && onUpload(e.loaded / e.total);
      // Also without a computable length: the upload is through, the server works
      xhr.upload.onload = () => onUpload(1);
    }
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // No JSON (e.g. a proxy's error page): the status says enough
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new ApiError(xhr.status, (body as { error?: string } | null)?.error ?? `Request failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, "Backend not reachable"));
    xhr.send(file);
  });
}

/** Sends JSON to a writing endpoint; throws the server's error message. Null for an empty answer (204). */
export async function send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T | null> {
  const headers: Record<string, string> = { "X-Quartermaster": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, err?.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : ((await res.json()) as T);
}

/**
 * Reactive resource: refetches when the path changes, on `reload()` or (with
 * `localized`) when the language changes. A null path clears the data. Stale
 * responses are dropped.
 */
export function useFetch<T>(path: () => string | null, localized = true): {
  data: Ref<T | null>; loading: Ref<boolean>; error: Ref<string>; reload: () => void;
} {
  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(false);
  const error = ref("");
  const tick = ref(0);
  let seq = 0;
  watch(
    () => [path(), localized ? lang.value : "", tick.value] as const,
    async ([p]) => {
      const mine = ++seq;
      error.value = "";
      if (p === null) {
        data.value = null;
        return;
      }
      loading.value = true;
      try {
        const result = await get<T>(p, localized ? { lang: lang.value } : {});
        if (mine === seq) data.value = result;
      } catch (e) {
        if (mine === seq) {
          data.value = null;
          error.value = e instanceof Error ? e.message : String(e);
        }
      } finally {
        if (mine === seq) loading.value = false;
      }
    },
    { immediate: true },
  );
  return { data, loading, error, reload: () => tick.value++ };
}
