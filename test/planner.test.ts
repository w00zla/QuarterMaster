import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { combine, computePlan, formatMicros, modifierAt, toMicros } from '../src/planner/plan.ts';
import type { ModifierRange, PlannerData, PlannerRecipe } from '../src/planner/types.ts';

const linear = (s: number, e: number, a: number, b: number): ModifierRange =>
  ({ type: 'Linear', startQuality: s, endQuality: e, values: { modifierAtStart: a, modifierAtEnd: b } });

const DAMAGE = [linear(0, 500, 0.95, 1.0), linear(501, 1000, 1.0, 1.05)];
const FUEL = [linear(0, 500, 1.2, 1.0), linear(501, 1000, 1.0, 0.8)];

const recipe = (over: Partial<PlannerRecipe> = {}): PlannerRecipe => ({
  uuid: 'bp-1',
  key: 'BP_1',
  name: 'Gun',
  outputType: 'WeaponGun',
  outputTypeLabel: 'Gun',
  outputSubTypeLabel: null,
  size: 1,
  grade: 1,
  gradeLetter: null,
  itemClass: null,
  manufacturer: null,
  isDefault: false,
  category: 'VehicleWeaponsS1',
  categoryGroup: 'VehicleWeapons',
  categoryLabel: 'Vehicle Weapons',
  craftSeconds: 90,
  requiredSlots: 2,
  retired: false,
  slots: [
    {
      index: 0, key: 'EMITTER', name: 'Emitter', requiredCount: 1,
      inputs: [{ kind: 'resource', uuid: 'r-metal', key: 'Metal', name: 'Metal', quantity: '0.0075', minQuality: 1 }],
      modifiers: [{ propertyUuid: 'p-dmg', key: 'GPP_Damage', name: 'Damage', unit: null, ranges: DAMAGE }],
    },
    {
      index: 1, key: 'APERTURE', name: 'Aperture', requiredCount: 1,
      inputs: [{ kind: 'item', uuid: 'i-gem', key: 'Gem', name: 'Gem', quantity: '7', minQuality: 300 }],
      modifiers: [
        { propertyUuid: 'p-dmg', key: 'GPP_Damage', name: 'Damage', unit: null, ranges: DAMAGE },
        { propertyUuid: 'p-fuel', key: 'GPP_Fuel', name: 'Fuel', unit: null, ranges: FUEL },
      ],
    },
  ],
  ...over,
});

const data = (...recipes: PlannerRecipe[]): PlannerData => ({ defaultQuality: 500, recipes });

describe('decimals', () => {
  it('sums and multiplies exactly', () => {
    assert.equal(formatMicros(toMicros('0.0075') * 3n + toMicros('0.1')), '0.1225');
    assert.equal(formatMicros(toMicros('0.1') + toMicros('0.2')), '0.3');
    assert.equal(formatMicros(toMicros('15')), '15');
    assert.throws(() => toMicros('1e-3'));
  });
});

describe('modifierAt', () => {
  it('interpolates within the matching range and clamps the quality', () => {
    assert.equal(modifierAt(DAMAGE, 0)!.value, 0.95);
    assert.equal(modifierAt(DAMAGE, 250)!.value, 0.975);
    assert.equal(modifierAt(DAMAGE, 500)!.value, 1);
    assert.equal(modifierAt(DAMAGE, 501)!.value, 1);
    assert.equal(modifierAt(DAMAGE, 2000)!.value, 1.05);
  });

  it('rounds additive steps and rejects unknown types', () => {
    const power: ModifierRange[] = [
      { type: 'LinearIntegerAdditive', startQuality: 0, endQuality: 500, values: { additiveModifierAtStart: -1, additiveModifierAtEnd: -1 } },
      { type: 'LinearIntegerAdditive', startQuality: 501, endQuality: 1000, values: { additiveModifierAtStart: 1, additiveModifierAtEnd: 1 } },
    ];
    assert.deepEqual(modifierAt(power, 800), { kind: 'additive', value: 1 });
    assert.equal(modifierAt([{ type: 'Curve', startQuality: 0, endQuality: 1000, values: {} }], 500), null);
  });

  it('combines multipliers multiplicatively and additive steps by sum (assumption)', () => {
    assert.equal(combine('multiplier', [1.05, 1.05]), 1.05 * 1.05);
    assert.equal(combine('additive', [1, -1, 1]), 1);
  });
});

describe('computePlan', () => {
  it('totals materials and craft time over entries', () => {
    const r = computePlan(data(recipe()), [{ blueprintUuid: 'bp-1', count: 3 }, { blueprintUuid: 'bp-1', count: 1 }]);
    assert.equal(r.craftSeconds, 360);
    assert.deepEqual(r.materials.map((m) => [m.kind, m.name, m.total, m.minQuality]), [
      ['resource', 'Metal', '0.03', 1],
      ['item', 'Gem', '28', 300],
    ]);
    assert.deepEqual(r.materials[0]!.usedBy.map((u) => u.total), ['0.0225', '0.0075']);
  });

  it('computes stats per quality, combined over slots, with direction', () => {
    const r = computePlan(data(recipe()), [{ blueprintUuid: 'bp-1', count: 1, quality: { 0: 1000, 1: 1000 } }]);
    const dmg = r.entries[0]!.stats.find((s) => s.key === 'GPP_Damage')!;
    assert.equal(dmg.value, 1.05 * 1.05);
    assert.deepEqual(dmg.perSlot.map((p) => p.slotIndex), [0, 1]);
    assert.equal(dmg.favorable, true);
    const fuel = r.entries[0]!.stats.find((s) => s.key === 'GPP_Fuel')!;
    assert.equal(fuel.value, 0.8);
    // Lower fuel use is what higher quality brings: favorable
    assert.equal(fuel.favorable, true);
    const low = computePlan(data(recipe()), [{ blueprintUuid: 'bp-1', count: 1, quality: { 1: 0 } }]).entries[0]!;
    assert.equal(low.stats.find((s) => s.key === 'GPP_Fuel')!.favorable, false);
    assert.equal(computePlan(data(recipe()), [{ blueprintUuid: 'bp-1', count: 1 }]).entries[0]!.stats[0]!.favorable, null);
  });

  it('warns about qualities below a slot minimum', () => {
    const r = computePlan(data(recipe()), [{ blueprintUuid: 'bp-1', count: 1, quality: { 1: 200 } }]);
    assert.equal(r.entries[0]!.slots[1]!.belowMinQuality, true);
    assert.ok(r.entries[0]!.warnings.some((w) => w.includes('below the minimum')));
  });

  it('uses only the chosen slots of "N of M" recipes', () => {
    const nOfM = recipe({ requiredSlots: 1 });
    const second = computePlan(data(nOfM), [{ blueprintUuid: 'bp-1', count: 1, slots: [1] }]);
    assert.deepEqual(second.materials.map((m) => m.name), ['Gem']);
    assert.deepEqual(second.entries[0]!.slots.map((s) => s.selected), [false, true]);
    const invalid = computePlan(data(nOfM), [{ blueprintUuid: 'bp-1', count: 1, slots: [0, 1] }]);
    assert.deepEqual(invalid.materials.map((m) => m.name), ['Metal']);
    assert.equal(invalid.entries[0]!.warnings.length, 1);
  });

  it('ignores modifiers without a curve and warns about unknown curve types', () => {
    const r = recipe();
    r.slots[0]!.modifiers.push({ propertyUuid: 'p-empty', key: 'GPP_Empty', name: 'Empty', unit: null, ranges: [] });
    r.slots[1]!.modifiers.push({ propertyUuid: 'p-odd', key: 'GPP_Odd', name: 'Odd', unit: null, ranges: [{ type: 'Curve', startQuality: 0, endQuality: 1000, values: {} }] });
    const e = computePlan(data(r), [{ blueprintUuid: 'bp-1', count: 1 }]).entries[0]!;
    assert.deepEqual(e.stats.map((s) => s.key).sort(), ['GPP_Damage', 'GPP_Fuel']);
    assert.deepEqual(e.warnings, ['Stat Odd: unsupported modifier in slot Aperture']);
  });

  it('reports unknown blueprints and retired ones', () => {
    const r = computePlan(data(recipe({ retired: true })), [{ blueprintUuid: 'nope', count: 1 }, { blueprintUuid: 'bp-1', count: 1 }]);
    assert.equal(r.warnings.length, 1);
    assert.ok(r.entries[0]!.warnings.some((w) => w.includes('no longer')));
  });
});
