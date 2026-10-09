// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { pickableBatches, stockList } from '../src/stock/lookup.ts';
import { add, adjust, merge, move, refineDone, refineSetDuration, refineStart, remove, share, split, StockError, type Actor, type StockErrorCode } from '../src/stock/service.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '900000000000000001';
const MEMBER_ROLE = '910000000000000001';
const [MIA, MAX, OLGA, NORA, ZED] = ['920000000000000001', '920000000000000002', '920000000000000003', '920000000000000004', '920000000000000005'];
const STATION2 = '10000000-0000-0000-0000-0000000000aa';

const mia: Actor = { userId: MIA, guildId: G, source: 'bot' };
const max: Actor = { userId: MAX, guildId: G, source: 'bot' };
const olga: Actor = { userId: OLGA, guildId: G, source: 'bot' };
// Left the org (inactive member row)
const nora: Actor = { userId: NORA, guildId: G, source: 'bot' };
// Not in any org
const zed: Actor = { userId: ZED, guildId: null, source: 'bot' };

const metal = { kind: 'resource' as const, uuid: U.metal, locationUuid: U.station };

/** Asserts that the promise fails with this stock error code. */
const refused = (p: Promise<unknown>, code: StockErrorCode) =>
  assert.rejects(p, (err: unknown) => err instanceof StockError && err.code === code);

describe('stock service (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  const sharesOf = async (batchId: number) =>
    (await db.execute<{ g: string }>(sql`SELECT guild_id AS g FROM app.stock_share WHERE batch_id = ${batchId} ORDER BY guild_id`)).map((r) => r.g);
  const batchCount = async () => Number((await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM app.stock_batch`))[0]!.n);

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    // A second selectable station, for moves between locations
    await db.execute(sql`INSERT INTO catalog.location (uuid, key, name_key, nav_icon, hide_in_starmap, content_hash, first_seen_import_id, last_seen_import_id)
      VALUES (${STATION2}, 'Test_Station2', 'test_station', 'Station', false, 'x', 1, 1)`);
    await ensureGuild(db, G, 'Stock Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE] });
    for (const id of [MIA, MAX, OLGA, NORA]) {
      await syncMember(db, G, settings, id, { userId: id, displayName: id.slice(-1), roleIds: [MEMBER_ROLE], bot: false });
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
    assert.deepEqual([b.batch!.lot, b.journal[0]!.action, b.journal[0]!.delta], [null, 'add', '0.005000']);
    assert.deepEqual(await sharesOf(b.batch!.id), []);
  });

  it('lets users without an org keep their own stock, but not share it', async () => {
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

  it('adds shared stock: always your own, shared in your org; not once you left it', async () => {
    const own = await add(db, mia, { ...metal, quality: 600, amount: '5', org: true });
    assert.deepEqual([own.batch!.ownerUserId, await sharesOf(own.batch!.id)], [MIA, [G]]);
    await refused(add(db, nora, { ...metal, quality: 600, amount: '2', org: true }), 'holderNotMember');
  });

  it('removes amounts or everything; only the owner, shared or not', async () => {
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

    const shared = (await add(db, mia, { ...metal, quality: 450, amount: '4', org: true })).batch!;
    await refused(remove(db, olga, { batchId: shared.id, amount: '1' }), 'notAllowed');
    assert.equal((await remove(db, mia, { batchId: shared.id, amount: '1' })).batch!.quantity, '3.000000');
  });

  it('adjusts to a counted amount, 0 empties the batch', async () => {
    const b = (await add(db, max, { ...metal, quality: 410, amount: '3' })).batch!;
    const up = await adjust(db, max, { batchId: b.id, amount: '3,25' });
    assert.deepEqual([up.batch!.quantity, up.journal[0]!.action, up.journal[0]!.delta], ['3.250000', 'adjust', '0.250000']);
    await refused(adjust(db, max, { batchId: b.id, amount: '3.25' }), 'noChange');
    const zero = await adjust(db, max, { batchId: b.id, amount: '0' });
    assert.deepEqual([zero.batch, zero.journal[0]!.delta], [null, '-3.250000']);
  });

  it('moves: another location (a new batch takes the shares along, an existing one keeps its own), giving to a member', async () => {
    const b = (await add(db, max, { ...metal, quality: 420, amount: '6' })).batch!;
    await refused(move(db, max, { batchId: b.id, amount: '1' }), 'nothingToMove');
    await refused(move(db, max, { batchId: b.id, amount: '1', toOwnerUserId: MAX }), 'nothingToMove');
    await share(db, max, { batchId: b.id, guildIds: [G] });
    await refused(move(db, olga, { batchId: b.id, amount: '1', toLocationUuid: STATION2 }), 'notAllowed');

    const moved = await move(db, max, { batchId: b.id, amount: '1', toLocationUuid: STATION2 });
    assert.deepEqual([moved.batch!.locationUuid, moved.batch!.quantity, await sharesOf(moved.batch!.id)], [STATION2, '1.000000', [G]]);
    assert.deepEqual(moved.journal.map((j) => [j.action, j.delta]), [['move_out', '-1.000000'], ['move_in', '1.000000']]);
    assert.equal(moved.journal[0]!.groupId, moved.journal[1]!.groupId);
    // Into an existing batch: its shares count
    await share(db, max, { batchId: moved.batch!.id, guildIds: [] });
    const merged = await move(db, max, { batchId: b.id, amount: '1', toLocationUuid: STATION2 });
    assert.deepEqual([merged.batch!.id, merged.batch!.quantity, await sharesOf(merged.batch!.id)], [moved.batch!.id, '2.000000', []]);
    assert.deepEqual(await sharesOf(b.id), [G]);

    // Giving: to an active member of the org it happens in, who gets it unshared
    const given = await move(db, max, { batchId: b.id, amount: '2', toOwnerUserId: MIA });
    assert.deepEqual([given.batch!.ownerUserId, await sharesOf(given.batch!.id)], [MIA, []]);
    assert.deepEqual(given.journal.map((j) => [j.ownerUserId, j.actorUserId]), [[MAX, MAX], [MIA, MAX]]);
    await refused(move(db, max, { batchId: b.id, amount: '1', toOwnerUserId: NORA }), 'holderNotMember');
    await refused(move(db, max, { batchId: b.id, amount: '1', toOwnerUserId: ZED }), 'holderNotMember');
    const zeds = (await add(db, zed, { ...metal, quality: 420, amount: '1' })).batch!;
    await refused(move(db, zed, { batchId: zeds.id, amount: null, toOwnerUserId: MIA }), 'notAllowed');
  });

  it('shares the whole batch in several orgs and takes it back; only the owner, only as a member there', async () => {
    const H = '900000000000000002';
    await ensureGuild(db, H, 'Second Org');
    const hSettings = await updateGuildSettings(db, H, { memberRoleIds: [MEMBER_ROLE] });
    await syncMember(db, H, hSettings, MAX, { userId: MAX, displayName: 'x', roleIds: [MEMBER_ROLE], bot: false });
    const x = (await add(db, max, { ...metal, quality: 425, amount: '2' })).batch!;
    const last = Number((await db.execute<{ n: string }>(sql`SELECT coalesce(max(id), 0)::text AS n FROM app.history`))[0]!.n);
    assert.deepEqual((await share(db, max, { batchId: x.id, guildIds: [H, G] })).guildIds, [G, H].sort());
    assert.deepEqual(await sharesOf(x.id), [G, H].sort());
    await share(db, max, { batchId: x.id, guildIds: [H] });
    assert.deepEqual(await sharesOf(x.id), [H]);
    await refused(share(db, max, { batchId: x.id, guildIds: [H] }), 'noChange');
    await refused(share(db, olga, { batchId: x.id, guildIds: [] }), 'notAllowed');
    const history = await db.execute<{ action: string; guild: string }>(sql`
      SELECT action, guild_id AS guild FROM app.history WHERE id > ${last} ORDER BY id`);
    assert.deepEqual(history.map((h) => [h.action, h.guild]), [['share', G], ['share', H], ['unshare', G]]);
    // Mia is not in H: she cannot share there
    const miaOwn = (await add(db, mia, { ...metal, quality: 425, amount: '1' })).batch!;
    await refused(share(db, mia, { batchId: miaOwn.id, guildIds: [H] }), 'holderNotMember');
  });

  it('splits a part off an unshared batch into a batch of its own, which can be shared apart', async () => {
    const main = (await add(db, mia, { ...metal, quality: 430, amount: '5' })).batch!;
    const part = await split(db, mia, { batchId: main.id, amount: '2' });
    assert.notEqual(part.batch!.id, main.id);
    assert.ok(part.batch!.lot);
    assert.deepEqual(part.journal.map((j) => [j.action, j.delta]), [['move_out', '-2.000000'], ['move_in', '2.000000']]);
    // New stock goes to the main batch, not the part
    assert.equal((await add(db, mia, { ...metal, quality: 430, amount: '1' })).batch!.id, main.id);
    await refused(split(db, mia, { batchId: main.id, amount: '4' }), 'nothingToMove');
    await refused(split(db, mia, { batchId: main.id, amount: '9' }), 'insufficient');
    await refused(split(db, max, { batchId: main.id, amount: '1' }), 'notAllowed');
    await share(db, mia, { batchId: part.batch!.id, guildIds: [G] });
    assert.deepEqual([await sharesOf(part.batch!.id), await sharesOf(main.id)], [[G], []]);
    await refused(split(db, mia, { batchId: part.batch!.id, amount: '1' }), 'sharedSplit');
    // A part moved elsewhere stays a part
    const placed = await move(db, mia, { batchId: part.batch!.id, amount: '1', toLocationUuid: STATION2 });
    assert.equal(placed.batch!.lot, part.batch!.lot);

    // Merging back: into the main batch, which keeps its own shares; the part is gone
    const back = await merge(db, mia, { batchId: part.batch!.id, expected: '1' });
    assert.deepEqual([back.batch!.id, back.batch!.quantity, back.batch!.lot, await sharesOf(main.id)], [main.id, '5.000000', null, []]);
    assert.deepEqual(back.journal.map((j) => [j.action, j.delta]), [['move_out', '-1.000000'], ['move_in', '1.000000']]);
    await refused(merge(db, mia, { batchId: main.id }), 'nothingToMove');
    // No main batch at that place: the part becomes it, with its shares (taken along when it was moved)
    const alone = await merge(db, mia, { batchId: placed.batch!.id });
    assert.deepEqual([alone.batch!.lot, alone.batch!.locationUuid, await sharesOf(alone.batch!.id)], [null, STATION2, [G]]);
  });

  it('refinery: personal jobs, completion replaces ore with the refined resource', async () => {
    const at = { locationUuid: U.station };
    await refused(refineStart(db, mia, { ...at, rows: [{ oreUuid: U.metal, quality: 600, amount: '8' }] }), 'notOre');
    await refused(refineStart(db, mia, { ...at, rows: [] }), 'invalidAmount');
    // A quality no other test books, so the result makes a new batch
    const started = await refineStart(db, mia, { ...at, rows: [{ oreUuid: U.ore, quality: 611, amount: '8' }] });
    const job = started.batches[0]!;
    assert.deepEqual([job.state, job.resourceUuid], ['refining', U.ore]);
    await refused(share(db, mia, { batchId: job.id, guildIds: [G] }), 'refiningFixed');
    const finish = (amount: string) => ({ jobId: started.jobId, rows: [{ batchId: job.id, amount }] });
    await refused(refineDone(db, olga, finish('5')), 'notAllowed');
    const before = await batchCount();
    const done = await refineDone(db, mia, finish('5,6'));
    const result = done.batches[0]!;
    // The refinery keeps the ore's quality
    assert.deepEqual([result.resourceUuid, result.state, result.quality, result.locationUuid], [U.metal, 'stored', 611, U.station]);
    assert.deepEqual(done.journal.map((j) => [j.action, j.resourceUuid, j.state, j.delta]), [
      ['refine_out', U.ore, 'refining', '-8.000000'], ['refine_in', U.metal, 'stored', '5.600000'],
    ]);
    assert.equal(done.journal[0]!.groupId, done.journal[1]!.groupId);
    assert.equal(await batchCount(), before);
    await refused(refineDone(db, mia, finish('1')), 'batchNotFound');
  });

  it('refinery: the time left of a job can be set later or cleared, by its owner only', async () => {
    const started = await refineStart(db, mia, { locationUuid: U.station, rows: [{ oreUuid: U.ore, quality: 612, amount: '2' }, { oreUuid: U.ore, quality: 613, amount: '1' }] });
    const set = { jobId: started.jobId, durationSeconds: 3600 };
    await refused(refineSetDuration(db, olga, set), 'notAllowed');
    await refused(refineSetDuration(db, mia, { ...set, durationSeconds: 0 }), 'invalidDuration');
    await refused(refineSetDuration(db, mia, { ...set, jobId: '00000000-0000-4000-8000-000000000000' }), 'batchNotFound');
    const before = Date.now();
    const { endsAt } = await refineSetDuration(db, mia, set);
    const left = new Date(endsAt!).getTime() - before;
    assert.ok(left > 3590_000 && left < 3610_000, String(left));
    const ends = async () => (await pickableBatches(db, mia, 'refining', 'en')).filter((p) => p.refine?.jobId === started.jobId).map((p) => p.refine!.endsAt);
    assert.equal(new Set(await ends()).size, 1);
    assert.deepEqual(await refineSetDuration(db, mia, { ...set, durationSeconds: null }), { endsAt: null });
    assert.deepEqual(await ends(), [null, null]);
    await refineDone(db, mia, { jobId: started.jobId, rows: started.batches.map((b) => ({ batchId: b.id, amount: '0' })) });
  });

  it('refinery: a job is a work order of several ores with end and expected yields', async () => {
    const at = { locationUuid: U.station };
    const row = { oreUuid: U.ore, quality: 610, amount: '4' };
    await refused(refineStart(db, mia, { ...at, durationSeconds: 0, rows: [row] }), 'invalidDuration');
    await refused(refineStart(db, mia, { ...at, durationSeconds: 1.5, rows: [row] }), 'invalidDuration');
    await refused(refineStart(db, mia, { ...at, rows: [{ ...row, expectedYield: 'x' }] }), 'invalidAmount');
    // Two qualities of the ore, the first one twice (adds up within the job), one row yields nothing
    const a = await refineStart(db, mia, { ...at, durationSeconds: 3600, rows: [
      { ...row, expectedYield: '1,7' }, { ...row, amount: '1', expectedYield: '0,3' }, { ...row, quality: 500, amount: '0.02', expectedYield: '0' },
    ] });
    assert.equal(a.batches.length, 2);
    assert.equal(a.journal.length, 3);
    // Same ore, place and quality in another job: not merged into the first
    const b = await refineStart(db, mia, { ...at, rows: [row] });
    assert.notEqual(b.jobId, a.jobId);
    const listed = (await stockList(db, { scope: { personalOf: MIA } }, 'en')).filter((p) => p.refine);
    const ofA = listed.filter((p) => p.refine!.jobId === a.jobId);
    assert.deepEqual(ofA.map((p) => [p.batch.quality, p.batch.quantity, p.refine!.expected]).sort(), [
      [500, '0.020000', '0.000000'], [610, '5.000000', '2.000000'],
    ]);
    const first = ofA[0]!.refine!;
    assert.equal(new Date(first.endsAt!).getTime() - new Date(first.startedAt!).getTime(), 3600_000);
    assert.ok(ofA.every((p) => p.refine!.startedAt === first.startedAt && p.refine!.endsAt === first.endsAt));
    const second = listed.find((p) => p.refine!.jobId === b.jobId)!.refine!;
    assert.deepEqual([second.endsAt, second.expected], [null, null]);
    assert.ok(second.startedAt);

    // Finishing takes exactly the job's batches
    const [big, tiny] = [ofA.find((p) => p.batch.quality === 610)!.batch, ofA.find((p) => p.batch.quality === 500)!.batch];
    await refused(refineDone(db, mia, { jobId: a.jobId, rows: [{ batchId: big.id, amount: '2' }] }), 'batchChanged');
    await refused(refineDone(db, mia, { jobId: a.jobId, rows: [
      { batchId: big.id, amount: '2' }, { batchId: tiny.id, amount: '0', expected: '1' },
    ] }), 'batchChanged');
    const done = await refineDone(db, mia, { jobId: a.jobId, rows: [
      { batchId: big.id, amount: '2', expected: '5' }, { batchId: tiny.id, amount: '0' },
    ] });
    // The tiny row only consumed its ore; one journal group for the whole job
    assert.deepEqual(done.journal.map((j) => j.action), ['refine_out', 'refine_in', 'refine_out']);
    assert.equal(new Set(done.journal.map((j) => j.groupId)).size, 1);
    assert.equal(done.batches.length, 1);
    // Stored stock has no job fields, and the refined result is stored stock
    const stored = (await stockList(db, { scope: { personalOf: MIA } }, 'en')).find((p) => p.batch.id === done.batches[0]!.id)!;
    assert.equal(stored.refine, null);
    const left = listed.find((p) => p.refine!.jobId === b.jobId)!.batch;
    await refineDone(db, mia, { jobId: b.jobId, rows: [{ batchId: left.id, amount: '3' }] });
  });

  it('refinery: only at UEX refineries once there is UEX data', async () => {
    const yields = [{ id_terminal: 1, terminal_name: 'Refinement Center - Elsewhere', star_system_name: 'Nyx', space_station_name: 'Elsewhere' }];
    await db.execute(sql`INSERT INTO ext.snapshot (source, endpoint, content_hash, data)
      VALUES ('uex', 'refineries_yields', ${'a'.repeat(64)}, ${JSON.stringify(yields)}::jsonb)`);
    const job = { locationUuid: U.station, rows: [{ oreUuid: U.ore, quality: 600, amount: '1' }] };
    await refused(refineStart(db, mia, job), 'notRefinery');
    await db.execute(sql`DELETE FROM ext.snapshot`);
    assert.ok((await refineStart(db, mia, job)).batches.length);
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
  it('writes one history row per operation, with source, category and the users involved; none for a refusal', async () => {
    const web: Actor = { ...max, source: 'webapp' };
    const app: Actor = { ...max, source: 'companion' };
    const last = Number((await db.execute<{ n: string }>(sql`SELECT coalesce(max(id), 0)::text AS n FROM app.history`))[0]!.n);
    const b = (await add(db, web, { ...metal, quality: 301, amount: '5' })).batch!;
    await adjust(db, web, { batchId: b.id, amount: '4' });
    await share(db, web, { batchId: b.id, guildIds: [G] });
    await move(db, app, { batchId: b.id, amount: '1', toOwnerUserId: MIA });
    await remove(db, web, { batchId: b.id, amount: '1' });
    await refused(remove(db, web, { batchId: b.id, amount: '99' }), 'insufficient');
    const job = await refineStart(db, web, { locationUuid: U.station, durationSeconds: 60, rows: [{ oreUuid: U.ore, quality: 602, amount: '3' }] });
    await refineDone(db, web, { jobId: job.jobId, rows: [{ batchId: job.batches[0]!.id, amount: '2' }] });

    const found = await db.execute<{ source: string; category: string; action: string; actor: string; owner: string; to: string | null;
      guild: string | null; target: string; details: Record<string, unknown> }>(sql`
      SELECT source, category, action, actor_user_id AS actor, owner_user_id AS owner, to_owner_user_id AS to, guild_id AS guild,
        target_uuid AS target, details FROM app.history WHERE id > ${last} ORDER BY id`);
    assert.deepEqual(found.map((r) => [r.source, r.category, r.action, r.actor, r.owner, r.to, r.guild, r.target]), [
      ['webapp', 'stock', 'add', MAX, MAX, null, null, U.metal],
      ['webapp', 'stock', 'adjust', MAX, MAX, null, null, U.metal],
      ['webapp', 'stock', 'share', MAX, MAX, null, G, U.metal],
      ['companion', 'stock', 'give', MAX, MAX, MIA, G, U.metal],
      ['webapp', 'stock', 'remove', MAX, MAX, null, null, U.metal],
      ['webapp', 'refinery', 'start', MAX, MAX, null, null, U.ore],
      ['webapp', 'refinery', 'done', MAX, MAX, null, null, U.metal],
    ]);
    assert.deepEqual([found[1]!.details.from, found[1]!.details.quality], ['5.000000', 301]);
    assert.deepEqual([found[5]!.details.durationSeconds, found[6]!.details.oreUuid, found[6]!.details.oreAmount, found[6]!.details.quality],
      [60, U.ore, '3.000000', 602]);
    assert.deepEqual([found[5]!.details.jobId, found[6]!.details.jobId], [job.jobId, job.jobId]);
  });
});
