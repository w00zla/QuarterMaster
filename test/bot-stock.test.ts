import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listLines, parseQuality, parseStatLines, statLines } from '../src/bot/commands/stock.ts';
import { UserError } from '../src/bot/errors.ts';
import type { ComponentStat, PickableBatch } from '../src/stock/lookup.ts';

const batch = (id: number, material: string, quality: number, quantity: string, extra: Partial<PickableBatch> = {}): PickableBatch => ({
  batch: {
    id, ownerUserId: 'me', kind: 'resource', resourceUuid: material, itemUuid: null, locationUuid: 'loc', state: 'stored', quality, quantity, lot: null, stats: null,
  },
  material, component: false, location: 'Area18', holderName: null, sharedIn: [], refine: null, ...extra,
});

describe('/qm-res input and lists', () => {
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

  it('shows components with their stats where materials show their quality', () => {
    const comp = (id: number, statsText: string) => ({
      ...batch(id, 'Glacier · Cooler · S2 · B Military', 0, '1', { component: true }), statsText,
      batch: { ...batch(id, 'x', 0, '1').batch, kind: 'item' as const, resourceUuid: null, itemUuid: 'c' },
    });
    assert.deepEqual(listLines([comp(1, 'Coolant Rating +5.0 %'), comp(2, '')], 'p', 'me', 0, 'en').lines, [
      '__Glacier · Cooler · S2 · B Military__ · Total: 2 pcs', '- Coolant Rating +5.0 % · 1 pcs · Area18', '- 1 pcs · Area18',
    ]);
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

describe('/qm-gear stats field', () => {
  const stats: ComponentStat[] = [
    { uuid: 'a', name: 'Coolant Rating', nameKey: null, base: null, kind: 'multiplier', min: 0, max: 20 },
    { uuid: 'b', name: 'Power Pips', nameKey: null, base: null, kind: 'additive', min: 0, max: 2 },
  ];
  const refused = (key: string, vars?: object) => (err: unknown) =>
    err instanceof UserError && err.key === key && (!vars || JSON.stringify(err.vars) === JSON.stringify(vars));

  it('fills one line per stat with its maximum and the current value', () => {
    assert.equal(statLines(stats, null), 'Coolant Rating (max. +20.0 %): 0\nPower Pips (max. +2): 0');
    assert.equal(statLines(stats, { a: '12.5' }), 'Coolant Rating (max. +20.0 %): 12.5\nPower Pips (max. +2): 0');
  });

  it('reads the numbers after the colons; 0 and an empty field mean none', () => {
    assert.deepEqual(parseStatLines('Coolant Rating (max. +20.0 %): 7,5 %\n\nPower Pips (max. +2): +1', stats), { a: '7.5', b: '1' });
    assert.deepEqual(parseStatLines(statLines(stats, null), stats), {});
    assert.deepEqual(parseStatLines('  \n', stats), {});
  });

  it('refuses changed lines and values out of bounds, naming the line', () => {
    assert.throws(() => parseStatLines('Coolant Rating (max. +20.0 %): 5', stats), refused('stock.err.statLines'));
    assert.throws(() => parseStatLines('Coolant (max. +20.0 %): 5\nPower Pips (max. +2): 0', stats), refused('stock.err.statLine', { line: 1 }));
    assert.throws(() => parseStatLines('Coolant Rating (max. +20.0 %): 21\nPower Pips (max. +2): 0', stats), refused('stock.err.statValue', { line: 1, min: 0, max: '20 %' }));
    assert.throws(() => parseStatLines('Coolant Rating (max. +20.0 %): 5\nPower Pips (max. +2): 1.5', stats), refused('stock.err.statValue', { line: 2, min: 0, max: '2' }));
    assert.throws(() => parseStatLines('Coolant Rating (max. +20.0 %): -5\nPower Pips (max. +2): 0', stats), refused('stock.err.statValue'));
  });

  it('shows the best of a stat whose improvement is a drop (recoil) and takes values down to it', () => {
    const recoil: ComponentStat[] = [{ uuid: 'r', name: 'Recoil Kick', nameKey: null, base: null, kind: 'multiplier', min: -40, max: 0 }];
    assert.equal(statLines(recoil, null), 'Recoil Kick (max. −40.0 %): 0');
    assert.deepEqual(parseStatLines('Recoil Kick (max. −40.0 %): -12.5', recoil), { r: '-12.5' });
    assert.throws(() => parseStatLines('Recoil Kick (max. −40.0 %): 5', recoil), refused('stock.err.statValue', { line: 1, min: -40, max: '0 %' }));
  });
});
