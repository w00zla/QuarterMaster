// Display helpers and input checks for stock (amounts are validated like the server does, as text).
import type { StockBatch } from "../../src/webapp/api-types";
import { parseAmount } from "../../src/stock/amount";
import { t } from "./i18n";
import { orgOf } from "./orgs";

export type Unit = "SCU" | "pcs";

export const unitText = (unit: Unit) => t(unit === "SCU" ? "unit.SCU" : "unit.pcs");

/** "12.5 SCU" */
export const qty = (quantity: string, unit: Unit) => `${quantity} ${unitText(unit)}`;

/** The typed amount normalized ("12,50" → "12.5"), null when the server would refuse it. */
export const amountOf = (text: string, unit: Unit) => parseAmount(text, unit === "SCU" ? "resource" : "item");

/** Quality 0-1000 as typed, null otherwise. */
export function qualityOf(text: string): number | null {
  const s = text.trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n <= 1000 ? n : null;
}

/** Star level of a quality: one per 100 from 500 (500-599 = 1 ... 900-999 = 5). */
const qualityStars = (q: number) => Math.min(5, Math.floor(q / 100) - 4);

/** The level of a quality: "⊘" (below 500, not usable), "★" to "★★★★★", "♛" (1000) */
export const qMark = (q: number) => (q < 500 ? "⊘" : q === 1000 ? "♛" : "★".repeat(qualityStars(q)));

/** The quality with its level: "⊘ 480", "★★★ 720", "♛ 1000" */
export const qText = (q: number | null) => (q === null ? "" : `${qMark(q)} ${q}`);

/** A duration: "3 h 12 min", "45 min" (minutes rounded up, so a running job never shows 0 min). */
export function hm(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} ${t("unit.h")} ${m} ${t("unit.min")}` : `${m} ${t("unit.min")}`;
}

/** "Org (holder)" or "Pers.", as in the bot. */
export const ownerText = (b: StockBatch) =>
  b.designation === "org" ? `${orgOf(b.guildId)?.name ?? "Org"} (${b.holderName ?? "?"})` : t("stock.pers");

/** "Quantanium · ★★★★ 820 · Area18 · Pers." */
export const batchText = (b: StockBatch) => `${b.material} · ${qText(b.quality)} · ${b.location} · ${ownerText(b)}`;

/** Within a material: best quality first, then the larger batch, then by location. */
export function compareBatches(a: StockBatch, b: StockBatch) {
  return b.quality - a.quality || Number(b.quantity) - Number(a.quantity) || a.location.localeCompare(b.location);
}

/** "1h 2m 5s" */
export function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : "", rest || (!h && !m) ? `${rest}s` : ""].filter(Boolean).join(" ");
}
