import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blueprintCategoryGroup, blueprintCategoryLocKey, itemClassLocKey, labelFromKey, typeLabel } from '../src/catalog/labels.ts';

describe('labels', () => {
  it('derives readable names from technical keys', () => {
    assert.equal(labelFromKey('VehicleComponentS1'), 'Vehicle Component S1');
    assert.equal(labelFromKey('FPSArmours'), 'FPS Armours');
    assert.equal(labelFromKey('RefiningExample1'), 'Refining Example 1');
    assert.equal(labelFromKey('Medical'), 'Medical');
    assert.equal(labelFromKey('some_key'), 'some key');
  });

  it('groups blueprint categories without their size and builds the loc key', () => {
    assert.equal(blueprintCategoryGroup('VehicleWeaponsS3'), 'VehicleWeapons');
    assert.equal(blueprintCategoryGroup('VehicleComponentS0'), 'VehicleComponent');
    assert.equal(blueprintCategoryGroup('FPSArmours'), 'FPSArmours');
    assert.equal(blueprintCategoryGroup('Example1'), 'Example1');
    assert.equal(blueprintCategoryLocKey('VehicleWeapons'), 'qm_blueprint_category_vehicleweapons');
  });

  it('builds loc keys of item classes', () => {
    assert.equal(itemClassLocKey('Military'), 'qm_item_class_military');
    assert.equal(itemClassLocKey('Energy (Laser)'), 'qm_item_class_energy_laser');
  });

  it('names item types from the game text, else from the type', () => {
    assert.equal(typeLabel('Cooler', 'Kühler'), 'Kühler');
    assert.equal(typeLabel('SalvageModifier', null), 'Salvage Modifier');
    assert.equal(typeLabel('UNDEFINED', null), null);
    assert.equal(typeLabel(null, null), null);
  });
});
