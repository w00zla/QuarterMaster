// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
// The user web app's feature endpoints through Hono (app.request): catalog, stock, refinery,
// blueprints, org members, profile — rights, the rosterStale guard and users without any org.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connect, type Db } from '../src/db/client.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings, type GuildSettings } from '../src/bot/settings.ts';
import type {
  BlueprintInfo, CatalogResponse, HistoryResponse, MaterialInfo, MeResponse, OrgMember, StockBatch, StockListResponse, SummaryResponse,
} from '../src/webapp/api-types.ts';
import { createApp } from '../src/webapp/app.ts';
import type { DiscordLogin } from '../src/webapp/discord.ts';
import { createSession } from '../src/webapp/session.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://qm.test';
const G = '700000000000000051';
const MEMBER_ROLE = '710000000000000051';
const OFFICER_ROLE = '710000000000000052';
const [OLGA, MIA, MAX, SOLO] = ['740000000000000051', '740000000000000052', '740000000000000053', '740000000000000054'];
const noLogin: DiscordLogin = { start: () => Promise.reject(new Error('unused')), finish: () => Promise.reject(new Error('unused')) };

describe('web app features (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;
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
  const fresh = (on: boolean) => db.execute(sql`UPDATE app.org SET roster_checked_at = ${on ? sql`now()` : sql`NULL`} WHERE guild_id = ${G}`);
  const metal = { subjectUuid: U.metal, locationUuid: U.station };

  before(async () => {
    ({ db, close } = connect(url));
    for (const schema of ['ext', 'web', 'bot', 'app', 'catalog', 'drizzle']) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    await ensureGuild(db, G, 'Feature Org');
    settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE], officerRoleIds: [OFFICER_ROLE] });
    for (const [id, role] of [[OLGA, OFFICER_ROLE], [MIA, MEMBER_ROLE], [MAX, MEMBER_ROLE]] as const) {
      await syncMember(db, G, settings, id, { userId: id, displayName: `n${id.slice(-2)}`, roleIds: [role], bot: false });
    }
    for (const id of [OLGA, MIA, MAX, SOLO]) {
      tokens.set(id, await createSession(db, { id, username: `u${id.slice(-2)}`, globalName: null, avatar: null }));
    }
    await fresh(true);
    app = createApp(db, noLogin, { origin: ORIGIN, trustProxy: false, distDir: null });
  });
  after(async () => close?.());

  it('catalog: materials with unit and ore flag, locations, blueprints', async () => {
    const { status, body } = await get<CatalogResponse>(SOLO, '/catalog?lang=en');
    assert.equal(status, 200);
    const byUuid = new Map(body.materials.map((m) => [m.uuid, m]));
    assert.deepEqual([byUuid.get(U.metal)?.unit, byUuid.get(U.metal)?.isOre], ['SCU', false]);
    assert.equal(byUuid.get(U.ore)?.isOre, true);
    assert.equal(byUuid.get(U.gem)?.unit, 'pcs');
    // Item types for the icons: items have one (or null), resources never
    assert.ok('type' in byUuid.get(U.gem)! && byUuid.get(U.metal)!.type === null);
    assert.ok(body.blueprints.every((b) => 'type' in b && 'typeLabel' in b));
    assert.ok(body.locations.some((l) => l.uuid === U.station));
    assert.ok(body.blueprints.some((b) => b.uuid === U.blueprint && b.isDefault && typeof b.name === 'string'));
  });

  it('a user without any org: personal stock, refinery, blueprints, profile', async () => {
    assert.equal((await post(SOLO, '/stock/add', { ...metal, quality: 700, amount: '12,5' })).status, 200);
    let list = await personal(SOLO);
    const batch = list.batches[0]!;
    assert.deepEqual([batch.quantity, batch.unit, batch.canChange, batch.designation, list.totals[U.metal]], ['12.5', 'SCU', true, 'personal', '12.5']);
    assert.equal((await post(SOLO, '/stock/remove', { batchId: batch.id, amount: '2.5', expected: '12.5' })).status, 200);
    // Booking against what the user saw: a changed batch is refused
    assert.deepEqual((await post(SOLO, '/stock/adjust', { batchId: batch.id, amount: '20', expected: '12.5' })).body, { error: 'batchChanged' });
    assert.equal((await post(SOLO, '/stock/adjust', { batchId: batch.id, amount: '20', expected: '10' })).status, 200);
    assert.equal((await personal(SOLO)).totals[U.metal], '20');

    // Refinery: start with ore, done consumes the job and stores the refined resource
    assert.equal((await post(SOLO, '/refinery/start', { locationUuid: U.station, rows: [] })).status, 400);
    assert.equal((await post(SOLO, '/refinery/start', { locationUuid: U.station, rows: [{ oreUuid: U.ore, quality: 400, amount: '8' }] })).status, 200);
    list = await personal(SOLO);
    const job = list.batches.find((b) => b.state === 'refining')!;
    const jobId = job.refine!.jobId;
    // Quality is the ore's: the request has none
    assert.equal((await post(SOLO, '/refinery/done', { jobId, rows: [{ batchId: job.id, amount: '5', quality: 650, expected: '8' }] })).status, 400);
    assert.equal((await post(SOLO, '/refinery/done', { jobId, rows: [{ batchId: job.id, amount: '5', expected: '8' }] })).status, 200);
    list = await personal(SOLO);
    assert.ok(!list.batches.some((b) => b.state === 'refining'));
    assert.ok(list.batches.some((b) => b.subjectUuid === U.metal && b.quality === 400 && b.quantity === '5'));

    // No org stock without an org
    assert.deepEqual((await post(SOLO, '/stock/add', { ...metal, quality: 1, amount: '1', guildId: G })).body, { error: 'notMember' });
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

  it('org stock: members add their own and donate, officers change it; others see it but cannot change it', async () => {
    assert.equal((await post(MIA, '/stock/add', { ...metal, quality: 800, amount: '3', guildId: G })).status, 200);
    // Members cannot name another holder
    assert.deepEqual((await post(MIA, '/stock/add', { ...metal, quality: 800, amount: '1', guildId: G, holderUserId: MAX })).body, { error: 'notAllowed' });
    assert.equal((await post(OLGA, '/stock/add', { ...metal, quality: 810, amount: '2', guildId: G, holderUserId: MAX })).status, 200);

    const asMax = await org(MAX);
    assert.equal(asMax.totals[U.metal], '5');
    assert.ok(asMax.batches.every((b) => !b.canChange));
    const miaBatch = (await org(OLGA)).batches.find((b) => b.holderUserId === MIA)!;
    assert.equal(miaBatch.canChange, true);
    assert.equal(miaBatch.holderName, 'n52');
    // A member cannot change org stock, not even what they hold
    assert.deepEqual((await post(MIA, '/stock/remove', { batchId: miaBatch.id, amount: '1', expected: '3', guildId: G })).body, { error: 'notAllowed' });
    assert.equal((await post(OLGA, '/stock/move', { batchId: miaBatch.id, amount: '1', expected: '3', guildId: G, toHolderUserId: OLGA })).status, 200);

    // Donation: own personal stock becomes org stock
    await post(MAX, '/stock/add', { ...metal, quality: 300, amount: '4' });
    const maxPersonal = (await personal(MAX)).batches[0]!;
    assert.equal((await post(MAX, '/stock/move', { batchId: maxPersonal.id, amount: null, expected: '4', guildId: G, toOrg: true })).status, 200);
    assert.ok((await org(MAX)).batches.some((b) => b.holderUserId === MAX && b.quality === 300));

    // Holder filter
    const held = (await get<StockListResponse>(MAX, `/stock?scope=org&guildId=${G}&holder=${OLGA}`)).body.batches;
    assert.ok(held.length > 0 && held.every((b: StockBatch) => b.holderUserId === OLGA));
  });

  it('org writes need a roster the bot vouches for; reads and personal stock do not', async () => {
    await fresh(false);
    try {
      assert.deepEqual((await post(MIA, '/stock/add', { ...metal, quality: 1, amount: '1', guildId: G })).body, { error: 'rosterStale' });
      assert.equal((await get(MIA, `/stock?scope=org&guildId=${G}`)).status, 200);
      assert.equal((await post(MIA, '/stock/add', { ...metal, quality: 1, amount: '1' })).status, 200);
      // The bot left the server: same
      await fresh(true);
      await db.execute(sql`UPDATE bot.guild SET left_at = now() WHERE guild_id = ${G}`);
      assert.deepEqual((await post(OLGA, '/stock/add', { ...metal, quality: 1, amount: '1', guildId: G })).body, { error: 'rosterStale' });
    } finally {
      await db.execute(sql`UPDATE bot.guild SET left_at = NULL WHERE guild_id = ${G}`);
      await fresh(true);
    }
  });

  it('find: the org\'s stock plus your own personal, best quality first; without an org your own only', async () => {
    const { body } = await get<StockListResponse>(MIA, `/stock/find?subject=${U.metal}&minQuality=300&guildId=${G}`);
    assert.ok(body.batches.length >= 3);
    assert.ok(body.batches.every((b, i, all) => i === 0 || all[i - 1]!.quality >= b.quality));
    assert.ok(body.batches.every((b) => b.designation === 'org' || b.holderUserId === MIA));
    const solo = (await get<StockListResponse>(SOLO, `/stock/find?subject=${U.metal}&minQuality=0`)).body.batches;
    assert.ok(solo.length > 0 && solo.every((b) => b.designation === 'personal' && b.holderUserId === SOLO));
  });

  it('org members and their blueprints: for active members of the same org only', async () => {
    await post(MAX, '/profile', { rsiHandle: 'MaxPower' });
    const members = (await get<OrgMember[]>(MIA, `/orgs/${G}/members`)).body;
    assert.deepEqual(members.map((m) => [m.userId, m.officer, m.rsiHandle]), [[OLGA, true, null], [MIA, false, null], [MAX, false, 'MaxPower']]);
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

  it('summary: personal and per org, consistent with the lists', async () => {
    await post(MIA, '/refinery/start', { locationUuid: U.station, rows: [{ oreUuid: U.ore, quality: 100, amount: '2' }, { oreUuid: U.ore, quality: 200, amount: '1' }] });
    const sum = (await get<SummaryResponse>(MIA, '/summary')).body;
    const mine = await personal(MIA);
    const stored = mine.batches.filter((b) => b.state === 'stored');
    assert.deepEqual(sum.personal, {
      materials: new Set(stored.map((b) => b.subjectUuid)).size, batches: stored.length,
      scu: stored.filter((b) => b.unit === 'SCU').reduce((t, b) => t + Number(b.quantity), 0).toString(),
      pieces: '0', refiningJobs: 1, blueprints: 0,
    });
    const orgList = await org(MIA);
    assert.deepEqual(sum.orgs.map((o) => o.guildId), [G]);
    assert.deepEqual([sum.orgs[0]!.members, sum.orgs[0]!.blueprints, sum.orgs[0]!.batches], [3, 1, orgList.batches.length]);
    // Without any org: personal only
    assert.deepEqual((await get<SummaryResponse>(SOLO, '/summary')).body.orgs, []);
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
    assert.equal((await post(MIA, '/stock/add', { ...metal, quality: 333, amount: '3', guildId: G })).status, 200);
    const batch = (await org(MIA)).batches.find((b) => b.quality === 333)!;
    // The officer moves it to another holder from the companion app (API token)
    const token = ((await (await app.request('/api/token', { method: 'POST', body: '{}', headers: { ...headers(OLGA), 'content-type': 'application/json' } })).json()) as { token: string }).token;
    const moved = await app.request('/api/stock/move', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: batch.id, amount: '1', expected: '3', guildId: G, toHolderUserId: MAX }),
    });
    assert.equal(moved.status, 200);

    const mia = since((await get<HistoryResponse>(MIA, '/history?lang=en')).body);
    assert.deepEqual(mia.map((e) => [e.source, e.category, e.action, e.actor.userId, e.holder?.userId, e.toHolder?.userId ?? null]), [
      ['companion', 'stock', 'move', OLGA, MIA, MAX],
      ['webapp', 'stock', 'add', MIA, MIA, null],
    ]);
    const [move] = mia;
    assert.deepEqual([move!.actor.name, move!.holder!.name, move!.toHolder!.name, move!.org, move!.amount, move!.unit, move!.quality],
      [`n${OLGA.slice(-2)}`, `n${MIA.slice(-2)}`, `n${MAX.slice(-2)}`, 'Feature Org', '1', 'SCU', 333]);
    assert.ok(move!.target !== U.metal && move!.location !== U.station, 'names, not UUIDs');
    // The new holder and the officer see the move; someone else sees none of it
    assert.ok(since((await get<HistoryResponse>(MAX, '/history')).body).some((e) => e.id === move!.id));
    assert.ok(since((await get<HistoryResponse>(OLGA, '/history')).body).some((e) => e.id === move!.id));
    assert.deepEqual(since((await get<HistoryResponse>(SOLO, '/history')).body), []);

    // Pages: newest first, `before` continues
    const older = (await get<HistoryResponse>(MIA, `/history?before=${move!.id}`)).body;
    assert.ok(older.entries.every((e) => e.id < move!.id) && older.entries[0]!.id === mia[1]!.id);
    assert.equal((await get(MIA, '/history?before=abc')).status, 400);

    // Filters (on the server, so pages continue within them)
    const ids = async (query: string) => since((await get<HistoryResponse>(MIA, `/history?${query}`)).body).map((e) => e.id);
    assert.deepEqual(await ids('source=companion'), [move!.id]);
    assert.deepEqual(await ids('by=others'), [move!.id]);
    assert.deepEqual(await ids('by=me&category=stock&action=add'), [mia[1]!.id]);
    assert.deepEqual(await ids('category=blueprint'), []);
    assert.deepEqual(await ids(`after=${mia[1]!.id}`), [move!.id]);
    assert.deepEqual(await ids(`after=${mia[1]!.id}&before=${move!.id}`), []);
    for (const bad of ['source=discord', 'by=everyone', 'action=fly', 'nope=1']) assert.equal((await get(MIA, `/history?${bad}`)).status, 400, bad);
  });
});
