// The crafting check against stock (src/planner/stock.ts), shared by the web app and the bot.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computePlan } from '../src/planner/plan.ts';
import type { PlannerData, PlannerRecipe } from '../src/planner/types.ts';
import type { StockBatch } from '../src/webapp/api-types.ts';
import { clampCount, coverageOf, needsOf, withQualityFloor, type Need } from '../src/planner/stock.ts';

const recipe = (uuid: string, metal: string, minQuality = 0): PlannerRecipe => ({
  uuid, key: uuid, name: uuid, outputType: null, outputTypeLabel: null, outputSubTypeLabel: null, size: null, grade: null,
  gradeLetter: null, itemClass: null, manufacturer: null, isDefault: false, category: null, categoryGroup: null, categoryLabel: null,
  craftSeconds: 60, requiredSlots: 2, retired: false,
  slots: [
    {
      index: 0, key: 'A', name: 'A', requiredCount: 1, modifiers: [],
      inputs: [{ kind: 'resource', uuid: 'r-metal', key: 'Metal', name: 'Metal', quantity: metal, minQuality }],
    },
    {
      index: 1, key: 'B', name: 'B', requiredCount: 1, modifiers: [],
      inputs: [{ kind: 'item', uuid: 'i-gem', key: 'Gem', name: 'Gem', quantity: '2', minQuality: 0 }],
    },
  ],
});

const data: PlannerData = { defaultQuality: 500, recipes: [recipe('bp-1', '0.1', 600), recipe('bp-2', '0.0075')] };

let nextId = 1;
const batch = (over: Partial<StockBatch>): StockBatch => ({
  id: nextId++, sharedIn: [], part: false, kind: 'resource', component: false, subjectUuid: 'r-metal', material: 'Metal', locationUuid: 'loc', location: 'Area18',
  state: 'stored', quality: 700, quantity: '1', unit: 'SCU', holderUserId: 'me', holderName: 'Me', canChange: true, refine: null, ...over,
});

const need = (over: Partial<Need> = {}): Need => ({ kind: 'resource', uuid: 'r-metal', name: 'Metal', total: '1', quality: 600, ...over });

const needOf = (n: Need) => [n.uuid, n.total, n.quality];

describe('crafting against stock', () => {
  it('raises qualities below the slot minimum and clamps the count', () => {
    const e = withQualityFloor(data, { blueprintUuid: 'bp-1', count: 250, quality: { 1: 900 } });
    assert.deepEqual(e.quality, { 0: 600, 1: 900 });
    assert.equal(e.count, 99);
    assert.equal(withQualityFloor(data, { blueprintUuid: 'bp-1', count: 3, quality: { 0: 100 } }).quality![0], 600);
    assert.equal(withQualityFloor(data, { blueprintUuid: 'bp-1', count: 3, quality: { 0: 800 } }).quality![0], 800);
    assert.equal(clampCount(0), 1);
    assert.equal(clampCount(Number.NaN), 1);
    assert.equal(clampCount(2.6), 3);
  });

  it('counts only stored batches at the target quality or better', () => {
    const c = coverageOf(need({ total: '5', quality: 600 }), [
      batch({ quality: 600, quantity: '2' }),
      batch({ quality: 599, quantity: '10' }),
      batch({ quality: 900, quantity: '1.5', holderUserId: 'max', holderName: 'Max' }),
      batch({ quality: 1000, quantity: '50', state: 'refining' }),
      batch({ subjectUuid: 'r-other', quantity: '50' }),
    ], 'me');
    assert.equal(c.missing, '1.5');
    assert.equal(c.covered, false);
    assert.equal(c.unit, 'SCU');
    // Only stored batches of the material at or above the target are listed
    assert.deepEqual(c.batches.map((b) => b.quality), [600, 900]);
  });

  it('computes the missing amount exactly', () => {
    const stock = [batch({ quantity: '0.1' }), batch({ quantity: '0.2' })];
    assert.equal(coverageOf(need({ total: '0.300001' }), stock, 'me').missing, '0.000001');
    const covered = coverageOf(need({ total: '0.3' }), stock, 'me');
    assert.equal(covered.missing, '0');
    assert.equal(covered.covered, true);
    const more = coverageOf(need({ total: '0.25' }), stock, 'me');
    assert.equal(more.missing, '0');
    assert.equal(more.covered, true);
  });

  it('needs per card with its count, at the slot quality', () => {
    const plan = computePlan(data, [withQualityFloor(data, { blueprintUuid: 'bp-1', count: 3, quality: { 0: 650 } })]);
    assert.deepEqual(needsOf(plan.entries[0]!).map(needOf), [['r-metal', '0.3', 650], ['i-gem', '6', 500]]);
  });

  it('merges the same material within one card at the highest quality', () => {
    const card: PlannerRecipe = {
      ...recipe('bp-c', '0.28'),
      slots: [
        { index: 0, key: 'A', name: 'A', requiredCount: 1, modifiers: [],
          inputs: [{ kind: 'resource', uuid: 'r-metal', key: 'Metal', name: 'Metal', quantity: '0.28', minQuality: 0 }] },
        { index: 1, key: 'B', name: 'B', requiredCount: 1, modifiers: [],
          inputs: [{ kind: 'resource', uuid: 'r-metal', key: 'Metal', name: 'Metal', quantity: '0.05', minQuality: 0 }] },
      ],
    };
    const one: PlannerData = { defaultQuality: 500, recipes: [card] };
    const plan = computePlan(one, [withQualityFloor(one, { blueprintUuid: 'bp-c', count: 2, quality: { 0: 500, 1: 940 } })]);
    const needs = needsOf(plan.entries[0]!);
    assert.deepEqual(needs.map(needOf), [['r-metal', '0.66', 940]]);
    const c = coverageOf(needs[0]!, [batch({ quality: 950, quantity: '0.5' }), batch({ quality: 777, quantity: '1' })], 'me');
    assert.equal(c.missing, '0.16');
  });

  it('skips unselected slots', () => {
    const oneOf = { ...data, recipes: [{ ...recipe('bp-3', '1'), requiredSlots: 1 }] };
    const picked = computePlan(oneOf, [{ blueprintUuid: 'bp-3', count: 1, slots: [1] }]);
    assert.deepEqual(needsOf(picked.entries[0]!).map((n) => n.uuid), ['i-gem']);
  });

  it('lists your own batches first, then by quality', () => {
    const c = coverageOf(need({ quality: 0 }), [
      batch({ quality: 900, holderUserId: 'max', holderName: 'Max' }),
      batch({ quality: 500 }),
      batch({ quality: 800 }),
    ], 'me');
    assert.deepEqual(c.batches.map((b) => [b.holderUserId, b.quality]), [['me', 800], ['me', 500], ['max', 900]]);
  });
});
