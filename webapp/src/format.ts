// Display helpers and input checks for stock (amounts are validated like the server does, as text).
import type { StockBatch } from "../../src/webapp/api-types";
import { parseAmount } from "../../src/stock/amount";
import { statValueText } from "../../src/stock/component-stats";
import { qMark, qualityStars } from "../../src/stock/quality";
import { materials } from "./catalog";
import { lang, t } from "./i18n";
import { orgOf } from "./orgs";
import { me } from "./session";

export type Unit = "SCU" | "pcs";

export const unitText = (unit: Unit) => t(unit === "SCU" ? "unit.SCU" : "unit.pcs");

/** Eine Menge in einem Eingabefeld: SCU mit mindestens einer Nachkommastelle im Format der Sprache
 * ("1,0" / "1.0"), Stück ganz ("1"). */
export const amountInput = (n: number, unit: Unit) => unit === "SCU"
  ? new Intl.NumberFormat(lang.value, { minimumFractionDigits: 1, maximumFractionDigits: 6, useGrouping: false }).format(n)
  : String(n);

/** "12.5 SCU" */
export const qty = (quantity: string, unit: Unit) => `${quantity} ${unitText(unit)}`;

/** A UEX price or value (aUEC, no unit text) in the language's format: whole, below 10 with up to 2 decimals. */
export const uec = (n: number) => new Intl.NumberFormat(lang.value, { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0 }).format(n);

/** "6.500 – 10.000", one price when all terminals agree. */
export const priceRange = (r: { min: number; max: number }) => (r.min === r.max ? uec(r.min) : `${uec(r.min)} – ${uec(r.max)}`);

/** "21.10.2026, 14:17" / "10/21/2026, 02:17 PM": the time of a UEX report, to the minute. */
export const priceTime = (iso: string) => new Intl.DateTimeFormat(lang.value, {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
}).format(new Date(iso));

/** The typed amount normalized ("12,50" → "12.5"), null when the server would refuse it. */
export const amountOf = (text: string, unit: Unit) => parseAmount(text, unit === "SCU" ? "resource" : "item");

/** Quality 0-1000 as typed, null otherwise. */
export function qualityOf(text: string): number | null {
  const s = text.trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n <= 1000 ? n : null;
}

// The level of a quality ("◌", "★" to "★★★★★", "♛"), shared with the bot
export { qMark };

/** The tier of a quality for filters: 0 = ◌, 1-5 = ★ to ★★★★★, 6 = ♛ */
export const qTier = (q: number) => (q < 500 ? 0 : q === 1000 ? 6 : qualityStars(q));
export const Q_TIER_MAX = 6;

/** A tier's mark, see qTier */
export const tierMark = (tier: number) => (tier === 0 ? "◌" : tier === Q_TIER_MAX ? "♛" : "★".repeat(tier));

/** The qualities of a tier range: "0–1000", "600–899", "1000" */
export function tierQualities(low: number, high: number): string {
  const from = low === 0 ? 0 : low === Q_TIER_MAX ? 1000 : 400 + 100 * low;
  const to = high === 0 ? 499 : high === Q_TIER_MAX ? 1000 : 499 + 100 * high;
  return from === to ? String(from) : `${from}–${to}`;
}

/** The quality with its level: "◌ 480", "★★★ 720", "♛ 1000" */
export const qText = (q: number | null) => (q === null ? "" : `${qMark(q)} ${q}`);

/** A duration: "3 h 12 min", "45 min" (minutes rounded up, so a running job never shows 0 min). */
export function hm(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} ${t("unit.h")} ${m} ${t("unit.min")}` : `${m} ${t("unit.min")}`;
}

/** "Pers." for your own batch, else its owner's name. */
export const ownerText = (b: StockBatch) => (b.holderUserId === me.value?.userId ? t("stock.pers") : b.holderName ?? "?");

/** "Shared · Org A, Org B": the orgs a batch is shared in. */
export const sharedText = (b: StockBatch) => t("stock.sharedIn", { org: b.sharedIn.map((g) => orgOf(g)?.name ?? "Org").join(", ") });

/** "Quantanium · ★★★★ 820"; a component has no quality: its name only. */
export const withQuality = (b: StockBatch) => {
  if (!b.component) return `${b.material} · ${qText(b.quality)}`;
  const stats = statsText(b.subjectUuid, b.stats);
  return stats ? `${b.material} · ${stats}` : b.material;
};

/** "★★★★ 820 · " before a batch's place; a component's stats instead ("Coolant Rating +5.0 % · "), if any. */
export const qualityPrefix = (b: StockBatch) => {
  if (!b.component) return `${qText(b.quality)} · `;
  const stats = statsText(b.subjectUuid, b.stats);
  return stats ? `${stats} · ` : "";
};

/**
 * A component's stats with the game's names, in the tooltip's order, like the crafting check shows them:
 * "Coolant Rating +5.0 % · Integrity −2.0 %", power pips "+1"; "" without.
 */
export function statsText(subjectUuid: string, stats: Record<string, string> | null): string {
  if (!stats) return "";
  const named = materials.value.get(subjectUuid)?.stats ?? [];
  const known = named.filter((s) => s.uuid in stats).map((s) => `${s.name} ${statValueText(s.kind, stats[s.uuid]!)}`);
  // A stat the catalog no longer lists (blueprint changed) still shows its value
  const other = Object.keys(stats).filter((k) => !named.some((s) => s.uuid === k)).map((k) => `? ${stats[k]}`);
  return [...known, ...other].join(" · ");
}

export { statValueText };

/** "Quantanium · ★★★★ 820 · Area18 · Pers." */
export const batchText = (b: StockBatch) => `${b.material} · ${qText(b.quality)} · ${b.location} · ${ownerText(b)}`;

/** Within a material: best quality first, then the larger batch, then by location. */
export function compareBatches(a: StockBatch, b: StockBatch) {
  return b.quality - a.quality || Number(b.quantity) - Number(a.quantity) || a.location.localeCompare(b.location);
}

const wholeOf = (text: string) => (/^\s*\d{0,6}\s*$/.test(text) ? Number(text.trim() || "0") : null);

/**
 * h, m and s as the terminal shows a refinery time ("4h 17m", "14m 5s"): seconds; undefined when all
 * three are empty (no time); null when invalid (not whole numbers, minutes or seconds over 59, or zero).
 */
export function durationOfParts(h: string, m: string, s: string): number | null | undefined {
  if (![h, m, s].some((x) => x.trim())) return undefined;
  const [hours, minutes, secs] = [wholeOf(h), wholeOf(m), wholeOf(s)];
  if (hours === null || minutes === null || secs === null || minutes > 59 || secs > 59) return null;
  return hours * 3600 + minutes * 60 + secs || null;
}

/** Seconds as the h, m and s fields of durationOfParts. */
export const partsOf = (seconds: number) =>
  ({ h: String(Math.floor(seconds / 3600)), m: String(Math.floor(seconds / 60) % 60), s: String(seconds % 60) });

/** "1h 2m 5s" */
export function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : "", rest || (!h && !m) ? `${rest}s` : ""].filter(Boolean).join(" ");
}
