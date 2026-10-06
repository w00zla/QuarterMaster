// Crafting check: the checked blueprints (kept in this browser only), loading the /api/crafting/*
// data in the effective language, and the planner's warnings in the UI language.
import { ref, watch, type Ref } from "vue";
import type { PlanEntry } from "../../src/planner/types";
import { ApiError, api } from "./api";
import { lang, t } from "./i18n";
import { loadMe } from "./session";
import { errorText } from "./toasts";

const KEY = "qm.webapp.crafting";

function load(): PlanEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return (value as PlanEntry[]).filter((e) => typeof e?.blueprintUuid === "string").map((e) => ({ ...e, count: 1 }));
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

// The shared planner (src/planner/plan.ts) words its warnings in English
export type WarningKind = "slots" | "retired" | "alternatives" | "belowMin" | "unsupported" | "other";

const WARNINGS: [WarningKind, RegExp, (m: RegExpExecArray) => string][] = [
  ["slots", /^(\d+) of (\d+) slots must be chosen; using the first \d+$/, (m) => t("crafting.warn.slots", { n: m[1]!, m: m[2]! })],
  ["retired", /^This blueprint is no longer in the game data$/, () => t("crafting.warn.retired")],
  ["alternatives", /^Slot (.+) offers alternatives; using the first$/, (m) => t("crafting.warn.alternatives", { slot: m[1]! })],
  ["belowMin", /^Quality (\d+) is below the minimum for slot (.+)$/, (m) => t("crafting.warn.belowMin", { q: m[1]!, slot: m[2]! })],
  ["unsupported", /^Stat (.+): unsupported modifier in slot (.+)$/, (m) => t("crafting.warn.unsupported", { stat: m[1]!, slot: m[2]! })],
];

/** A planner warning in the UI language (unknown ones as they are). */
export function warningOf(w: string): { kind: WarningKind; text: string } {
  for (const [kind, re, text] of WARNINGS) {
    const m = re.exec(w);
    if (m) return { kind, text: text(m) };
  }
  return { kind: "other", text: w };
}
