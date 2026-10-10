// Runs against TEST_DATABASE_URL only; the ext, web, bot, app and catalog schemas there are dropped and recreated.
// The admin's read-only user data: orgs, users (names from web logins, tokens or the roster) and the data checks.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { addBlueprint } from '../src/bot/blueprints.ts';
import { ensureGuild, markGuildLeft, updateGuildSettings } from '../src/bot/settings.ts';
import { storeSnapshot } from '../src/ext/store.ts';
import { add, refineStart, type Actor } from '../src/stock/service.ts';
import { createSession } from '../src/webapp/session.ts';
import { createApiToken } from '../src/webapp/token.ts';
import { getDataChecks, getOrg, getOrgs, getUser, getUsers } from '../src/adminapp/users.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const [G, G2] = ['700000000000000061', '700000000000000062'];
const ROLE = '710000000000000061';
const [OLGA, MIA, SOLO] = ['740000000000000061', '740000000000000062', '740000000000000063'];

describe('admin: users, orgs and data checks (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;
  const actor = (userId: string, guildId: string | null = null): Actor => ({ userId, guildId, source: 'webapp' });

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });

    await ensureGuild(db, G, 'Alpha Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [ROLE] });
    await ensureGuild(db, G2, 'Beta Org');
    for (const id of [OLGA, MIA]) {
      await syncMember(db, G, settings, id, { userId: id, displayName: `nick${id.slice(-2)}`, roleIds: [ROLE], bot: false });
    }
    await markGuildLeft(db, G2);

    // Olga: web login and companion token, shared stock and a blueprint; Mia: bot only; Solo: no org, a refinery job
    const web = connectAs(url, 'qm_web');
    try {
      await createSession(web.db, { id: OLGA, username: 'olga', globalName: 'Olga O.', avatar: null });
      await createApiToken(web.db, { userId: OLGA, username: 'olga', globalName: 'Olga O.', avatar: null });
      await createSession(web.db, { id: SOLO, username: 'solo', globalName: null, avatar: null });
    } finally {
      await web.close();
    }
    await add(db, actor(OLGA, G), { kind: 'resource', uuid: U.metal, locationUuid: U.station, quality: 700, amount: '12.5', org: true });
    await add(db, actor(OLGA), { kind: 'item', uuid: U.gem, locationUuid: U.station, quality: 500, amount: '3' });
    await add(db, actor(MIA, G), { kind: 'resource', uuid: U.metal, locationUuid: U.station, quality: 800, amount: '2', org: true });
    await addBlueprint(db, OLGA, U.blueprint2, 'webapp');
    await refineStart(db, actor(SOLO), { locationUuid: U.station, durationSeconds: 3600, rows: [{ resourceUuid: U.metal, quality: 400, amount: '8' }] });
  });
  after(async () => close?.());

  it('lists orgs with bot state, roster counts and shared stock', async () => {
    const orgs = await getOrgs(db);
    assert.deepEqual(orgs.map((o) => [o.name, o.membersActive, o.sharedBatches, o.memberRoles, o.leftAt === null]), [
      ['Alpha Org', 2, 2, 1, true], ['Beta Org', 0, 0, 0, false],
    ]);
    assert.ok(orgs[0]!.lastActivity);

    const org = (await getOrg(db, G, 'en'))!;
    assert.deepEqual(org.members.map((m) => [m.userId, m.name, m.displayName, m.active]), [
      [OLGA, 'Olga O.', 'nick61', true], [MIA, 'nick62', 'nick62', true],
    ]);
    // Only what is shared there: the metal of both, not Olga's unshared gem
    assert.deepEqual(org.stock.map((s) => [s.uuid, s.total, s.unit, s.batches, s.owners, s.minQuality, s.maxQuality]), [
      [U.metal, '14.5', 'SCU', 2, 2, 700, 800],
    ]);
    assert.equal(await getOrg(db, '700000000000000099', 'en'), null);
  });

  it('lists users from the roster and the web app, with their data', async () => {
    const users = new Map((await getUsers(db)).map((u) => [u.userId, u]));
    assert.deepEqual([...users.keys()].sort(), [OLGA, MIA, SOLO]);
    const olga = users.get(OLGA)!;
    assert.deepEqual([olga.name, olga.discordUsername, olga.orgs, olga.batches, olga.resourceScu, olga.itemPcs, olga.blueprints, olga.companion],
      ['Olga O.', 'olga', ['Alpha Org'], 2, '12.5', '3', 1, true]);
    assert.ok(olga.lastSeen && olga.lastActivity);
    // Bot only: the nickname, no web data
    const mia = users.get(MIA)!;
    assert.deepEqual([mia.name, mia.discordUsername, mia.lastSeen, mia.companion], ['nick62', null, null, false]);
    // No org: the Discord username of the login; the refinery job is no stored batch
    const solo = users.get(SOLO)!;
    assert.deepEqual([solo.name, solo.orgs, solo.batches, solo.resourceScu, solo.refineryJobs], ['solo', [], 0, '0', 1]);

    const detail = (await getUser(db, OLGA, 'en'))!;
    assert.deepEqual([detail.sessions, !!detail.tokenCreatedAt, detail.tokenLastUsedAt], [1, true, null]);
    assert.deepEqual(detail.memberships.map((m) => [m.org, m.displayName, m.active]), [['Alpha Org', 'nick61', true]]);
    assert.deepEqual(detail.stock.map((s) => [s.uuid, s.total, s.shared]), [[U.metal, '12.5', 1], [U.gem, '3', 0]]);
    assert.deepEqual(detail.blueprintList.map((b) => b.uuid), [U.blueprint2]);
    // Newest first; blueprints without a unit, stock with its own
    assert.deepEqual([detail.history[0]!.category, detail.history[0]!.action, detail.history[0]!.unit], ['blueprint', 'add', null]);
    assert.ok(detail.history.some((h) => h.action === 'add' && h.unit === 'pcs' && h.amount === '3'));
    assert.ok(detail.history.every((h) => !h.byOther && h.target));

    const job = (await getUser(db, SOLO, 'en'))!.jobs;
    assert.deepEqual(job.map((j) => [j.scu, j.ores.length, !!j.endsAt]), [['8', 1, true]]);
    assert.equal(await getUser(db, '740000000000000099', 'en'), null);
  });

  it('data checks: retired catalog entries, overdue jobs, jobs outside the refineries', async () => {
    const count = async () => Object.fromEntries((await getDataChecks(db, 'en')).map((c) => [c.key, c.hits.length]));
    assert.deepEqual(await count(), { retiredMaterial: 0, retiredLocation: 0, retiredBlueprint: 0, overdueJob: 0, jobNotAtRefinery: 0 });

    await db.execute(sql`UPDATE catalog.item SET retired_at = now() WHERE uuid = ${U.gem}`);
    await db.execute(sql`UPDATE catalog.blueprint SET retired_at = now() WHERE uuid = ${U.blueprint2}`);
    await db.execute(sql`UPDATE app.stock_batch SET refine_started_at = now() - interval '9 days', refine_ends_at = now() - interval '8 days' WHERE state = 'refining'`);
    // UEX data without this station: the job sits outside every refinery
    await storeSnapshot(db, 'uex', 'refineries_yields', [
      { id_terminal: 1, terminal_name: 'Refinery Nowhere', star_system_name: 'Nyx', space_station_name: 'Nowhere', commodity_name: 'Iron (Ore)', value: 1 },
    ]);
    assert.deepEqual(await count(), { retiredMaterial: 1, retiredLocation: 0, retiredBlueprint: 1, overdueJob: 1, jobNotAtRefinery: 1 });
    const checks = new Map((await getDataChecks(db, 'en')).map((c) => [c.key, c.hits]));
    assert.deepEqual(checks.get('retiredMaterial')!.map((h) => [h.userId, h.name, h.amount, h.unit]), [[OLGA, 'Olga O.', '3', 'pcs']]);
    assert.deepEqual(checks.get('overdueJob')!.map((h) => [h.userId, h.name, h.amount, h.unit]), [[SOLO, 'solo', '8', 'SCU']]);

    await db.execute(sql`UPDATE catalog.location SET retired_at = now() WHERE uuid = ${U.station}`);
    // Every batch sits there: Olga's two, Mia's one, Solo's job
    assert.equal((await count()).retiredLocation, 4);
  });
});
