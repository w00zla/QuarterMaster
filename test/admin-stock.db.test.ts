// Runs against TEST_DATABASE_URL only; the ext, web, bot, app and catalog schemas there are dropped and recreated.
// The admin's read-only stock views: stored stock per subject over all users, its holders, every refinery job.
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
import { materialCatalog } from '../src/stock/lookup.ts';
import { add, COMPONENT_QUALITY, refineStart, split, type Actor } from '../src/stock/service.ts';
import { getRefineryJobs, getStock, getStockSubject } from '../src/adminapp/stock.ts';
import { FPS, FPS_RECORDS, RECORDS, U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const [G, G2] = ['700000000000000071', '700000000000000072'];
const ROLE = '710000000000000071';
const [OLGA, MIA, SOLO] = ['740000000000000071', '740000000000000072', '740000000000000073'];

describe('admin: stock and refinery (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;
  const actor = (userId: string, guildId: string | null = null): Actor => ({ userId, guildId, source: 'webapp' });

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot({ ...RECORDS, ...FPS_RECORDS });
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    // The cooler's stat as on a real one (multipliers 0.8–1.2 in its first slot; see stock-components.db.test.ts)
    const ranges = [
      { type: 'Linear', startQuality: 0, endQuality: 500, values: { modifierAtStart: 0.8, modifierAtEnd: 1 } },
      { type: 'Linear', startQuality: 501, endQuality: 1000, values: { modifierAtStart: 1, modifierAtEnd: 1.2 } },
    ];
    await db.execute(sql`UPDATE catalog.blueprint_slot SET modifiers = CASE WHEN slot_index = 0 AND tier_index = 0
        THEN ${JSON.stringify([{ propertyUuid: U.property, ranges }])}::jsonb ELSE '[]'::jsonb END
      WHERE blueprint_uuid IN (SELECT uuid FROM catalog.blueprint WHERE output_item_uuid = ${U.output})`);

    for (const [guildId, name] of [[G, 'Alpha Org'], [G2, 'Beta Org']] as const) {
      await ensureGuild(db, guildId, name);
      const settings = await updateGuildSettings(db, guildId, { memberRoleIds: [ROLE] });
      for (const id of [OLGA, MIA]) {
        await syncMember(db, guildId, settings, id, { userId: id, displayName: `nick${id.slice(-2)}`, roleIds: [ROLE], bot: false });
      }
    }

    // Olga: metal shared in both orgs, an unshared gem, two coolers (one with stats); Mia: metal shared in Alpha,
    // unshared metal with a part split off, a helmet; Solo: no org, two refinery jobs (one without an end)
    await add(db, actor(OLGA, G), { kind: 'resource', uuid: U.metal, locationUuid: U.station, quality: 700, amount: '12.5', org: true, shareIn: [G2] });
    await add(db, actor(OLGA), { kind: 'item', uuid: U.gem, locationUuid: U.station, quality: 500, amount: '3' });
    const cooler = { kind: 'item' as const, uuid: U.output, locationUuid: U.station, quality: COMPONENT_QUALITY, amount: '1' };
    await add(db, actor(OLGA), { ...cooler, stats: { [U.property]: '5' } });
    await add(db, actor(OLGA), cooler);
    await add(db, actor(MIA, G), { kind: 'resource', uuid: U.metal, locationUuid: U.station, quality: 800, amount: '2', org: true });
    const own = await add(db, actor(MIA), { kind: 'resource', uuid: U.metal, locationUuid: U.station, quality: 300, amount: '4' });
    await split(db, actor(MIA), { batchId: own.batch!.id, amount: '1' });
    await add(db, actor(MIA), { kind: 'item', uuid: FPS.helmet, locationUuid: U.station, quality: COMPONENT_QUALITY, amount: '1' });
    await refineStart(db, actor(SOLO), { locationUuid: U.station, durationSeconds: 3600, rows: [{ resourceUuid: U.metal, quality: 400, amount: '8' }] });
    await refineStart(db, actor(SOLO), { locationUuid: U.station, rows: [
      { resourceUuid: U.metal, quality: 100, amount: '2' }, { resourceUuid: U.metal, quality: 900, amount: '1.5' },
    ] });
  });
  after(async () => close?.());

  it('sums the stored stock per subject over all users, grouped like the web app', async () => {
    const stock = await getStock(db, 'en');
    // Resources first, refinery jobs left out
    assert.equal(stock[0]!.uuid, U.metal);
    const by = new Map(stock.map((s) => [s.uuid, s]));
    assert.deepEqual([...by.keys()].sort(), [U.metal, U.gem, U.output, FPS.helmet].sort());
    const pick = (uuid: string) => {
      const s = by.get(uuid)!;
      return [s.group, s.gear, s.unit, s.total, s.batches, s.owners, s.shared, s.orgs, s.minQuality, s.maxQuality, s.withStats];
    };
    assert.deepEqual(pick(U.metal), ['resource', null, 'SCU', '18.5', 4, 2, 2, 2, 300, 800, 0]);
    assert.deepEqual(pick(U.gem), ['harvestable', null, 'pcs', '3', 1, 1, 0, 0, 500, 500, 0]);
    // Gear without quality; the cooler is a ship component, the helmet FPS gear
    assert.deepEqual(pick(U.output), ['gear', 'ship', 'pcs', '2', 2, 1, 0, 0, null, null, 1]);
    assert.deepEqual(pick(FPS.helmet), ['gear', 'fps', 'pcs', '1', 1, 1, 0, 0, null, null, 0]);
    assert.deepEqual([by.get(U.output)!.type, by.get(U.output)!.typeLabel], ['Cooler', 'Cooler']);
  });

  it('lists the holders of a subject: stored first, with orgs, lots and stats', async () => {
    const metal = (await getStockSubject(db, 'resource', U.metal, 'en'))!;
    assert.deepEqual([metal.name, metal.group, metal.unit], ['Test Metal', 'resource', 'SCU']);
    assert.deepEqual(metal.holders.map((h) => [h.owner.userId, h.state, h.quantity, h.quality, h.lot, h.orgs]), [
      [OLGA, 'stored', '12.5', 700, false, ['Alpha Org', 'Beta Org']],
      [MIA, 'stored', '3', 300, false, []],
      [MIA, 'stored', '2', 800, false, ['Alpha Org']],
      [MIA, 'stored', '1', 300, true, []],
      [SOLO, 'refining', '8', 400, false, []],
      [SOLO, 'refining', '2', 100, false, []],
      [SOLO, 'refining', '1.5', 900, false, []],
    ]);
    assert.deepEqual(metal.holders.slice(0, 2).map((h) => [h.owner.name, h.location]), [['nick71', 'Test Station'], ['nick72', 'Test Station']]);
    // Solo is in no roster and never logged in
    assert.equal(metal.holders.at(-1)!.owner.name, null);

    const cooler = (await getStockSubject(db, 'item', U.output, 'en'))!;
    const statName = (await materialCatalog(db, 'en')).get(U.output)!.stats[0]!.name;
    assert.deepEqual([cooler.group, cooler.gear], ['gear', 'ship']);
    assert.deepEqual(cooler.holders.map((h) => [h.quality, h.stats]).sort((a, b) => (a[1] as unknown[]).length - (b[1] as unknown[]).length),
      [[null, []], [null, [{ name: statName, value: '+5.0 %' }]]]);

    // Known to the catalog but in nobody's stock; unknown; the wrong kind
    assert.deepEqual((await getStockSubject(db, 'item', FPS.rifle, 'en'))!.holders, []);
    assert.equal(await getStockSubject(db, 'resource', '10000000-0000-0000-0000-0000000000ee', 'en'), null);
    assert.equal(await getStockSubject(db, 'item', U.metal, 'en'), null);
  });

  it('lists every refinery job with its state and whether it sits at a UEX refinery', async () => {
    const jobs = await getRefineryJobs(db, 'en');
    // The next to end first, the one without an end last; without UEX data every location counts
    assert.deepEqual(jobs.map((j) => [j.owner.userId, j.owner.name, j.state, j.scu, j.atRefinery, !!j.startedAt, !!j.endsAt]), [
      [SOLO, null, 'running', '8', true, true, true],
      [SOLO, null, 'open', '3.5', true, true, false],
    ]);
    assert.deepEqual(jobs[1]!.materials, [{ name: 'Test Metal', quantity: '1.5', quality: 900 }, { name: 'Test Metal', quantity: '2', quality: 100 }]);
    assert.deepEqual(jobs[0]!.location, { uuid: U.station, name: 'Test Station' });

    // Ready since a day, ready for longer than the overdue limit
    await db.execute(sql`UPDATE app.stock_batch SET refine_started_at = now() - interval '2 days', refine_ends_at = now() - interval '1 day'
      WHERE refine_job = ${jobs[0]!.jobId}`);
    assert.equal((await getRefineryJobs(db, 'en'))[0]!.state, 'ready');
    await db.execute(sql`UPDATE app.stock_batch SET refine_started_at = now() - interval '9 days', refine_ends_at = now() - interval '8 days'
      WHERE refine_job = ${jobs[0]!.jobId}`);
    assert.equal((await getRefineryJobs(db, 'en'))[0]!.state, 'overdue');

    // UEX data without this station: both jobs sit outside every refinery
    await storeSnapshot(db, 'uex', 'refineries_yields', [
      { id_terminal: 1, terminal_name: 'Refinery Nowhere', star_system_name: 'Nyx', space_station_name: 'Nowhere', commodity_name: 'Iron (Ore)', value: 1 },
    ]);
    assert.deepEqual((await getRefineryJobs(db, 'en')).map((j) => j.atRefinery), [false, false]);
  });
});
