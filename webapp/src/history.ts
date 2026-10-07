// History texts shared by the history view and the toasts for actions from the bot and the
// companion app: an entry's source, category, action, people and details in the UI language. The
// toasts: 'history' realtime messages from another source than the web app come in bursts ("Register
// all" in the companion app sends one per blueprint), so they are collected for a moment, fetched in
// one go, and the same action by the same person from the same source becomes one notice with a
// count. Notices stay until dismissed.
import type { HistoryEntry, HistoryPerson, HistoryResponse } from "../../src/webapp/api-types";
import { api } from "./api";
import { hm, qText, qty } from "./format";
import { isKey, lang, t } from "./i18n";
import { coalesced, onServerMessage } from "./realtime";
import { me } from "./session";
import { notify } from "./toasts";

// Local time as "2026-10-07 14:05" in every language
const pad = (n: number) => String(n).padStart(2, "0");
export function when(at: string): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const sourceText = (e: HistoryEntry) => t(`history.source.${e.source}`);
export const categoryText = (e: HistoryEntry) => t(`history.category.${e.category}`);
export function actionLabel(category: string, action: string): string {
  const key = `history.action.${category}.${action}`;
  return isKey(key) ? t(key) : action;
}
export const actionText = (e: HistoryEntry) => actionLabel(e.category, e.action);
export const personText = (p: HistoryPerson) => (p.userId === me.value?.userId ? t("history.you") : p.name);
/** "Pers." or "Org (holder)", as in the stock lists. */
const ownerText = (designation: "personal" | "org" | null, org: string | null, holder: HistoryPerson | null) =>
  designation === "org" ? `${org ?? "Org"} (${holder ? personText(holder) : "?"})` : t("stock.pers");

/** Amount, quality, place and owner, with what changed (→) and what went in (refinery). */
export function detailsText(e: HistoryEntry): string {
  if (e.category === "blueprint") return "";
  const unit = e.unit ?? "SCU";
  const parts: string[] = [];
  if (e.action === "adjust" && e.from !== null && e.amount !== null) parts.push(`${e.from} → ${qty(e.amount, unit)}`);
  else if (e.amount !== null) parts.push(qty(e.amount, unit));
  if (e.quality !== null) parts.push(qText(e.quality));
  if (e.location) parts.push(e.toLocation ? `${e.location} → ${e.toLocation}` : e.location);
  if (e.category === "stock") {
    const from = ownerText(e.designation, e.org, e.holder);
    const changed = e.toDesignation !== null || e.toHolder !== null;
    const to = ownerText(e.toDesignation ?? e.designation, e.org, e.toHolder ?? e.holder);
    parts.push(changed ? `${from} → ${to}` : from);
  }
  if (e.method) parts.push(e.method);
  if (e.expectedYield) parts.push(`≈ ${qty(e.expectedYield, "SCU")}`);
  if (e.durationSeconds) parts.push(hm(e.durationSeconds));
  if (e.ore && e.oreAmount) parts.push(`← ${e.ore} ${qty(e.oreAmount, "SCU")}${e.oreQuality !== null ? ` ${qText(e.oreQuality)}` : ""}`);
  return parts.join(" · ");
}

// Targets named in a grouped notice
const LISTED = 3;
// Pages fetched per burst at most (100 entries each)
const MAX_PAGES = 10;

const pending = new Set<number>();
// Collecting: until 1 s after the last message, at most 5 s after the first
const flushSoon = coalesced(() => void flush(), 1000, 5000);

/** Fetches the collected entries (everything newer than the oldest of them) and shows them grouped. */
async function flush() {
  const ids = new Set(pending);
  pending.clear();
  if (!ids.size) return;
  const after = Math.min(...ids) - 1;
  const found: HistoryEntry[] = [];
  let before: number | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await api<HistoryResponse>(`/history?lang=${lang.value}&after=${after}${before ? `&before=${before}` : ""}`);
      found.push(...r.entries.filter((e) => ids.has(e.id)));
      if (!r.more || !r.entries.length) break;
      before = r.entries.at(-1)!.id;
    }
  } catch {
    return;
  }
  // Oldest first; one notice per source, person, category and action
  const groups = new Map<string, HistoryEntry[]>();
  for (const e of found.sort((a, b) => a.id - b.id)) {
    const key = [e.source, e.actor.userId, e.category, e.action].join("|");
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const group of groups.values()) notifyGroup(group);
}

/** One entry: "Bot · Stock · Added · Quantanium" with its details; several: the count and the first targets. */
function notifyGroup(group: HistoryEntry[]) {
  const e = group[0]!;
  const title = `${sourceText(e)}${e.actor.userId === me.value?.userId ? "" : ` · ${e.actor.name}`}`;
  if (group.length === 1) return notify(title, `${categoryText(e)} · ${actionText(e)} · ${e.target}`, detailsText(e));
  const names = group.slice(0, LISTED).map((x) => x.target).join(", ");
  const rest = group.length - LISTED;
  notify(title, `${categoryText(e)} · ${actionText(e)} · ${group.length}×`, rest > 0 ? `${names} ${t("history.andMore", { n: rest })}` : names);
}

const off = onServerMessage((m) => {
  if (m.type !== "history" || m.source === "webapp") return;
  pending.add(m.id);
  flushSoon.schedule();
});
// Dev: a hot update runs this module again; the old listener must go, or every notice shows twice
import.meta.hot?.dispose(() => {
  off();
  flushSoon.cancel();
});
