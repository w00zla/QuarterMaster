// Runs against TEST_DATABASE_URL only; the ext, web, bot, app and catalog schemas there are dropped and recreated.
// The admin's Status: the UEX pull's freshness, the bot's logs channels working off the history, the check hits.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { storeSnapshot } from '../src/ext/store.ts';
import { add } from '../src/stock/service.ts';
import { getStatus } from '../src/adminapp/status.ts';
import { getDataChecks } from '../src/adminapp/users.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '700000000000000071';
const ROLE = '710000000000000071';
const CHANNEL = '720000000000000071';
const OLGA = '740000000000000071';

describe('admin: status (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;
  // Backdating rows needs more than qm_app may (history is append-only for it)
  let owner: ReturnType<typeof connectAs>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    owner = connectAs(url, 'qm_owner');
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    await ensureGuild(db, G, 'Alpha Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [ROLE], logsChannelId: CHANNEL, logsLevel: 'stock' });
    await syncMember(db, G, settings, OLGA, { userId: OLGA, displayName: 'olga', roleIds: [ROLE], bot: false });
  });
  after(async () => {
    await owner?.close();
    await close?.();
  });

  it('reports the catalog and no UEX data before the first pull', async () => {
    const s = await getStatus(db);
    assert.equal(s.game?.importId, 1);
    assert.deepEqual(s.uex, []);
    assert.deepEqual(s.botLogs.map((g) => [g.org, g.marked, g.pending, g.state]), [['Alpha Org', true, 0, 'ok']]);
  });

  it('rates the UEX endpoints by their last check', async () => {
    await storeSnapshot(db, 'uex', 'terminals', [{ id: 1 }]);
    await storeSnapshot(db, 'uex', 'commodities', [{ id: 1 }, { id: 2 }]);
    await owner.db.execute(sql`UPDATE ext.snapshot SET checked_at = now() - interval '50 minutes' WHERE endpoint = 'commodities'`);
    const s = await getStatus(db);
    assert.deepEqual(s.uex.map((e) => [e.endpoint, e.rows, e.state]), [['commodities', 2, 'warn'], ['terminals', 1, 'ok']]);
    await owner.db.execute(sql`UPDATE ext.snapshot SET checked_at = now() - interval '3 hours' WHERE endpoint = 'commodities'`);
    assert.equal((await getStatus(db)).uex[0]!.state, 'err');
  });

  it('counts the rows a logs channel has not worked off, by the age of the oldest', async () => {
    await add(db, { userId: OLGA, guildId: G, source: 'webapp' }, { kind: 'resource', uuid: U.metal, locationUuid: U.station, quality: 700, amount: '5', org: true });
    let [g] = (await getStatus(db)).botLogs;
    assert.equal(g!.pending, 1);
    assert.equal(g!.state, 'ok');

    await owner.db.execute(sql`UPDATE app.history SET created_at = now() - interval '5 minutes'`);
    [g] = (await getStatus(db)).botLogs;
    assert.equal(g!.state, 'warn');
    await owner.db.execute(sql`UPDATE app.history SET created_at = now() - interval '1 hour'`);
    [g] = (await getStatus(db)).botLogs;
    assert.equal(g!.state, 'err');

    // Worked off: the mark is at the newest row
    await owner.db.execute(sql`UPDATE bot.guild SET logs_after = (SELECT max(id) FROM app.history)`);
    [g] = (await getStatus(db)).botLogs;
    assert.deepEqual([g!.pending, g!.oldestPendingAt, g!.state], [0, null, 'ok']);

    // No mark yet
    await owner.db.execute(sql`UPDATE bot.guild SET logs_after = NULL`);
    [g] = (await getStatus(db)).botLogs;
    assert.deepEqual([g!.marked, g!.state], [false, 'warn']);
  });

  it('sums the hits of the user data checks', async () => {
    const s = await getStatus(db);
    const hits = (await getDataChecks(db, 'en')).reduce((n, c) => n + c.hits.length, 0);
    assert.equal(s.checkHits, hits);
  });
});
