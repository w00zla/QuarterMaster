// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { previewPanel, type StartDraft } from '../src/bot/commands/refinery.ts';
import { doneText, parseDoneText } from '../src/bot/refinery-lines.ts';
import { pickableBatches } from '../src/stock/lookup.ts';
import { refineDone, refineRemove, refineStart, type Actor } from '../src/stock/service.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const MIA = '952000000000000001';
// Refinery jobs are personal: no org
const mia: Actor = { userId: MIA, guildId: null, source: 'bot' };

const draft = (materials: string, duration = '2h 30m'): StartDraft => ({
  locationUuid: U.station, station: 'Station', duration, materials, ready: null, booking: false,
});
const panelText = (p: Awaited<ReturnType<typeof previewPanel>>) => JSON.stringify(p.components[0]!.toJSON());

describe('/qm-refinery work orders (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
  });

  after(async () => close?.());

  it('previews the lines and only lets a complete work order through', async () => {
    // An ore is no material of a job any more
    const bad = draft('test metal 600 8\ntest metal (ore) 500 3', 'soon');
    const p = await previewPanel(db, 'en', 'tok', bad);
    assert.equal(bad.ready, null);
    assert.match(panelText(p), /Line 2/);
    assert.match(panelText(p), /Duration/);

    const good = draft('test metal 600 8\nTestmetall 500 2,5');
    await previewPanel(db, 'en', 'tok', good);
    assert.deepEqual(good.ready, {
      locationUuid: U.station, durationSeconds: 9000,
      rows: [{ resourceUuid: U.metal, quality: 600, amount: '8' }, { resourceUuid: U.metal, quality: 500, amount: '2.5' }],
    });
  });

  it('takes an empty duration as open: booked without an end', async () => {
    const open = draft('test metal 600 8', '  ');
    const p = await previewPanel(db, 'en', 'tok', open);
    assert.deepEqual(open.ready, { locationUuid: U.station, rows: [{ resourceUuid: U.metal, quality: 600, amount: '8' }] });
    assert.match(panelText(p), /duration open/);
  });

  it('books the previewed order and finishes it from the prefilled lines', async () => {
    const d = draft('test metal 600 8\ntest metal 500 2,5');
    await previewPanel(db, 'en', 'tok', d);
    const { jobId } = await refineStart(db, mia, d.ready!);
    const batches = (await pickableBatches(db, mia, 'refining', 'en')).filter((p) => p.refine?.jobId === jobId);
    // Prefilled with the expected yields; the second line comes out with less
    const rows = batches.map((p) => ({ name: p.material, quality: p.batch.quality, expected: p.batch.quantity }));
    const text = doneText(rows).replace(/^(.* 500:).*$/m, '$1 2');
    const parsed = parseDoneText(text, rows);
    assert.ok('amounts' in parsed, JSON.stringify(parsed));
    const r = await refineDone(db, mia, {
      jobId, rows: batches.map((p, i) => ({ batchId: p.batch.id, amount: parsed.amounts[i]!, expected: p.batch.quantity })),
    });
    assert.deepEqual(r.batches.map((b) => [b.state, b.quality, b.quantity]).sort(), [['stored', 500, '2.000000'], ['stored', 600, '8.000000']]);
    assert.deepEqual(await pickableBatches(db, mia, 'refining', 'en'), []);
  });

  it('removes a job that will not come out: nothing is stored', async () => {
    const d = draft('test metal 700 4');
    await previewPanel(db, 'en', 'tok', d);
    const { jobId, batches } = await refineStart(db, mia, d.ready!);
    const stored = (await pickableBatches(db, mia, 'change', 'en')).filter((p) => p.batch.state === 'stored' && p.batch.quality === 700);
    await refineRemove(db, mia, { jobId, rows: batches.map((b) => ({ batchId: b.id, expected: b.quantity })) });
    assert.deepEqual(await pickableBatches(db, mia, 'refining', 'en'), []);
    assert.deepEqual((await pickableBatches(db, mia, 'change', 'en')).filter((p) => p.batch.state === 'stored' && p.batch.quality === 700), stored);
  });
});
