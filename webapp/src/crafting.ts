// Crafting check: the checked blueprints (kept in this browser only), loading the /api/crafting/*
// data in the effective language, and the planner's warnings in the UI language.
import { reactive, ref, watch, type Ref } from "vue";
import type { PlanEntry, PlanWarning } from "../../src/planner/types";
import { ApiError, api } from "./api";
import { clampCount } from "../../src/planner/stock";
import { lang, t } from "./i18n";
import { loadMe } from "./session";
import { errorText } from "./toasts";

const KEY = "qm.webapp.crafting";

function load(): PlanEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return (value as PlanEntry[]).filter((e) => typeof e?.blueprintUuid === "string").map((e) => ({ ...e, count: clampCount(Number(e.count)) }));
  } catch {
    return [];
  }
}

export const checks = ref<PlanEntry[]>(load());

/** Newest on top; a blueprint already in the list just moves up. */
export function addToCrafting(uuid: string) {
  const existing = checks.value.find((e) => e.blueprintUuid === uuid);
  checks.value = [existing ?? { blueprintUuid: uuid, count: 1 }, ...checks.value.filter((e) => e.blueprintUuid !== uuid)];
}

watch(
  checks,
  (entries) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      // localStorage unavailable: the list lasts until reload.
    }
  },
  { deep: true },
);

// The view's own state: Stock and Owners panels opened per blueprint (closed by default; the lists of the
// former open-by-default state, stockClosed/ownersClosed, are dropped)
const UI_KEY = "qm.webapp.crafting.ui";

interface CraftingUi {
  stockOpen: string[];
  ownersOpen: string[];
}

function loadUi(): CraftingUi {
  try {
    const value = JSON.parse(localStorage.getItem(UI_KEY) ?? "{}") as Partial<CraftingUi>;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { stockOpen: strings(value?.stockOpen), ownersOpen: strings(value?.ownersOpen) };
  } catch {
    return { stockOpen: [], ownersOpen: [] };
  }
}

export const craftingUi = reactive<CraftingUi>(loadUi());

/** Adds or removes an ID in a UI state list. */
export function toggleIn(list: string[], id: string) {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else list.push(id);
}

watch(
  craftingUi,
  (ui) => {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify(ui));
    } catch {
      // localStorage unavailable: the state lasts until reload.
    }
  },
  { deep: true },
);

/**
 * Reactive GET: refetches when the path or the language changes; a null path clears the data.
 * Stale responses are dropped.
 */
export function useCrafting<T>(path: () => string | null): { data: Ref<T | null>; loading: Ref<boolean>; error: Ref<string> } {
  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(false);
  const error = ref("");
  let seq = 0;
  watch(
    () => [path(), lang.value] as const,
    async ([p, l]) => {
      const mine = ++seq;
      error.value = "";
      if (p === null) {
        data.value = null;
        loading.value = false;
        return;
      }
      loading.value = true;
      try {
        const result = await api<T>(`${p}${p.includes("?") ? "&" : "?"}lang=${l}`);
        if (mine === seq) data.value = result;
      } catch (e) {
        if (mine === seq) {
          data.value = null;
          error.value = errorText(e);
        }
        if (e instanceof ApiError && e.status === 401) void loadMe();
      } finally {
        if (mine === seq) loading.value = false;
      }
    },
    { immediate: true },
  );
  return { data, loading, error };
}

/** A planner warning in the UI language. */
export function warningText(w: PlanWarning): string {
  switch (w.code) {
    case "slots": return t("crafting.warn.slots", { n: w.required, m: w.total });
    case "retired": return t("crafting.warn.retired");
    case "alternatives": return t("crafting.warn.alternatives", { slot: w.slot });
    case "belowMin": return t("crafting.warn.belowMin", { q: w.quality, slot: w.slot });
    case "unsupported": return t("crafting.warn.unsupported", { stat: w.stat, slot: w.slot });
  }
}
