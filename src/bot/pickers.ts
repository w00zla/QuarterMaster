// Autocomplete choices for stock commands: locations, materials, batches (members: roster.searchMembers).
// Choice values: location UUID; material `<kind>:<uuid>` (ores: the UUID); batch ID.
import type { Db } from '../db/client.ts';
import { formatAmount } from '../stock/amount.ts';
import {
  locationCatalog, materialCatalog, pickableBatches, searchWords, type BatchPick, type PickableBatch,
} from '../stock/lookup.ts';
import type { Actor } from '../stock/service.ts';
import { t, type Lang } from './i18n.ts';

export interface Choice {
  name: string;
  value: string;
}

// Discord limit for choice names
const MAX_NAME = 100;
const fit = (s: string) => (s.length > MAX_NAME ? `${s.slice(0, MAX_NAME - 1)}…` : s);

export async function locationChoices(db: Db, lang: Lang, query: string): Promise<Choice[]> {
  const locations = (await locationCatalog(db, lang)).values();
  return searchWords(locations, query, (l) => `${l.label} ${l.nameEn}`, (l) => l.name)
    .map((l) => ({ name: fit(l.label), value: l.uuid }));
}

/** ores = false: what /qm-stock add takes (with its unit); ores = true: ores for the refinery. */
export async function materialChoices(db: Db, lang: Lang, query: string, ores: boolean): Promise<Choice[]> {
  const materials = [...(await materialCatalog(db, lang)).values()].filter((m) => m.isOre === ores);
  return searchWords(materials, query, (m) => `${m.name} ${m.nameEn}`, (m) => m.name).map((m) => ores
    ? { name: fit(m.name), value: m.uuid }
    : { name: fit(`${m.name} (${t(lang, m.kind === 'item' ? 'unit.pcs' : 'unit.scu')})`), value: `${m.kind}:${m.uuid}` });
}

/**
 * "⚗️ Quantanium · Q820 · 12.5 SCU · Area18 · Org (Hans)" or "… · Personal"; `asTotal` labels the amount as the batch's
 * total ("Total: 12.5 SCU"), for replies after a booking.
 */
export function batchLabel(p: PickableBatch, lang: Lang, asTotal = false): string {
  const b = p.batch;
  const amount = `${formatAmount(b.quantity)} ${t(lang, b.kind === 'item' ? 'unit.pcs' : 'unit.scu')}`;
  return fit([
    `${b.state === 'refining' ? '⚗️ ' : ''}${p.material}`,
    `Q${b.quality}`,
    asTotal ? t(lang, 'stock.list.total', { amount }) : amount,
    p.location,
    b.designation === 'org' ? `${t(lang, 'stock.org')} (${p.holderName ?? '?'})` : t(lang, 'stock.personal'),
  ].filter(Boolean).join(' · '));
}

export async function batchChoices(db: Db, actor: Actor, pick: BatchPick, lang: Lang, query: string): Promise<Choice[]> {
  const batches = (await pickableBatches(db, actor, pick, lang)).map((p) => ({ p, label: batchLabel(p, lang) }));
  // The sort is stable: within one material the quality order of pickableBatches stays
  const found = searchWords(batches, query, (x) => x.label, (x) => x.p.material);
  return found.map((x) => ({ name: x.label, value: String(x.p.batch.id) }));
}
