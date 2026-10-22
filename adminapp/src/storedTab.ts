// A detail panel's chosen tab, remembered per browser; without localStorage (blocked, private window) the default.
import { ref, watch, type Ref } from "vue";

export function useStoredTab<T extends string>(key: string, tabs: readonly T[], fallback: T): Ref<T> {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    // Not readable: the default
  }
  const tab = ref(tabs.find((t) => t === stored) ?? fallback) as Ref<T>;
  watch(tab, (t) => {
    try {
      localStorage.setItem(key, t);
    } catch {
      // Not remembered
    }
  });
  return tab;
}
