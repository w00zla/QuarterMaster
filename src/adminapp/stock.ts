// Read-only views of the stock for the admin API: stored stock per subject over all users with its holders,
// and every refinery job. Reads app and catalog (and ext for the UEX refineries).
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { locText, one, rows } from '../db/query.ts';
import { COMPONENT_TYPES, fpsTypeSql } from '../catalog/components.ts';
import { ITEM_TYPE_KEY_PREFIX, typeLabel } from '../catalog/labels.ts';
import { refineryLocations } from '../ext/refineries.ts';
import { formatAmount } from '../stock/amount.ts';
import { statValueText } from '../stock/component-stats.ts';
import { locationCatalog } from '../stock/lookup.ts';
import { componentStats } from '../stock/service.ts';
import { OVERDUE_DAYS, userNames } from './users.ts';
import type { RefineryJob, StockHolder, StockRow, StockSubject } from './api-types.ts';

/** Timestamp as ISO 8601 string (the driver would return Postgres' text format here). */
const iso = (e: SQL) => sql`to_json(${e}) #>> '{}'`;
const unitOf = (kind: string) => (kind === 'resource' ? 'SCU' as const : 'pcs' as const);
// Resource `r` / item `i` joined
const materialName = (lang: string) => sql`coalesce(${locText(lang, sql`coalesce(r.name_key, i.name_key)`)}, r.key, i.class_name)`;
const placeName = (lang: string) => sql`coalesce(${locText(lang, sql`l.name_key`)}, l.key)`;
// Gear by the item type alone (also when the catalog retired it or a variant took over as the plain part)
const shipSql = sql.raw(`i.type IN (${COMPONENT_TYPES.map((t) => `'${t}'`).join(', ')})`);
const fpsSql = sql.raw(fpsTypeSql('i'));
// The StockGroup: resource (SCU) and harvestable (items that are not gear) make the user web app's Resources tab, gear its Gear tab
const SUBJECT_COLUMNS = (lang: string, kind: SQL) => sql`${materialName(lang)} AS name,
  CASE WHEN ${kind} = 'resource' THEN 'resource' WHEN ${shipSql} OR ${fpsSql} THEN 'gear' ELSE 'harvestable' END AS "group",
  CASE WHEN ${shipSql} THEN 'ship' WHEN ${fpsSql} THEN 'fps' END AS gear,
  i.type, ${locText(lang, sql`${ITEM_TYPE_KEY_PREFIX} || lower(i.type)`)} AS "typeLabel"`;

type SubjectBase = Omit<StockRow, 'unit' | 'total' | 'batches' | 'owners' | 'shared' | 'orgs' | 'minQuality' | 'maxQuality' | 'withStats'>;
const withType = <T extends SubjectBase>(s: T): T => ({ ...s, typeLabel: typeLabel(s.type, s.typeLabel) });

/** Stored stock per subject over all users, largest amount first per kind. */
export async function getStock(db: Db, lang: string): Promise<StockRow[]> {
  const found = await rows<StockRow>(db, sql`
    WITH sh AS (
      SELECT coalesce(b.resource_uuid, b.item_uuid) AS uuid, count(DISTINCT s.guild_id)::int AS orgs
      FROM app.stock_share s JOIN app.stock_batch b ON b.id = s.batch_id
      WHERE b.state = 'stored'
      GROUP BY 1)
    SELECT b.kind, coalesce(b.resource_uuid, b.item_uuid) AS uuid, ${SUBJECT_COLUMNS(lang, sql`b.kind`)},
      sum(b.quantity)::text AS total, count(*)::int AS batches, count(DISTINCT b.owner_user_id)::int AS owners,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM app.stock_share s WHERE s.batch_id = b.id))::int AS shared,
      coalesce(sh.orgs, 0) AS orgs, min(b.quality) AS "minQuality", max(b.quality) AS "maxQuality",
      count(*) FILTER (WHERE b.stats IS NOT NULL)::int AS "withStats"
    FROM app.stock_batch b
    LEFT JOIN catalog.resource r ON r.uuid = b.resource_uuid
    LEFT JOIN catalog.item i ON i.uuid = b.item_uuid
    LEFT JOIN sh ON sh.uuid = coalesce(b.resource_uuid, b.item_uuid)
    WHERE b.state = 'stored'
    GROUP BY b.kind, b.resource_uuid, b.item_uuid, r.uuid, i.uuid, sh.orgs
    ORDER BY b.kind DESC, sum(b.quantity) DESC, name`);
  return found.map((s) => {
    const gear = s.group === 'gear';
    return {
      ...withType(s), unit: unitOf(s.kind), total: formatAmount(s.total),
      // Gear is stored with quality 0 and has no quality to show
      minQuality: gear ? null : s.minQuality, maxQuality: gear ? null : s.maxQuality,
    };
  });
}

/**
 * Who holds a subject: every batch of it, stored ones first (refinery jobs count as not stock yet), with the
 * orgs it is shared in and, for gear, its stats by name. Null when the catalog does not know the subject.
 */
export async function getStockSubject(db: Db, kind: 'resource' | 'item', uuid: string, lang: string): Promise<StockSubject | null> {
  const subject = await one<SubjectBase>(db, sql`
    SELECT ${kind} AS kind, coalesce(r.uuid, i.uuid) AS uuid, ${SUBJECT_COLUMNS(lang, sql`${kind}`)}
    FROM (SELECT 1) x
    LEFT JOIN catalog.resource r ON ${kind} = 'resource' AND r.uuid = ${uuid}
    LEFT JOIN catalog.item i ON ${kind} = 'item' AND i.uuid = ${uuid}
    WHERE r.uuid IS NOT NULL OR i.uuid IS NOT NULL`);
  if (!subject) return null;

  const found = await rows<Omit<StockHolder, 'owner' | 'stats'> & { userId: string; locationUuid: string; stats: Record<string, string> | null }>(db, sql`
    SELECT b.id::int AS "batchId", b.owner_user_id AS "userId", l.uuid AS "locationUuid", ${placeName(lang)} AS location,
      b.quantity::text AS quantity, b.quality, b.state, b.lot IS NOT NULL AS lot, b.stats,
      coalesce((SELECT array_agg(o.name ORDER BY lower(o.name)) FROM app.stock_share s JOIN app.org o ON o.guild_id = s.guild_id
        WHERE s.batch_id = b.id), '{}') AS orgs
    FROM app.stock_batch b
    JOIN catalog.location l ON l.uuid = b.location_uuid
    WHERE b.kind = ${kind} AND coalesce(b.resource_uuid, b.item_uuid) = ${uuid}
    ORDER BY b.state = 'refining', b.quantity DESC, b.id`);

  // Stat names in the tooltip's order (Integrity last); the kind (percent or steps) from the blueprints
  const keys = [...new Set(found.flatMap((b) => Object.keys(b.stats ?? {})))];
  const properties = keys.length ? await rows<{ uuid: string; key: string; name: string }>(db, sql`
    SELECT cp.uuid::text AS uuid, cp.key, coalesce(${locText(lang, sql`cp.name_key`)}, cp.key) AS name
    FROM catalog.crafted_property cp WHERE cp.uuid::text IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`) : [];
  properties.sort((a, b) => Number(a.key === 'GPP_Health_MaxHealth') - Number(b.key === 'GPP_Health_MaxHealth') || a.key.localeCompare(b.key));
  const bounds = keys.length && kind === 'item' ? (await componentStats(db, sql`i.uuid = ${uuid}`)).get(uuid) : undefined;
  const statsOf = (stats: Record<string, string> | null) => {
    if (!stats) return [];
    const value = (k: string) => {
      const kindOf = bounds?.get(k)?.kind;
      return kindOf ? statValueText(kindOf, stats[k]!) : stats[k]!;
    };
    const known = properties.filter((p) => p.uuid in stats).map((p) => ({ name: p.name, value: value(p.uuid) }));
    const other = Object.keys(stats).filter((k) => !properties.some((p) => p.uuid === k)).map((k) => ({ name: k, value: stats[k]! }));
    return [...known, ...other];
  };

  const names = await userNames(db);
  const locations = await locationCatalog(db, lang);
  const holders = found.map(({ userId, locationUuid, stats, ...b }): StockHolder => ({
    ...b,
    owner: { userId, name: names.get(userId)?.name ?? null },
    // Ambiguous names with their system; a location no longer selectable by its plain name
    location: locations.get(locationUuid)?.short ?? b.location,
    quantity: formatAmount(b.quantity),
    quality: subject.group === 'gear' ? null : b.quality,
    stats: statsOf(stats),
  }));
  return { ...withType(subject), unit: unitOf(kind), holders };
}

/** Every refinery job (the batches sharing `refine_job`), the next to end first, jobs without an end last. */
export async function getRefineryJobs(db: Db, lang: string): Promise<RefineryJob[]> {
  type Row = Omit<RefineryJob, 'owner' | 'location' | 'atRefinery'> & { userId: string; locationUuid: string; location: string };
  const found = await rows<Row>(db, sql`
    SELECT b.refine_job AS "jobId", b.owner_user_id AS "userId", l.uuid AS "locationUuid", ${placeName(lang)} AS location,
      ${iso(sql`min(b.refine_started_at)`)} AS "startedAt", ${iso(sql`max(b.refine_ends_at)`)} AS "endsAt",
      CASE WHEN max(b.refine_ends_at) IS NULL THEN 'open' WHEN max(b.refine_ends_at) > now() THEN 'running'
        WHEN max(b.refine_ends_at) < now() - ${`${OVERDUE_DAYS} days`}::interval THEN 'overdue' ELSE 'ready' END AS state,
      json_agg(json_build_object('name', ${materialName(lang)}, 'quantity', b.quantity::text, 'quality', b.quality)
        ORDER BY ${materialName(lang)}, b.quality DESC) AS materials,
      sum(b.quantity)::text AS scu
    FROM app.stock_batch b
    JOIN catalog.location l ON l.uuid = b.location_uuid
    LEFT JOIN catalog.resource r ON r.uuid = b.resource_uuid
    LEFT JOIN catalog.item i ON i.uuid = b.item_uuid
    WHERE b.state = 'refining'
    GROUP BY b.refine_job, b.owner_user_id, l.uuid
    ORDER BY max(b.refine_ends_at) NULLS LAST, min(b.refine_started_at), b.refine_job`);
  const names = await userNames(db);
  const locations = await locationCatalog(db, lang);
  // Without UEX data every selectable location counts as a refinery
  const refineries = await refineryLocations(db);
  return found.map(({ userId, locationUuid, location, ...j }) => ({
    ...j,
    owner: { userId, name: names.get(userId)?.name ?? null },
    location: { uuid: locationUuid, name: locations.get(locationUuid)?.short ?? location },
    atRefinery: !refineries || refineries.has(locationUuid),
    materials: j.materials.map((m) => ({ ...m, quantity: formatAmount(m.quantity) })),
    scu: formatAmount(j.scu),
  }));
}
