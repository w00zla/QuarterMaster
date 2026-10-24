// Reads for the mining data (catalog.mining_provider, catalog.mineable): what is mined where, the mined
// resources with their refined material and item, and the star map objects' parents.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { importCache } from '../db/import-cache.ts';
import { locText, rows } from '../db/query.ts';

/** One mineable row with its provider's places, numbers as Postgres sends them. */
export interface MineableRow {
  oreUuid: string;
  ore: string;
  method: 'ship' | 'roc' | 'fps';
  qualityScale: string;
  share: string;
  minPercent: string;
  maxPercent: string;
  rarity: string | null;
  qualityMin: number | null;
  qualityMax: number | null;
  qualityValues: Array<{ value: number; chance: number }>;
  locationUuids: string[];
}

/** What yields the resource: mined itself, refined into it, or breaking into the item (a gem). */
export const mineablesOf = (db: Db, uuid: string, lang: string) => rows<MineableRow>(db, sql`
  SELECT r.uuid AS "oreUuid", coalesce(${locText(lang, sql`r.name_key`)}, r.key) AS ore, m.method, m.quality_scale::text AS "qualityScale",
    m.share::text AS share, m.min_percent::text AS "minPercent", m.max_percent::text AS "maxPercent", m.rarity,
    m.quality_min AS "qualityMin", m.quality_max AS "qualityMax", m.quality_values AS "qualityValues",
    p.location_uuids::text[] AS "locationUuids"
  FROM catalog.mineable m
  JOIN catalog.mining_provider p ON p.uuid = m.provider_uuid
  JOIN catalog.resource r ON r.uuid = m.resource_uuid
  WHERE m.resource_uuid = ${uuid} OR r.refined_uuid = ${uuid} OR m.item_uuid = ${uuid}`);

export interface MinedResourceRow {
  uuid: string;
  name: string;
  refinedUuid: string | null;
  refined: string | null;
  itemUuid: string | null;
  methods: Array<'ship' | 'roc' | 'fps'>;
}

/** Every mined resource with the methods it is mined with. */
export const minedResources = importCache(async (db: Db, lang: string) => rows<MinedResourceRow>(db, sql`
  SELECT r.uuid, coalesce(${locText(lang, sql`r.name_key`)}, r.key) AS name,
    f.uuid AS "refinedUuid", CASE WHEN f.uuid IS NULL THEN NULL ELSE coalesce(${locText(lang, sql`f.name_key`)}, f.key) END AS refined,
    (array_agg(m.item_uuid) FILTER (WHERE m.item_uuid IS NOT NULL))[1] AS "itemUuid",
    array_agg(DISTINCT m.method ORDER BY m.method) AS methods
  FROM catalog.mineable m
  JOIN catalog.resource r ON r.uuid = m.resource_uuid
  LEFT JOIN catalog.resource f ON f.uuid = r.refined_uuid
  GROUP BY r.uuid, f.uuid`));

/** Every uuid the mining data answers for (mined and refined resources, items); language-independent. */
const minableSet = importCache(async (db: Db) => new Set((await rows<{ uuid: string }>(db, sql`
  SELECT m.resource_uuid AS uuid FROM catalog.mineable m
  UNION SELECT r.refined_uuid FROM catalog.mineable m JOIN catalog.resource r ON r.uuid = m.resource_uuid WHERE r.refined_uuid IS NOT NULL
  UNION SELECT m.item_uuid FROM catalog.mineable m WHERE m.item_uuid IS NOT NULL`)).map((r) => r.uuid)));
export const minableUuids = (db: Db) => minableSet(db, '');

export interface PlaceInfo { key: string; type: string | null; parent: string | null }

/** Key, type and parent of every star map object; language-independent. */
const placeInfo = importCache(async (db: Db) => new Map((await rows<{ uuid: string } & PlaceInfo>(db, sql`
  SELECT uuid, key, type, parent_uuid AS parent FROM catalog.location`)).map(({ uuid, ...p }) => [uuid, p])));
export const placeInfos = (db: Db) => placeInfo(db, '');

/** The name of a resource or item, null when the catalog has neither. */
export async function subjectName(db: Db, uuid: string, lang: string): Promise<string | null> {
  const [found] = await rows<{ name: string }>(db, sql`
    SELECT coalesce(${locText(lang, sql`r.name_key`)}, r.key) AS name FROM catalog.resource r WHERE r.uuid = ${uuid}
    UNION ALL SELECT coalesce(${locText(lang, sql`i.name_key`)}, i.class_name) FROM catalog.item i WHERE i.uuid = ${uuid}`);
  return found?.name ?? null;
}

// Places whose name says nothing of where they are: the game's text of the area they lie in (the two Nyx
// asteroid clusters are both called "Asteroid Cluster"; the ring texts hang on no star map object)
const AREA_TEXTS: Record<string, string> = {
  AsteroidCluster_Nyx_Glaciem: 'nyx_asteroidbelt1',
  AsteroidCluster_Nyx_Keeger: 'nyx_asteroidbelt2',
};

/** Location uuid -> the name of the area it lies in (see AREA_TEXTS). */
export const placeAreas = importCache(async (db: Db, lang: string) => new Map((await rows<{ uuid: string; name: string | null }>(db, sql`
  SELECT l.uuid, ${locText(lang, sql`a.key`)} AS name
  FROM catalog.location l
  JOIN (VALUES ${sql.join(Object.entries(AREA_TEXTS).map(([k, v]) => sql`(${k}, ${v})`), sql`, `)}) AS a(location_key, key) ON a.location_key = l.key`))
  .filter((r) => r.name).map((r) => [r.uuid, r.name!])));
