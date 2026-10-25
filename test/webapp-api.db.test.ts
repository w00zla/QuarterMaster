// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
// The user web app's feature endpoints through Hono (app.request): catalog, stock, refinery,
// blueprints, org members, profile — rights, memberships and users without any org.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import type { Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, markGuildLeft, updateGuildSettings, type GuildSettings } from '../src/bot/settings.ts';
import type {
  BlueprintInfo, CatalogResponse, HistoryResponse, MaterialInfo, MeResponse, OrgMember, StockBatch, StockListResponse, SummaryResponse,
} from '../src/webapp/api-types.ts';
import { getOverview } from '../src/adminapp/queries.ts';
import { findStock } from '../src/stock/lookup.ts';
import { createApp } from '../src/webapp/app.ts';
import type { DiscordLogin } from '../src/webapp/discord.ts';
import { createSession } from '../src/webapp/session.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://qm.test';
const G = '700000000000000051';
const MEMBER_ROLE = '710000000000000051';
const [OLGA, MIA, MAX, SOLO] = ['740000000000000051', '740000000000000052', '740000000000000053', '740000000000000054'];
const noLogin: DiscordLogin = { start: () => Promise.reject(new Error('unused')), finish: () => Promise.reject(new Error('unused')) };

describe('web app features (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let webDb: Db;
  let closeDb: () => Promise<void>;
  let closeWeb: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let settings: GuildSettings;
  const tokens = new Map<string, string>();

  const headers = (user: string) => ({ cookie: `__Host-qm_session=${tokens.get(user)}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
  const get = async <T>(user: string, path: string) => {
    const res = await app.request(`/api${path}`, { headers: headers(user) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const post = async (user: string, path: string, body: unknown) => {
    const res = await app.request(`/api${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: { ...headers(user), 'content-type': 'application/json' },
    });
    return { status: res.status, body: (await res.json()) as { ok?: true; error?: string } };
  };
  const personal = async (user: string) => (await get<StockListResponse>(user, '/stock?scope=personal')).body;
  const org = async (user: string) => (await get<StockListResponse>(user, `/stock?scope=org&guildId=${G}`)).body;
  const metal = { subjectUuid: U.metal, locationUuid: U.station };

  before(async () => {
    await prepareDb(url);
    // db plays the bot and the admin (seeding, roster, overview), the web app itself runs as qm_web
    ({ db, close: closeDb } = connectAs(url, 'qm_app'));
    ({ db: webDb, close: closeWeb } = connectAs(url, 'qm_web'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    await ensureGuild(db, G, 'Feature Org');
    settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE] });
    for (const id of [OLGA, MIA, MAX]) {
      await syncMember(db, G, settings, id, { userId: id, displayName: `n${id.slice(-2)}`, roleIds: [MEMBER_ROLE], bot: false });
    }
    for (const id of [OLGA, MIA, MAX, SOLO]) {
      tokens.set(id, await createSession(webDb, { id, username: `u${id.slice(-2)}`, globalName: null, avatar: null }));
    }
    app = createApp(webDb, noLogin, { origin: ORIGIN, trustProxy: false, distDir: null });
  });
  after(async () => { await closeDb?.(); await closeWeb?.(); });

  it('catalog: materials with unit (never ores), locations, blueprints', async () => {
    const { status, body } = await get<CatalogResponse>(SOLO, '/catalog?lang=en');
    assert.equal(status, 200);
    const byUuid = new Map(body.materials.map((m) => [m.uuid, m]));
    assert.equal(byUuid.get(U.metal)?.unit, 'SCU');
    assert.ok(!byUuid.has(U.ore));
    assert.ok(!('isOre' in byUuid.get(U.metal)!) && !('methods' in body));
    // The game's loc key (for the companion's language pack lookup)
    assert.equal(byUuid.get(U.metal)?.nameKey, 'items_commodities_testmetal');
    assert.ok(body.locations.every((l) => 'nameKey' in l));
    assert.equal(byUuid.get(U.gem)?.unit, 'pcs');
    // Item types for the icons: items have one (or null), resources never
    assert.ok('type' in byUuid.get(U.gem)! && byUuid.get(U.metal)!.type === null);
    assert.ok(body.blueprints.every((b) => 'type' in b && 'typeLabel' in b));
    assert.ok(body.locations.some((l) => l.uuid === U.station));
    assert.ok(body.blueprints.some((b) => b.uuid === U.blueprint && b.isDefault && typeof b.name === 'string'));
  });

  it('catalog: an ETag, revalidated (304 while unchanged); other routes stay no-store', async () => {
    const first = await app.request('/api/catalog?lang=en', { headers: headers(SOLO) });
    const tag = first.headers.get('etag');
    assert.equal(first.status, 200);
    assert.ok(tag);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    const again = await app.request('/api/catalog?lang=en', { headers: { ...headers(SOLO), 'if-none-match': tag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('cache-control'), 'private, no-cache');
    assert.equal(again.headers.get('etag'), tag);
    // Another language is another body
    assert.notEqual((await app.request('/api/catalog?lang=de', { headers: headers(SOLO) })).headers.get('etag'), tag);
    assert.equal((await app.request('/api/me', { headers: headers(SOLO) })).headers.get('cache-control'), 'no-store');
  });

  it('a user without any org: personal stock, refinery, blueprints, profile', async () => {
    assert.equal((await post(SOLO, '/stock/add', { ...metal, quality: 700, amount: '12,5' })).status, 200);
    let list = await personal(SOLO);
    const batch = list.batches[0]!;
    assert.deepEqual([batch.quantity, batch.unit, batch.canChange, batch.sharedIn, list.totals[U.metal]], ['12.5', 'SCU', true, [], '12.5']);
    assert.equal((await post(SOLO, '/stock/remove', { batchId: batch.id, amount: '2.5', expected: '12.5' })).status, 200);
    // Booking against what the user saw: a changed batch is refused
    assert.deepEqual((await post(SOLO, '/stock/adjust', { batchId: batch.id, amount: '20', expected: '12.5' })).body, { error: 'batchChanged' });
    assert.equal((await post(SOLO, '/stock/adjust', { batchId: batch.id, amount: '20', expected: '10' })).status, 200);
    assert.equal((await personal(SOLO)).totals[U.metal], '20');

    // Refinery: start with the refined material and its expected yield, done stores it
    assert.equal((await post(SOLO, '/refinery/start', { locationUuid: U.station, rows: [] })).status, 400);
    assert.equal((await post(SOLO, '/refinery/start', { locationUuid: U.station, rows: [{ oreUuid: U.ore, quality: 400, amount: '8' }] })).status, 400);
    assert.deepEqual((await post(SOLO, '/refinery/start', { locationUuid: U.station, rows: [{ resourceUuid: U.ore, quality: 400, amount: '8' }] })).body,
      { error: 'notBookable' });
    assert.equal((await post(SOLO, '/refinery/start', { locationUuid: U.station, rows: [{ resourceUuid: U.metal, quality: 400, amount: '8' }] })).status, 200);
    list = await personal(SOLO);
    const job = list.batches.find((b) => b.state === 'refining')!;
    // Not stock yet: the material's total leaves the job out
    assert.deepEqual([job.subjectUuid, job.quantity, list.totals[U.metal]], [U.metal, '8', '20']);
    const jobId = job.refine!.jobId;
    // Started without a time: set later (the terminal's time left), only by the owner
    assert.equal(job.refine!.endsAt, null);
    assert.equal((await post(SOLO, '/refinery/duration', { jobId, durationSeconds: 1.5 })).status, 400);
    assert.equal((await post(SOLO, '/refinery/duration', { jobId, durationSeconds: 600 })).status, 200);
    assert.ok((await personal(SOLO)).batches.find((b) => b.id === job.id)!.refine!.endsAt);
    // The quality stays: the request has none
    assert.equal((await post(SOLO, '/refinery/done', { jobId, rows: [{ batchId: job.id, amount: '5', quality: 650, expected: '8' }] })).status, 400);
    assert.equal((await post(SOLO, '/refinery/done', { jobId, rows: [{ batchId: job.id, amount: '5', expected: '8' }] })).status, 200);
    list = await personal(SOLO);
    assert.ok(!list.batches.some((b) => b.state === 'refining'));
    assert.ok(list.batches.some((b) => b.subjectUuid === U.metal && b.quality === 400 && b.quantity === '5' && b.state === 'stored'));
    assert.equal(list.totals[U.metal], '25');

    // A job that will not come out is removed as a whole
    assert.equal((await post(SOLO, '/refinery/start', { locationUuid: U.station, rows: [{ resourceUuid: U.metal, quality: 401, amount: '3' }] })).status, 200);
    const lost = (await personal(SOLO)).batches.find((b) => b.state === 'refining')!;
    const lostJob = { jobId: lost.refine!.jobId, rows: [{ batchId: lost.id, expected: lost.quantity }] };
    assert.deepEqual((await post(MIA, '/refinery/remove', lostJob)).body, { error: 'notAllowed' });
    assert.equal((await post(SOLO, '/refinery/remove', { ...lostJob, rows: [{ batchId: lost.id }] })).status, 400);
    assert.deepEqual((await post(SOLO, '/refinery/remove', { ...lostJob, rows: [{ batchId: lost.id, expected: '4' }] })).body, { error: 'batchChanged' });
    assert.equal((await post(SOLO, '/refinery/remove', lostJob)).status, 200);
    assert.ok(!(await personal(SOLO)).batches.some((b) => b.state === 'refining'));

    // No org stock without an org
    assert.deepEqual((await post(SOLO, '/stock/add', { ...metal, quality: 1, amount: '1', guildIds: [G] })).body, { error: 'notMember' });
    assert.deepEqual((await get(SOLO, `/stock?scope=org&guildId=${G}`)).body, { error: 'notMember' });

    // Blueprints: default ones are never registered
    assert.deepEqual((await post(SOLO, '/blueprints/add', { uuid: U.blueprint })).body, { error: 'blueprintDefault' });
    assert.equal((await post(SOLO, '/blueprints/add', { uuid: U.blueprint2 })).status, 200);
    assert.deepEqual((await get(SOLO, '/blueprints')).body, { uuids: [U.blueprint2] });
    assert.equal((await post(SOLO, '/blueprints/remove', { uuid: U.blueprint2 })).status, 200);

    // Profile
    assert.deepEqual((await post(SOLO, '/profile', { rsiHandle: 'no spaces allowed' })).body, { error: 'invalidHandle' });
    assert.equal((await post(SOLO, '/profile', { rsiHandle: 'Solo_Pilot', langOverride: 'de' })).status, 200);
    const me = (await get<MeResponse>(SOLO, '/me')).body;
    assert.deepEqual([me.rsiHandle, me.langOverride, me.orgs], ['Solo_Pilot', 'de', []]);
    assert.equal((await post(SOLO, '/profile', { langOverride: null })).status, 200);
    assert.equal((await get<MeResponse>(SOLO, '/me')).body.langOverride, null);
  });

  it('personal stock is only ever its owner\'s', async () => {
    const solo = (await personal(SOLO)).batches[0]!;
    assert.ok(!(await personal(MIA)).batches.some((b) => b.id === solo.id));
    // Changing someone else's batch: refused by the stock service
    assert.deepEqual((await post(MIA, '/stock/remove', { batchId: solo.id, amount: null, expected: solo.quantity })).body, { error: 'notAllowed' });
  });

  it('shared stock: everyone shares and changes their own, gives to members; others see it but cannot change it', async () => {
    assert.equal((await post(MIA, '/stock/add', { ...metal, quality: 800, amount: '3', guildIds: [G] })).status, 200);
    assert.equal((await post(OLGA, '/stock/add', { ...metal, quality: 810, amount: '2', guildIds: [G] })).status, 200);

    const asMax = await org(MAX);
    assert.equal(asMax.totals[U.metal], '5');
    assert.ok(asMax.batches.every((b) => !b.canChange));
    assert.equal((await org(OLGA)).batches.find((b) => b.holderUserId === MIA)!.canChange, false);
    const miaBatch = (await org(MIA)).batches.find((b) => b.holderUserId === MIA)!;
    assert.equal(miaBatch.canChange, true);
    assert.equal(miaBatch.holderName, 'n52');
    // Only the owner changes it, without naming the org
    assert.deepEqual((await post(OLGA, '/stock/remove', { batchId: miaBatch.id, amount: '1', expected: '3' })).body, { error: 'notAllowed' });
    assert.equal((await post(MIA, '/stock/remove', { batchId: miaBatch.id, amount: '1', expected: '3' })).status, 200);
    // Your own list holds what you share
    assert.ok((await personal(MIA)).batches.some((b) => b.id === miaBatch.id && b.sharedIn.join() === G));
    // Giving: to a member of the org, who gets it unshared
    assert.equal((await post(MIA, '/stock/move', { batchId: miaBatch.id, amount: '1', expected: '2', guildId: G, toOwnerUserId: OLGA })).status, 200);
    assert.ok((await personal(OLGA)).batches.some((b) => b.quality === 800 && !b.sharedIn.length && b.quantity === '1'));
    assert.deepEqual((await post(MIA, '/stock/move', { batchId: miaBatch.id, amount: '1', expected: '1', guildId: G, toOwnerUserId: SOLO })).body,
      { error: 'holderNotMember' });

    // Sharing: own stock offered in the org, a part split off first; taken back again
    await post(MAX, '/stock/add', { ...metal, quality: 300, amount: '4' });
    const maxOwn = (await personal(MAX)).batches[0]!;
    assert.equal((await post(MAX, '/stock/split', { batchId: maxOwn.id, amount: '1', expected: '4' })).status, 200);
    const part = (await personal(MAX)).batches.find((b) => b.id !== maxOwn.id && b.quality === 300)!;
    assert.equal(part.quantity, '1');
    assert.equal((await post(MAX, '/stock/share', { batchId: part.id, guildIds: [G] })).status, 200);
    assert.deepEqual((await org(MAX)).batches.filter((b) => b.holderUserId === MAX && b.quality === 300).map((b) => [b.id, b.quantity]), [[part.id, '1']]);
    assert.deepEqual((await post(OLGA, '/stock/share', { batchId: part.id, guildIds: [] })).body, { error: 'notAllowed' });
    assert.deepEqual((await post(MAX, '/stock/split', { batchId: part.id, amount: '0.5', expected: '1' })).body, { error: 'sharedSplit' });
    assert.equal((await post(MAX, '/stock/share', { batchId: part.id, guildIds: [] })).status, 200);
    assert.equal((await post(MAX, '/stock/share', { batchId: part.id, guildIds: [G] })).status, 200);

    // Holder filter
    const held = (await get<StockListResponse>(MAX, `/stock?scope=org&guildId=${G}&holder=${OLGA}`)).body.batches;
    assert.ok(held.length > 0 && held.every((b: StockBatch) => b.holderUserId === OLGA));
  });

  it('org writes need an active membership; a server the bot left has none', async () => {
    assert.deepEqual((await post(SOLO, '/stock/add', { ...metal, quality: 1, amount: '1', guildIds: [G] })).body, { error: 'notMember' });
    // The bot left: it deactivates the org's members, the org is gone for them
    await markGuildLeft(db, G);
    try {
      assert.deepEqual((await post(MIA, '/stock/add', { ...metal, quality: 1, amount: '1', guildIds: [G] })).body, { error: 'notMember' });
      assert.equal((await get(MIA, `/stock?scope=org&guildId=${G}`)).status, 403);
      assert.equal((await post(MIA, '/stock/add', { ...metal, quality: 1, amount: '1' })).status, 200);
    } finally {
      for (const id of [OLGA, MIA, MAX]) {
        await syncMember(db, G, settings, id, { userId: id, displayName: `n${id.slice(-2)}`, roleIds: [MEMBER_ROLE], bot: false });
      }
    }
  });

  it('findStock (the bot\'s find): what is shared in the org plus your own, best quality first', async () => {
    const found = await findStock(db, G, MIA, U.metal, 300, 'en');
    assert.ok(found.length >= 3);
    assert.ok(found.every((p, i, all) => i === 0 || all[i - 1]!.batch.quality >= p.batch.quality));
    assert.ok(found.every((p) => p.batch.quality >= 300 && p.batch.state === 'stored'));
    assert.ok(found.every((p) => p.sharedIn.includes(G) || p.batch.ownerUserId === MIA));
  });

  it('org members and their blueprints: for active members of the same org only', async () => {
    await post(MAX, '/profile', { rsiHandle: 'MaxPower' });
    const members = (await get<OrgMember[]>(MIA, `/orgs/${G}/members`)).body;
    assert.deepEqual(members.map((m) => [m.userId, m.rsiHandle]), [[OLGA, null], [MIA, null], [MAX, 'MaxPower']]);
    await post(MAX, '/blueprints/add', { uuid: U.blueprint2 });
    await post(OLGA, '/blueprints/add', { uuid: U.blueprint2 });
    // SOLO has it too, but is not in the org: not listed
    await post(SOLO, '/blueprints/add', { uuid: U.blueprint2 });
    assert.deepEqual((await get(MIA, `/orgs/${G}/blueprints`)).body, { entries: [{ uuid: U.blueprint2, owners: [
      { userId: MAX, displayName: 'n53', rsiHandle: 'MaxPower' }, { userId: OLGA, displayName: 'n51', rsiHandle: null },
    ].sort((a, b) => a.displayName.localeCompare(b.displayName)) }] });
    // Not in the org: neither the members nor their blueprints
    assert.equal((await get(SOLO, `/orgs/${G}/members`)).status, 403);
    assert.equal((await get(SOLO, `/orgs/${G}/blueprints`)).status, 403);
  });

  it('crafting check: game data lists, what uses an ingredient, recipes', async () => {
    const bps = (await get<Array<{ uuid: string }>>(SOLO, '/crafting/blueprints?lang=en')).body;
    assert.ok(bps.some((b) => b.uuid === U.blueprint));
    assert.ok((await get<Array<{ uuid: string }>>(SOLO, '/crafting/resources?lang=de')).body.some((r) => r.uuid === U.metal));
    assert.ok((await get<Array<{ uuid: string }>>(SOLO, '/crafting/items')).body.some((i) => i.uuid === U.gem));
    const uses = (await get<Array<{ uuid: string }>>(SOLO, `/crafting/used-by?kind=resource&uuid=${U.metal}`)).body;
    assert.ok(uses.some((u) => u.uuid === U.blueprint));
    assert.equal((await get(SOLO, `/crafting/used-by?kind=resource&uuid=${U.station}`)).status, 404);
    assert.equal((await get(SOLO, `/crafting/used-by?kind=planet&uuid=${U.metal}`)).status, 400);
    const plan = (await get<{ recipes: Array<{ uuid: string }> }>(SOLO, `/crafting/recipes?uuids=${U.blueprint},nonsense`)).body;
    assert.deepEqual(plan.recipes.map((r) => r.uuid), [U.blueprint]);
  });

  it('stock scope all: your own plus what is shared in every org of yours, yours to change only', async () => {
    const all = (await get<StockListResponse>(MIA, '/stock?scope=all')).body;
    // Your own (shared ones included) and what others share: each batch once
    const parts = [...new Map([...(await personal(MIA)).batches, ...(await org(MIA)).batches].map((b) => [b.id, b])).values()];
    assert.deepEqual(all.batches.map((b) => b.id).sort((a, b) => a - b), parts.map((b) => b.id).sort((a, b) => a - b));
    for (const b of all.batches) assert.equal(b.canChange, parts.find((p) => p.id === b.id)!.canChange);
    // Without any org: personal only
    assert.deepEqual((await get<StockListResponse>(SOLO, '/stock?scope=all')).body, (await personal(SOLO)));
  });

  it('summary: personal and per org, consistent with the lists', async () => {
    await post(MIA, '/refinery/start', {
      locationUuid: U.station, durationSeconds: 3600,
      rows: [{ resourceUuid: U.metal, quality: 100, amount: '0.75' }, { resourceUuid: U.metal, quality: 200, amount: '1' }],
    });
    const sum = (await get<SummaryResponse>(MIA, '/summary')).body;
    const mine = await personal(MIA);
    const stored = mine.batches.filter((b) => b.state === 'stored');
    const res = stored.filter((b) => b.unit === 'SCU');
    assert.deepEqual(sum.personal.resources, {
      kinds: new Set(res.map((b) => b.subjectUuid)).size,
      scu: res.reduce((t, b) => t + Number(b.quantity), 0).toString(),
      locations: new Set(res.map((b) => b.locationUuid)).size,
    });
    assert.deepEqual(sum.personal.items, { kinds: 0, pieces: '0', locations: 0 });
    const job = mine.batches.find((b) => b.state === 'refining')!;
    assert.deepEqual(sum.personal.refining, { jobs: 1, expected: '1.75', locations: 1, endsAt: [job.refine!.endsAt] });
    assert.equal(sum.personal.blueprints, 0);
    // The fixture's one pool rewards one blueprint
    assert.equal(sum.obtainableBlueprints, 1);
    const orgList = await org(MIA);
    assert.deepEqual(sum.orgs.map((o) => o.guildId), [G]);
    assert.deepEqual([sum.orgs[0]!.members, sum.orgs[0]!.blueprints], [3, 1]);
    const orgRes = orgList.batches.filter((b) => b.unit === 'SCU');
    assert.equal(sum.orgs[0]!.resources.scu, orgRes.reduce((t, b) => t + Number(b.quantity), 0).toString());
    // Without any org: personal only
    assert.deepEqual((await get<SummaryResponse>(SOLO, '/summary')).body.orgs, []);
  });

  it('admin overview: registered blueprints the game data has no source for', async () => {
    // Blueprint 2 is in the fixture's reward pool: no gap
    assert.equal((await getOverview(db, 'en')).gaps.registeredNoSource.length, 0);
    const n = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM app.user_blueprint WHERE blueprint_uuid = ${U.blueprint2}`))[0]!.n;
    assert.ok(n > 0);
    // Without the pool it has no known source, but users registered it
    await db.execute(sql`UPDATE catalog.raw_record SET retired_at = now() WHERE type = 'BlueprintPoolRecord'`);
    try {
      const gaps = (await getOverview(db, 'en')).gaps;
      assert.equal(gaps.noSourceBlueprints, 1);
      assert.deepEqual(gaps.registeredNoSource.map((b) => [b.uuid, b.users]), [[U.blueprint2, n]]);
    } finally {
      await db.execute(sql`UPDATE catalog.raw_record SET retired_at = NULL WHERE type = 'BlueprintPoolRecord'`);
    }
  });

  it('info cards: blueprint with its recipe, resource or item, no raw records', async () => {
    const bp = (await get<BlueprintInfo & Record<string, unknown>>(SOLO, `/info/blueprint/${U.blueprint}?lang=en`)).body;
    assert.equal(bp.isDefault, true);
    assert.ok(bp.slots.length > 0 && bp.slots.every((s) => s.inputs.length > 0));
    assert.ok(!('raw' in bp));
    const metal = (await get<MaterialInfo & Record<string, unknown>>(SOLO, `/info/material/${U.metal}`)).body;
    assert.deepEqual([metal.kind, metal.isOre, metal.usedIn > 0, 'raw' in metal], ['resource', false, true, false]);
    assert.equal((await get<MaterialInfo>(SOLO, `/info/material/${U.ore}`)).body.isOre, true);
    assert.equal((await get<MaterialInfo>(SOLO, `/info/material/${U.gem}`)).body.kind, 'item');
    assert.equal((await get(SOLO, `/info/material/${U.station}`)).status, 404);
    assert.equal((await get(SOLO, '/info/blueprint/nope')).status, 400);
  });

  it('refuses malformed requests', async () => {
    assert.deepEqual((await post(MIA, '/stock/add', { ...metal, quality: 1, amount: '1', extra: true })).body, { error: 'invalid' });
    assert.deepEqual((await post(MIA, '/stock/remove', { batchId: 'x', amount: null, expected: '1' })).body, { error: 'invalid' });
    assert.equal((await get(MIA, '/stock?scope=everything')).status, 400);
    assert.deepEqual((await post(MIA, '/stock/add', { subjectUuid: U.station, locationUuid: U.station, quality: 1, amount: '1' })).body, { error: 'unknownSubject' });
  });
  it('history: own actions and what others did to your data, with source (web app or companion), names, pages', async () => {
    const last = Number((await db.execute<{ n: string }>(sql`SELECT coalesce(max(id), 0)::text AS n FROM app.history`))[0]!.n);
    const since = (r: HistoryResponse) => r.entries.filter((e) => e.id > last);
    assert.equal((await post(MIA, '/stock/add', { ...metal, quality: 333, amount: '3', guildIds: [G] })).status, 200);
    const batch = (await org(MIA)).batches.find((b) => b.quality === 333)!;
    // The owner gives some to another member from the companion app (API token)
    const token = ((await (await app.request('/api/token', { method: 'POST', body: '{}', headers: { ...headers(MIA), 'content-type': 'application/json' } })).json()) as { token: string }).token;
    const moved = await app.request('/api/stock/move', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: batch.id, amount: '1', expected: '3', guildId: G, toOwnerUserId: MAX }),
    });
    assert.equal(moved.status, 200);

    const mia = since((await get<HistoryResponse>(MIA, '/history?lang=en')).body);
    assert.deepEqual(mia.map((e) => [e.source, e.category, e.action, e.actor.userId, e.holder?.userId, e.toHolder?.userId ?? null]), [
      ['companion', 'stock', 'give', MIA, MIA, MAX],
      // Adding shared is two steps: the stock, then the share
      ['webapp', 'stock', 'share', MIA, MIA, null],
      ['webapp', 'stock', 'add', MIA, undefined, null],
    ]);
    const added = mia[2]!;
    const [move] = mia;
    assert.deepEqual([move!.actor.name, move!.holder!.name, move!.toHolder!.name, move!.org, move!.amount, move!.unit, move!.quality],
      [`n${MIA.slice(-2)}`, `n${MIA.slice(-2)}`, `n${MAX.slice(-2)}`, 'Feature Org', '1', 'SCU', 333]);
    assert.ok(move!.target !== U.metal && move!.location !== U.station, 'names, not UUIDs');
    assert.equal(move!.targetUuid, U.metal);
    // The recipient sees the give, other members of the org only the share; someone outside it nothing
    assert.ok(since((await get<HistoryResponse>(MAX, '/history')).body).some((e) => e.id === move!.id));
    const olga = since((await get<HistoryResponse>(OLGA, '/history')).body);
    assert.deepEqual(olga.map((e) => [e.action, e.actor.userId]), [['share', MIA]]);
    assert.deepEqual(since((await get<HistoryResponse>(SOLO, '/history')).body), []);

    // Pages: newest first, `before` continues
    const older = (await get<HistoryResponse>(MIA, `/history?before=${move!.id}`)).body;
    assert.ok(older.entries.every((e) => e.id < move!.id) && older.entries[0]!.id === mia[1]!.id);
    assert.equal((await get(MIA, '/history?before=abc')).status, 400);

    // Filters (on the server, so pages continue within them)
    const ids = async (query: string) => since((await get<HistoryResponse>(MIA, `/history?${query}`)).body).map((e) => e.id);
    assert.deepEqual(await ids('source=companion'), [move!.id]);
    assert.deepEqual(await ids('by=others'), []);
    // For the recipient it is someone else's action
    assert.ok(since((await get<HistoryResponse>(MAX, '/history?by=others')).body).some((e) => e.id === move!.id));
    assert.deepEqual(await ids('by=me&category=stock&action=add'), [added.id]);
    assert.deepEqual(await ids('category=blueprint'), []);
    assert.deepEqual(await ids(`after=${added.id}`), [move!.id, mia[1]!.id]);
    assert.deepEqual(await ids(`after=${mia[1]!.id}&before=${move!.id}`), []);
    for (const bad of ['source=discord', 'by=everyone', 'action=fly', 'nope=1']) assert.equal((await get(MIA, `/history?${bad}`)).status, 400, bad);
  });
});
