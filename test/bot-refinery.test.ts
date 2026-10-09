import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { doneText, formatDuration, parseDoneText, parseDuration, parseOreLines, resolveOre } from '../src/bot/refinery-lines.ts';
import { addOreName, type OreCatalog } from '../src/stock/ore-names.ts';

// Ore names in both languages, as the catalog has them
const cat: OreCatalog = { ores: new Map(), oreParts: [] };
const ORES = {
  quantanium: ['Quantanium (Raw)', 'Quantanium (Roh)'],
  laranite: ['Laranite (Ore)', 'Laranit (Erz)'],
  heph: ['Hephaestanite (Raw)', 'Hephaestanit (Roh)'],
  hephOre: ['Hephaestanite (Ore)', 'Hephaestanit (Erz)'],
  ice: ['Raw Ice', 'Roheis'],
  silicon: ['Raw Silicon', 'Silizium (Roh)'],
};
for (const [uuid, names] of Object.entries(ORES)) for (const n of names) addOreName(cat, n, uuid);

describe('refinery duration', () => {
  it('reads hours, minutes, seconds, days and plain minutes', () => {
    assert.equal(parseDuration('2h 30m'), 9000);
    assert.equal(parseDuration('2h30m'), 9000);
    assert.equal(parseDuration('45m'), 2700);
    assert.equal(parseDuration('2H'), 7200);
    assert.equal(parseDuration('41m 20s'), 2480);
    assert.equal(parseDuration('1d 2h'), 93600);
    assert.equal(parseDuration(' 150 '), 9000);
  });

  it('refuses anything else', () => {
    for (const bad of ['', '0', '0m', 'abc', '2h 3h', '2 h 30', '2,5h', '-5m', '2h foo']) assert.equal(parseDuration(bad), null, bad);
  });

  it('formats the largest two units', () => {
    assert.equal(formatDuration(9660), '2h 41m');
    assert.equal(formatDuration(2700), '45m');
    assert.equal(formatDuration(93600), '1d 2h');
    assert.equal(formatDuration(7205), '2h');
    assert.equal(formatDuration(20), '20s');
  });
});

describe('refinery ore lines', () => {
  it('resolves names in both languages, abbreviations and qualifiers', () => {
    assert.equal(resolveOre(cat, 'Quantanium (Raw)'), 'quantanium');
    assert.equal(resolveOre(cat, 'quanta'), 'quantanium');
    assert.equal(resolveOre(cat, 'Laranit (Erz)'), 'laranite');
    assert.equal(resolveOre(cat, 'HEPH (RAW)'), 'heph');
    assert.equal(resolveOre(cat, 'heph raw'), 'heph');
    assert.equal(resolveOre(cat, 'heph ore'), 'hephOre');
    assert.equal(resolveOre(cat, 'raw ice'), 'ice');
    // Two ores fit
    assert.equal(resolveOre(cat, 'heph'), null);
    assert.equal(resolveOre(cat, 'gold'), null);
  });

  it('reads name, quality, amount and an optional yield from the right', () => {
    const r = parseOreLines('quanta 820 12,5\n\n  Laranite (Ore)  Q610 40 SCU 18.2\nheph raw 550 8', cat, 30);
    assert.deepEqual(r.errors, []);
    assert.equal(r.tooMany, false);
    assert.deepEqual(r.rows.map(({ text: _t, ...x }) => x), [
      { line: 1, oreUuid: 'quantanium', quality: 820, amount: '12.5' },
      { line: 3, oreUuid: 'laranite', quality: 610, amount: '40', expectedYield: '18.2' },
      { line: 4, oreUuid: 'heph', quality: 550, amount: '8' },
    ]);
  });

  it('accepts a yield of 0 and names the error of each bad line', () => {
    const r = parseOreLines([
      'raw ice 300 20 0',
      'quanta 820',
      'quanta 1200 5',
      'quanta 820 0',
      'quanta 820 5 x',
      'heph 550 8',
      '820 12',
      'gold 500 3',
    ].join('\n'), cat, 30);
    assert.deepEqual(r.rows.map((x) => [x.oreUuid, x.expectedYield]), [['ice', '0']]);
    assert.deepEqual(r.errors.map((e) => [e.line, e.error]), [[2, 'format'], [3, 'quality'], [4, 'amount'], [5, 'format'], [6, 'ore'], [7, 'format'], [8, 'ore']]);
  });

  it('flags more rows than a work order takes', () => {
    assert.equal(parseOreLines('quanta 820 1\nquanta 800 1\nquanta 700 1', cat, 2).tooMany, true);
  });
});

describe('refinery done lines', () => {
  const rows = [
    { name: 'Quantanium', quality: 820, expected: '5.69' },
    { name: 'Hephaestanite (R)', quality: 550, expected: null },
  ];

  it('prefills one line per ore and reads the amounts back', () => {
    const text = doneText(rows);
    assert.equal(text, 'Quantanium 820: 5.69\nHephaestanite (R) 550:');
    assert.deepEqual(parseDoneText(text.replace('550:', '550: 3,6'), rows), { amounts: ['5.69', '3.6'] });
    assert.deepEqual(parseDoneText('quantanium 820:0\n\nHephaestanite (R) 550 : 1', rows), { amounts: ['0', '1'] });
  });

  it('refuses changed, missing or reordered lines and missing amounts', () => {
    assert.deepEqual(parseDoneText('Quantanium 820: 5', rows), { error: 'lines' });
    assert.deepEqual(parseDoneText('Hephaestanite (R) 550: 1\nQuantanium 820: 5', rows), { error: 'mismatch', line: 1 });
    assert.deepEqual(parseDoneText('Quantanium 821: 5\nHephaestanite (R) 550: 1', rows), { error: 'mismatch', line: 1 });
    assert.deepEqual(parseDoneText(doneText(rows), rows), { error: 'yield', line: 2 });
    assert.deepEqual(parseDoneText('Quantanium 820: abc\nHephaestanite (R) 550: 1', rows), { error: 'yield', line: 1 });
  });
});
