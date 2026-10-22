// Where a gear stat's base comes from and how the tooltip shows it (src/stock/component-base.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { baseValue, tooltipForm } from '../src/stock/component-base.ts';

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
