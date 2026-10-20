// The companion app's inventory scan (companion/src/inventory.ts): reads of the freight manager's
// warehouse as the OCR delivers them (as in the user's screenshots and live frames of 2026-10-18)
// turned into sightings and into proposals, one per stack.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addName, emptyNames } from '../src/stock/material-names.ts';
import type { StockBatch } from '../src/webapp/api-types.ts';
import {
  addRequest, fromMicro, inStockOf, InventoryScan, proposalsOf, sightingOf, toMicro,
  type InventoryCatalog, type InventoryReadEvent, type Proposal, type ReadTile, type ReadTooltip,
} from '../companion/src/inventory.ts';

const APHORITE = '00000000-0000-4000-8000-000000000001';
const SILICON = '00000000-0000-4000-8000-000000000002';
const HEPH = '00000000-0000-4000-8000-000000000003';
const COOLER = '00000000-0000-4000-8000-000000000004';
const LOC = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';

function catalog(): InventoryCatalog {
  const materials = emptyNames();
  addName(materials, 'Aphorite', APHORITE);
  addName(materials, 'Aphorit', APHORITE);
  addName(materials, 'Silicon', SILICON);
  addName(materials, 'Silizium', SILICON);
  addName(materials, 'Hephaestanite', HEPH);
  addName(materials, 'Blizzard', COOLER);
  return { materials, units: new Map([[APHORITE, 'pcs'], [SILICON, 'SCU'], [HEPH, 'SCU'], [COOLER, 'pcs']]), components: new Set([COOLER]) };
}

const rect = { x0: 0, y0: 0, x1: 10, y1: 10 };
// A tile's place in the frame at the read's pitch (260 × 255)
const tileRect = (row: number, col: number) => ({ x0: 1980 + col * 260, y0: 650 + row * 255, x1: 2220 + col * 260, y1: 890 + row * 255 });
const tile = (row: number, col: number, quality: number | null, count: number | null, hovered = false, countUncertain = false): ReadTile =>
  ({ rect: tileRect(row, col), row, col, quality, qualityAmbiguous: false, count, countUncertain, hovered, qualityText: quality === null ? '' : `${quality}Q`, badgeText: count === null ? '' : `X${count}` });
const tooltip = (name: string, quality: number | null, scu: string | null): ReadTooltip => ({ name, quality, scu, x: 0, y: 0, rect });
const read = (atMs: number, tiles: ReadTile[], tip: ReadTooltip | null): InventoryReadEvent =>
  ({ atMs, ms: 400, width: 3840, height: 1600, grid: { tiles, tooltip: tip, cells: [], cols: [], rows: [], pitchX: 260, pitchY: 255 }, components: null, cursor: null, boxes: [], frame: null, refinery: null });

describe('sightings', () => {
  it('an SCU material: the amount from the tooltip', () => {
    const s = sightingOf(read(1, [tile(0, 0, 572, 1, true), tile(0, 1, 310, 1)], tooltip('Hephaestanite', 572, '0.263')), catalog());
    assert.deepEqual([s?.materialUuid, s?.quality, s?.amount, s?.unit, s?.row, s?.col, s?.problem], [HEPH, 572, '0.263', 'SCU', 0, 0, null]);
  });

  it('a ship component stays a sighting: the components scan books those', () => {
    const s = sightingOf(read(1, [tile(0, 0, null, 1, true)], tooltip('Blizzard', null, null)), catalog());
    assert.deepEqual([s?.materialUuid, s?.problem], [COOLER, 'component']);
  });

  it('an item material: the count from the badge, the quality from the chip', () => {
    const s = sightingOf(read(1, [tile(1, 0, null, 14, true)], tooltip('Aphorite', 561, '0.001')), catalog());
    assert.deepEqual([s?.materialUuid, s?.quality, s?.amount, s?.unit, s?.amountUncertain, s?.problem], [APHORITE, 561, '14', 'pcs', false, null]);
    const uncertain = sightingOf(read(1, [tile(1, 0, 561, 1, true, true)], tooltip('Aphorite', null, null)), catalog());
    assert.deepEqual([uncertain?.quality, uncertain?.amount, uncertain?.amountUncertain], [561, '1', true]);
  });

  it('nothing without a tooltip or a hovered tile', () => {
    assert.equal(sightingOf(read(1, [tile(0, 0, 523, 1, true)], null), catalog()), null);
    assert.equal(sightingOf(read(1, [tile(0, 0, 523, 1)], tooltip('Aphorite', 523, '0.001')), catalog()), null);
  });

  it('flags unknown names, missing qualities and amounts', () => {
    const unknown = sightingOf(read(1, [tile(0, 0, null, 1, true)], tooltip('Hat and Monocle', null, null)), catalog());
    assert.deepEqual([unknown?.materialUuid, unknown?.problem, unknown?.name, unknown?.amount], [null, 'unknownMaterial', 'Hat and Monocle', '1']);
    const noQuality = sightingOf(read(1, [tile(0, 0, null, 2, true)], tooltip('Aphorite', null, null)), catalog());
    assert.deepEqual([noQuality?.materialUuid, noQuality?.problem], [APHORITE, 'noQuality']);
    const noAmount = sightingOf(read(1, [tile(0, 0, 310, 1, true)], tooltip('Silicon', 310, null)), catalog());
    assert.deepEqual([noAmount?.problem], ['noAmount']);
    const noCount = sightingOf(read(1, [tile(0, 0, 523, null, true)], tooltip('Aphorite', 523, '0.001')), catalog());
    assert.deepEqual([noCount?.problem], ['noAmount']);
  });
});

describe('InventoryScan', () => {
  const cat = catalog();
  /** Feeds the same read twice (a sighting needs two reads of one tile that agree); the second's result. */
  const twice = (scan: InventoryScan, e: InventoryReadEvent) => {
    scan.feed(e, cat);
    return scan.feed({ ...e, atMs: e.atMs + 1 }, cat);
  };

  it('a stack is its content in its column: the same tile after a scroll is one sighting, another column another', () => {
    const scan = new InventoryScan();
    assert.ok(twice(scan, read(1, [tile(2, 0, 523, 1, true)], tooltip('Aphorite', 523, null))));
    // Scrolled: the same stack in another row
    assert.equal(twice(scan, read(3, [tile(0, 0, 523, 1, true)], tooltip('Aphorite', 523, null))), null, 'the same stack');
    // Another quality, and the same numbers in another column: other stacks
    assert.ok(twice(scan, read(5, [tile(3, 0, 686, 1, true)], tooltip('Aphorite', 686, null))));
    assert.ok(twice(scan, read(7, [tile(0, 2, 523, 1, true)], tooltip('Aphorite', 523, null))));
    assert.deepEqual(scan.list().map((s) => [s.col, s.quality]), [[2, 523], [0, 686], [0, 523]]);
    scan.clear();
    assert.equal(scan.list().length, 0);
  });

  it('a single read books nothing: two in a row of one tile must agree', () => {
    const scan = new InventoryScan();
    assert.equal(scan.feed(read(1, [tile(0, 0, null, 14, true)], tooltip('Aphorite', 561, '0.001')), cat), null, 'the first read waits');
    // The chip misread once ("56"): no sighting, and the pending one starts over
    assert.equal(scan.feed(read(2, [tile(0, 0, null, 14, true)], tooltip('Aphorite', 56, '0.001')), cat), null);
    assert.equal(scan.feed(read(3, [tile(0, 0, null, 14, true)], tooltip('Aphorite', 561, '0.001')), cat), null);
    assert.ok(scan.feed(read(4, [tile(0, 0, null, 14, true)], tooltip('Aphorite', 561, '0.001')), cat));
    assert.deepEqual(scan.list().map((s) => [s.quality, s.amount]), [[561, '14']]);
  });

  it('the previous tile\'s tooltip, still shown right after the cursor moved on, counts nowhere', () => {
    const scan = new InventoryScan();
    // Aphorite Q724 on r0 c1, then the cursor on r0 c2 (x2) while that tooltip still shows: one read
    twice(scan, read(1, [tile(0, 1, 724, 4, true), tile(0, 2, null, 2)], tooltip('Aphorite', 724, '0.001')));
    assert.equal(scan.feed(read(3, [tile(0, 1, 724, 4), tile(0, 2, null, 2, true)], tooltip('Aphorite', 724, '0.001')), cat), null);
    assert.equal(scan.feed(read(4, [tile(0, 1, 724, 4), tile(0, 2, null, 2, true)], tooltip('Aphorite', 523, '0.001')), cat), null);
    assert.ok(scan.feed(read(5, [tile(0, 1, 724, 4), tile(0, 2, null, 2, true)], tooltip('Aphorite', 523, '0.001')), cat));
    assert.deepEqual(scan.list().map((s) => [s.col, s.quality, s.amount]), [[2, 523, '2'], [1, 724, '4']]);
  });

  it('two agreeing reads of different tiles count nothing', () => {
    const scan = new InventoryScan();
    // The same stack text read over two tiles (the cursor moving down a column of equal stacks):
    // neither read was confirmed on its own tile
    scan.feed(read(1, [tile(0, 0, 561, 14, true)], tooltip('Aphorite', 561, '0.001')), cat);
    assert.equal(scan.feed(read(2, [tile(1, 0, 561, 14, true)], tooltip('Aphorite', 561, '0.001')), cat), null);
  });

  it('the same tile though the fit counts its rows from another top row', () => {
    const scan = new InventoryScan();
    // Same place in the frame, row 0 in one read and row 1 in the next (a partly visible top row fitted)
    scan.feed(read(1, [tile(0, 0, 561, 14, true)], tooltip('Aphorite', 561, '0.001')), cat);
    const moved = { ...tile(1, 0, 561, 14, true), rect: tileRect(0, 0) };
    assert.ok(scan.feed(read(2, [moved], tooltip('Aphorite', 561, '0.001')), cat));
  });

  it('a count confirmed with a digit lost ("X1" and "X10" of one stack) books neither', () => {
    const scan = new InventoryScan();
    // 1080p 2026-10-19: Aphorite X10 read as X1 in some frames, both twice in a row
    assert.ok(twice(scan, read(1, [tile(1, 2, null, 1, true)], tooltip('Aphorite', 348, '0.001'))));
    assert.ok(twice(scan, read(3, [tile(1, 2, null, 10, true)], tooltip('Aphorite', 348, '0.001'))));
    assert.deepEqual(scan.list().map((s) => [s.amount, s.problem]), [['10', 'amountFlicker'], ['1', 'amountFlicker']]);
    assert.deepEqual(proposalsOf(scan.list(), [], LOC), []);
    // Another count of the same material in the same column (another stack): no flicker
    const other = new InventoryScan();
    twice(other, read(1, [tile(0, 2, null, 4, true)], tooltip('Aphorite', 348, '0.001')));
    twice(other, read(3, [tile(1, 2, null, 2, true)], tooltip('Aphorite', 348, '0.001')));
    assert.deepEqual(other.list().map((s) => s.problem), [null, null]);
  });

  it('an uncertain count merges with a certain read of the same stack', () => {
    const scan = new InventoryScan();
    // The badge read "X": count 1, uncertain
    assert.ok(twice(scan, read(1, [tile(1, 3, null, 1, true, true)], tooltip('Aphorite', 526, '0.001'))));
    // Read again with the digits: replaces it
    const certain = twice(scan, read(3, [tile(1, 3, null, 2, true)], tooltip('Aphorite', 526, '0.001')));
    assert.deepEqual([certain?.amount, certain?.amountUncertain, scan.list().length], ['2', false, 1]);
    // An uncertain read after a certain one changes nothing
    assert.equal(twice(scan, read(5, [tile(1, 3, null, 1, true, true)], tooltip('Aphorite', 526, '0.001'))), null);
    assert.deepEqual(scan.list().map((s) => s.amount), ['2']);
  });
});

describe('amounts', () => {
  it('micro units round-trip', () => {
    assert.equal(toMicro('0.263'), 263000n);
    assert.equal(toMicro('2'), 2_000_000n);
    assert.equal(toMicro('0,5'), 500000n);
    assert.equal(fromMicro(263000n), '0.263');
    assert.equal(fromMicro(2_000_000n), '2');
    assert.equal(fromMicro(1_500_000n), '1.5');
    assert.throws(() => toMicro('1.2.3'));
    assert.throws(() => toMicro('abc'));
  });
});

describe('proposals', () => {
  const batch = (subjectUuid: string, quality: number, quantity: string, locationUuid = LOC, extra: Partial<StockBatch> = {}): StockBatch => ({
    id: 1, sharedIn: [], part: false, kind: 'resource', component: false, stats: null, subjectUuid, material: '', locationUuid, location: '', state: 'stored',
    quality, quantity, unit: 'SCU', holderUserId: 'u', holderName: null, canChange: true, refine: null, ...extra,
  });
  const cat = catalog();

  it('one per stack, with the stock stored at the location of that material and quality', () => {
    const scan = new InventoryScan();
    for (const e of [
      read(1, [tile(0, 0, 310, 1, true)], tooltip('Silicon', 310, '2')),
      read(2, [tile(0, 1, 310, 1, true)], tooltip('Silicon', 310, '0.134')),
      read(3, [tile(1, 0, 782, 1, true)], tooltip('Silicon', 782, '0.656')),
      read(4, [tile(1, 1, 572, 1, true)], tooltip('Hephaestanite', 572, '0.263')),
      read(5, [tile(1, 2, null, 1, true)], tooltip('Hat and Monocle', null, null)),
    ]) {
      scan.feed(e, cat);
      scan.feed(e, cat);
    }
    const stock = [
      batch(SILICON, 310, '1.5'),
      batch(SILICON, 310, '0.5'),
      // Another location, a refinery job, someone else's: not counted
      batch(SILICON, 782, '5', OTHER),
      batch(HEPH, 572, '9', LOC, { state: 'refining' }),
      batch(HEPH, 572, '9', LOC, { canChange: false }),
    ];
    const ps = proposalsOf(scan.sightings.values(), stock, LOC);
    assert.deepEqual(
      ps.map((p) => [p.materialUuid, p.quality, p.amount, p.stored]),
      [[SILICON, 310, '2', '2'], [SILICON, 310, '0.134', '2'], [SILICON, 782, '0.656', '0'], [HEPH, 572, '0.263', '0']],
    );
    assert.deepEqual(addRequest(ps[1]!, LOC), { subjectUuid: SILICON, locationUuid: LOC, quality: 310, amount: '0.134' });
    assert.deepEqual(addRequest(ps[1]!, LOC, ['g1']), { subjectUuid: SILICON, locationUuid: LOC, quality: 310, amount: '0.134', guildIds: ['g1'] });
    // Sightings are keyed by content, so the proposal ids are stable across scrolls
    assert.equal(ps[0]!.id, '0|' + SILICON + '|310|2');
  });

  it('marks the stacks the stored stock covers: registered first, then the earliest seen', () => {
    const p = (id: string, quality: number, amount: string): Proposal =>
      ({ id, materialUuid: SILICON, quality, unit: 'SCU', amount, amountUncertain: false, stored: '' });
    // Newest first, as listed
    const ps = [p('d', 310, '1'), p('c', 310, '2'), p('b', 310, '1.5'), p('a', 310, '1'), p('x', 782, '1')];
    const stock = [batch(SILICON, 310, '2'), batch(SILICON, 310, '0.5'), batch(SILICON, 782, '5', OTHER)];
    // 2.5 stored: a (1) and b (1.5) are covered, c and d are new; Q782 has none here
    assert.deepEqual([...inStockOf(ps, stock, LOC, new Set())].sort(), ['a', 'b']);
    // c registered here: it counts first (2), then a (1) fits no more of the 0.5 left
    assert.deepEqual([...inStockOf(ps, stock, LOC, new Set(['c']))].sort(), ['c']);
    // A registered one counts even when the stock was not reloaded yet
    assert.deepEqual([...inStockOf(ps, [], LOC, new Set(['x']))], ['x']);
  });
});
