import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MineableRow, PlaceInfo } from '../src/webapp/mining-query.ts';
import { miningRows } from '../src/webapp/mining.ts';
import type { StarMapPlace } from '../src/webapp/unlock-query.ts';

const PLANET = '00000000-0000-4000-8000-000000000001';
const MOON = '00000000-0000-4000-8000-000000000002';
const BASE_A = '00000000-0000-4000-8000-000000000003';
const BASE_B = '00000000-0000-4000-8000-000000000004';
const LAGRANGE = '00000000-0000-4000-8000-000000000005';

const names = new Map<string, StarMapPlace>([
  [PLANET, { name: 'Crusader', system: 'Stanton', isSystem: false }],
  [MOON, { name: 'Yela', system: 'Stanton', isSystem: false }],
  [BASE_A, { name: 'Mining Base #A', system: 'Stanton', isSystem: false }],
  [BASE_B, { name: 'Asteroid Mining Base', system: 'Stanton', isSystem: false }],
  [LAGRANGE, { name: 'CRU L3-A', system: 'Stanton', isSystem: false }],
]);
const infos = new Map<string, PlaceInfo>([
  [PLANET, { key: 'Stanton2', type: 'Planet', parent: null }],
  [MOON, { key: 'Stanton2c', type: 'Moon', parent: PLANET }],
  [BASE_A, { key: 'AsteroidCluster_MiningBase_Stanton2_Small_01', type: 'Asteroid', parent: null }],
  [BASE_B, { key: 'AsteroidCluster_MiningBase_Stanton2_Medium_02', type: 'Asteroid', parent: null }],
  [LAGRANGE, { key: 'Stanton2_L3_01', type: 'Planet', parent: null }],
]);

const row = (over: Partial<MineableRow>): MineableRow => ({
  oreUuid: 'ore', ore: 'Taranite (Raw)', method: 'ship', qualityScale: '1', share: '0.18', minPercent: '5.7', maxPercent: '10', rarity: 'rare',
  qualityMin: 525, qualityMax: 1000, qualityValues: [{ value: 525, chance: 0.6 }, { value: 1000, chance: 0.4 }], locationUuids: [], ...over,
});

describe('mining rows', () => {
  it('shows a moon with its planet, groups instanced places and sorts by share', () => {
    const rows = miningRows([
      row({ locationUuids: [MOON, LAGRANGE] }),
      row({ share: '0.02', rarity: 'legendary', locationUuids: [BASE_A, BASE_B] }),
    ], names, infos);
    assert.deepEqual(rows.map((r) => [r.place, r.parent, r.group, r.count, r.share]), [
      ['CRU L3-A', null, null, 1, 18],
      ['Yela', 'Crusader', null, 1, 18],
      [null, null, 'miningBase', 2, 2],
    ]);
    assert.deepEqual(rows[0]!.parts[0]!.quality, { min: 525, max: 1000, values: [{ value: 525, chance: 0.6 }, { value: 1000, chance: 0.4 }] });
  });

  it('puts the parts of an ore into one row, the rich one first; grouped places count once per place', () => {
    const rows = miningRows([
      row({ qualityScale: '0.49', share: '0.15', minPercent: '40', maxPercent: '80', qualityMin: 310, qualityMax: 525, locationUuids: [MOON, BASE_A, BASE_B] }),
      row({ locationUuids: [MOON, BASE_A, BASE_B] }),
    ], names, infos);
    assert.deepEqual(rows.map((r) => [r.place, r.count, r.share, r.parts.map((p) => [p.qualityScale, p.minPercent, p.quality?.min])]), [
      [null, 2, 18, [[1, 5.7, 525], [0.49, 40, 310]]],
      ['Yela', 1, 18, [[1, 5.7, 525], [0.49, 40, 310]]],
    ]);
  });

  it('names the area of a place that has one (a Nyx ring) like a moon its planet', () => {
    const rows = miningRows([row({ locationUuids: [LAGRANGE] })], names, infos, new Map([[LAGRANGE, 'Glaciem-Ring']]));
    assert.deepEqual(rows.map((r) => [r.place, r.parent]), [['CRU L3-A', 'Glaciem-Ring']]);
  });

  it('keeps ores apart and leaves out the quality when there is none', () => {
    const rows = miningRows([
      row({ locationUuids: [MOON] }),
      row({ oreUuid: 'other', ore: 'Other (Ore)', qualityMin: null, locationUuids: [MOON] }),
    ], names, infos);
    assert.deepEqual(rows.map((r) => [r.ore, r.parts[0]!.quality === null]), [['Other (Ore)', true], ['Taranite (Raw)', false]]);
  });

  it('carries the ore\'s uuid and thumbnail hash (null without one)', () => {
    const rows = miningRows([
      row({ locationUuids: [MOON] }),
      row({ oreUuid: 'other', ore: 'Other (Ore)', locationUuids: [MOON] }),
    ], names, infos, new Map(), new Map([['ore', '0123abcd']]));
    assert.deepEqual(rows.map((r) => [r.oreUuid, r.thumb]), [['other', null], ['ore', '0123abcd']]);
  });
});
