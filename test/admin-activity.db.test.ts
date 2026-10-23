// Runs against TEST_DATABASE_URL only; the ext, web, bot, app and catalog schemas there are dropped and recreated.
// The admin's dashboard and activity list: history rows with names, filters and the id cursor; the dashboard's figures.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { one } from '../src/db/query.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { addBlueprint } from '../src/bot/blueprints.ts';
import { ensureGuild, markGuildLeft, updateGuildSettings } from '../src/bot/settings.ts';
import { add, COMPONENT_QUALITY, move, refineStart, type Actor } from '../src/stock/service.ts';
import { createSession } from '../src/webapp/session.ts';
import { createApiToken } from '../src/webapp/token.ts';
import { activityFilter, getActivity, getDashboard } from '../src/adminapp/activity.ts';
import { FPS, FPS_RECORDS, RECORDS, U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const [G, G2] = ['700000000000000071', '700000000000000072'];
const ROLE = '710000000000000071';
const [OLGA, MIA, SOLO] = ['740000000000000071', '740000000000000072', '740000000000000073'];

describe('activity filter (query parameters)', () => {
  it('keeps valid values and drops the rest', () => {
    const q = (params: Record<string, string>) => activityFilter((name) => params[name]);
    assert.deepEqual(q({}), {
      before: undefined, limit: 100, source: undefined, category: undefined, action: undefined, guildId: undefined, userId: undefined, days: undefined,
    });
    assert.deepEqual(q({ before: '42', limit: '20', source: 'companion', category: 'refinery', action: 'start', guild: G, user: OLGA, days: '7' }), {
      before: 42, limit: 20, source: 'companion', category: 'refinery', action: 'start', guildId: G, userId: OLGA, days: 7,
    });
    const bad = q({ before: '-1', limit: '5000', source: 'discord', category: 'x', action: 'drop', guild: '12', user: 'abc', days: '0' });
    assert.deepEqual([bad.before, bad.limit, bad.source, bad.category, bad.action, bad.guildId, bad.userId, bad.days],
      [undefined, 200, undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('admin: dashboard and activity (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;
  const actor = (userId: string, source: Actor['source'], guildId: string | null = null): Actor => ({ userId, guildId, source });
  const historyCount = async (where = sql`true`) => (await one<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM app.history WHERE ${where}`))!.n;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot({ ...RECORDS, ...FPS_RECORDS });
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });

    await ensureGuild(db, G, 'Alpha Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [ROLE] });
    await ensureGuild(db, G2, 'Beta Org');
    for (const id of [OLGA, MIA]) {
      await syncMember(db, G, settings, id, { userId: id, displayName: `nick${id.slice(-2)}`, roleIds: [ROLE], bot: false });
    }
    await markGuildLeft(db, G2);

    // Olga: web login and a companion token used today; Solo: web login, no org; Mia: bot only
    const web = connectAs(url, 'qm_web');
    try {
      await createSession(web.db, { id: OLGA, username: 'olga', globalName: 'Olga O.', avatar: null });
      await createApiToken(web.db, { userId: OLGA, username: 'olga', globalName: 'Olga O.', avatar: null });
      await web.db.execute(sql`UPDATE web.api_token SET last_used_at = now() WHERE user_id = ${OLGA}`);
      await createSession(web.db, { id: SOLO, username: 'solo', globalName: null, avatar: null });
    } finally {
      await web.close();
    }

    await add(db, actor(OLGA, 'webapp', G), { kind: 'resource', uuid: U.metal, locationUuid: U.station, quality: 700, amount: '12.5', org: true });
    const gem = await add(db, actor(OLGA, 'companion'), { kind: 'item', uuid: U.gem, locationUuid: U.station, quality: 500, amount: '3' });
    await add(db, actor(OLGA, 'companion'), { kind: 'item', uuid: U.output, locationUuid: U.station, quality: COMPONENT_QUALITY, amount: '1' });
    await add(db, actor(MIA, 'bot', G), { kind: 'resource', uuid: U.metal, locationUuid: U.station, quality: 800, amount: '2', org: true });
    await add(db, actor(MIA, 'bot'), { kind: 'item', uuid: FPS.helmet, locationUuid: U.station, quality: COMPONENT_QUALITY, amount: '1' });
    await addBlueprint(db, OLGA, U.blueprint2, 'companion');
    // A give in Alpha: one gem to Mia
    await move(db, actor(OLGA, 'webapp', G), { batchId: gem.batch!.id, amount: '1', toOwnerUserId: MIA });
    // Solo: one job running, one ready (for over a week: a data check hit)
    await refineStart(db, actor(SOLO, 'webapp'), { locationUuid: U.station, durationSeconds: 3600, rows: [{ resourceUuid: U.metal, quality: 400, amount: '8' }] });
    const ready = await refineStart(db, actor(SOLO, 'webapp'), { locationUuid: U.station, durationSeconds: 60, rows: [{ resourceUuid: U.metal, quality: 100, amount: '2' }] });
    await db.execute(sql`UPDATE app.stock_batch SET refine_started_at = now() - interval '9 days', refine_ends_at = now() - interval '8 days'
      WHERE refine_job = ${ready.jobId}`);
  });
  after(async () => close?.());

  it('lists history rows newest first, with names, org, target, amount and locations', async () => {
    const all = await getActivity(db, 'en', activityFilter(() => undefined));
    assert.equal(all.rows.length, await historyCount());
    assert.equal(all.next, null);
    assert.deepEqual(all.rows.map((r) => r.id), [...all.rows.map((r) => r.id)].sort((a, b) => b - a));

    const give = all.rows.find((r) => r.action === 'give')!;
    assert.deepEqual([give.actor, give.owner, give.toOwner, give.org, give.guildId, give.amount, give.unit, give.source],
      [{ userId: OLGA, name: 'Olga O.' }, { userId: OLGA, name: 'Olga O.' }, { userId: MIA, name: 'nick72' }, 'Alpha Org', G, '1', 'pcs', 'webapp']);
    assert.ok(give.location && give.target && give.target !== U.gem);

    const bp = all.rows.find((r) => r.category === 'blueprint')!;
    assert.deepEqual([bp.action, bp.source, bp.unit, bp.amount, bp.location], ['add', 'companion', null, null, null]);
    assert.notEqual(bp.target, U.blueprint2);

    const metal = all.rows.find((r) => r.action === 'add' && r.targetUuid === U.metal && r.actor.userId === OLGA)!;
    assert.deepEqual([metal.amount, metal.unit, metal.quality, metal.details.locationUuid], ['12.5', 'SCU', 700, U.station]);
  });

  it('filters by source, category, action, org, user and days; pages by id', async () => {
    const q = (params: Record<string, string>) => getActivity(db, 'en', activityFilter((name) => params[name]));
    assert.equal((await q({ source: 'companion' })).rows.length, await historyCount(sql`source = 'companion'`));
    assert.ok((await q({ source: 'companion' })).rows.every((r) => r.source === 'companion'));
    assert.deepEqual((await q({ category: 'refinery' })).rows.map((r) => [r.action, r.owner.userId]), [['start', SOLO], ['start', SOLO]]);
    assert.ok((await q({ action: 'add' })).rows.every((r) => r.action === 'add'));
    assert.ok((await q({ guild: G })).rows.every((r) => r.guildId === G));
    assert.equal((await q({ guild: G2 })).rows.length, 0);
    // Mia as actor or as the new owner of the give
    const mia = (await q({ user: MIA })).rows;
    assert.ok(mia.some((r) => r.action === 'give') && mia.every((r) => [r.actor.userId, r.owner.userId, r.toOwner?.userId].includes(MIA)));
    assert.equal((await q({ days: '1' })).rows.length, await historyCount());

    const pages = [];
    let page = await q({ limit: '3' });
    pages.push(...page.rows);
    while (page.next !== null) {
      page = await q({ limit: '3', before: String(page.next) });
      pages.push(...page.rows);
    }
    assert.deepEqual(pages.map((r) => r.id), (await q({})).rows.map((r) => r.id));
  });

  it('dashboard: attention, KPIs, the day series, reach, orgs and sources', async () => {
    const total = await historyCount();
    const d = await getDashboard(db, 'en', 7);

    // No UEX data yet, Solo's job ready for over a week; the catalog is imported, no logs channel
    assert.deepEqual(d.attention.map((a) => [a.severity, a.text, a.to]), [
      ['warn', 'UEX pull: no data yet', '/status'], ['warn', 'Refinery jobs ready for over a week: 1', '/status'],
    ]);

    const k = d.kpis;
    assert.deepEqual([k.activeUsers.value, k.activeUsers.known, k.activeUsers.series.length], [3, 3, 30]);
    assert.equal(k.actions.value, total);
    assert.equal(k.actions.bySource.bot + k.actions.bySource.webapp + k.actions.bySource.companion, total);
    assert.equal(k.actions.bySource.companion, await historyCount(sql`source = 'companion'`));
    assert.equal(k.actions.series.reduce((sum, s) => sum + s.count, 0), total);
    assert.match(k.actions.series.at(-1)!.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(k.orgs, { withBot: 1, total: 2, activeMembers: 2 });
    // Metal 12.5 + 2 SCU; gems 2 + 1, a cooler and a helmet (gear)
    assert.deepEqual(k.stock, { batches: 6, owners: 2, resourceScu: '14.5', itemPcs: '5', gearPcs: '2' });
    assert.deepEqual(k.refinery, { running: 1, ready: 1 });
    assert.deepEqual(k.blueprints, { owned: 1, users: 1, viaCompanion: 1 });

    assert.equal(d.perDay.length, 7);
    assert.equal(d.perDay.reduce((sum, p) => sum + p.bot + p.webapp + p.companion, 0), total);
    assert.equal((await getDashboard(db, 'en', 90)).perDay.length, 90);

    assert.deepEqual(d.latest.map((r) => r.id), (await getActivity(db, 'en', activityFilter((n) => (n === 'limit' ? '12' : undefined)))).rows.map((r) => r.id));
    assert.equal(d.latest.length, Math.min(12, total));
    assert.deepEqual(d.reach, { known: 3, inOrg: 2, holdingData: 3, webLogin30d: 2, companion30d: 1 });
    assert.deepEqual(d.orgs.map((o) => o.name), ['Alpha Org', 'Beta Org']);
    assert.deepEqual([!!d.sources.game, d.sources.uex, d.sources.botLogs],
      [true, { state: null, checkedAt: null, endpoints: 0 }, { state: null, channels: 0 }]);
  });
});
