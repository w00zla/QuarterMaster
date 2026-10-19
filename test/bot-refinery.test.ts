import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { doneText, formatDuration, parseDoneText, parseDuration, parseMaterialLines } from '../src/bot/refinery-lines.ts';
import { addName, emptyNames, findMaterial } from '../src/stock/material-names.ts';

// Refined material names in both languages, as the catalog has them
const cat = emptyNames();
const MATERIALS = {
  quantainium: ['Quantainium', 'Quantainium'],
  laranite: ['Laranite', 'Laranit'],
  heph: ['Hephaestanite', 'Hephaestanit'],
  silicon: ['Silicon', 'Silizium'],
  tin: ['Tin', 'Zinn'],
  titanium: ['Titanium', 'Titan'],
};
for (const [uuid, names] of Object.entries(MATERIALS)) for (const n of names) addName(cat, n, uuid);

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

describe('refinery material lines', () => {
  it('resolves names in both languages, as the terminal writes them and abbreviated', () => {
    assert.equal(findMaterial(cat, 'QUANTAINIUM'), 'quantainium');
    assert.equal(findMaterial(cat, 'quanta'), 'quantainium');
    assert.equal(findMaterial(cat, 'Laranit'), 'laranite');
    assert.equal(findMaterial(cat, 'HEPHAESTANITE'), 'heph');
    // The OCR's accent on an A (the refinery terminal at 1080p, 2026-10-19)
    assert.equal(findMaterial(cat, 'HEPHAESTÁNITE'), 'heph');
    assert.equal(findMaterial(cat, 'silizium'), 'silicon');
    // An exact name wins over a longer one starting with it ("Titan" is also the start of "Titanium")
    assert.equal(findMaterial(cat, 'tin'), 'tin');
    assert.equal(findMaterial(cat, 'titan'), 'titanium');
    // Two materials fit, or none
    assert.equal(findMaterial(cat, 'ti'), null);
    assert.equal(findMaterial(cat, 'gold'), null);
    assert.equal(findMaterial(cat, ''), null);
  });

  it('reads name, quality and expected yield from the right', () => {
    const r = parseMaterialLines('quanta 820 5,69\n\n  Laranit  Q610 12.4 SCU\nHEPHAESTANITE 550 8', cat, 30);
    assert.deepEqual(r.errors, []);
    assert.equal(r.tooMany, false);
    assert.deepEqual(r.rows.map(({ text: _t, ...x }) => x), [
      { line: 1, resourceUuid: 'quantainium', quality: 820, amount: '5.69' },
      { line: 3, resourceUuid: 'laranite', quality: 610, amount: '12.4' },
      { line: 4, resourceUuid: 'heph', quality: 550, amount: '8' },
    ]);
  });

  it('names the error of each bad line', () => {
    const r = parseMaterialLines([
      'silicon 300 20',
      'quanta 820',
      'quanta 1200 5',
      'quanta 820 0',
      'quanta 820 5 x',
      'ti 550 8',
      '820 12',
      'gold 500 3',
    ].join('\n'), cat, 30);
    assert.deepEqual(r.rows.map((x) => [x.resourceUuid, x.amount]), [['silicon', '20']]);
    assert.deepEqual(r.errors.map((e) => [e.line, e.error]), [[2, 'format'], [3, 'quality'], [4, 'amount'], [5, 'format'], [6, 'material'], [7, 'format'], [8, 'material']]);
  });

  it('flags more rows than a work order takes', () => {
    assert.equal(parseMaterialLines('quanta 820 1\nquanta 800 1\nquanta 700 1', cat, 2).tooMany, true);
  });
});

describe('refinery done lines', () => {
  const rows = [
    { name: 'Quantainium', quality: 820, expected: '5.69' },
    { name: 'Hephaestanite', quality: 550, expected: null },
  ];

  it('prefills one line per material and reads the amounts back', () => {
    const text = doneText(rows);
    assert.equal(text, 'Quantainium 820: 5.69\nHephaestanite 550:');
    assert.deepEqual(parseDoneText(text.replace('550:', '550: 3,6'), rows), { amounts: ['5.69', '3.6'] });
    assert.deepEqual(parseDoneText('quantainium 820:0\n\nHephaestanite 550 : 1', rows), { amounts: ['0', '1'] });
  });

  it('refuses changed, missing or reordered lines and missing amounts', () => {
    assert.deepEqual(parseDoneText('Quantainium 820: 5', rows), { error: 'lines' });
    assert.deepEqual(parseDoneText('Hephaestanite 550: 1\nQuantainium 820: 5', rows), { error: 'mismatch', line: 1 });
    assert.deepEqual(parseDoneText('Quantainium 821: 5\nHephaestanite 550: 1', rows), { error: 'mismatch', line: 1 });
    assert.deepEqual(parseDoneText(doneText(rows), rows), { error: 'yield', line: 2 });
    assert.deepEqual(parseDoneText('Quantainium 820: abc\nHephaestanite 550: 1', rows), { error: 'yield', line: 1 });
  });
});
