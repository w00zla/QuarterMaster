// The admin's view of the mining data (catalog.mining_provider, catalog.mineable): every provider with its
// places and methods, and per provider what it yields. Places and systems as the web app names them.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { locText as text, one, rows } from '../db/query.ts';
import { starMap } from '../webapp/unlock-query.ts';
import type { MineableDetailRow, MiningMethod, MiningPlace, MiningProviderDetail, MiningProviderRow } from './api-types.ts';

interface ProviderRaw { uuid: string; key: string; locationUuids: string[]; methods: MiningMethod[]; resources: number }

const PROVIDERS = sql`
  SELECT p.uuid, p.key, p.location_uuids::text[] AS "locationUuids",
    array_agg(DISTINCT m.method ORDER BY m.method) AS methods, count(DISTINCT m.resource_uuid)::int AS resources
  FROM catalog.mining_provider p JOIN catalog.mineable m ON m.provider_uuid = p.uuid`;

async function withPlaces(db: Db, lang: string, list: ProviderRaw[]): Promise<MiningProviderRow[]> {
  const names = await starMap(db, lang);
  const keys = new Map((await rows<{ uuid: string; key: string }>(db, sql`
    SELECT uuid, key FROM catalog.location WHERE uuid IN (SELECT unnest(location_uuids) FROM catalog.mining_provider)`)).map((l) => [l.uuid, l.key]));
  return list.map(({ locationUuids, ...p }) => {
    const places: MiningPlace[] = locationUuids.map((uuid) => ({
      uuid, key: keys.get(uuid) ?? uuid, name: names.get(uuid)?.name ?? keys.get(uuid) ?? uuid, system: names.get(uuid)?.system ?? null,
    })).sort((a, b) => a.name.localeCompare(b.name));
    const systems = [...new Set(places.map((l) => l.system).filter((s): s is string => !!s))].sort();
    return { ...p, places, systems };
  });
}

export async function getMiningProviders(db: Db, lang: string): Promise<MiningProviderRow[]> {
  return withPlaces(db, lang, await rows<ProviderRaw>(db, sql`${PROVIDERS} GROUP BY p.uuid ORDER BY p.key`));
}

export async function getMiningProvider(db: Db, uuid: string, lang: string): Promise<MiningProviderDetail | null> {
  const found = await one<ProviderRaw>(db, sql`${PROVIDERS} WHERE p.uuid = ${uuid} GROUP BY p.uuid`);
  if (!found) return null;
  const [provider] = await withPlaces(db, lang, [found]);
  const mineables = (await rows<{
    method: MiningMethod; qualityScale: string; resourceUuid: string; resourceKey: string; resource: string; itemUuid: string | null; itemKey: string | null;
    item: string | null; share: string; minPercent: string; maxPercent: string; rarity: string | null;
    qualityMin: number | null; qualityMax: number | null; qualityValues: Array<{ value: number; chance: number }>;
  }>(db, sql`
    SELECT m.method, m.quality_scale::text AS "qualityScale", r.uuid AS "resourceUuid", r.key AS "resourceKey", coalesce(${text(lang, sql`r.name_key`)}, r.key) AS resource,
      i.uuid AS "itemUuid", i.class_name AS "itemKey", coalesce(${text(lang, sql`i.name_key`)}, i.class_name) AS item,
      m.share::text AS share, m.min_percent::text AS "minPercent", m.max_percent::text AS "maxPercent", m.rarity,
      m.quality_min AS "qualityMin", m.quality_max AS "qualityMax", m.quality_values AS "qualityValues"
    FROM catalog.mineable m
    JOIN catalog.resource r ON r.uuid = m.resource_uuid
    LEFT JOIN catalog.item i ON i.uuid = m.item_uuid
    WHERE m.provider_uuid = ${uuid}
    ORDER BY m.method, m.share DESC, resource, m.quality_scale DESC`)).map((m): MineableDetailRow => ({
    method: m.method, qualityScale: Number(m.qualityScale),
    resource: { uuid: m.resourceUuid, key: m.resourceKey, name: m.resource },
    item: m.itemUuid ? { uuid: m.itemUuid, key: m.itemKey!, name: m.item! } : null,
    share: Number(m.share), minPercent: Number(m.minPercent), maxPercent: Number(m.maxPercent), rarity: m.rarity,
    quality: m.qualityMin === null || m.qualityMax === null ? null : { min: m.qualityMin, max: m.qualityMax, values: m.qualityValues },
  }));
  return { ...provider!, mineables };
}
