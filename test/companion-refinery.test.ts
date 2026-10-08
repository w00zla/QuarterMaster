// The companion app's refinery drafts from OCR screens (companion/src/refinery.ts); the screens are
// what the OCR read from the user's screenshots of 2026-10-07 (Dinyx job at CRU-L1).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CatalogResponse } from '../src/webapp/api-types.ts';
import { buildCatalog, cscuToScu, RefineryTracker, resolveDraft, startRequest, type Screen, type ScreenRow } from '../companion/src/refinery.ts';

const row = (name: string, quality: number, qty: number | null, yieldCscu: number | null, extra: Partial<ScreenRow> = {}): ScreenRow =>
  ({ name, inert: false, quality, qty, yieldCscu, todo: null, done: null, ...extra });

const quote = (method: string, seconds: number, yields: (number | null)[]): Screen => ({
  kind: 'quote', station: 'CRU-L1 AMBITIOUS DREAM STATION', method, seconds,
  rows: [
    row('TITANIUM (ORE)', 516, 21, yields[0]!),
    row('INERT MATERIALS', 0, 79, 0, { inert: true }),
    row('ASLARITE (RAW)', 575, 18, yields[1]!),
    row('AGRICIUM (ORE)', 346, 389, yields[2]!),
    row('AGRICIUM (ORE)', 588, 43, yields[3]!),
    row('AGRICIUM (ORE)', 667, 46, yields[4]!),
  ],
});

const processing = (seconds: number): Screen => ({
  kind: 'processing', station: 'CRU-L1 AMBITIOUS DREAM STATION', method: null, seconds,
  rows: [
    row('TITANIUM', 516, null, 9, { todo: 10, done: 0 }),
    row('ASLARITE', 575, null, 8, { todo: 9, done: 0 }),
    row('AGRICIUM', 346, null, 175, { todo: 175, done: 0 }),
    row('AGRICIUM', 588, null, 19, { todo: 20, done: 0 }),
    row('AGRICIUM', 667, null, 20, { todo: 21, done: 0 }),
  ],
});

const T0 = Date.UTC(2026, 9, 7, 20, 41, 52);

describe('companion refinery drafts', () => {
  it('cSCU to exact SCU text', () => {
    assert.deepEqual([389, 21, 20, 100, 0, 1234].map(cscuToScu), ['3.89', '0.21', '0.2', '1', '0', '12.34']);
  });

  it('a started job matching the last quote becomes one draft', () => {
    const t = new RefineryTracker();
    // Not selected yet ("--" yields), then two quotes: the last one counts
    assert.equal(t.feed({ atMs: T0, screen: quote('Select an option', 0, [null, null, null, null, null]) }), null);
    t.feed({ atMs: T0 + 7_000, screen: quote('Cormack Method', 72, [6, 5, 122, 13, 14]) });
    t.feed({ atMs: T0 + 15_000, screen: quote('Dinyx Solventation', 3474, [9, 8, 175, 19, 20]) });
    const at = T0 + 109_000;
    const d = t.feed({ atMs: at, screen: processing(57 * 60 + 45) })!;
    assert.ok(d);
    assert.deepEqual([d.method, d.seconds, d.endsAtMs, d.rows.length], ['Dinyx Solventation', 3474, at + 3465_000, 5]);
    // The same job seen again: no second draft
    t.feed({ atMs: at + 30_000, screen: quote('Dinyx Solventation', 3474, [9, 8, 175, 19, 20]) });
    assert.equal(t.feed({ atMs: at + 40_000, screen: processing(57 * 60 + 5) }), null);
    assert.equal(t.drafts.length, 1);
  });

  it('no draft without a matching quote', () => {
    const t = new RefineryTracker();
    assert.equal(t.feed({ atMs: T0, screen: processing(3465) }), null);
    // Other yields (another method's quote) or a time that does not fit
    t.feed({ atMs: T0, screen: quote('Cormack Method', 72, [6, 5, 122, 13, 14]) });
    assert.equal(t.feed({ atMs: T0 + 10_000, screen: processing(60) }), null);
    t.feed({ atMs: T0, screen: quote('Dinyx Solventation', 3474, [9, 8, 175, 19, 20]) });
    assert.equal(t.feed({ atMs: T0 + 10_000, screen: processing(9000) }), null);
    // Too old a quote
    t.feed({ atMs: T0, screen: quote('Dinyx Solventation', 3474, [9, 8, 175, 19, 20]) });
    assert.equal(t.feed({ atMs: T0 + 31 * 60_000, screen: processing(1600) }), null);
  });

  it('resolves names against the catalog and builds the start request', () => {
    const catalog = {
      materials: [
        { uuid: 'ti', name: 'Titanium (Ore)', isOre: true }, { uuid: 'as', name: 'Aslarite (Raw)', isOre: true },
        { uuid: 'ag', name: 'Agricium (Ore)', isOre: true }, { uuid: 'agr', name: 'Agricium', isOre: false },
      ],
      locations: [{ uuid: 'cru', label: 'CRU-L1 Ambitious Dream Station · Crusader · Stanton', refinery: true }],
      methods: [{ code: 'DIN', name: 'Dinyx Solventation' }],
    } as unknown as CatalogResponse;
    const t = new RefineryTracker();
    t.feed({ atMs: T0, screen: quote('Dinyx Solventation', 3474, [9, 8, 175, 19, 20]) });
    const d = t.feed({ atMs: T0 + 9_000, screen: processing(3465) })!;
    const r = resolveDraft(d, buildCatalog([catalog]));
    assert.deepEqual([r.locationUuid, r.methodCode], ['cru', 'DIN']);
    assert.deepEqual(r.rows.map((x) => [x.oreUuid, x.quality, x.amount, x.expectedYield]), [
      ['ti', 516, '0.21', '0.09'], ['as', 575, '0.18', '0.08'], ['ag', 346, '3.89', '1.75'], ['ag', 588, '0.43', '0.19'], ['ag', 667, '0.46', '0.2'],
    ]);
    const body = startRequest(r, d.endsAtMs, T0 + 60_000)!;
    assert.deepEqual([body.locationUuid, body.method, body.durationSeconds, body.rows.length], ['cru', 'DIN', 3414, 5]);
    // An unknown station: nothing to register yet
    assert.equal(startRequest({ ...r, locationUuid: null }, d.endsAtMs, T0), null);
  });
});
