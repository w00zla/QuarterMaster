// The web app's blueprint unlocks (catalog.blueprint_source): the info card's summary and the details
// dialog. Game data only; registered by registerRoutes. The shaping below is pure (tested without a DB).
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { getBlueprint } from '../adminapp/queries.ts';
import type {
  UnlockEventTier, UnlockKind, UnlockMarker, UnlockMissionGroup, UnlockMissionRow, UnlockOdds, UnlockSection, UnlockSummary, UnlocksResponse,
} from './api-types.ts';
import { HttpError, type Env } from './routes.ts';
import { starMap, unlockSources, type StarMapPlace, type UnlockSourceRow } from './unlock-query.ts';

/** One source with its texts and places resolved. */
export interface UnlockSource {
  kind: UnlockKind;
  weight: number;
  poolWeight: number;
  chance: number | null;
  title: string;
  missionType: string | null;
  faction: string | null;
  rank: string | null;
  minReputation: number | null;
  systems: string[];
  locations: string[];
  chain: boolean;
  illegal: boolean;
  onAccept: boolean;
  event: string | null;
  minPoints: number | null;
}

// The kinds in display order; a new kind (shops, loot, …) gets its line here and its section below
const KINDS: UnlockKind[] = ['mission', 'event'];

/** The game's placeholders ("~mission(Location)", "~mission(Contractor|Title)") become "…". */
export const cleanTitle = (title: string) => title.replace(/~\w+\([^)]*\)/g, '…').replace(/\s+/g, ' ').trim();

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** The odds of one source: weight of the pool's total, reduced ("2 of 12" -> "1 of 6"). */
export function oddsOf(weight: number, poolWeight: number, chance: number | null): UnlockOdds {
  const c = chance === null || chance >= 1 ? null : chance;
  if (!(weight > 0) || !(poolWeight >= weight)) return { num: 1, den: 1, chance: c };
  if (Number.isInteger(weight) && Number.isInteger(poolWeight)) {
    const d = gcd(poolWeight, weight);
    return { num: weight / d, den: poolWeight / d, chance: c };
  }
  return { num: 1, den: Math.round((poolWeight / weight) * 10) / 10, chance: c };
}

const probability = (o: UnlockOdds) => (o.num / o.den) * (o.chance ?? 1);
const oddsKey = (o: UnlockOdds) => `${o.num}/${o.den}/${o.chance}`;

/** The best odds and whether the odds differ. */
function bestOf(odds: UnlockOdds[]): { best: UnlockOdds; varies: boolean } {
  const best = odds.reduce((a, b) => (probability(b) > probability(a) ? b : a));
  return { best, varies: new Set(odds.map(oddsKey)).size > 1 };
}

const sourceOdds = (s: UnlockSource) => oddsOf(s.weight, s.poolWeight, s.chance);

/** The markers of one source. */
function markersOf(s: UnlockSource): UnlockMarker[] {
  const m: UnlockMarker[] = [];
  if (s.illegal) m.push('illegal');
  if (s.kind === 'mission' && s.event) m.push('event');
  if (s.chain) m.push('chain');
  if ((s.minReputation ?? 0) > 0) m.push('rank');
  if (s.chance !== null && s.chance < 1) m.push('random');
  if (s.onAccept) m.push('onAccept');
  return m;
}

/** One line per kind: the count, the markers every source of it has, the best odds. */
export function unlockSummary(sources: UnlockSource[]): UnlockSummary[] {
  return KINDS.flatMap((kind) => {
    const of = sources.filter((s) => s.kind === kind);
    if (!of.length) return [];
    const sets = of.map(markersOf);
    const markers = sets[0]!.filter((m) => sets.every((set) => set.includes(m)));
    return [{ kind, count: of.length, markers, ...bestOf(of.map(sourceOdds)) }];
  });
}

const byText = (a: string, b: string) => a.localeCompare(b);
// null last
const byOptional = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : byText(a, b));

/** Missions per faction and mission type; equal rows merged with a count, nothing dropped. */
export function missionGroups(sources: UnlockSource[]): UnlockMissionGroup[] {
  const groups = new Map<string, UnlockSource[]>();
  for (const s of sources.filter((x) => x.kind === 'mission')) {
    const key = JSON.stringify([s.faction, s.missionType]);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.values()].map((list) => {
    const rows = new Map<string, { row: UnlockMissionRow; rep: number }>();
    for (const s of list) {
      const row: UnlockMissionRow = {
        title: s.title, rank: s.rank, systems: s.systems, locations: s.locations,
        markers: markersOf(s).filter((m) => m === 'chain' || m === 'illegal' || m === 'onAccept'),
        event: s.event, odds: sourceOdds(s), count: 1,
      };
      const key = JSON.stringify({ ...row, count: 0 });
      const found = rows.get(key);
      if (found) found.row.count++;
      else rows.set(key, { row, rep: s.minReputation ?? -1 });
    }
    const ranked = list.filter((s) => s.rank !== null).sort((a, b) => (a.minReputation ?? 0) - (b.minReputation ?? 0));
    const sorted = [...rows.values()].sort((a, b) => a.rep - b.rep || byText(a.row.title, b.row.title)).map((r) => r.row);
    return {
      faction: list[0]!.faction, missionType: list[0]!.missionType, count: list.length,
      systems: [...new Set(list.flatMap((s) => s.systems))].sort(byText),
      rankFrom: ranked[0]?.rank ?? null, rankTo: ranked.at(-1)?.rank ?? null,
      ...bestOf(list.map(sourceOdds)), rows: sorted,
    };
  }).sort((a, b) => byOptional(a.faction, b.faction) || byOptional(a.missionType, b.missionType));
}

/** Event tiers by event and points; equal ones merged. */
export function eventTiers(sources: UnlockSource[]): UnlockEventTier[] {
  const tiers = new Map<string, UnlockEventTier>();
  for (const s of sources.filter((x) => x.kind === 'event')) {
    const tier = { event: s.event ?? '', minPoints: s.minPoints, odds: sourceOdds(s), count: 1 };
    const key = JSON.stringify({ ...tier, count: 0 });
    const found = tiers.get(key);
    if (found) found.count++;
    else tiers.set(key, tier);
  }
  return [...tiers.values()].sort((a, b) => byText(a.event, b.event) || (a.minPoints ?? 0) - (b.minPoints ?? 0));
}

/** The dialog's sections, one per kind the blueprint has. */
export function unlockSections(sources: UnlockSource[]): UnlockSection[] {
  return KINDS.flatMap((kind): UnlockSection[] => {
    const count = sources.filter((s) => s.kind === kind).length;
    if (!count) return [];
    return [kind === 'mission' ? { kind, count, groups: missionGroups(sources) } : { kind, count, tiers: eventTiers(sources) }];
  });
}

const num = (v: string | null) => (v === null ? null : Number(v));

/** A query row as a source: systems from the localities and bound places, the places that are no system. */
export function toSource(r: UnlockSourceRow, places: Map<string, StarMapPlace>): UnlockSource {
  const all = [...r.localityUuids, ...r.locationUuids].map((u) => places.get(u)).filter((p) => p !== undefined);
  const bound = r.locationUuids.map((u) => places.get(u)).filter((p) => p !== undefined && !p.isSystem);
  return {
    kind: r.kind as UnlockKind, weight: Number(r.weight), poolWeight: Number(r.poolWeight), chance: num(r.chance),
    title: cleanTitle(r.title ?? '') || r.contractKey || '…', missionType: r.missionType, faction: r.faction, rank: r.rank,
    minReputation: num(r.minReputation),
    systems: [...new Set(all.map((p) => p.system).filter((s) => s !== null))].sort(byText),
    locations: [...new Set(bound.map((p) => p!.name))],
    chain: r.requiresPrevious, illegal: r.illegal, onAccept: r.onAccept, event: r.eventKey, minPoints: r.minPoints,
  };
}

/** A blueprint's sources, resolved. */
export async function loadUnlocks(db: Db, blueprintUuid: string, lang: string): Promise<UnlockSource[]> {
  const [found, places] = [await unlockSources(db, blueprintUuid, lang), await starMap(db, lang)];
  return found.map((r) => toSource(r, places));
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export function registerUnlockRoutes(api: Hono<Env>, db: Db) {
  api.get('/unlocks/:uuid', async (c) => {
    const id = uuid.safeParse(c.req.param('uuid'));
    if (!id.success) throw new HttpError(400, 'invalid');
    const lang = c.req.query('lang') === 'de' ? 'de' : 'en';
    const bp = await getBlueprint(db, id.data, lang);
    if (!bp) throw new HttpError(404, 'notFound');
    return c.json({ name: bp.name, sections: unlockSections(await loadUnlocks(db, id.data, lang)) } satisfies UnlocksResponse);
  });
}
