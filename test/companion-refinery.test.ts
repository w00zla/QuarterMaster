// The companion app's refinery sync (companion/src/refinery.ts): terminal overviews as the OCR reads
// them (rows as in the user's screenshots of 2026-10-08 at CRU-L1) against the user's running jobs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CatalogResponse, StockBatch } from '../src/webapp/api-types.ts';
import {
  buildCatalog, cscuToScu, doneRequest, findStation, finishedRequests, gameNameKeys, jobsOf, RefinerySync, removeRequest, resolveOrder, startRequest,
  type Job, type OverviewEvent, type OverviewOrder, type Proposal,
} from '../companion/src/refinery.ts';

const HEPH = '00000000-0000-4000-8000-000000000001';
const SILICON = '00000000-0000-4000-8000-000000000002';
const TITANIUM = '00000000-0000-4000-8000-000000000003';
const CRU = '00000000-0000-4000-8000-0000000000c1';
const ARC = '00000000-0000-4000-8000-0000000000c2';

const material = (uuid: string, name: string, nameKey: string) =>
  ({ uuid, kind: 'resource' as const, name, nameKey, unit: 'SCU' as const, type: null, typeLabel: null,
    component: false, label: name, size: null, gradeLetter: null, itemClass: null, stats: [], minable: false, thumb: null });
const location = (uuid: string, label: string, nameKey: string, refinery = true) =>
  ({ uuid, key: nameKey.toUpperCase(), label, short: label.split(' · ')[0]!, nameKey, refinery, yields: {} });

const catalog = (names: [string, string, string]): CatalogResponse => ({
  materials: [
    material(HEPH, names[0], 'items_commodities_hephaestanite'),
    material(SILICON, names[1], 'items_commodities_silicon'),
    material(TITANIUM, names[2], 'items_commodities_titanium'),
  ],
  locations: [
    location(CRU, 'CRU-L1 Ambitious Dream Station · Crusader · Stanton', 'rr_cru_l1'),
    location(ARC, 'ARC-L1 Wide Forest Station · ArcCorp · Stanton', 'rr_arc_l1'),
  ],
  blueprints: [],
  magazineBlueprints: [],
});

const CAT = buildCatalog([catalog(['Hephaestanite', 'Silicon', 'Titanium']), catalog(['Hephaestanit', 'Silizium', 'Titan'])], {});

const processing = (seconds: number, rows: [string, number, number][]): OverviewOrder =>
  ({ status: 'processing', seconds, rows: rows.map(([name, quality, yieldCscu]) => ({ name, quality, yieldCscu })) });
const completed = (rows: [string, number, number][]): OverviewOrder =>
  ({ status: 'completed', seconds: null, rows: rows.map(([name, quality, yieldCscu]) => ({ name, quality, yieldCscu })) });
const read = (atMs: number, ...orders: OverviewOrder[]): OverviewEvent =>
  ({ atMs, overview: { station: 'CRU-L1 AMBITIOUS DREAM STATION', orders } });

const ORDER2: [string, number, number][] = [['HEPHAESTANITE', 572, 91], ['SILICON', 310, 540], ['SILICON', 510, 105]];
const T0 = Date.parse('2026-10-08T20:31:18Z');

const job = (jobId: string, endsAt: string | null, batches: [number, string, number, string][], locationUuid = CRU): Job =>
  ({ jobId, locationUuid, endsAt, batches: batches.map(([id, resourceUuid, quality, quantity]) => ({ id, resourceUuid, quality, quantity })) });
const JOB2 = (endsAt: string | null, heph = '0.91') =>
  job('job-2', endsAt, [[11, HEPH, 572, heph], [12, SILICON, 310, '5.4'], [13, SILICON, 510, '1.05']]);

/** Feeds the same read twice (the second makes it stable). */
function twice(sync: RefinerySync, e: OverviewEvent, jobs: Job[]) {
  const first = sync.feed(e, CAT, jobs, e.atMs);
  return { first, second: sync.feed({ ...e, atMs: e.atMs + 2000 }, CAT, jobs, e.atMs + 2000) };
}

describe('companion refinery sync', () => {
  it('cSCU to exact SCU text', () => {
    assert.deepEqual([389, 20, 0, 100, 105].map(cscuToScu), ['3.89', '0.2', '0', '1', '1.05']);
  });

  it('names: the catalog in both languages and the player\'s language pack', () => {
    assert.deepEqual(gameNameKeys([catalog(['a', 'b', 'c'])]).sort(),
      ['items_commodities_hephaestanite', 'items_commodities_silicon', 'items_commodities_titanium', 'rr_arc_l1', 'rr_cru_l1']);
    const own = buildCatalog([catalog(['Hephaestanite', 'Silicon', 'Titanium'])], { items_commodities_silicon: 'Siliziumdioxid', rr_cru_l1: 'Ambitionierter Traum' });
    const o = resolveOrder(processing(60, [['SILIZIUMDIOXID', 310, 540], ['HEPHAESTANIUM', 572, 91]]), own)!;
    // A name neither the catalog nor the pack has: that row is left out
    assert.deepEqual(o.rows, [{ resourceUuid: SILICON, quality: 310, yieldCscu: 540 }]);
    assert.equal(findStation(own, 'AMBITIONIERTER TRAUM'), CRU);
    assert.equal(findStation(CAT, 'CRU-L1 AMBITIOUS DREAM STATION'), CRU);
    assert.equal(findStation(CAT, 'SOMEWHERE ELSE'), null);
  });

  it('resolving merges a material\'s rows of one quality and drops what cannot be read', () => {
    const o = resolveOrder(processing(60, [['SILIZIUM', 310, 100], ['SILICON', 310, 40], ['UNOBTAINIUM', 500, 5], ['TITANIUM', 516, 0]]), CAT)!;
    assert.deepEqual(o.rows, [{ resourceUuid: SILICON, quality: 310, yieldCscu: 140 }]);
    assert.equal(resolveOrder(processing(60, [['UNOBTAINIUM', 500, 5]]), CAT), null);
  });

  it('a running order without a job becomes a proposal once two reads agree', () => {
    const sync = new RefinerySync();
    const { first, second } = twice(sync, read(T0, processing(3600, ORDER2)), []);
    assert.equal(first.locationUuid, CRU);
    assert.equal(sync.proposals.length, 1);
    assert.deepEqual(second.updates, []);
    const p = sync.proposals[0]!;
    assert.equal(p.kind, 'new');
    const req = startRequest(p as Extract<Proposal, { kind: 'new' }>, T0 + 2000 + 60_000);
    assert.equal(req.locationUuid, CRU);
    // The end stays the game's: the time left at the moment of registering
    assert.equal(req.durationSeconds, 3600 - 60);
    assert.deepEqual(req.rows, [
      { resourceUuid: HEPH, quality: 572, amount: '0.91' },
      { resourceUuid: SILICON, quality: 310, amount: '5.4' },
      { resourceUuid: SILICON, quality: 510, amount: '1.05' },
    ].sort((a, b) => `${a.resourceUuid}:${a.quality}`.localeCompare(`${b.resourceUuid}:${b.quality}`)));
  });

  it('a read with rows hidden ("Work Order Accepted" over the panel) is no order of its own', () => {
    // 2026-10-19: two reads show only the first rows, then the whole order
    const sync = new RefinerySync();
    twice(sync, read(T0, processing(3600, ORDER2.slice(0, 1))), []);
    assert.equal(sync.proposals.length, 1);
    twice(sync, read(T0 + 6000, processing(3594, ORDER2)), []);
    assert.deepEqual(sync.proposals.map((p) => p.kind === 'new' && p.rows.length), [3], 'the fuller order replaces the short one');
    // A short read after it changes nothing
    twice(sync, read(T0 + 12000, processing(3588, ORDER2.slice(0, 2))), []);
    assert.equal(sync.proposals.length, 1);
    // A short read of a registered job is not proposed
    const other = new RefinerySync();
    twice(other, read(T0, processing(3600, ORDER2.slice(0, 1))), [JOB2('2026-10-08T21:31:18Z')]);
    assert.equal(other.proposals.length, 0);
  });

  it('one read alone or two different reads do nothing', () => {
    const sync = new RefinerySync();
    sync.feed(read(T0, processing(3600, ORDER2)), CAT, [], T0);
    sync.feed(read(T0 + 2000, processing(3598, [['HEPHAESTANITE', 572, 9], ['SILICON', 310, 540], ['SILICON', 510, 105]])), CAT, [], T0 + 2000);
    assert.equal(sync.proposals.length, 0);
  });

  it('a matched running job gets the terminal\'s yields and end by itself', () => {
    const sync = new RefinerySync();
    const end = new Date(T0 + 3600_000).toISOString();
    // Yields as the terminal shows them, the end within the slack: nothing to do
    assert.deepEqual(twice(sync, read(T0, processing(3600, ORDER2)), [JOB2(end)]).second.updates, []);
    // Another yield and an open end
    const { second } = twice(new RefinerySync(), read(T0, processing(3600, ORDER2)), [JOB2(null, '0.8')]);
    assert.deepEqual(second.updates, [
      { kind: 'yield', jobId: 'job-2', batchId: 11, amount: '0.91', expected: '0.8' },
      // The second read (2 s later) still says 3600 s left
      { kind: 'duration', jobId: 'job-2', durationSeconds: 3600 },
    ]);
  });

  it('of several matching jobs the one with the closest end', () => {
    const near = { ...JOB2(new Date(T0 + 3500_000).toISOString(), '0.8'), jobId: 'near' };
    const far = { ...JOB2(new Date(T0 + 9000_000).toISOString(), '0.8'), jobId: 'far' };
    const { second } = twice(new RefinerySync(), read(T0, processing(3600, ORDER2)), [far, near]);
    assert.ok(second.updates.every((u) => u.jobId === 'near'));
  });

  it('a finished order of a job: a proposal to store it with the terminal\'s yields', () => {
    const sync = new RefinerySync();
    twice(sync, read(T0, completed(ORDER2)), [JOB2(null, '0.8')]);
    const p = sync.proposals[0] as Extract<Proposal, { kind: 'store' }>;
    assert.equal(p.kind, 'store');
    assert.deepEqual(doneRequest(p), { jobId: 'job-2', rows: [
      { batchId: 11, amount: '0.91', expected: '0.8' }, { batchId: 12, amount: '5.4', expected: '5.4' }, { batchId: 13, amount: '1.05', expected: '1.05' },
    ] });
    // Stored: the terminal keeps showing it until collected; no proposal again, not even as one without a job
    sync.markStored(p);
    twice(sync, read(T0 + 10_000, completed(ORDER2)), []);
    assert.equal(sync.proposals.length, 0);
  });

  it('a finished order without a job: its materials into the stock, once', () => {
    const sync = new RefinerySync();
    twice(sync, read(T0, completed(ORDER2)), []);
    const p = sync.proposals[0] as Extract<Proposal, { kind: 'finished' }>;
    assert.equal(p.kind, 'finished');
    assert.deepEqual(finishedRequests(p), [
      { subjectUuid: HEPH, locationUuid: CRU, quality: 572, amount: '0.91' },
      { subjectUuid: SILICON, locationUuid: CRU, quality: 310, amount: '5.4' },
      { subjectUuid: SILICON, locationUuid: CRU, quality: 510, amount: '1.05' },
    ]);
    sync.markStored(p);
    // A restart of the app: the stored keys come back from the caller
    const again = new RefinerySync(sync.stored);
    twice(again, read(T0 + 60_000, completed(ORDER2)), []);
    assert.equal(again.proposals.length, 0);
    // Another order with other yields is new
    twice(again, read(T0 + 70_000, completed([['HEPHAESTANITE', 572, 90]])), []);
    assert.equal(again.proposals.length, 1);
  });

  it('after the visit: jobs of the station no read showed are proposed for removal', () => {
    const sync = new RefinerySync();
    const gone = job('gone', null, [[21, TITANIUM, 516, '0.03']]);
    const elsewhere = job('elsewhere', null, [[31, TITANIUM, 516, '0.03']], ARC);
    const jobs = [JOB2(null), gone, elsewhere];
    sync.startVisit();
    // Seen once is enough (scrolled past it)
    sync.feed(read(T0, processing(3600, ORDER2)), CAT, jobs, T0);
    sync.endVisit(jobs);
    assert.deepEqual(sync.proposals.map((p) => p.id), ['missing:gone']);
    assert.deepEqual(removeRequest(gone), { jobId: 'gone', rows: [{ batchId: 21, expected: '0.03' }] });
    // A visit that read nothing of a station proposes nothing for it
    const quiet = new RefinerySync();
    quiet.startVisit();
    quiet.endVisit(jobs);
    assert.equal(quiet.proposals.length, 0);
  });

  it('dismissed proposals do not come back; done ones go with the jobs', () => {
    const sync = new RefinerySync();
    twice(sync, read(T0, processing(3600, ORDER2)), []);
    sync.dismiss(sync.proposals[0]!.id);
    twice(sync, read(T0 + 10_000, processing(3590, ORDER2)), []);
    assert.equal(sync.proposals.length, 0);

    const other = new RefinerySync();
    twice(other, read(T0, processing(3600, ORDER2)), []);
    // Registered elsewhere (web app): the proposal goes
    other.prune([JOB2(null)]);
    assert.equal(other.proposals.length, 0);
  });

  it('jobs from a personal stock list', () => {
    const batch = (id: number, state: 'stored' | 'refining', jobId: string | null): StockBatch => ({
      id, sharedIn: [], part: false, kind: 'resource', component: false, stats: null, subjectUuid: HEPH, material: 'Hephaestanite', locationUuid: CRU, location: 'CRU-L1',
      state, quality: 572, quantity: '0.91', unit: 'SCU', holderUserId: '1', holderName: null, canChange: true,
      refine: jobId ? { jobId, startedAt: null, endsAt: null } : null,
    });
    const jobs = jobsOf([batch(1, 'refining', 'a'), batch(2, 'stored', null), batch(3, 'refining', 'a')]);
    assert.deepEqual(jobs.map((j) => [j.jobId, j.batches.map((b) => b.id)]), [['a', [1, 3]]]);
  });
});
