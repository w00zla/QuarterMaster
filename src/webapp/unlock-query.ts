// Reads for the blueprint unlocks (catalog.blueprint_source): a blueprint's sources with their texts, the
// blueprints that have any, and the star map's systems (for the localities a contract is offered at).
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { importCache } from '../db/import-cache.ts';
import { locText, rows } from '../db/query.ts';

/** One source row, texts in the language (else English), numbers as Postgres sends them. */
export interface UnlockSourceRow {
  kind: string;
  weight: string;
  poolWeight: string;
  chance: string | null;
  title: string | null;
  contractKey: string | null;
  missionType: string | null;
  faction: string | null;
  rank: string | null;
  minReputation: string | null;
  localityUuids: string[];
  locationUuids: string[];
  requiresPrevious: boolean;
  illegal: boolean;
  onAccept: boolean;
  eventKey: string | null;
  minPoints: number | null;
}

export const unlockSources = (db: Db, blueprintUuid: string, lang: string) => rows<UnlockSourceRow>(db, sql`
  SELECT s.kind, s.weight::text AS weight, s.pool_weight::text AS "poolWeight", s.chance::text AS chance,
    ${locText(lang, sql`s.title_key`)} AS title, s.contract_key AS "contractKey",
    ${locText(lang, sql`s.mission_type_key`)} AS "missionType", ${locText(lang, sql`s.faction_name_key`)} AS faction,
    ${locText(lang, sql`s.min_rank_name_key`)} AS rank, s.min_reputation::text AS "minReputation",
    s.locality_uuids::text[] AS "localityUuids", s.location_uuids::text[] AS "locationUuids",
    s.requires_previous AS "requiresPrevious", s.illegal, s.on_accept AS "onAccept", s.event_key AS "eventKey", s.min_points AS "minPoints"
  FROM catalog.blueprint_source s
  WHERE s.blueprint_uuid = ${blueprintUuid}
  ORDER BY s.source_index`);

// Blueprints with at least one source; language-independent, cached under one key
const unlockable = importCache(async (db: Db) =>
  new Set((await rows<{ uuid: string }>(db, sql`SELECT DISTINCT blueprint_uuid AS uuid FROM catalog.blueprint_source`)).map((r) => r.uuid)));
export const unlockableBlueprints = (db: Db) => unlockable(db, '');

export interface StarMapPlace {
  // The localized name, else the record key (never empty)
  name: string;
  // The system's name (its star), null when none is found
  system: string | null;
  // A star or a solar system itself: shown as the system, not as a place
  isSystem: boolean;
}

const SYSTEM_TYPES = new Set(['Star', 'SolarSystem']);

/**
 * Every star map object with its system. The system is the star above it; roots without a star (the
 * solar system records, a Nyx asteroid field) get it from their key ("NyxSolarSystem", "Nyx" -> the star
 * "NyxStar"), the longest matching star key wins.
 */
export const starMap = importCache(async (db: Db, lang: string): Promise<Map<string, StarMapPlace>> => {
  const all = await rows<{ uuid: string; key: string; parent: string | null; type: string | null; name: string | null }>(db, sql`
    SELECT l.uuid, l.key, l.parent_uuid AS parent, l.type, ${locText(lang, sql`l.name_key`)} AS name FROM catalog.location l`);
  const byUuid = new Map(all.map((l) => [l.uuid, l]));
  const nameOf = (l: { name: string | null }) => l.name?.trim() || null;
  const starName = (s: { key: string; name: string | null }) => nameOf(s) ?? s.key.replace(/Star$/i, '');
  const stars = all.filter((l) => l.type === 'Star').map((s) => ({ base: s.key.replace(/Star$/i, '').toLowerCase(), name: starName(s) }))
    .filter((s) => s.base).sort((a, b) => b.base.length - a.base.length);
  const systemOf = (uuid: string): string | null => {
    let root = byUuid.get(uuid);
    for (let node = root, n = 0; node && n < 12; n++, node = node.parent ? byUuid.get(node.parent) : undefined) {
      if (node.type === 'Star') return starName(node);
      root = node;
    }
    const key = root?.key.toLowerCase() ?? '';
    return stars.find((s) => key.startsWith(s.base))?.name ?? null;
  };
  return new Map(all.map((l) => [l.uuid, { name: nameOf(l) ?? l.key, system: systemOf(l.uuid), isSystem: SYSTEM_TYPES.has(l.type ?? '') }]));
});
