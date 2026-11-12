// Where a gear stat's base comes from and how the tooltip shows it (src/stock/component-base.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { basePaths, baseStats, baseValue, tooltipForm } from '../src/stock/component-base.ts';
import { parsePath, pathQueryFirst } from '../src/stock/jsonpath.ts';

describe('component base values', () => {
  it('turns a record value into the tooltip value', () => {
    assert.equal(baseValue('GPP_Quantum_Speed', 259054500), 259.0545);
    assert.equal(baseValue('GPP_Weapon_FireRate', '650'), 650);
    // Damage mitigation from the linked damage record: 1 - the physical damage multiplier
    assert.equal(baseValue('GPP_Armor_DamageMitigation', 0.7), 0.3);
    assert.equal(baseValue('GPP_Armor_TemperatureMin', -61), -61);
    assert.equal(baseValue('GPP_Weapon_Damage', 1), null, 'shown as a change: no base');
    assert.equal(baseValue('GPP_Health_MaxHealth', 'x'), null);
  });

  it('takes a weapon sequence\'s pace, a charged or parallel action\'s shot where its first fire mode has no rate', () => {
    const places = basePaths().filter(([key]) => key === 'GPP_Weapon_FireRate');
    assert.deepEqual(places.map(([, rank]) => rank), [0, 1, 2, 3, 4]);
    // Lumin V: a sequence entry of 625 RPM; Scalpel: 1.2 seconds per shot = 50 RPM
    assert.equal(baseValue('GPP_Weapon_FireRate', '625', 1), 625);
    assert.equal(baseValue('GPP_Weapon_FireRate', '1.2', 2), 50);
    assert.equal(baseValue('GPP_Weapon_FireRate', 0, 2), null, 'no pace');
    // Charged (Arrowhead) and parallel (Tripledown) first actions: the shot's rate as it is (unchecked)
    assert.equal(baseValue('GPP_Weapon_FireRate', 70, 3), 70);
    assert.equal(baseValue('GPP_Weapon_FireRate', 60, 4), 60);
    assert.equal(baseValue('GPP_Weapon_FireRate', 1, 5), null, 'no such place');
  });

  it('reads a record\'s bases: per property the first place that holds a number, links followed', () => {
    const weapon = (fireActions: unknown[]) => ({ Components: [{ _Type_: 'SCItemWeaponComponentParams', fireActions }] });
    const none = () => undefined;
    assert.deepEqual(baseStats(weapon([{ fireRate: 650, sequenceEntries: [{ unit: 'RPM', delay: 1 }] }]), none), { GPP_Weapon_FireRate: 650 });
    assert.deepEqual(baseStats(weapon([{ sequenceEntries: [{ unit: 'RPM', delay: 625 }, { unit: 'RPM', delay: 700 }] }]), none), { GPP_Weapon_FireRate: 625 });
    // A rate that is no number (null, a text) does not count: the next place does
    assert.deepEqual(baseStats(weapon([{ fireRate: null, sequenceEntries: [{ unit: 'Seconds', delay: 1.2 }] }]), none), { GPP_Weapon_FireRate: 50 });
    assert.deepEqual(baseStats(weapon([{ _Type_: 'SWeaponActionFireChargedParams', weaponAction: { fireRate: 70 } }]), none), { GPP_Weapon_FireRate: 70 });
    assert.deepEqual(baseStats(weapon([{ _Type_: 'SWeaponActionParallelParams', weaponActions: [{ fireRate: 60 }, { fireRate: 90 }] }]), none), { GPP_Weapon_FireRate: 60 });
    // A pace of 0 seconds is no rate; a beam holds none anywhere
    assert.deepEqual(baseStats(weapon([{ sequenceEntries: [{ unit: 'Seconds', delay: 0 }] }]), none), {});
    assert.deepEqual(baseStats(weapon([{ _Type_: 'SWeaponActionFireBeamParams' }]), none), {});
    // Scale, and several properties of one record
    assert.deepEqual(baseStats({ Components: [
      { _Type_: 'SCItemQuantumDriveParams', quantumFuelRequirement: 0.007546, params: { driveSpeed: 259054500 } },
      { _Type_: 'SHealthComponentParams', Health: 200 },
      { _Type_: 'ItemResourceComponentParams', states: [{ deltas: [
        { generation: { resource: 'Power', resourceAmountPerSecond: { units: 16 } } },
        { generation: { resource: 'Coolant', resourceAmountPerSecond: { standardResourceUnits: 22 } } },
      ] }] },
    ] }, none), {
      GPP_Health_MaxHealth: 200, GPP_ItemResource_CoolantGeneration: 22, GPP_ItemResource_PowerGeneration: 16,
      GPP_Quantum_Speed: 259.0545, GPP_Quantum_FuelRequirement: 7.546,
    });
    // The damage mitigation sits in the linked record, found by its path from "libs/" on, lower case
    const armor = { Components: [{ _Type_: 'SCItemSuitArmorParams', damageResistance: 'file://./../../libs/foundry/records/Damage/MediumArmor.json' }] };
    const asked: string[] = [];
    const linked = (path: string) => (asked.push(path), { damageResistance: { PhysicalResistance: { Multiplier: 0.7 } } });
    assert.deepEqual(baseStats(armor, linked), { GPP_Armor_DamageMitigation: 0.3 });
    assert.deepEqual(asked, ['libs/foundry/records/damage/mediumarmor.json']);
    assert.deepEqual(baseStats(armor, none), {}, 'no such record');
    assert.deepEqual(baseStats({ Components: [{ _Type_: 'SCItemSuitArmorParams', damageResistance: null }] }, linked), {}, 'no link');
    assert.deepEqual(baseStats({}, linked), {});
    assert.deepEqual(baseStats(null, linked), {});
  });

  it('tells from the display transformation whether the tooltip shows the value or its change', () => {
    assert.equal(tooltipForm(null), 'value');
    assert.equal(tooltipForm({ _Type_: 'CraftingDisplayTransformation_Scale', scale: 1000 }), 'value');
    assert.equal(tooltipForm({ _Type_: 'CraftingDisplayTransformation_ConvertFactorToPercentChange' }), 'change');
    assert.equal(tooltipForm({ _Type_: 'CraftingDisplayTransformation_ConvertFactorToNegatedPercentChange' }), 'negatedChange');
    assert.equal(tooltipForm({
      _Type_: 'CraftingDisplayTransformation_Sequence',
      transformations: [{ _Type_: 'CraftingDisplayTransformation_ConvertValueToFactorOfBaseValue' }, { _Type_: 'CraftingDisplayTransformation_ConvertFactorToPercentChange' }],
    }), 'change');
  });
});

// Each case is what Postgres' jsonb_path_query_first answers in lax mode (undefined: no row)
describe('jsonpath subset (Postgres lax mode)', () => {
  const first = pathQueryFirst;

  it('parses every base path and nothing outside the subset', () => {
    for (const [, , place] of basePaths()) {
      assert.ok(parsePath(place.path).length > 0);
      if (place.link) assert.ok(parsePath(place.link).length > 0);
    }
    for (const bad of ['a.b', '$.a[1 to 2]', '$.a ? (@.b > 1)', '$.a.size()', '$."a b"', '$.a ? (@.b == 1)', 'strict $.a', '$.a[last]', '$.*']) {
      assert.throws(() => parsePath(bad), /jsonpath/, bad);
    }
  });

  it('follows members; a missing one finds nothing, a null is found', () => {
    assert.equal(first({ a: { b: 5 } }, '$.a.b'), 5);
    assert.equal(first({ a: { b: '5' } }, '$.a.b'), '5');
    assert.equal(first({ a: { b: null } }, '$.a.b'), null);
    assert.equal(first({ a: {} }, '$.a.b'), undefined);
    assert.equal(first({ a: 5 }, '$.a.b'), undefined);
    assert.equal(first(null, '$.a'), undefined);
    assert.deepEqual(first({ a: [1, 2] }, '$.a'), [1, 2], 'an array is found as it is');
    assert.equal(first({ A: 1 }, '$.a'), undefined, 'case matters');
  });

  it('unwraps an array one level on member access', () => {
    assert.equal(first({ a: [{ x: 1 }, { b: 2 }, { b: 3 }] }, '$.a.b'), 2);
    assert.equal(first({ a: [[{ b: 2 }]] }, '$.a.b'), undefined, 'not two levels');
    assert.equal(first({ a: [null, 7, 'x', { b: 4 }] }, '$.a.b'), 4);
  });

  it('takes all elements or one; a value that is no array counts as an array of one', () => {
    assert.equal(first({ a: [{ b: 1 }, { b: 2 }] }, '$.a[*].b'), 1);
    assert.equal(first({ a: [{ b: 1 }, { b: 2 }] }, '$.a[1].b'), 2);
    assert.equal(first({ a: [{ b: 1 }] }, '$.a[1].b'), undefined, 'beyond the end');
    assert.equal(first({ a: [] }, '$.a[0]'), undefined);
    assert.equal(first({ a: { b: 1 } }, '$.a[*].b'), 1);
    assert.equal(first({ a: { b: 1 } }, '$.a[0].b'), 1);
    assert.equal(first({ a: { b: 1 } }, '$.a[1].b'), undefined);
    // [0] of each of several: the first that has one
    assert.equal(first({ a: [{ c: [] }, { c: [8, 9] }] }, '$.a[*].c[0]'), 8);
  });

  it('filters by a text member; the first match that goes on counts', () => {
    const data = { Components: [null, { _Type_: 'A', v: 1 }, { _Type_: 'B' }, { _Type_: 'B', v: 2 }, { _Type_: 'B', v: 3 }, 'B'] };
    assert.equal(first(data, '$.Components[*] ? (@._Type_ == "A").v'), 1);
    assert.equal(first(data, '$.Components[*] ? (@._Type_ == "B").v'), 2, 'the first B has no v');
    assert.equal(first(data, '$.Components[*] ? (@._Type_ == "C").v'), undefined);
    assert.deepEqual(first(data, '$.Components[*] ? (@._Type_ == "B")'), { _Type_: 'B' });
    // Other types never equal a text
    assert.equal(first([{ t: 1, v: 1 }, { t: null, v: 2 }, { t: true, v: 3 }, { t: { x: '1' }, v: 4 }], '$[*] ? (@.t == "1").v'), undefined);
    // A filter on an array tests its elements, on an object the object itself
    assert.equal(first({ a: [{ u: 'RPM', d: 5 }] }, '$.a ? (@.u == "RPM").d'), 5);
    assert.equal(first({ a: { u: 'RPM', d: 5 } }, '$.a ? (@.u == "RPM").d'), 5);
    assert.equal(first({ a: { u: 'Seconds', d: 5 } }, '$.a[0] ? (@.u == "RPM").d'), undefined);
    // The compared member may be a list holding the text, or sit below further members
    assert.equal(first([{ t: ['x', 'y'], v: 1 }], '$[*] ? (@.t == "y").v'), 1);
    assert.equal(first([{ t: [['y']], v: 1 }], '$[*] ? (@.t == "y").v'), undefined);
    assert.equal(first([{ g: { r: 'Power' }, v: 1 }, { g: { r: 'Coolant' }, v: 2 }], '$[*] ? (@.g.r == "Coolant").v'), 2);
  });

  it('chains as the base paths do', () => {
    const record = { Components: [
      { _Type_: 'ItemResourceComponentParams', states: [
        { deltas: [{ generation: { resource: 'Power', resourceAmountPerSecond: { units: 4 } } }, { consumption: {} }] },
        { deltas: [{ generation: { resource: 'Coolant', resourceAmountPerSecond: { standardResourceUnits: 22 } } }] },
      ] },
      { _Type_: 'SCItemWeaponComponentParams', fireActions: [{ sequenceEntries: [{ unit: 'Seconds', delay: 1.2 }, { unit: 'RPM', delay: 9 }] }, { fireRate: 300 }] },
    ] };
    const component = (t: string) => `$.Components[*] ? (@._Type_ == "${t}")`;
    assert.equal(first(record, `${component('ItemResourceComponentParams')}.states[*].deltas[*].generation ? (@.resource == "Coolant").resourceAmountPerSecond.standardResourceUnits`), 22);
    assert.equal(first(record, `${component('SCItemWeaponComponentParams')}.fireActions[0].fireRate`), undefined, 'the first fire mode only');
    assert.equal(first(record, `${component('SCItemWeaponComponentParams')}.fireActions[0].sequenceEntries[0] ? (@.unit == "RPM").delay`), undefined, 'the first entry only');
    assert.equal(first(record, `${component('SCItemWeaponComponentParams')}.fireActions[0].sequenceEntries[0] ? (@.unit == "Seconds").delay`), 1.2);
  });
});
