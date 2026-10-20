// What an org offers: the figures of the web app's org tiles and the bot's board, and the board's
// material lines. Org stock = stored batches shared in the org by its active members.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { importCache } from '../db/import-cache.ts';
import { REWARD_POOL_PATHS, rows } from '../db/query.ts';
import type { StockMetrics } from '../webapp/api-types.ts';
import { formatAmount } from './amount.ts';
import { componentItemSql } from './service.ts';

export interface OrgMetrics extends StockMetrics {
  // Active members
  members: number;
  // Distinct blueprints its active members registered
  blueprints: number;
}

// Blueprints a player can unlock: not retired, not default, in a reward pool (the admin overview's
// "no source" count is the rest); language-independent, cached under one key
const obtainable = importCache(async (db: Db) =>
  (await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM catalog.blueprint b JOIN catalog.raw_record r ON r.uuid = b.uuid
    WHERE b.retired_at IS NULL AND NOT b.is_default AND r.path IN ${REWARD_POOL_PATHS}`))[0]?.n ?? 0);
export const obtainableBlueprints = (db: Db) => obtainable(db, '');

/** Stock figures in the shape of the web app's tiles (exact decimal text). */
export function stockMetrics(s: StockMetricsRow | undefined): StockMetrics {
  return {
    resources: { kinds: s?.resources ?? 0, scu: formatAmount(s?.scu ?? '0'), locations: s?.resourceLocations ?? 0 },
    items: { kinds: s?.items ?? 0, pieces: formatAmount(s?.pieces ?? '0'), locations: s?.itemLocations ?? 0 },
    components: { kinds: s?.components ?? 0, pieces: formatAmount(s?.componentPieces ?? '0'), locations: s?.componentLocations ?? 0 },
  };
}

export interface StockMetricsRow {
  resources: number; scu: string; resourceLocations: number; items: number; pieces: string; itemLocations: number;
  components: number; componentPieces: string; componentLocations: number;
}

/** The columns of StockMetricsRow over stored batches `b`. */
export function stockMetricsSql() {
  const comp = componentItemSql('b.item_uuid');
  const item = sql`b.kind = 'item' AND NOT ${comp}`;
  return sql`count(DISTINCT b.resource_uuid)::int AS resources,
    coalesce(sum(b.quantity) FILTER (WHERE b.kind = 'resource'), 0)::text AS scu,
    count(DISTINCT b.location_uuid) FILTER (WHERE b.kind = 'resource')::int AS "resourceLocations",
    count(DISTINCT b.item_uuid) FILTER (WHERE ${item})::int AS items,
    coalesce(sum(b.quantity) FILTER (WHERE ${item}), 0)::text AS pieces,
    count(DISTINCT b.location_uuid) FILTER (WHERE ${item})::int AS "itemLocations",
    count(DISTINCT b.item_uuid) FILTER (WHERE ${comp})::int AS components,
    coalesce(sum(b.quantity) FILTER (WHERE ${comp}), 0)::text AS "componentPieces",
    count(DISTINCT b.location_uuid) FILTER (WHERE ${comp})::int AS "componentLocations"`;
}

/** The figures of each org in `guildIds` (orgs without anything get zeros). */
export async function orgMetrics(db: Db, guildIds: string[]): Promise<Map<string, OrgMetrics>> {
  if (!guildIds.length) return new Map();
  const ids = sql.join(guildIds.map((g) => sql`${g}`), sql`, `);
  const stock = await rows<StockMetricsRow & { guildId: string }>(db, sql`
    SELECT sh.guild_id AS "guildId", ${stockMetricsSql()}
    FROM app.stock_share sh
    JOIN app.stock_batch b ON b.id = sh.batch_id AND b.state = 'stored'
    JOIN app.member m ON m.guild_id = sh.guild_id AND m.user_id = b.owner_user_id AND m.active
    WHERE sh.guild_id IN (${ids})
    GROUP BY sh.guild_id`);
  const people = await rows<{ guildId: string; members: number; blueprints: number }>(db, sql`
    SELECT o.guild_id AS "guildId",
      (SELECT count(*) FROM app.member m WHERE m.guild_id = o.guild_id AND m.active)::int AS members,
      (SELECT count(DISTINCT b.blueprint_uuid) FROM app.user_blueprint b
        JOIN app.member m ON m.user_id = b.user_id AND m.guild_id = o.guild_id AND m.active)::int AS blueprints
    FROM app.org o WHERE o.guild_id IN (${ids})`);
  return new Map(guildIds.map((g) => {
    const p = people.find((r) => r.guildId === g);
    return [g, { ...stockMetrics(stock.find((r) => r.guildId === g)), members: p?.members ?? 0, blueprints: p?.blueprints ?? 0 }];
  }));
}

export interface OrgMaterial {
  kind: 'resource' | 'item';
  uuid: string;
  // A ship component (an item, no quality)
  component: boolean;
  // Exact decimal text, without trailing zeros
  total: string;
  bestQuality: number;
  // Distinct members holding it
  holders: number;
}

/** The org's stock per material, largest amount first (per kind). */
export async function orgMaterials(db: Db, guildId: string): Promise<OrgMaterial[]> {
  const found = await rows<OrgMaterial>(db, sql`
    SELECT b.kind, coalesce(b.resource_uuid, b.item_uuid) AS uuid, bool_or(${componentItemSql('b.item_uuid')}) AS component,
      sum(b.quantity)::text AS total, max(b.quality)::int AS "bestQuality", count(DISTINCT b.owner_user_id)::int AS holders
    FROM app.stock_share sh
    JOIN app.stock_batch b ON b.id = sh.batch_id AND b.state = 'stored'
    JOIN app.member m ON m.guild_id = sh.guild_id AND m.user_id = b.owner_user_id AND m.active
    WHERE sh.guild_id = ${guildId}
    GROUP BY b.kind, coalesce(b.resource_uuid, b.item_uuid)
    ORDER BY b.kind, sum(b.quantity) DESC`);
  return found.map((m) => ({ ...m, total: formatAmount(m.total) }));
}
