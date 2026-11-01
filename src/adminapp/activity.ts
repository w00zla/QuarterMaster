// The admin's dashboard (is everything running, is it used, do the data hold: one call) and the activity
// list (app.history, newest first, filtered, paged by id). Read-only. Days are UTC days; the 7-day figures
// are rolling (now - 7 days). app.history has no index on created_at: the day series scan the table.
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { locText, one, rows } from '../db/query.ts';
import { blueprintCatalog } from '../bot/blueprints.ts';
import type { Lang } from '../bot/i18n.ts';
import { COMPONENT_TYPES, fpsTypeSql } from '../catalog/components.ts';
import { formatAmount } from '../stock/amount.ts';
import { getStatus } from './status.ts';
import { getDataChecks, getOrgs, userNames } from './users.ts';
import type {
  ActivityResponse, ActivityRow, ActivitySource, AttentionItem, DashboardResponse, DataCheckKey, DayCount, DaySources, Health,
} from './api-types.ts';

/** Timestamp as ISO 8601 string (the driver would return Postgres' text format here). */
const iso = (e: SQL) => sql`to_json(${e}) #>> '{}'`;
// History row `h` with resource `r` / item `i` joined
const materialName = (lang: string) => sql`coalesce(${locText(lang, sql`coalesce(r.name_key, i.name_key)`)}, r.key, i.class_name)`;
const placeName = (lang: string, alias: string) => sql`coalesce(${locText(lang, sql.raw(`${alias}.name_key`))}, ${sql.raw(alias)}.key)`;
// A location UUID out of details (NULL when missing or malformed: the cast would fail the query)
const detailUuid = (field: string) => sql.raw(`CASE WHEN h.details->>'${field}' ~ '^[0-9a-fA-F-]{36}$' THEN (h.details->>'${field}')::uuid END`);
// The joined catalog.item `i` is gear (as isComponentType || isFpsType)
const GEAR = sql.raw(`(i.type IN (${COMPONENT_TYPES.map((t) => `'${t}'`).join(', ')}) OR ${fpsTypeSql('i')})`);

type Names = Awaited<ReturnType<typeof userNames>>;
const ref = (names: Names, userId: string) => ({ userId, name: names.get(userId)?.name ?? null });

// --- activity -----------------------------------------------------------------------------

export const SOURCES: readonly ActivitySource[] = ['bot', 'webapp', 'companion'];
export const CATEGORIES = ['stock', 'refinery', 'blueprint'] as const;
// Every action the history's CHECK allows, over all categories
export const ACTIONS = ['add', 'remove', 'adjust', 'move', 'share', 'unshare', 'give', 'split', 'merge', 'start', 'done'] as const;
export const ACTIVITY_LIMIT = 100;
export const ACTIVITY_MAX = 200;

export interface ActivityFilter {
  // Rows with a smaller id (the cursor)
  before?: number;
  limit: number;
  source?: string;
  category?: string;
  action?: string;
  guildId?: string;
  // Actor, owner or new owner
  userId?: string;
  // Only the last n days
  days?: number;
}

const SNOWFLAKE = /^[0-9]{17,20}$/;
const positive = (v: string | undefined) => {
  const n = Number(v);
  return v && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};
const oneOf = (v: string | undefined, allowed: readonly string[]) => (v && allowed.includes(v) ? v : undefined);

/** The filter from query parameters; anything invalid is left out. */
export function activityFilter(query: (name: string) => string | undefined): ActivityFilter {
  const days = positive(query('days'));
  return {
    before: positive(query('before')),
    limit: Math.min(positive(query('limit')) ?? ACTIVITY_LIMIT, ACTIVITY_MAX),
    source: oneOf(query('source'), SOURCES),
    category: oneOf(query('category'), CATEGORIES),
    action: oneOf(query('action'), ACTIONS),
    guildId: SNOWFLAKE.test(query('guild') ?? '') ? query('guild') : undefined,
    userId: SNOWFLAKE.test(query('user') ?? '') ? query('user') : undefined,
    days: days && Math.min(days, 3650),
  };
}

type RawRow = Omit<ActivityRow, 'actor' | 'owner' | 'toOwner' | 'unit'> & { actorUserId: string; ownerUserId: string; toOwnerUserId: string | null };

async function activityRows(db: Db, lang: string, f: ActivityFilter, names: Names): Promise<ActivityResponse> {
  const where: SQL[] = [];
  if (f.before) where.push(sql`h.id < ${f.before}`);
  if (f.source) where.push(sql`h.source = ${f.source}`);
  if (f.category) where.push(sql`h.category = ${f.category}`);
  if (f.action) where.push(sql`h.action = ${f.action}`);
  if (f.guildId) where.push(sql`h.guild_id = ${f.guildId}`);
  if (f.userId) where.push(sql`(h.actor_user_id = ${f.userId} OR h.owner_user_id = ${f.userId} OR h.to_owner_user_id = ${f.userId})`);
  if (f.days) where.push(sql`h.created_at > now() - make_interval(days => ${f.days}::int)`);
  // One more than asked: tells whether there is a next page
  const found = await rows<RawRow>(db, sql`
    SELECT h.id::int AS id, ${iso(sql`h.created_at`)} AS at, h.source, h.category, h.action,
      h.actor_user_id AS "actorUserId", h.owner_user_id AS "ownerUserId", h.to_owner_user_id AS "toOwnerUserId",
      h.guild_id AS "guildId", o.name AS org, h.target_kind AS "targetKind", h.target_uuid AS "targetUuid",
      ${materialName(lang)} AS target, h.details->>'amount' AS amount, (h.details->>'quality')::int AS quality,
      ${placeName(lang, 'l')} AS location, ${placeName(lang, 'tl')} AS "toLocation", h.details
    FROM app.history h
    LEFT JOIN app.org o ON o.guild_id = h.guild_id
    LEFT JOIN catalog.resource r ON h.target_kind = 'resource' AND r.uuid = h.target_uuid
    LEFT JOIN catalog.item i ON h.target_kind = 'item' AND i.uuid = h.target_uuid
    LEFT JOIN catalog.location l ON l.uuid = ${detailUuid('locationUuid')}
    LEFT JOIN catalog.location tl ON tl.uuid = ${detailUuid('toLocationUuid')}
    ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
    ORDER BY h.id DESC
    LIMIT ${f.limit + 1}`);
  const page = found.slice(0, f.limit);
  const catalog = page.some((h) => h.targetKind === 'blueprint') ? await blueprintCatalog(db, lang as Lang) : null;
  return {
    rows: page.map(({ actorUserId, ownerUserId, toOwnerUserId, ...h }): ActivityRow => ({
      ...h,
      actor: ref(names, actorUserId),
      owner: ref(names, ownerUserId),
      toOwner: toOwnerUserId ? ref(names, toOwnerUserId) : null,
      target: h.targetKind === 'blueprint' ? catalog?.byUuid.get(h.targetUuid)?.label ?? h.targetUuid : h.target ?? h.targetUuid,
      amount: h.amount === null ? null : formatAmount(h.amount),
      unit: h.targetKind === 'blueprint' ? null : h.targetKind === 'resource' ? 'SCU' : 'pcs',
    })),
    next: found.length > f.limit ? page[page.length - 1]!.id : null,
  };
}

export async function getActivity(db: Db, lang: string, filter: ActivityFilter): Promise<ActivityResponse> {
  return activityRows(db, lang, filter, await userNames(db));
}

// --- dashboard ----------------------------------------------------------------------------

export const DASHBOARD_DAYS = [7, 30, 90] as const;
// Days of the KPI sparklines
export const SERIES_DAYS = 30;
const LATEST_ROWS = 12;
// Reach: a web login or companion use within this many days counts
export const REACH_DAYS = 30;

const RANK: Record<Health, number> = { ok: 0, warn: 1, err: 2 };
const worst = (states: Health[]): Health | null => (states.length ? states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : null);

const CHECK_TEXT: Record<DataCheckKey, string> = {
  retiredMaterial: 'Stock of retired materials',
  retiredLocation: 'Stock at retired locations',
  retiredBlueprint: 'Registered retired blueprints',
  jobNotAtRefinery: 'Refinery jobs outside the UEX refineries',
};

export async function getDashboard(db: Db, lang: string, days: number): Promise<DashboardResponse> {
  const names = await userNames(db);
  const status = await getStatus(db);
  const checks = await getDataChecks(db, 'en');

  const attention: AttentionItem[] = [];
  if (!status.game) attention.push({ severity: 'err', text: 'No catalog import', to: '/imports' });
  const uexLate = status.uex.filter((e) => e.state !== 'ok');
  if (!status.uex.length) attention.push({ severity: 'warn', text: 'UEX pull: no data yet', to: '/status' });
  else if (uexLate.length) {
    const state = worst(uexLate.map((e) => e.state)) as 'warn' | 'err';
    attention.push({ severity: state, text: `UEX pull ${state === 'err' ? 'stale' : 'late'}: ${uexLate.length} of ${status.uex.length} endpoints`, to: '/status' });
  }
  for (const g of status.botLogs) {
    if (g.state === 'ok') continue;
    const what = !g.marked ? 'not started' : g.state === 'err' ? 'stuck' : 'behind';
    attention.push({ severity: g.state, text: `Bot logs ${what}: ${g.org}`, to: '/status' });
  }
  for (const c of checks) {
    if (c.hits.length) attention.push({ severity: 'warn', text: `${CHECK_TEXT[c.key]}: ${c.hits.length}`, to: '/status' });
  }
  attention.sort((a, b) => RANK[b.severity] - RANK[a.severity]);

  // One row per UTC day over the longer of the chart and the sparklines, every day present
  const span = Math.max(days, SERIES_DAYS);
  const perDay = await rows<DaySources & { users: number }>(db, sql`
    WITH h AS (
      SELECT (created_at AT TIME ZONE 'UTC')::date AS day, source, actor_user_id FROM app.history
      WHERE created_at >= ((now() AT TIME ZONE 'UTC')::date - ${span - 1}::int)::timestamp AT TIME ZONE 'UTC')
    SELECT to_char(d, 'YYYY-MM-DD') AS day,
      count(h.day) FILTER (WHERE h.source = 'bot')::int AS bot,
      count(h.day) FILTER (WHERE h.source = 'webapp')::int AS webapp,
      count(h.day) FILTER (WHERE h.source = 'companion')::int AS companion,
      count(DISTINCT h.actor_user_id)::int AS users
    FROM generate_series(((now() AT TIME ZONE 'UTC')::date - ${span - 1}::int)::timestamp, (now() AT TIME ZONE 'UTC')::date::timestamp,
      interval '1 day') d
    LEFT JOIN h ON h.day = d::date
    GROUP BY d ORDER BY d`);
  const series = perDay.slice(-SERIES_DAYS);

  const week = (await one<{ users: number; actions: number } & Record<ActivitySource, number>>(db, sql`
    SELECT count(DISTINCT actor_user_id)::int AS users, count(*)::int AS actions,
      count(*) FILTER (WHERE source = 'bot')::int AS bot, count(*) FILTER (WHERE source = 'webapp')::int AS webapp,
      count(*) FILTER (WHERE source = 'companion')::int AS companion
    FROM app.history WHERE created_at > now() - interval '7 days'`))!;

  const stock = (await one<{ batches: number; owners: number; scu: string; pcs: string; gear: string; running: number; ready: number }>(db, sql`
    SELECT count(*) FILTER (WHERE b.state = 'stored')::int AS batches,
      count(DISTINCT b.owner_user_id) FILTER (WHERE b.state = 'stored')::int AS owners,
      coalesce(sum(b.quantity) FILTER (WHERE b.state = 'stored' AND b.kind = 'resource'), 0)::text AS scu,
      coalesce(sum(b.quantity) FILTER (WHERE b.state = 'stored' AND b.kind = 'item'), 0)::text AS pcs,
      coalesce(sum(b.quantity) FILTER (WHERE b.state = 'stored' AND b.kind = 'item' AND ${GEAR}), 0)::text AS gear,
      count(DISTINCT b.refine_job) FILTER (WHERE b.refine_ends_at IS NULL OR b.refine_ends_at > now())::int AS running,
      count(DISTINCT b.refine_job) FILTER (WHERE b.refine_ends_at <= now())::int AS ready
    FROM app.stock_batch b
    LEFT JOIN catalog.item i ON i.uuid = b.item_uuid`))!;

  const facts = (await one<{
    activeMembers: number; owned: number; blueprintUsers: number; viaCompanion: number;
    inOrg: number; holdingData: number; webLogin: number; companion: number;
  }>(db, sql`
    SELECT
      (SELECT count(DISTINCT m.user_id) FROM app.member m JOIN bot.guild g ON g.guild_id = m.guild_id AND g.left_at IS NULL
        WHERE m.active)::int AS "activeMembers",
      (SELECT count(*) FROM app.user_blueprint)::int AS owned,
      (SELECT count(DISTINCT user_id) FROM app.user_blueprint)::int AS "blueprintUsers",
      (SELECT count(*) FROM app.history WHERE category = 'blueprint' AND action = 'add' AND source = 'companion')::int AS "viaCompanion",
      (SELECT count(DISTINCT user_id) FROM app.member WHERE active)::int AS "inOrg",
      (SELECT count(*) FROM (SELECT owner_user_id FROM app.stock_batch UNION SELECT user_id FROM app.user_blueprint) d)::int AS "holdingData",
      (SELECT count(DISTINCT user_id) FROM web.session WHERE last_seen_at > now() - make_interval(days => ${REACH_DAYS}::int))::int AS "webLogin",
      (SELECT count(*) FROM web.api_token WHERE last_used_at > now() - make_interval(days => ${REACH_DAYS}::int))::int AS companion`))!;

  const orgs = (await getOrgs(db)).sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));

  return {
    checkedAt: status.checkedAt,
    attention,
    kpis: {
      activeUsers: { value: week.users, known: names.size, series: series.map((d): DayCount => ({ day: d.day, count: d.users })) },
      actions: {
        value: week.actions,
        bySource: { bot: week.bot, webapp: week.webapp, companion: week.companion },
        series: series.map((d): DayCount => ({ day: d.day, count: d.bot + d.webapp + d.companion })),
      },
      orgs: { withBot: orgs.filter((o) => o.joinedAt !== null && o.leftAt === null).length, total: orgs.length, activeMembers: facts.activeMembers },
      stock: {
        batches: stock.batches, owners: stock.owners,
        resourceScu: formatAmount(stock.scu), itemPcs: formatAmount(stock.pcs), gearPcs: formatAmount(stock.gear),
      },
      refinery: { running: stock.running, ready: stock.ready },
      blueprints: { owned: facts.owned, users: facts.blueprintUsers, viaCompanion: facts.viaCompanion },
    },
    perDay: perDay.slice(-days).map(({ users: _users, ...d }) => d),
    latest: (await activityRows(db, lang, { limit: LATEST_ROWS }, names)).rows,
    reach: {
      known: names.size, inOrg: facts.inOrg, holdingData: facts.holdingData, webLogin30d: facts.webLogin, companion30d: facts.companion,
    },
    orgs,
    sources: {
      game: status.game,
      uex: {
        state: worst(status.uex.map((e) => e.state)),
        checkedAt: status.uex.reduce<string | null>((min, e) => (min === null || e.checkedAt < min ? e.checkedAt : min), null),
        endpoints: status.uex.length,
      },
      botLogs: { state: worst(status.botLogs.map((g) => g.state)), channels: status.botLogs.length },
    },
  };
}
