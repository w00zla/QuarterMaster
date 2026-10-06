// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connect, type Db } from '../src/db/client.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { add, adjust, move, refineDone, refineStart, remove, StockError, type Actor, type StockErrorCode } from '../src/stock/service.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '900000000000000001';
const MEMBER_ROLE = '910000000000000001';
const OFFICER_ROLE = '910000000000000002';
const [MIA, MAX, OLGA, NORA, ZED] = ['920000000000000001', '920000000000000002', '920000000000000003', '920000000000000004', '920000000000000005'];
const STATION2 = '10000000-0000-0000-0000-0000000000aa';

const mia: Actor = { userId: MIA, guildId: G, officer: false };
const max: Actor = { userId: MAX, guildId: G, officer: false };
const olga: Actor = { userId: OLGA, guildId: G, officer: true };
// Not in any org
const zed: Actor = { userId: ZED, guildId: null, officer: false };

const metal = { kind: 'resource' as const, uuid: U.metal, locationUuid: U.station };

/** Asserts that the promise fails with this stock error code. */
const refused = (p: Promise<unknown>, code: StockErrorCode) =>
  assert.rejects(p, (err: unknown) => err instanceof StockError && err.code === code);

describe('stock service (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  const batchCount = async () => Number((await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM app.stock_batch`))[0]!.n);

  before(async () => {
    ({ db, close } = connect(url));
    for (const schema of ['uex', 'web', 'bot', 'app', 'catalog', 'drizzle']) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    // A second selectable station, for moves between locations
    await db.execute(sql`INSERT INTO catalog.location (uuid, key, name_key, nav_icon, hide_in_starmap, content_hash, first_seen_import_id, last_seen_import_id)
      VALUES (${STATION2}, 'Test_Station2', 'test_station', 'Station', false, 'x', 1, 1)`);
    await ensureGuild(db, G, 'Stock Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE], officerRoleIds: [OFFICER_ROLE] });
    for (const [id, role] of [[MIA, MEMBER_ROLE], [MAX, MEMBER_ROLE], [OLGA, OFFICER_ROLE], [NORA, MEMBER_ROLE]] as const) {
      await syncMember(db, G, settings, id, { userId: id, displayName: id.slice(-1), roleIds: [role], bot: false });
    }
    await db.execute(sql`UPDATE app.member SET active = false WHERE user_id = ${NORA}`);
  });
  after(async () => close?.());

  it('adds personal stock, merging the same batch and keeping qualities apart', async () => {
    const a = await add(db, mia, { ...metal, quality: 820, amount: '12,5' });
    const b = await add(db, mia, { ...metal, quality: 820, amount: '0.005' });
    const c = await add(db, mia, { ...metal, quality: 700, amount: '1' });
    assert.equal(a.batch!.id, b.batch!.id);
    assert.equal(b.batch!.quantity, '12.505000');
    assert.notEqual(c.batch!.id, a.batch!.id);
    assert.deepEqual([b.batch!.guildId, b.batch!.designation, b.journal[0]!.action, b.journal[0]!.delta], [null, 'personal', 'add', '0.005000']);
  });

  it('lets users without an org keep personal stock, but not org stock', async () => {
    const r = await add(db, zed, { ...metal, quality: 500, amount: '3' });
    assert.equal(r.batch!.ownerUserId, ZED);
    await refused(add(db, zed, { ...metal, quality: 500, amount: '3', org: true }), 'notAllowed');
  });

  it('refuses bad input: subject, location, amount, quality, ores', async () => {
    await refused(add(db, mia, { ...metal, uuid: '10000000-0000-0000-0000-0000000000ee', quality: 1, amount: '1' }), 'unknownSubject');
    await refused(add(db, mia, { ...metal, uuid: 'nope', quality: 1, amount: '1' }), 'unknownSubject');
    await refused(add(db, mia, { ...metal, locationUuid: U.star, quality: 1, amount: '1' }), 'unknownLocation');
    await refused(add(db, mia, { ...metal, quality: 1001, amount: '1' }), 'invalidQuality');
    await refused(add(db, mia, { ...metal, quality: 1, amount: '0' }), 'invalidAmount');
    await refused(add(db, mia, { kind: 'item', uuid: U.gem, locationUuid: U.station, quality: 1, amount: '1.5' }), 'invalidAmount');
    await refused(add(db, mia, { ...metal, uuid: U.ore, quality: 1, amount: '1' }), 'oreViaRefinery');
    const gem = await add(db, mia, { kind: 'item', uuid: U.gem, locationUuid: U.station, quality: 300, amount: '7' });
    assert.deepEqual([gem.batch!.kind, gem.batch!.itemUuid, gem.batch!.quantity], ['item', U.gem, '7.000000']);
  });

  it('org stock: members hold their own, officers book for active members', async () => {
    const own = await add(db, mia, { ...metal, quality: 600, amount: '5', org: true });
    assert.deepEqual([own.batch!.guildId, own.batch!.ownerUserId, own.batch!.designation], [G, MIA, 'org']);
    await refused(add(db, mia, { ...metal, quality: 600, amount: '5', org: true, holderUserId: MAX }), 'notAllowed');
    await refused(add(db, mia, { ...metal, quality: 600, amount: '5', holderUserId: MAX }), 'notAllowed');
    const forMax = await add(db, olga, { ...metal, quality: 600, amount: '2', org: true, holderUserId: MAX });
    assert.deepEqual([forMax.batch!.ownerUserId, forMax.journal[0]!.actorUserId], [MAX, OLGA]);
    await refused(add(db, olga, { ...metal, quality: 600, amount: '2', org: true, holderUserId: NORA }), 'holderNotMember');
    await refused(add(db, olga, { ...metal, quality: 600, amount: '2', org: true, holderUserId: ZED }), 'holderNotMember');
  });

  it('removes amounts or everything; only the owner (personal) or an officer (org)', async () => {
    const b = (await add(db, max, { ...metal, quality: 400, amount: '10' })).batch!;
    await refused(remove(db, mia, { batchId: b.id, amount: '1' }), 'notAllowed');
    await refused(remove(db, olga, { batchId: b.id, amount: '1' }), 'notAllowed');
    const part = await remove(db, max, { batchId: b.id, amount: '2.5' });
    assert.deepEqual([part.batch!.quantity, part.journal[0]!.delta], ['7.500000', '-2.500000']);
    await refused(remove(db, max, { batchId: b.id, amount: '8' }), 'insufficient');
    await refused(remove(db, max, { batchId: b.id, amount: null, expected: '10' }), 'batchChanged');
    const all = await remove(db, max, { batchId: b.id, amount: null, expected: '7.5' });
    assert.equal(all.batch, null);
    assert.equal(all.journal[0]!.delta, '-7.500000');
    await refused(remove(db, max, { batchId: b.id, amount: null }), 'batchNotFound');

    const org = (await add(db, mia, { ...metal, quality: 450, amount: '4', org: true })).batch!;
    await refused(remove(db, mia, { batchId: org.id, amount: '1' }), 'notAllowed');
    assert.equal((await remove(db, olga, { batchId: org.id, amount: '1' })).batch!.quantity, '3.000000');
  });

  it('adjusts to a counted amount, 0 empties the batch', async () => {
    const b = (await add(db, max, { ...metal, quality: 410, amount: '3' })).batch!;
    const up = await adjust(db, max, { batchId: b.id, amount: '3,25' });
    assert.deepEqual([up.batch!.quantity, up.journal[0]!.action, up.journal[0]!.delta], ['3.250000', 'adjust', '0.250000']);
    await refused(adjust(db, max, { batchId: b.id, amount: '3.25' }), 'noChange');
    const zero = await adjust(db, max, { batchId: b.id, amount: '0' });
    assert.deepEqual([zero.batch, zero.journal[0]!.delta], [null, '-3.250000']);
  });

  it('moves: personal to another location, donations, officer reassignments', async () => {
    const b = (await add(db, max, { ...metal, quality: 420, amount: '6' })).batch!;
    const moved = await move(db, max, { batchId: b.id, amount: '1', toLocationUuid: STATION2 });
    assert.deepEqual([moved.batch!.locationUuid, moved.batch!.designation, moved.batch!.quantity], [STATION2, 'personal', '1.000000']);
    assert.deepEqual(moved.journal.map((j) => [j.action, j.delta]), [['move_out', '-1.000000'], ['move_in', '1.000000']]);
    assert.equal(moved.journal[0]!.groupId, moved.journal[1]!.groupId);
    await refused(move(db, max, { batchId: b.id, amount: '1' }), 'nothingToMove');
    await refused(move(db, max, { batchId: b.id, amount: '1', toHolderUserId: MIA }), 'notAllowed');

    // Donation: a member gives own stock to the org and holds it; naming another holder is for officers
    await refused(move(db, max, { batchId: b.id, amount: '1', toOrg: true, toHolderUserId: MIA }), 'notAllowed');
    const donated = await move(db, max, { batchId: b.id, amount: '2', toOrg: true });
    assert.deepEqual([donated.batch!.guildId, donated.batch!.ownerUserId, donated.batch!.designation], [G, MAX, 'org']);
    assert.deepEqual(donated.journal.map((j) => j.guildId), [null, G]);

    // Org stock: members cannot move it, officers can (also hand it out as personal stock)
    await refused(move(db, max, { batchId: donated.batch!.id, amount: '1', toLocationUuid: STATION2 }), 'notAllowed');
    const reassigned = await move(db, olga, { batchId: donated.batch!.id, amount: '1', toHolderUserId: MIA });
    assert.equal(reassigned.batch!.ownerUserId, MIA);
    const handedOut = await move(db, olga, { batchId: donated.batch!.id, amount: null, toOrg: false });
    assert.deepEqual([handedOut.batch!.designation, handedOut.batch!.ownerUserId, handedOut.batch!.guildId], ['personal', MAX, null]);
  });

  it('refinery: personal jobs, completion replaces ore with the refined resource', async () => {
    await refused(refineStart(db, mia, { oreUuid: U.metal, locationUuid: U.station, quality: 600, amount: '8' }), 'notOre');
    const job = (await refineStart(db, mia, { oreUuid: U.ore, locationUuid: U.station, quality: 600, amount: '8' })).batch!;
    assert.deepEqual([job.state, job.designation, job.resourceUuid], ['refining', 'personal', U.ore]);
    await refused(move(db, mia, { batchId: job.id, amount: null, toOrg: true }), 'refiningFixed');
    await refused(refineDone(db, olga, { batchId: job.id, amount: '5', quality: 640 }), 'notAllowed');
    const before = await batchCount();
    const done = await refineDone(db, mia, { batchId: job.id, amount: '5,6', quality: 640 });
    assert.deepEqual([done.batch!.resourceUuid, done.batch!.state, done.batch!.quality, done.batch!.locationUuid], [U.metal, 'stored', 640, U.station]);
    assert.deepEqual(done.journal.map((j) => [j.action, j.resourceUuid, j.state, j.delta]), [
      ['refine_out', U.ore, 'refining', '-8.000000'], ['refine_in', U.metal, 'stored', '5.600000'],
    ]);
    assert.equal(done.journal[0]!.groupId, done.journal[1]!.groupId);
    assert.equal(await batchCount(), before);
    await refused(refineDone(db, mia, { batchId: done.batch!.id, amount: '1', quality: 1 }), 'notRefining');
  });

  it('refinery: only at UEX refineries once there is UEX data', async () => {
    const yields = [{ id_terminal: 1, terminal_name: 'Refinement Center - Elsewhere', star_system_name: 'Nyx', space_station_name: 'Elsewhere' }];
    await db.execute(sql`INSERT INTO uex.snapshot (endpoint, content_hash, data)
      VALUES ('refineries_yields', ${'a'.repeat(64)}, ${JSON.stringify(yields)}::jsonb)`);
    await refused(refineStart(db, mia, { oreUuid: U.ore, locationUuid: U.station, quality: 600, amount: '1' }), 'notRefinery');
    await db.execute(sql`TRUNCATE uex.snapshot`);
    assert.ok((await refineStart(db, mia, { oreUuid: U.ore, locationUuid: U.station, quality: 600, amount: '1' })).batch);
  });

  it('never hands out the same units twice under concurrent removal', async () => {
    const b = (await add(db, max, { ...metal, quality: 430, amount: '1' })).batch!;
    const results = await Promise.allSettled([1, 2, 3].map(() => remove(db, max, { batchId: b.id, amount: '1' })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results) {
      if (r.status === 'rejected') assert.ok(r.reason instanceof StockError && ['insufficient', 'batchNotFound'].includes(r.reason.code));
    }
    const journal = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM app.stock_journal WHERE action = 'remove' AND quality = 430`);
    assert.equal(journal[0]!.n, '1');
  });
});
