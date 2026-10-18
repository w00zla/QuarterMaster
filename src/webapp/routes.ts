// The user web app's feature endpoints: catalog, stock, refinery, blueprints, org members, profile.
// Rights: every org-scoped call needs an active membership (roster), the stock service decides who
// may book what (Actor).
// Personal stock and blueprints work without any org.
import { sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { importCache } from '../db/import-cache.ts';
import { rows } from '../db/query.ts';
import { toMicros, formatMicros } from '../planner/plan.ts';
import { blueprintCatalog, ownedBlueprints, addBlueprint, removeBlueprint } from '../bot/blueprints.ts';
import { loadPlannerData } from '../planner/load.ts';
import { getBlueprint, getBlueprints, getItem, getItems, getResource, getResources } from '../adminapp/queries.ts';
import { formatAmount } from '../stock/amount.ts';
import { locationCatalog, materialCatalog, stockList, type PickableBatch } from '../stock/lookup.ts';
import { obtainableBlueprints, orgMetrics, stockMetrics, stockMetricsSql, type StockMetricsRow } from '../stock/org-summary.ts';
import * as stock from '../stock/service.ts';
import { MAX_REFINE_ROWS, StockError, type Actor } from '../stock/service.ts';
import type { Source } from '../history/record.ts';
import { listHistory } from './history.ts';
import { refineryMatch } from '../ext/refineries.ts';
import type {
  BlueprintInfo, BlueprintListResponse, BlueprintOwner, CatalogResponse, CraftingUse, HistoryResponse, Lang, MaterialInfo, OkResponse,
  OrgBlueprintsResponse,
  OrgMember, StockBatch,
  StockListResponse, SummaryResponse,
} from './api-types.ts';
import type { Session } from './session.ts';

/** A refusal with an error code the SPA translates. */
export class HttpError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422;
  constructor(status: HttpError['status'], code: string) {
    super(code);
    this.status = status;
  }
}

type Env = { Variables: { session: Session; token: string; apiToken?: boolean } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SNOWFLAKE = /^[0-9]{17,20}$/;
const uuid = z.string().regex(UUID);
const snowflake = z.string().regex(SNOWFLAKE);
const quality = z.number().int();
// As typed; the stock service validates the number
const amount = z.string().max(32);

const schemas = {
  add: z.object({ subjectUuid: uuid, locationUuid: uuid, quality, amount, guildIds: z.array(snowflake).max(25).optional() }).strict(),
  remove: z.object({ batchId: z.number().int().positive(), amount: amount.nullable(), expected: amount }).strict(),
  adjust: z.object({ batchId: z.number().int().positive(), amount, expected: amount }).strict(),
  move: z.object({
    batchId: z.number().int().positive(), amount: amount.nullable(), expected: amount, guildId: snowflake.optional(),
    toLocationUuid: uuid.optional(), toOwnerUserId: snowflake.optional(),
  }).strict(),
  split: z.object({ batchId: z.number().int().positive(), amount, expected: amount }).strict(),
  merge: z.object({ batchId: z.number().int().positive(), expected: amount }).strict(),
  share: z.object({ batchId: z.number().int().positive(), guildIds: z.array(snowflake).max(25) }).strict(),
  refineStart: z.object({
    locationUuid: uuid, durationSeconds: z.number().int().optional(),
    rows: z.array(z.object({ resourceUuid: uuid, quality, amount }).strict()).min(1).max(MAX_REFINE_ROWS),
  }).strict(),
  refineDuration: z.object({ jobId: uuid, durationSeconds: z.number().int().nullable() }).strict(),
  refineDone: z.object({
    jobId: uuid,
    rows: z.array(z.object({ batchId: z.number().int().positive(), amount, expected: amount }).strict()).min(1).max(MAX_REFINE_ROWS),
  }).strict(),
  refineRemove: z.object({
    jobId: uuid,
    rows: z.array(z.object({ batchId: z.number().int().positive(), expected: amount }).strict()).min(1).max(MAX_REFINE_ROWS),
  }).strict(),
  blueprint: z.object({ uuid }).strict(),
  history: z.object({
    lang: z.string().optional(),
    before: z.string().regex(/^[1-9][0-9]{0,15}$/).optional(),
    after: z.string().regex(/^[0-9]{1,16}$/).transform(Number).optional(),
    source: z.enum(['bot', 'webapp', 'companion']).optional(),
    category: z.enum(['stock', 'refinery', 'blueprint']).optional(),
    action: z.enum(['add', 'remove', 'adjust', 'move', 'share', 'unshare', 'give', 'split', 'merge', 'start', 'done']).optional(),
    by: z.enum(['me', 'others']).optional(),
  }).strict(),
  profile: z.object({
    rsiHandle: z.string().regex(/^[A-Za-z0-9_-]{3,60}$/).nullable().optional(),
    langOverride: z.enum(['de', 'en']).nullable().optional(),
  }).strict(),
};

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // The one field with its own message
    if (parsed.error.issues.some((i) => i.path[0] === 'rsiHandle')) throw new HttpError(422, 'invalidHandle');
    throw new HttpError(400, 'invalid');
  }
  return parsed.data;
}

// Item types (icon and display name) of blueprint outputs and items, per language, from the admin's
// queries; reloaded after a newer catalog import like the other catalogs
const blueprintTypes = importCache(async (db: Db, lang: string) =>
  new Map((await getBlueprints(db, lang)).map((r) => [r.uuid, { type: r.outputType, typeLabel: r.outputTypeLabel }])));
const itemTypes = importCache(async (db: Db, lang: string) =>
  new Map((await getItems(db, lang)).map((r) => [r.uuid, { type: r.type, typeLabel: r.typeLabel }])));
const noType = { type: null, typeLabel: null };

const langOf = (c: Context): Lang => (c.req.query('lang') === 'de' ? 'de' : 'en');
const unitOf = (kind: 'resource' | 'item'): 'SCU' | 'pcs' => (kind === 'resource' ? 'SCU' : 'pcs');
const ok = (c: Context) => c.json({ ok: true } satisfies OkResponse);

/** The caller's active membership in the org; 403 notMember without one. */
async function membership(db: Db, userId: string, guildId: string) {
  const [m] = await db.execute(sql`SELECT 1 FROM app.member WHERE guild_id = ${guildId} AND user_id = ${userId} AND active`);
  if (!m) throw new HttpError(403, 'notMember');
}

/** Where a request comes from: the companion app (API token) or the web app (session). */
const sourceOf = (c: Context<Env>): Source => (c.get('apiToken') ? 'companion' : 'webapp');

/** The stock service's Actor for a write: with the org it happens in (adding shared, giving) a member there. */
async function actorFor(c: Context<Env>, db: Db, userId: string, guildId: string | undefined): Promise<Actor> {
  const source = sourceOf(c);
  if (!guildId) return { userId, guildId: null, source };
  await membership(db, userId, guildId);
  return { userId, guildId, source };
}

/** Runs a stock booking; refusals become 422 with the service's code. */
async function book(c: Context, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    if (err instanceof StockError) throw new HttpError(422, err.code);
    throw err;
  }
  return ok(c);
}

// The viewer's active orgs (what someone else's batch may show of its shares)
const orgsOf = async (db: Db, userId: string) =>
  new Set((await db.execute<{ g: string }>(sql`SELECT guild_id AS g FROM app.member WHERE user_id = ${userId} AND active`)).map((r) => r.g));

function toBatch(p: PickableBatch, viewer: string, viewerOrgs: Set<string>): StockBatch {
  const b = p.batch;
  return {
    id: b.id,
    sharedIn: b.ownerUserId === viewer ? p.sharedIn : p.sharedIn.filter((g) => viewerOrgs.has(g)),
    part: b.lot !== null,
    kind: b.kind,
    component: p.component,
    subjectUuid: b.resourceUuid ?? b.itemUuid!,
    material: p.material,
    locationUuid: b.locationUuid,
    location: p.location,
    state: b.state,
    quality: b.quality,
    quantity: formatAmount(b.quantity),
    unit: unitOf(b.kind),
    holderUserId: b.ownerUserId,
    holderName: p.holderName,
    canChange: b.ownerUserId === viewer,
    refine: p.refine && {
      jobId: p.refine.jobId,
      startedAt: p.refine.startedAt && new Date(p.refine.startedAt).toISOString(),
      endsAt: p.refine.endsAt && new Date(p.refine.endsAt).toISOString(),
    },
  };
}

function listResponse(found: PickableBatch[], viewer: string, viewerOrgs: Set<string>): StockListResponse {
  const sums = new Map<string, bigint>();
  const batches = found.map((p) => toBatch(p, viewer, viewerOrgs));
  // Stock only: a refinery job is not there yet
  for (const b of batches) if (b.state === 'stored') sums.set(b.subjectUuid, (sums.get(b.subjectUuid) ?? 0n) + toMicros(b.quantity));
  return { batches, totals: Object.fromEntries([...sums].map(([k, v]) => [k, formatMicros(v)])) };
}

export function registerRoutes(api: Hono<Env>, db: Db) {
  // --- catalog ------------------------------------------------------------------------------
  api.get('/catalog', async (c) => {
    const lang = langOf(c);
    const [materials, locations, blueprints] = [await materialCatalog(db, lang), await locationCatalog(db, lang), await blueprintCatalog(db, lang)];
    const [bpTypes, types] = [await blueprintTypes(db, lang), await itemTypes(db, lang)];
    const refineries = await refineryMatch(db);
    return c.json({
      materials: [...materials.values()].map((m) => ({
        uuid: m.uuid, kind: m.kind, name: m.name, nameKey: m.nameKey, unit: unitOf(m.kind), ...(m.kind === 'item' ? types.get(m.uuid) ?? noType : noType),
        component: m.component, label: m.label, size: m.size, gradeLetter: m.gradeLetter, itemClass: m.itemClass, manufacturerCode: m.manufacturerCode,
      }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      locations: [...locations.values()].map((l) => ({
        uuid: l.uuid, label: l.label, short: l.short, nameKey: l.nameKey, refinery: refineries?.matched.has(l.uuid) ?? true,
        yields: Object.fromEntries(refineries?.yields.get(l.uuid) ?? []),
      }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      blueprints: blueprints.entries.map((e) => ({
        uuid: e.uuid, label: e.label, name: e.name, ...(bpTypes.get(e.uuid) ?? noType), size: e.size, gradeLetter: e.gradeLetter, itemClass: e.itemClass,
        manufacturerCode: e.manufacturerCode, category: e.categoryLabel, isDefault: e.isDefault, retired: e.retired,
      }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    } satisfies CatalogResponse);
  });

  // --- stock ----------------------------------------------------------------------------------
  api.get('/stock', async (c) => {
    const me = c.get('session').userId;
    const lang = langOf(c);
    if (c.req.query('scope') === 'org') {
      const guildId = snowflake.safeParse(c.req.query('guildId'));
      if (!guildId.success) throw new HttpError(400, 'invalid');
      await membership(db, me, guildId.data);
      const holder = c.req.query('holder');
      if (holder !== undefined && !SNOWFLAKE.test(holder)) throw new HttpError(400, 'invalid');
      const found = await stockList(db, { scope: { guildId: guildId.data }, holderUserId: holder }, lang);
      return c.json(listResponse(found, me, await orgsOf(db, me)));
    }
    if (c.req.query('scope') === 'all') return c.json(listResponse(await stockList(db, { scope: { allOf: me } }, lang), me, await orgsOf(db, me)));
    if (c.req.query('scope') !== 'personal') throw new HttpError(400, 'invalid');
    return c.json(listResponse(await stockList(db, { scope: { personalOf: me } }, lang), me, new Set()));
  });

  api.post('/stock/add', async (c) => {
    const input = await body(c, schemas.add);
    const me = c.get('session').userId;
    const material = (await materialCatalog(db, 'en')).get(input.subjectUuid);
    if (!material) throw new HttpError(422, 'unknownSubject');
    for (const g of input.guildIds ?? []) await membership(db, me, g);
    const actor = await actorFor(c, db, me, undefined);
    return book(c, () => stock.add(db, actor, {
      kind: material.kind, uuid: input.subjectUuid, locationUuid: input.locationUuid, quality: input.quality, amount: input.amount,
      shareIn: input.guildIds,
    }));
  });

  api.post('/stock/remove', async (c) => {
    const input = await body(c, schemas.remove);
    const actor = await actorFor(c, db, c.get('session').userId, undefined);
    return book(c, () => stock.remove(db, actor, { batchId: input.batchId, amount: input.amount, expected: input.expected }));
  });

  api.post('/stock/adjust', async (c) => {
    const input = await body(c, schemas.adjust);
    const actor = await actorFor(c, db, c.get('session').userId, undefined);
    return book(c, () => stock.adjust(db, actor, { batchId: input.batchId, amount: input.amount, expected: input.expected }));
  });

  api.post('/stock/move', async (c) => {
    const { guildId, ...input } = await body(c, schemas.move);
    const actor = await actorFor(c, db, c.get('session').userId, guildId);
    return book(c, () => stock.move(db, actor, input));
  });

  api.post('/stock/split', async (c) => {
    const input = await body(c, schemas.split);
    const actor = await actorFor(c, db, c.get('session').userId, undefined);
    return book(c, () => stock.split(db, actor, input));
  });

  api.post('/stock/merge', async (c) => {
    const input = await body(c, schemas.merge);
    const actor = await actorFor(c, db, c.get('session').userId, undefined);
    return book(c, () => stock.merge(db, actor, input));
  });

  api.post('/stock/share', async (c) => {
    const input = await body(c, schemas.share);
    // The service checks the membership in every org it newly goes to
    return book(c, () => stock.share(db, { userId: c.get('session').userId, guildId: null, source: sourceOf(c) }, input));
  });

  // --- refinery (always personal) -------------------------------------------------------------
  api.post('/refinery/start', async (c) => {
    const input = await body(c, schemas.refineStart);
    const actor = await actorFor(c, db, c.get('session').userId, undefined);
    return book(c, () => stock.refineStart(db, actor, input));
  });

  // The time a running job still needs (end = now + seconds, null clears it): typed later, or read off the
  // terminal's PROCESSING screen by the companion app
  api.post('/refinery/duration', async (c) => {
    const input = await body(c, schemas.refineDuration);
    const actor = await actorFor(c, db, c.get('session').userId, undefined);
    return book(c, () => stock.refineSetDuration(db, actor, input));
  });

  api.post('/refinery/done', async (c) => {
    const input = await body(c, schemas.refineDone);
    const actor = await actorFor(c, db, c.get('session').userId, undefined);
    return book(c, () => stock.refineDone(db, actor, input));
  });

  // A job that will not come out (cancelled, lost to a game patch)
  api.post('/refinery/remove', async (c) => {
    const input = await body(c, schemas.refineRemove);
    const actor = await actorFor(c, db, c.get('session').userId, undefined);
    return book(c, () => stock.refineRemove(db, actor, input));
  });

  // --- blueprints -------------------------------------------------------------------------------
  api.get('/blueprints', async (c) => c.json({ uuids: [...await ownedBlueprints(db, c.get('session').userId)] } satisfies BlueprintListResponse));

  api.post('/blueprints/add', async (c) => {
    const { uuid: bp } = await body(c, schemas.blueprint);
    const entry = (await blueprintCatalog(db, 'en')).byUuid.get(bp);
    if (!entry) throw new HttpError(422, 'unknownBlueprint');
    if (entry.isDefault) throw new HttpError(422, 'blueprintDefault');
    if (entry.retired) throw new HttpError(422, 'blueprintRetired');
    await addBlueprint(db, c.get('session').userId, bp, sourceOf(c));
    return ok(c);
  });

  api.post('/blueprints/remove', async (c) => {
    const { uuid: bp } = await body(c, schemas.blueprint);
    await removeBlueprint(db, c.get('session').userId, bp, sourceOf(c));
    return ok(c);
  });

  // --- orgs -----------------------------------------------------------------------------------
  api.get('/orgs/:guildId/members', async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE.test(guildId)) throw new HttpError(400, 'invalid');
    await membership(db, c.get('session').userId, guildId);
    const members = await db.execute<OrgMember & Record<string, unknown>>(sql`
      SELECT m.user_id AS "userId", m.display_name AS "displayName", u.rsi_handle AS "rsiHandle"
      FROM app.member m JOIN app.app_user u ON u.user_id = m.user_id
      WHERE m.guild_id = ${guildId} AND m.active ORDER BY lower(m.display_name)`);
    return c.json([...members] satisfies OrgMember[]);
  });

  api.get('/orgs/:guildId/blueprints', async (c) => {
    const guildId = c.req.param('guildId');
    if (!SNOWFLAKE.test(guildId)) throw new HttpError(400, 'invalid');
    await membership(db, c.get('session').userId, guildId);
    // The registry is visible to the org: active members only
    const found = await db.execute<{ uuid: string; owners: BlueprintOwner[] }>(sql`
      SELECT b.blueprint_uuid AS uuid,
        json_agg(json_build_object('userId', m.user_id, 'displayName', m.display_name, 'rsiHandle', u.rsi_handle)
          ORDER BY lower(m.display_name)) AS owners
      FROM app.user_blueprint b
      JOIN app.member m ON m.user_id = b.user_id AND m.guild_id = ${guildId} AND m.active
      JOIN app.app_user u ON u.user_id = b.user_id
      GROUP BY b.blueprint_uuid`);
    return c.json({ entries: found.map((r) => ({ uuid: r.uuid, owners: r.owners })) } satisfies OrgBlueprintsResponse);
  });

  // --- summary --------------------------------------------------------------------------------
  // --- history ----------------------------------------------------------------------------------
  api.get('/history', async (c) => {
    const q = schemas.history.safeParse(c.req.query());
    if (!q.success) throw new HttpError(400, 'invalid');
    const { before, lang: _lang, ...filter } = q.data;
    return c.json(await listHistory(db, c.get('session').userId, langOf(c), before === undefined ? undefined : Number(before), filter) satisfies HistoryResponse);
  });

  api.get('/summary', async (c) => {
    const me = c.get('session').userId;
    // Your stored stock, shared or not; each org's figures (what its active members shared) come from
    // orgMetrics, like the bot's board: your shared stock counts in both
    const [stock] = await rows<StockMetricsRow>(db, sql`
      SELECT ${stockMetricsSql()}
      FROM app.stock_batch b
      WHERE b.state = 'stored' AND b.owner_user_id = ${me}`);
    // Refinery jobs are personal only
    const [refining] = await db.execute<{ jobs: number; expected: string | null; locations: number; ends: string[] }>(sql`
      SELECT count(DISTINCT refine_job)::int AS jobs,
        sum(quantity)::text AS expected,
        count(DISTINCT location_uuid)::int AS locations,
        coalesce(array_agg(DISTINCT to_json(refine_ends_at)#>>'{}') FILTER (WHERE refine_ends_at IS NOT NULL), '{}') AS ends
      FROM app.stock_batch
      WHERE state = 'refining' AND owner_user_id = ${me}`);
    const orgIds = (await rows<{ guildId: string }>(db, sql`
      SELECT o.guild_id AS "guildId" FROM app.member mine JOIN app.org o ON o.guild_id = mine.guild_id
      WHERE mine.user_id = ${me} AND mine.active ORDER BY lower(o.name)`)).map((o) => o.guildId);
    const orgs = await orgMetrics(db, orgIds);
    const [own] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM app.user_blueprint WHERE user_id = ${me}`);
    return c.json({
      obtainableBlueprints: await obtainableBlueprints(db),
      personal: {
        ...stockMetrics(stock),
        refining: {
          jobs: refining?.jobs ?? 0,
          expected: refining?.expected == null ? null : formatAmount(refining.expected),
          locations: refining?.locations ?? 0,
          endsAt: (refining?.ends ?? []).map((e) => new Date(e).toISOString()).sort(),
        },
        blueprints: own?.n ?? 0,
      },
      orgs: orgIds.map((guildId) => ({ guildId, ...orgs.get(guildId)! })),
    } satisfies SummaryResponse);
  });

  // --- info cards (game data for hover tooltips; never the raw records) ------------------------
  api.get('/info/blueprint/:uuid', async (c) => {
    const id = uuid.safeParse(c.req.param('uuid'));
    if (!id.success) throw new HttpError(400, 'invalid');
    const bp = await getBlueprint(db, id.data, langOf(c));
    if (!bp) throw new HttpError(404, 'notFound');
    const tier = bp.tiers[0];
    const o = bp.output;
    return c.json({
      name: bp.name, type: o?.type ?? null, typeLabel: o?.typeLabel ?? null, subTypeLabel: o?.subTypeLabel ?? null, size: o?.size ?? null,
      gradeLetter: o?.gradeLetter ?? null, itemClass: o?.itemClass ?? null, manufacturer: o?.manufacturer ?? null,
      category: bp.categoryLabel, isDefault: bp.isDefault, retired: bp.retiredAt !== null,
      craftSeconds: tier?.craftSeconds ?? null, requiredSlots: tier?.requiredSlots ?? 0,
      // A slot without any input (broken game data) tells nothing
      slots: (tier?.slots ?? []).filter((s) => s.inputs.length).map((s) => ({
        name: s.name,
        inputs: s.inputs.map((i) => ({ name: i.name, kind: i.kind, quantity: formatAmount(i.quantity), minQuality: i.minQuality })),
      })),
    } satisfies BlueprintInfo);
  });

  api.get('/info/material/:uuid', async (c) => {
    const id = uuid.safeParse(c.req.param('uuid'));
    if (!id.success) throw new HttpError(400, 'invalid');
    const lang = langOf(c);
    const blank = { group: null, isOre: false, refined: null, ores: [], typeLabel: null, subTypeLabel: null, size: null, gradeLetter: null, itemClass: null, manufacturer: null };
    const distinct = (uses: Array<{ uuid: string }>) => new Set(uses.map((u) => u.uuid)).size;
    const resource = await getResource(db, id.data, lang);
    if (resource) {
      return c.json({
        ...blank, kind: 'resource', name: resource.name, type: null, description: resource.description,
        group: resource.groupPath.join(' › ') || null, isOre: resource.isOre, refined: resource.refined?.name ?? null,
        ores: resource.ores.map((o) => o.name), usedIn: distinct(resource.usedBy),
      } satisfies MaterialInfo);
    }
    const item = await getItem(db, id.data, lang);
    if (!item) throw new HttpError(404, 'notFound');
    return c.json({
      ...blank, kind: 'item', name: item.name, type: item.type, description: item.description, typeLabel: item.typeLabel, subTypeLabel: item.subTypeLabel,
      size: item.size, gradeLetter: item.gradeLetter, itemClass: item.itemClass,
      manufacturer: item.manufacturer?.name ?? item.manufacturer?.code ?? null, usedIn: distinct(item.inputOf),
    } satisfies MaterialInfo);
  });

  // --- crafting check (the planner's game data; the admin's catalog queries) ---------------------
  api.get('/crafting/blueprints', async (c) => c.json(await getBlueprints(db, langOf(c))));
  api.get('/crafting/resources', async (c) => c.json(await getResources(db, langOf(c))));
  api.get('/crafting/items', async (c) => c.json(await getItems(db, langOf(c))));
  api.get('/crafting/used-by', async (c) => {
    const kind = c.req.query('kind');
    const found = uuid.safeParse(c.req.query('uuid'));
    if ((kind !== 'resource' && kind !== 'item') || !found.success) throw new HttpError(400, 'invalid');
    const uses = kind === 'resource'
      ? (await getResource(db, found.data, langOf(c)))?.usedBy
      : (await getItem(db, found.data, langOf(c)))?.inputOf;
    if (!uses) throw new HttpError(404, 'notFound');
    return c.json(uses satisfies CraftingUse[]);
  });
  api.get('/crafting/recipes', async (c) => {
    const uuids = [...new Set((c.req.query('uuids') ?? '').split(',').filter((u) => UUID.test(u)))].slice(0, 200);
    return c.json(await loadPlannerData(db, uuids, langOf(c)));
  });

  // --- profile ----------------------------------------------------------------------------------
  api.post('/profile', async (c) => {
    const input = await body(c, schemas.profile);
    const me = c.get('session').userId;
    if (input.rsiHandle !== undefined) {
      await db.execute(sql`UPDATE app.app_user SET rsi_handle = ${input.rsiHandle}, updated_at = now() WHERE user_id = ${me}`);
    }
    if (input.langOverride !== undefined) {
      await db.execute(sql`INSERT INTO web.user_setting (user_id, lang) VALUES (${me}, ${input.langOverride})
        ON CONFLICT (user_id) DO UPDATE SET lang = excluded.lang, updated_at = now()`);
    }
    return ok(c);
  });
}
