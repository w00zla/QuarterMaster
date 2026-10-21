// Wording of the blueprint unlocks (info card, dialog): counts per kind, markers, odds.
import type { UnlockKind, UnlockMarker, UnlockOdds } from "../../src/webapp/api-types";
import { lang, t, type Key } from "./i18n";

const KIND_COUNT: Record<UnlockKind, [Key, Key]> = {
  mission: ["unlock.kind.mission.one", "unlock.kind.mission.other"],
  event: ["unlock.kind.event.one", "unlock.kind.event.other"],
};

/** "126 Missionen", "1 Event-Stufe" */
export const kindCount = (kind: UnlockKind, n: number) => t(KIND_COUNT[kind][n === 1 ? 0 : 1], { n });

const MARKER: Record<UnlockMarker, { key: Key; tag: string }> = {
  illegal: { key: "unlock.marker.illegal", tag: "err" },
  event: { key: "unlock.marker.event", tag: "warn" },
  chain: { key: "unlock.marker.chain", tag: "" },
  rank: { key: "unlock.marker.rank", tag: "" },
  random: { key: "unlock.marker.random", tag: "" },
  onAccept: { key: "unlock.marker.onAccept", tag: "" },
};

export const markerText = (m: UnlockMarker) => t(MARKER[m].key);
/** The tag's colour class: illegal red, event yellow, the rest grey. */
export const markerClass = (m: UnlockMarker) => MARKER[m].tag;

const number = (n: number) => new Intl.NumberFormat(lang.value, { maximumFractionDigits: 1 }).format(n);
const percent = (n: number) => new Intl.NumberFormat(lang.value, { style: "percent", maximumFractionDigits: 1 }).format(n);

/** "1 von 7", "1 von 7 · 50 %", "25 %", "sicher" */
export function oddsText(o: UnlockOdds): string {
  const parts = [o.num === o.den ? null : t("unlock.odds", { n: number(o.num), m: number(o.den) }), o.chance === null ? null : percent(o.chance)]
    .filter((p) => p !== null);
  return parts.length ? parts.join(" · ") : t("unlock.certain");
}

/** The best odds, "bis …" when the sources differ. */
export const bestText = (o: { best: UnlockOdds; varies: boolean }) => (o.varies ? t("unlock.upTo", { odds: oddsText(o.best) }) : oddsText(o.best));

/** "ab 120.000 Punkten" */
export const pointsText = (n: number) => t("unlock.fromPoints", { n: new Intl.NumberFormat(lang.value).format(n) });
