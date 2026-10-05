import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatAmount, parseAmount } from '../src/stock/amount.ts';

describe('stock amounts', () => {
  it('accepts SCU with point or comma and normalizes', () => {
    assert.equal(parseAmount('12,5', 'resource'), '12.5');
    assert.equal(parseAmount(' 0.046 ', 'resource'), '0.046');
    assert.equal(parseAmount('007.500', 'resource'), '7.5');
    assert.equal(parseAmount('99999999.999999', 'resource'), '99999999.999999');
  });

  it('refuses zero, negatives, junk, too many digits and fractional pieces', () => {
    for (const bad of ['0', '0,000', '-1', '1e3', '1.2.3', '', 'abc', '0.0000001', '100000000']) {
      assert.equal(parseAmount(bad, 'resource'), null, bad);
    }
    assert.equal(parseAmount('3', 'item'), '3');
    assert.equal(parseAmount('3.0', 'item'), '3');
    assert.equal(parseAmount('3.5', 'item'), null);
  });

  it('formats NUMERIC text without trailing zeros', () => {
    assert.equal(formatAmount('12.500000'), '12.5');
    assert.equal(formatAmount('-3.000000'), '-3');
    assert.equal(formatAmount('7'), '7');
  });
});
