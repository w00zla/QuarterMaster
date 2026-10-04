// The blueprints being checked in the planner: kept in this browser (localStorage) only.
import { ref, watch } from "vue";
import type { PlanEntry } from "../../src/planner/types";

const KEY = "qm.planner";

function load(): PlanEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    // Earlier versions stored a single entry
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return (list as PlanEntry[]).filter((e) => typeof e?.blueprintUuid === "string").map((e) => ({ ...e, count: 1 }));
  } catch {
    return [];
  }
}

export const checks = ref<PlanEntry[]>(load());

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
