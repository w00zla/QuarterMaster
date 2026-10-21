// The blueprint unlocks' shaping (src/webapp/unlocks.ts): titles, odds, the info card's summary, the
// dialog's groups and tiers, systems from the star map.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanTitle, eventTiers, missionGroups, oddsOf, toSource, unlockSections, unlockSummary, type UnlockSource } from '../src/webapp/unlocks.ts';
import type { UnlockSourceRow } from '../src/webapp/unlock-query.ts';

const mission = (fields: Partial<UnlockSource> = {}): UnlockSource => ({
  kind: 'mission', weight: 1, poolWeight: 7, chance: 1, title: 'Deliver', missionType: 'Delivery', faction: 'Covalex', rank: 'Neutral',
  minReputation: 0, systems: ['Stanton'], locations: [], chain: false, illegal: false, onAccept: false, event: null, minPoints: null, ...fields,
});
const tier = (fields: Partial<UnlockSource> = {}): UnlockSource =>
  mission({ kind: 'event', title: '…', missionType: null, faction: null, rank: null, minReputation: null, systems: [], chance: null, event: 'RoX', minPoints: 1000, weight: 1, poolWeight: 1, ...fields });

describe('blueprint unlocks', () => {
  it('turns the game placeholders into "…"', () => {
    assert.equal(cleanTitle('Med. Purchase Order: ~mission(Location)'), 'Med. Purchase Order: …');
    assert.equal(cleanTitle('~mission(Contractor|BlackBoxRecoverTitleEasy)  near ~mission(Location|Address)'), '… near …');
    assert.equal(cleanTitle('No placeholder'), 'No placeholder');
  });

  it('reduces the odds, keeps a chance below 1 only', () => {
    assert.deepEqual(oddsOf(2, 12, 1), { num: 1, den: 6, chance: null });
    assert.deepEqual(oddsOf(2, 11, null), { num: 2, den: 11, chance: null });
    assert.deepEqual(oddsOf(1, 1, 0.25), { num: 1, den: 1, chance: 0.25 });
    assert.deepEqual(oddsOf(1.5, 4.5, 1), { num: 1, den: 3, chance: null });
  });

  it('sums up per kind: markers only when all have them, the best odds', () => {
    const [m, e] = unlockSummary([
      mission({ illegal: true, chain: true, minReputation: 800, poolWeight: 14 }),
      mission({ illegal: true, poolWeight: 6, chance: 0.5 }),
      tier(),
    ]);
    // 1/14 against 1/6 at half the time (1/12): 1/12 is better
    assert.deepEqual(m, { kind: 'mission', count: 2, markers: ['illegal'], best: { num: 1, den: 6, chance: 0.5 }, varies: true });
    assert.deepEqual(e, { kind: 'event', count: 1, markers: [], best: { num: 1, den: 1, chance: null }, varies: false });
    assert.deepEqual(unlockSummary([mission({ event: 'ORS', onAccept: true, chance: 0.25 })])[0]!.markers, ['event', 'random', 'onAccept']);
    assert.deepEqual(unlockSummary([]), []);
  });

  it('groups missions by faction and type, merges equal rows, keeps the rest', () => {
    const groups = missionGroups([
      mission({ title: 'B', rank: 'Head Contractor', minReputation: 38000, systems: ['Pyro'] }),
      mission({ title: 'A', rank: 'Neutral', minReputation: 0 }),
      mission({ title: 'A', rank: 'Neutral', minReputation: 0 }),
      mission({ title: 'A', rank: 'Neutral', minReputation: 0, poolWeight: 9 }),
      mission({ faction: null, missionType: 'Investigation', rank: null, minReputation: null, chain: true, locations: ['Levski'], systems: ['Nyx'] }),
      mission({ missionType: 'Hauling', illegal: true, onAccept: true, minReputation: 800 }),
    ]);
    assert.deepEqual(groups.map((g) => [g.faction, g.missionType, g.count]), [
      ['Covalex', 'Delivery', 4], ['Covalex', 'Hauling', 1], [null, 'Investigation', 1],
    ]);
    const delivery = groups[0]!;
    assert.deepEqual([delivery.systems, delivery.rankFrom, delivery.rankTo, delivery.best, delivery.varies],
      [['Pyro', 'Stanton'], 'Neutral', 'Head Contractor', { num: 1, den: 7, chance: null }, true]);
    assert.deepEqual(delivery.rows.map((r) => [r.title, r.count, r.odds.den]), [['A', 2, 7], ['A', 1, 9], ['B', 1, 7]]);
    assert.deepEqual(groups[1]!.rows[0]!.markers, ['illegal', 'onAccept']);
    const delve = groups[2]!;
    assert.deepEqual([delve.rankFrom, delve.rows[0]!.markers, delve.rows[0]!.locations], [null, ['chain'], ['Levski']]);
  });

  it('lists event tiers and one section per kind', () => {
    assert.deepEqual(eventTiers([tier({ minPoints: 2000 }), tier(), tier()]).map((x) => [x.event, x.minPoints, x.count]), [['RoX', 1000, 2], ['RoX', 2000, 1]]);
    assert.deepEqual(unlockSections([tier(), mission()]).map((s) => [s.kind, s.count]), [['mission', 1], ['event', 1]]);
    assert.deepEqual(unlockSections([tier()]).map((s) => s.kind), ['event']);
  });

  it('resolves systems and bound places, never a system as a place', () => {
    const places = new Map([
      ['star', { name: 'Stanton', system: 'Stanton', isSystem: true }],
      ['moon', { name: 'Arial', system: 'Stanton', isSystem: false }],
      ['nyx', { name: 'Nyx System', system: 'Nyx', isSystem: true }],
      ['field', { name: 'Glaciem Ring', system: null, isSystem: false }],
    ]);
    const row: UnlockSourceRow = {
      kind: 'mission', weight: '1', poolWeight: '4', chance: '0.25', title: null, contractKey: 'Debug_Name', missionType: null, faction: null,
      rank: null, minReputation: null, localityUuids: ['star', 'nyx', 'field', 'gone'], locationUuids: ['moon', 'star'],
      requiresPrevious: false, illegal: false, onAccept: false, eventKey: null, minPoints: null,
    };
    const s = toSource(row, places);
    assert.deepEqual([s.title, s.systems, s.locations, s.chance, s.poolWeight], ['Debug_Name', ['Nyx', 'Stanton'], ['Arial'], 0.25, 4]);
  });
});
