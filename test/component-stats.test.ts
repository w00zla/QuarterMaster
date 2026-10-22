import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { statBest, statBounds, statValue, statValueText, unionBounds } from '../src/stock/component-stats.ts';
import type { ModifierRange } from '../src/planner/types.ts';

const linear = (lowStart: number, highEnd: number): ModifierRange[] => [
  { type: 'Linear', startQuality: 0, endQuality: 500, values: { modifierAtStart: lowStart, modifierAtEnd: 1 } },
  { type: 'Linear', startQuality: 501, endQuality: 1000, values: { modifierAtStart: 1, modifierAtEnd: highEnd } },
];
const steps = (values: number[]): ModifierRange[] => values.map((v, i) => (
  { type: 'LinearIntegerAdditive', startQuality: i * 300, endQuality: i * 300 + 299, values: { additiveModifierAtStart: v, additiveModifierAtEnd: v } }));

describe('component stat bounds', () => {
  it('multiplies the slots of a multiplier stat, as a percent gain rounded up, from no change', () => {
    // HeatSafe's coolant rating: COOLANT 0.85–1.15 and PUMP IMPELLER 0.95–1.05
    assert.deepEqual(statBounds([linear(0.85, 1.15), linear(0.95, 1.05)]), { kind: 'multiplier', min: 0, max: 20.8 });
    assert.deepEqual(statBounds([linear(0.8, 1.2)]), { kind: 'multiplier', min: 0, max: 20 });
    // A slot without a range (armor's "Panel Covering": valueRanges [null]) changes nothing
    assert.deepEqual(statBounds([linear(0.9, 1.1), []]), { kind: 'multiplier', min: 0, max: 10 });
    assert.equal(statBounds([[]]), null);
  });

  it('adds up the steps of an additive stat (power pips), from no change', () => {
    assert.deepEqual(statBounds([steps([-1, 0, 1]), steps([-1, 0, 1])]), { kind: 'additive', min: 0, max: 2 });
  });

  it('takes the improvement from Q1000: a drop for recoil and quantum fuel burn, up to no change', () => {
    // A rifle's recoil kick: 1.4 at Q0, 0.6 at Q1000
    const recoil: ModifierRange[] = [{ type: 'Linear', startQuality: 0, endQuality: 1000, values: { modifierAtStart: 1.4, modifierAtEnd: 0.6 } }];
    assert.deepEqual(statBounds([recoil]), { kind: 'multiplier', min: -40, max: 0 });
    // Quantum fuel burn: 1.2 at Q0, 0.8 at Q1000 (two ranges)
    const fuel: ModifierRange[] = [
      { type: 'Linear', startQuality: 0, endQuality: 500, values: { modifierAtStart: 1.2, modifierAtEnd: 1 } },
      { type: 'Linear', startQuality: 501, endQuality: 1000, values: { modifierAtStart: 1, modifierAtEnd: 0.8 } },
    ];
    assert.deepEqual(statBounds([fuel]), { kind: 'multiplier', min: -20, max: 0 });
    assert.equal(statBest({ kind: 'multiplier', min: -20, max: 0 }), -20);
    assert.equal(statBest({ kind: 'multiplier', min: 0, max: 20.8 }), 20.8);
    assert.equal(statValue({ kind: 'multiplier', min: -40, max: 0 }, '-12.5'), '-12.5');
    assert.equal(statValue({ kind: 'multiplier', min: -40, max: 0 }, '5'), null);
  });

  it('leaves out what nothing can improve, unknown and mixed range types', () => {
    assert.equal(statBounds([linear(1, 1)]), null);
    assert.equal(statBounds([linear(0.8, 1)]), null);
    assert.equal(statBounds([[{ type: 'Curve', startQuality: 0, endQuality: 1000, values: {} }]]), null);
    assert.equal(statBounds([[...linear(0.8, 1.2), ...steps([1])]]), null);
    assert.equal(statBounds([]), null);
  });

  it('takes the widest bounds over several blueprints of one kind', () => {
    assert.deepEqual(unionBounds([{ kind: 'multiplier', min: 0, max: 5 }, { kind: 'multiplier', min: 0, max: 20 }]),
      { kind: 'multiplier', min: 0, max: 20 });
    assert.equal(unionBounds([{ kind: 'multiplier', min: 0, max: 5 }, { kind: 'additive', min: 0, max: 1 }]), null);
  });

  it('checks and normalizes typed values', () => {
    const pct = { kind: 'multiplier' as const, min: 0, max: 20.8 };
    assert.equal(statValue(pct, '+5,0'), '5');
    assert.equal(statValue(pct, '20.8'), '20.8');
    assert.equal(statValue(pct, '-0.0'), '0');
    assert.equal(statValue(pct, '-1'), null);
    assert.equal(statValue(pct, '20.9'), null);
    assert.equal(statValue(pct, '1.25'), null);
    assert.equal(statValue(pct, 'abc'), null);
    const pips = { kind: 'additive' as const, min: 0, max: 2 };
    assert.equal(statValue(pips, '+1'), '1');
    assert.equal(statValue(pips, '1.5'), null);
    assert.equal(statValue(pips, '3'), null);
  });

  it('shows values like the crafting check', () => {
    assert.equal(statValueText('multiplier', '5'), '+5.0 %');
    assert.equal(statValueText('multiplier', '-12.5'), '−12.5 %');
    assert.equal(statValueText('additive', '1'), '+1');
    assert.equal(statValueText('additive', '0'), '±0');
  });
});
