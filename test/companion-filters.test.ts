// The companion app's user filters (src/userFilters.ts): wildcard terms per kind against an
// item's names.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filteredBy, parseFilters, wildcard, type UserFilter } from '../companion/src/userFilters.ts';

describe('wildcard', () => {
  it('matches the whole name, case aside', () => {
    assert.ok(wildcard('quantanium').test('Quantanium'));
    assert.ok(!wildcard('Quant').test('Quantanium'));
    assert.ok(wildcard('*rifle*').test('CQ7 Rifle'));
    assert.ok(wildcard('Ind/?/B *').test('Ind/1/B Guardian'));
    assert.ok(!wildcard('Ind/?/B *').test('Ind/12/B Guardian'));
  });

  it('takes every other character literally', () => {
    assert.ok(wildcard('A.B (x)').test('a.b (X)'));
    assert.ok(!wildcard('A.B').test('AxB'));
    assert.ok(wildcard('Lärm*').test('lärmschutz'));
  });
});

describe('filteredBy', () => {
  const filters: UserFilter[] = [
    { pattern: '*Rifle*', kind: 'fps' },
    { pattern: 'Quantanium', kind: 'all' },
  ];

  it('applies a filter to its kind only', () => {
    assert.equal(filteredBy(filters, 'fps', ['CQ7 Rifle']), '*Rifle*');
    assert.equal(filteredBy(filters, 'comps', ['Rifle Cooler']), null);
  });

  it('applies "all" to every kind and an unknown kind to every filter', () => {
    assert.equal(filteredBy(filters, 'mats', ['Quantainium', 'Quantanium']), 'Quantanium');
    assert.equal(filteredBy(filters, null, ['CQ7 Rifle']), '*Rifle*');
  });

  it('is null without a match', () => {
    assert.equal(filteredBy(filters, 'fps', ['P4-AR']), null);
    assert.equal(filteredBy([], 'fps', ['CQ7 Rifle']), null);
  });
});

describe('parseFilters', () => {
  it('keeps the valid entries, trimmed', () => {
    assert.deepEqual(parseFilters([{ pattern: ' *Rifle* ', kind: 'fps' }, { pattern: '', kind: 'all' }, { pattern: 'x', kind: 'ships' }, null, 3]), [{ pattern: '*Rifle*', kind: 'fps' }]);
    assert.deepEqual(parseFilters('nope'), []);
  });
});
