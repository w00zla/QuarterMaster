// Texts for history rows (dashboard feed, activity list) and the day labels of the charts.
import type { ActivityRow, ActivitySource } from "../../src/adminapp/api-types";

export const SOURCE_LABEL: Record<ActivitySource, string> = { bot: "Bot", webapp: "Web app", companion: "Companion" };

export const CATEGORY_LABEL: Record<ActivityRow["category"], string> = { stock: "Stock", refinery: "Refinery", blueprint: "Blueprint" };

// The actions app.history allows per category (its CHECK)
export const ACTIONS: Record<ActivityRow["category"], string[]> = {
  stock: ["add", "remove", "adjust", "move", "share", "unshare", "give", "split", "merge"],
  refinery: ["start", "done", "remove", "adjust"],
  blueprint: ["add", "remove"],
};

/** "12.5 SCU", "3 pcs", "" without an amount. */
export const amountText = (r: Pick<ActivityRow, "amount" | "unit">) => (r.amount === null ? "" : `${r.amount}${r.unit ? ` ${r.unit}` : ""}`);

/** A UTC day (YYYY-MM-DD) as "Oct 22". */
export const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
