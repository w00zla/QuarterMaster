// Read-only views of the user data for the admin API: orgs, users and checks of user data the catalog
// no longer backs. Reads app and bot, and of web only the session/token columns qm_app is granted
// (deploy/db-roles.sh: never the token hashes).
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { locText, one, rows } from '../db/query.ts';
import { blueprintCatalog } from '../bot/blueprints.ts';
import type { Lang } from '../bot/i18n.ts';
import { COMPONENT_TYPES, fpsTypeSql } from '../catalog/components.ts';
import { refineryLocations } from '../ext/refineries.ts';
import { formatAmount } from '../stock/amount.ts';
import { IDLE_MS } from '../webapp/session.ts';
import type {
  DataCheck, DataCheckHit, MaterialTotal, OrgActivityRow, OrgDetail, OrgMemberRow, OrgRow, ActivitySource, UserDetail,
  UserHistoryRow, UserMembership, UserRefineryJob, UserRow,
} from './api-types.ts';

/** Timestamp as ISO 8601 string (the driver would return Postgres' text format here). */
const iso = (e: SQL) => sql`to_json(${e}) #>> '{}'`;
const amount = (text: string | null) => (text === null ? null : formatAmount(text));
const unitOf = (kind: string) => (kind === 'resource' ? 'SCU' as const : 'pcs' as const);
// Batch `b` with resource `r` / item `i` joined
const materialName = (lang: string) => sql`coalesce(${locText(lang, sql`coalesce(r.name_key, i.name_key)`)}, r.key, i.class_name)`;
const placeName = (lang: string) => sql`coalesce(${locText(lang, sql`l.name_key`)}, l.key)`;
// A web session still valid (the idle timeout is checked by the web app, not stored)
const validSession = sql`s.expires_at > now() AND s.last_seen_at > now() - ${`${IDLE_MS} milliseconds`}::interval`;
// Item `i` is gear: a ship component or FPS gear (isComponentType || isFpsType); every other item is a harvestable
const isGear = sql.raw(`coalesce(i.type IN (${COMPONENT_TYPES.map((t) => `'${t}'`).join(', ')}) OR ${fpsTypeSql('i')}, false)`);
// The StockGroup of batch `b`
const stockGroup = sql`CASE WHEN b.kind = 'resource' THEN 'resource' WHEN ${isGear} THEN 'gear' ELSE 'harvestable' END`;
// How far back the channels (sources) of a user's own actions count
export const CHANNEL_DAYS = 30;
const recent = sql`h.created_at > now() - ${`${CHANNEL_DAYS} days`}::interval`;

/**
 * Display names of every known user: the newest web login's Discord profile, else the companion token's
 * (taken at its creation), else the org nickname (an active membership first).
 */
export async function userNames(db: Db): Promise<Map<string, { name: string | null; username: string | null }>> {
  const found = await rows<{ userId: string; name: string | null; username: string | null }>(db, sql`
    WITH ids AS (SELECT user_id FROM app.app_user UNION SELECT user_id FROM web.session UNION SELECT user_id FROM web.api_token),
    ws AS (SELECT DISTINCT ON (user_id) user_id, discord_username, discord_global_name FROM web.session ORDER BY user_id, last_seen_at DESC),
    m AS (SELECT DISTINCT ON (user_id) user_id, display_name FROM app.member ORDER BY user_id, active DESC, updated_at DESC)
    SELECT ids.user_id AS "userId",
      coalesce(ws.discord_global_name, ws.discord_username, t.discord_global_name, t.discord_username, m.display_name) AS name,
      coalesce(ws.discord_username, t.discord_username) AS username
    FROM ids
    LEFT JOIN ws ON ws.user_id = ids.user_id
    LEFT JOIN web.api_token t ON t.user_id = ids.user_id
    LEFT JOIN m ON m.user_id = ids.user_id`);
  return new Map(found.map((u) => [u.userId, { name: u.name, username: u.username }]));
}

// --- orgs ---------------------------------------------------------------------------------

const ORG_COLUMNS = sql`o.guild_id AS "guildId", o.name, ${iso(sql`o.created_at`)} AS "createdAt",
  ${iso(sql`g.joined_at`)} AS "joinedAt", ${iso(sql`g.left_at`)} AS "leftAt", cardinality(o.member_role_ids) AS "memberRoles",
  g.base_lang AS "baseLang", g.logs_channel_id AS "logsChannelId", g.logs_level AS "logsLevel",
  g.board_channel_id AS "boardChannelId", g.board_message_id AS "boardMessageId", g.board_style AS "boardStyle",
  g.board_title AS "boardTitle", g.board_subtitle AS "boardSubtitle",
  (SELECT count(*) FROM app.member m WHERE m.guild_id = o.guild_id AND m.active)::int AS "membersActive",
  (SELECT count(*) FROM app.member m WHERE m.guild_id = o.guild_id AND NOT m.active)::int AS "membersInactive",
  (SELECT count(*) FROM app.stock_share s JOIN app.stock_batch b ON b.id = s.batch_id
    JOIN app.member m ON m.guild_id = s.guild_id AND m.user_id = b.owner_user_id AND m.active
    WHERE s.guild_id = o.guild_id)::int AS "sharedBatches",
  (SELECT ${iso(sql`max(h.created_at)`)} FROM app.history h WHERE h.guild_id = o.guild_id) AS "lastActivity"`;

export function getOrgs(db: Db): Promise<OrgRow[]> {
  return rows<OrgRow>(db, sql`
    SELECT ${ORG_COLUMNS} FROM app.org o LEFT JOIN bot.guild g ON g.guild_id = o.guild_id
    ORDER BY lower(o.name), o.guild_id`);
}

export async function getOrg(db: Db, guildId: string, lang: string): Promise<OrgDetail | null> {
  const org = await one<OrgRow>(db, sql`
    SELECT ${ORG_COLUMNS} FROM app.org o LEFT JOIN bot.guild g ON g.guild_id = o.guild_id WHERE o.guild_id = ${guildId}`);
  if (!org) return null;
  const names = await userNames(db);
  const members = (await rows<Omit<OrgMemberRow, 'name'>>(db, sql`
    SELECT m.user_id AS "userId", m.display_name AS "displayName", m.active, ${iso(sql`m.first_seen_at`)} AS "firstSeenAt",
      ${iso(sql`m.inactive_since`)} AS "inactiveSince", u.rsi_handle AS "rsiHandle"
    FROM app.member m JOIN app.app_user u ON u.user_id = m.user_id
    WHERE m.guild_id = ${guildId}
    ORDER BY m.active DESC, lower(m.display_name)`)).map((m) => ({ ...m, name: names.get(m.userId)?.name ?? null }));
  // What the org sees: batches shared there by active members
  const stock = await materialTotals(db, lang, sql`EXISTS (SELECT 1 FROM app.stock_share s
    JOIN app.member m ON m.guild_id = s.guild_id AND m.user_id = b.owner_user_id AND m.active
    WHERE s.batch_id = b.id AND s.guild_id = ${guildId})`);
  const activity = (await historyRows(db, lang, sql`h.guild_id = ${guildId}`, ORG_ACTIVITY_ROWS, await blueprintCatalog(db, lang as Lang)))
    .map(({ org: _org, ...h }): OrgActivityRow => ({ ...h, actorName: names.get(h.actorUserId)?.name ?? null }));
  return { ...org, members, stock, activity };
}

const ORG_ACTIVITY_ROWS = 20;

/** Stored stock per material of the batches `where` selects, largest first. */
async function materialTotals(db: Db, lang: string, where: SQL): Promise<MaterialTotal[]> {
  const found = await rows<Omit<MaterialTotal, 'unit'> & { kind: string }>(db, sql`
    SELECT coalesce(b.resource_uuid, b.item_uuid) AS uuid, b.kind, ${materialName(lang)} AS name, ${stockGroup} AS "group",
      sum(b.quantity)::text AS total,
      count(*)::int AS batches, min(b.quality) AS "minQuality", max(b.quality) AS "maxQuality",
      count(DISTINCT b.owner_user_id)::int AS owners,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM app.stock_share s WHERE s.batch_id = b.id))::int AS shared
    FROM app.stock_batch b
    LEFT JOIN catalog.resource r ON r.uuid = b.resource_uuid
    LEFT JOIN catalog.item i ON i.uuid = b.item_uuid
    WHERE b.state = 'stored' AND ${where}
    GROUP BY 1, 2, 3, 4
    ORDER BY "group" DESC, sum(b.quantity) DESC, name`);
  return found.map(({ kind, ...m }) => ({ ...m, unit: unitOf(kind), total: formatAmount(m.total) }));
}

// --- users --------------------------------------------------------------------------------

type UserBase = Omit<UserRow, 'name' | 'discordUsername'>;

const USER_ROWS = sql`
  WITH ids AS (SELECT user_id FROM app.app_user UNION SELECT user_id FROM web.session UNION SELECT user_id FROM web.api_token)
  SELECT ids.user_id AS "userId", u.rsi_handle AS "rsiHandle", ${iso(sql`u.created_at`)} AS "createdAt",
    coalesce((SELECT array_agg(o.name ORDER BY lower(o.name)) FROM app.member m JOIN app.org o ON o.guild_id = m.guild_id
      WHERE m.user_id = ids.user_id AND m.active), '{}') AS orgs,
    coalesce(st.batches, 0) AS batches, coalesce(st.scu, '0') AS "resourceScu",
    coalesce(st.harvestables, '0') AS "harvestablePcs", coalesce(st.gear, '0') AS "gearPcs",
    coalesce(st.jobs, 0) AS "refineryJobs",
    (SELECT count(*) FROM app.user_blueprint ub WHERE ub.user_id = ids.user_id)::int AS blueprints,
    (SELECT ${iso(sql`max(h.created_at)`)} FROM app.history h WHERE h.actor_user_id = ids.user_id) AS "lastActivity",
    (SELECT coalesce(array_agg(DISTINCT h.source ORDER BY h.source), '{}') FROM app.history h
      WHERE h.actor_user_id = ids.user_id AND ${recent}) AS channels,
    (SELECT ${iso(sql`max(s.last_seen_at)`)} FROM web.session s WHERE s.user_id = ids.user_id) AS "lastSeen",
    EXISTS (SELECT 1 FROM web.api_token t WHERE t.user_id = ids.user_id) AS companion
  FROM ids
  LEFT JOIN app.app_user u ON u.user_id = ids.user_id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE b.state = 'stored')::int AS batches,
      (sum(b.quantity) FILTER (WHERE b.state = 'stored' AND b.kind = 'resource'))::text AS scu,
      (sum(b.quantity) FILTER (WHERE b.state = 'stored' AND b.kind = 'item' AND NOT ${isGear}))::text AS harvestables,
      (sum(b.quantity) FILTER (WHERE b.state = 'stored' AND b.kind = 'item' AND ${isGear}))::text AS gear,
      count(DISTINCT b.refine_job)::int AS jobs
    FROM app.stock_batch b LEFT JOIN catalog.item i ON i.uuid = b.item_uuid
    WHERE b.owner_user_id = ids.user_id) st ON true`;

export async function getUsers(db: Db): Promise<UserRow[]> {
  const names = await userNames(db);
  const found = await rows<UserBase>(db, sql`${USER_ROWS} ORDER BY ids.user_id`);
  return found.map((u) => withName(u, names));
}

function withName(u: UserBase, names: Awaited<ReturnType<typeof userNames>>): UserRow {
  const n = names.get(u.userId);
  return {
    ...u, name: n?.name ?? null, discordUsername: n?.username ?? null, resourceScu: formatAmount(u.resourceScu),
    harvestablePcs: formatAmount(u.harvestablePcs), gearPcs: formatAmount(u.gearPcs),
  };
}

const HISTORY_ROWS = 50;

export async function getUser(db: Db, userId: string, lang: string): Promise<UserDetail | null> {
  const base = await one<UserBase>(db, sql`${USER_ROWS} WHERE ids.user_id = ${userId}`);
  if (!base) return null;
  const user = withName(base, await userNames(db));

  const web = (await one<{ sessions: number; tokenCreatedAt: string | null; tokenLastUsedAt: string | null }>(db, sql`
    SELECT (SELECT count(*) FROM web.session s WHERE s.user_id = ${userId} AND ${validSession})::int AS sessions,
      (SELECT ${iso(sql`t.created_at`)} FROM web.api_token t WHERE t.user_id = ${userId}) AS "tokenCreatedAt",
      (SELECT ${iso(sql`t.last_used_at`)} FROM web.api_token t WHERE t.user_id = ${userId}) AS "tokenLastUsedAt"`))!;
  const actions: Record<ActivitySource, number> = { bot: 0, webapp: 0, companion: 0 };
  for (const a of await rows<{ source: ActivitySource; count: number }>(db, sql`
    SELECT h.source, count(*)::int AS count FROM app.history h WHERE h.actor_user_id = ${userId} AND ${recent} GROUP BY h.source`)) {
    actions[a.source] = a.count;
  }

  const memberships = await rows<UserMembership>(db, sql`
    SELECT m.guild_id AS "guildId", o.name AS org, m.display_name AS "displayName", m.active,
      ${iso(sql`m.first_seen_at`)} AS "firstSeenAt", ${iso(sql`m.inactive_since`)} AS "inactiveSince"
    FROM app.member m JOIN app.org o ON o.guild_id = m.guild_id
    WHERE m.user_id = ${userId}
    ORDER BY m.active DESC, lower(o.name)`);

  const stock = await materialTotals(db, lang, sql`b.owner_user_id = ${userId}`);

  const jobs = (await rows<UserRefineryJob>(db, sql`
    SELECT b.refine_job AS "jobId", ${placeName(lang)} AS location,
      json_agg(json_build_object('name', ${materialName(lang)}, 'amount', b.quantity::text, 'quality', b.quality)
        ORDER BY b.quantity DESC, ${materialName(lang)}) AS materials,
      sum(b.quantity)::text AS scu,
      ${iso(sql`min(b.refine_started_at)`)} AS "startedAt", ${iso(sql`max(b.refine_ends_at)`)} AS "endsAt"
    FROM app.stock_batch b
    JOIN catalog.location l ON l.uuid = b.location_uuid
    LEFT JOIN catalog.resource r ON r.uuid = b.resource_uuid
    LEFT JOIN catalog.item i ON i.uuid = b.item_uuid
    WHERE b.owner_user_id = ${userId} AND b.state = 'refining'
    GROUP BY b.refine_job, l.uuid
    ORDER BY max(b.refine_ends_at) NULLS LAST`)).map((j) => ({
    ...j, scu: formatAmount(j.scu), materials: j.materials.map((m) => ({ ...m, amount: formatAmount(m.amount) })),
  }));

  const catalog = await blueprintCatalog(db, lang as Lang);
  const blueprintList = (await rows<{ uuid: string }>(db, sql`
    SELECT blueprint_uuid AS uuid FROM app.user_blueprint WHERE user_id = ${userId}`))
    .map((b) => ({ uuid: b.uuid, name: catalog.byUuid.get(b.uuid)?.label ?? b.uuid }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const history = (await historyRows(db, lang,
    sql`h.actor_user_id = ${userId} OR h.owner_user_id = ${userId} OR h.to_owner_user_id = ${userId}`, HISTORY_ROWS, catalog))
    .map(({ actorUserId, ...h }): UserHistoryRow => ({ ...h, byOther: actorUserId !== userId }));

  return { ...user, ...web, actions, memberships, stock, jobs, blueprintList, history };
}

type HistoryRow = Omit<UserHistoryRow, 'byOther'> & { actorUserId: string };

/** The newest `limit` rows of app.history `h` that `where` selects, their targets named. */
async function historyRows(
  db: Db, lang: string, where: SQL, limit: number, catalog: Awaited<ReturnType<typeof blueprintCatalog>>,
): Promise<HistoryRow[]> {
  return (await rows<Omit<HistoryRow, 'unit'> & { targetKind: string; targetUuid: string }>(db, sql`
    SELECT h.id::int AS id, ${iso(sql`h.created_at`)} AS at, h.source, h.category, h.action, h.actor_user_id AS "actorUserId",
      o.name AS org, h.target_kind AS "targetKind", h.target_uuid AS "targetUuid",
      ${materialName(lang)} AS target, h.details->>'amount' AS amount, (h.details->>'quality')::int AS quality
    FROM app.history h
    LEFT JOIN app.org o ON o.guild_id = h.guild_id
    LEFT JOIN catalog.resource r ON h.target_kind = 'resource' AND r.uuid = h.target_uuid
    LEFT JOIN catalog.item i ON h.target_kind = 'item' AND i.uuid = h.target_uuid
    WHERE ${where}
    ORDER BY h.id DESC
    LIMIT ${limit}`)).map(({ targetKind, targetUuid, ...h }) => ({
    ...h,
    target: targetKind === 'blueprint' ? catalog.byUuid.get(targetUuid)?.label ?? targetUuid : h.target ?? targetUuid,
    amount: amount(h.amount),
    unit: targetKind === 'blueprint' ? null : unitOf(targetKind),
  }));
}

// --- data checks --------------------------------------------------------------------------

/** User data the catalog or the refinery data no longer backs; every check is listed, also without hits. */
export async function getDataChecks(db: Db, lang: string): Promise<DataCheck[]> {
  const names = await userNames(db);
  type Hit = Omit<DataCheckHit, 'name' | 'unit' | 'amount'> & { kind: string | null; amount: string | null };
  const hits = (found: Hit[]): DataCheckHit[] => found.map(({ kind, ...h }) => ({
    ...h, name: names.get(h.userId)?.name ?? null, amount: amount(h.amount), unit: kind ? unitOf(kind) : null,
  }));
  const batches = (where: SQL) => rows<Hit>(db, sql`
    SELECT b.owner_user_id AS "userId", b.kind, ${materialName(lang)} AS subject, ${placeName(lang)} AS location,
      b.quantity::text AS amount, ${iso(sql`b.refine_ends_at`)} AS "endsAt"
    FROM app.stock_batch b
    JOIN catalog.location l ON l.uuid = b.location_uuid
    LEFT JOIN catalog.resource r ON r.uuid = b.resource_uuid
    LEFT JOIN catalog.item i ON i.uuid = b.item_uuid
    WHERE ${where}
    ORDER BY b.owner_user_id, subject, b.id`);
  // One row per refinery job, its ores joined
  const jobs = (where: SQL) => rows<Hit>(db, sql`
    SELECT b.owner_user_id AS "userId", 'resource' AS kind, string_agg(${materialName(lang)}, ', ' ORDER BY ${materialName(lang)}) AS subject,
      ${placeName(lang)} AS location, sum(b.quantity)::text AS amount, ${iso(sql`max(b.refine_ends_at)`)} AS "endsAt"
    FROM app.stock_batch b
    JOIN catalog.location l ON l.uuid = b.location_uuid
    LEFT JOIN catalog.resource r ON r.uuid = b.resource_uuid
    LEFT JOIN catalog.item i ON i.uuid = b.item_uuid
    WHERE b.state = 'refining' AND ${where}
    GROUP BY b.owner_user_id, b.refine_job, l.uuid
    ORDER BY max(b.refine_ends_at), b.owner_user_id`);

  const refineries = await refineryLocations(db);
  // Without UEX data every selectable location counts as a refinery
  const outside = !refineries ? sql`false`
    : refineries.size ? sql`b.location_uuid NOT IN (${sql.join([...refineries].map((u) => sql`${u}::uuid`), sql`, `)})`
    : sql`true`;

  return [
    { key: 'retiredMaterial', hits: hits(await batches(sql`(r.retired_at IS NOT NULL OR i.retired_at IS NOT NULL)`)) },
    { key: 'retiredLocation', hits: hits(await batches(sql`l.retired_at IS NOT NULL`)) },
    {
      key: 'retiredBlueprint',
      hits: hits(await rows<Hit>(db, sql`
        SELECT ub.user_id AS "userId", NULL AS kind, coalesce(${locText(lang, sql`i.name_key`)}, i.class_name, bp.key) AS subject,
          NULL AS location, NULL AS amount, NULL AS "endsAt"
        FROM app.user_blueprint ub
        JOIN catalog.blueprint bp ON bp.uuid = ub.blueprint_uuid
        LEFT JOIN catalog.item i ON i.uuid = bp.output_item_uuid
        WHERE bp.retired_at IS NOT NULL
        ORDER BY ub.user_id, subject`)),
    },
    { key: 'jobNotAtRefinery', hits: hits(await jobs(outside)) },
  ];
}
