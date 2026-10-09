import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listLines, parseQuality } from '../src/bot/commands/stock.ts';
import type { PickableBatch } from '../src/stock/lookup.ts';

const batch = (id: number, material: string, quality: number, quantity: string, extra: Partial<PickableBatch> = {}): PickableBatch => ({
  batch: {
    id, ownerUserId: 'me', kind: 'resource', resourceUuid: material, itemUuid: null, locationUuid: 'loc', state: 'stored', quality, quantity, lot: null,
  },
  material, location: 'Area18', holderName: null, sharedIn: [], refine: null, ...extra,
});

describe('/qm-stock input and lists', () => {
  it('takes qualities 0-1000 as typed', () => {
    assert.equal(parseQuality(' 820 '), 820);
    assert.equal(parseQuality('0'), 0);
    assert.equal(parseQuality('1000'), 1000);
    for (const bad of ['1001', '-1', '8.5', '', 'abc', '12345']) assert.equal(parseQuality(bad), null, bad);
  });

  it('groups by material with totals over all pages and marks owners per scope', () => {
    const entries = [
      batch(1, 'Copper', 700, '2.5', { sharedIn: ['g'], holderName: 'Me' }),
      batch(2, 'Copper', 600, '1'),
      batch(3, 'Gold', 900, '3', { batch: { ...batch(3, 'Gold', 900, '3').batch, ownerUserId: 'olga' }, holderName: 'Olga', sharedIn: ['g'] }),
    ];
    assert.deepEqual(listLines(entries, 'p', 'me', 0, 'en'), {
      lines: ['__Copper__ · Total: 3.5 SCU', '- Q700 · 2.5 SCU · Area18 · shared', '- Q600 · 1 SCU · Area18', '__Gold__ · Total: 3 SCU', '- Q900 · 3 SCU · Area18 · shared'],
      page: 0, pages: 1,
    });
    const all = listLines(entries, 'a', 'me', 0, 'de').lines;
    assert.equal(all[1], '- Q700 · 2.5 SCU · Area18 · Pers.');
    assert.equal(all[4], '- Q900 · 3 SCU · Area18 · Olga');
    assert.equal(listLines(entries, 'o', 'me', 0, 'en').lines[1], '- Q700 · 2.5 SCU · Area18 · Me');
  });

  it('pages by 20, repeats the material head on every page and clamps the page', () => {
    const entries = Array.from({ length: 25 }, (_, i) => batch(i, 'Copper', 1000 - i, '1'));
    const second = listLines(entries, 'p', 'me', 1, 'en');
    assert.equal(second.pages, 2);
    assert.equal(second.lines[0], '__Copper__ · Total: 25 SCU');
    assert.equal(second.lines.length, 6);
    assert.equal(listLines(entries, 'p', 'me', 9, 'en').page, 1);
    assert.deepEqual(listLines([], 'p', 'me', 0, 'en'), { lines: [], page: 0, pages: 1 });
  });
});
