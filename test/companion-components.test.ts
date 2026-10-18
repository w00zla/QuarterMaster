// The companion app's ship component scan (companion/src/components.ts): tooltips of the character
// inventory as the OCR delivers them (as in the user's screenshots of 2026-10-18) turned into
// sightings with converted stats and into proposals, one per tile.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CatalogResponse, CatalogStat } from '../src/webapp/api-types.ts';
import {
  addRequest, buildComponentCatalog, ComponentScan, findComponents, parseField, parseNumber, proposalsOf, sightingOf, statFromTooltip, statNameKeys, statsOf,
  type ComponentCatalog, type ComponentRead,
} from '../companion/src/components.ts';

const BLIZZARD = '00000000-0000-4000-8000-000000000001';
const BLIZZARD_S2 = '00000000-0000-4000-8000-000000000002';
const SOVEREIGN = '00000000-0000-4000-8000-000000000003';
const ATLAS = '00000000-0000-4000-8000-000000000004';
// A record sharing the Blizzard's name, size and grade without a blueprint (a ship-fitted variant)
const BLIZZARD_VARIANT = '00000000-0000-4000-8000-000000000005';
const COOLANT = '00000000-0000-4000-8000-0000000000a1';
const HEALTH = '00000000-0000-4000-8000-0000000000a2';
const PIPS = '00000000-0000-4000-8000-0000000000a3';
const SPEED = '00000000-0000-4000-8000-0000000000a4';
const LOC = '00000000-0000-4000-8000-0000000000c1';

const stat = (uuid: string, name: string, base: number | null, kind: CatalogStat['kind'] = 'multiplier', max = 20): CatalogStat =>
  ({ uuid, name, nameKey: `statname_${name.toLowerCase().replace(/\W/g, '')}`, kind, min: 0, max, base });
const coolant = (base: number) => stat(COOLANT, 'Coolant Rating', base, 'multiplier', 20.8);
const health = (base: number) => stat(HEALTH, 'Integrity', base);

const material = (uuid: string, name: string, size: number, gradeLetter: string, stats: CatalogStat[]): CatalogResponse['materials'][number] => ({
  uuid, kind: 'item', name, nameKey: `item_name_${name.toLowerCase()}`, unit: 'pcs', type: 'Cooler', typeLabel: 'Cooler', component: true,
  label: `${name} · Cooler · S${size} · ${gradeLetter} Military`, size, gradeLetter, itemClass: 'Military', stats,
});

function responses(): CatalogResponse[] {
  const en: CatalogResponse['materials'] = [
    material(BLIZZARD, 'Blizzard', 3, 'A', [coolant(60), health(1800)]),
    material(BLIZZARD_S2, 'Blizzard', 2, 'A', [coolant(40), health(1200)]),
    material(BLIZZARD_VARIANT, 'Blizzard', 3, 'A', []),
    material(SOVEREIGN, 'Sovereign IP-10', 1, 'B', [stat(PIPS, 'Power Pips', 16, 'additive', 2), health(400)]),
    material(ATLAS, 'Atlas', 1, 'A', [stat(SPEED, 'Quantum Speed', 259.0545), health(200)]),
    // A resource: never a component
    { uuid: '00000000-0000-4000-8000-0000000000f1', kind: 'resource', name: 'Blizzard', nameKey: null, unit: 'SCU', type: null, typeLabel: null, component: false, label: 'Blizzard', size: null, gradeLetter: null, itemClass: null, stats: [] },
  ];
  const de = en.map((m) => ({ ...m, stats: m.stats.map((s) => ({ ...s, name: s.uuid === COOLANT ? 'Kühlleistung' : s.uuid === HEALTH ? 'Integrität' : s.name })) }));
  const base = { locations: [], blueprints: [], blueprintTypes: [], itemTypes: [] } as unknown as Omit<CatalogResponse, 'materials'>;
  return [{ ...base, materials: en }, { ...base, materials: de }];
}

const catalog = (gameNames: Record<string, string> = {}): ComponentCatalog => buildComponentCatalog(responses(), gameNames);

const rect = { x0: 0, y0: 0, x1: 10, y1: 10 };
const read = (title: string | null, lines: string[] = [], cell: { row: number; col: number; span?: number } | null = { row: 1, col: 2 }, page = 2): ComponentRead =>
  ({ tooltip: title ? { title, lines: lines.map((text) => ({ text, rect })), rect } : null, page: { index: page, total: 3 }, cell: cell && { span: 1, ...cell, rect } });

const BLIZZARD_LINES = ['Volume: 756000 µSCU', 'Item Type: Cooler', 'Manufacturer: Aegis Dynamics', 'Size: 3', 'Grade: A', 'Class: Military',
  'Navy mechanics worked with Aegis engineers to', 'ensure the Blizzard met their specific needs.', 'Coolant Rating: 60.00', 'Integrity: 1800.00'];

describe('catalog', () => {
  it('collects the components with their names in every language and the pack, and the stat names', () => {
    const cat = catalog({ item_name_blizzard: 'Schneesturm', statname_coolantrating: 'Coolant Output' });
    assert.equal(cat.components.length, 5);
    const blizzard = cat.components.find((c) => c.uuid === BLIZZARD)!;
    assert.deepEqual([...blizzard.names].sort(), ['BLIZZARD', 'SCHNEESTURM']);
    assert.deepEqual([...cat.statNames.get(COOLANT)!].sort(), ['COOLANTOUTPUT', 'COOLANTRATING', 'KÜHLLEISTUNG']);
    assert.deepEqual(statNameKeys(responses()).sort(), ['statname_coolantrating', 'statname_integrity', 'statname_powerpips', 'statname_quantumspeed']);
  });

  it('finds a component by its title, the prefix narrowing size and grade', () => {
    const cat = catalog();
    assert.deepEqual(findComponents(cat, 'Mil/3/A Blizzard').map((c) => c.uuid), [BLIZZARD], 'the craftable one among the S3 A variants');
    assert.deepEqual(findComponents(cat, 'Mil/3/ABlizzard').map((c) => c.uuid), [BLIZZARD], 'the OCR dropped the space');
    assert.deepEqual(findComponents(cat, 'Mil/2/A Blizzard').map((c) => c.uuid), [BLIZZARD_S2]);
    assert.equal(findComponents(cat, 'Blizzard').length, 2, 'without a prefix both craftable sizes stay');
    assert.deepEqual(findComponents(cat, 'Mil/1/B Sovereign IP-10').map((c) => c.uuid), [SOVEREIGN]);
    assert.deepEqual(findComponents(cat, 'Sovereign IP-10').map((c) => c.uuid), [SOVEREIGN]);
    assert.deepEqual(findComponents(cat, 'Mil/3/A Frostbite'), []);
    // An unknown size and grade keep every hit of the name
    assert.equal(findComponents(cat, 'Mil/9/Z Blizzard').length, 2);
  });
});

describe('tooltip lines', () => {
  it('splits label and value, with and without the colon', () => {
    assert.deepEqual(parseField('Coolant Rating: 60.00'), { label: 'Coolant Rating', value: '60.00' });
    assert.deepEqual(parseField('Quantum Speed: 259.05 Mm/s'), { label: 'Quantum Speed', value: '259.05 Mm/s' });
    assert.deepEqual(parseField('Integrity 1800.00'), { label: 'Integrity', value: '1800.00' });
    assert.deepEqual(parseField('Item Type; Cooler'), { label: 'Item Type', value: 'Cooler' });
    assert.equal(parseField('ensure the Blizzard met their specific needs.'), null);
    assert.equal(parseField('Registered To You'), null);
    assert.equal(parseNumber('259.05 Mm/s'), 259.05);
    assert.equal(parseNumber('1,800.00'), 1800);
    assert.equal(parseNumber('7.55 per Km'), 7.55);
    assert.equal(parseNumber('Mm/s'), null);
  });

  it('turns an absolute value into the gain over the base', () => {
    assert.equal(statFromTooltip(coolant(60), '60.00'), '0');
    assert.equal(statFromTooltip(coolant(60), '67.50'), '12.5');
    assert.equal(statFromTooltip(coolant(22), '23.60'), '7.3');
    assert.equal(statFromTooltip(stat(SPEED, 'Quantum Speed', 259.0545), '259.05 Mm/s'), '0', 'rounding below the base is no loss');
    assert.equal(statFromTooltip(coolant(60), '58.00'), null, 'below the base');
    assert.equal(statFromTooltip(coolant(60), '80.00'), null, 'beyond the blueprint');
    assert.equal(statFromTooltip(coolant(60), '6O.00'), null, 'no number');
    assert.equal(statFromTooltip(coolant(60), '0'), null);
    assert.equal(statFromTooltip(stat(COOLANT, 'Coolant Rating', null), '60.00'), null, 'no base known');
    assert.equal(statFromTooltip(stat(PIPS, 'Power Pips', 16, 'additive', 2), '17'), '1');
    assert.equal(statFromTooltip(stat(PIPS, 'Power Pips', 16, 'additive', 2), '16'), '0');
    assert.equal(statFromTooltip(stat(PIPS, 'Power Pips', 16, 'additive', 2), '19'), null);
  });

  it('reads the stats of a component off its lines in any language, ignoring the rest', () => {
    const cat = catalog();
    const blizzard = cat.components.find((c) => c.uuid === BLIZZARD)!;
    // An unmodified component: both stats read, no gain
    assert.deepEqual(statsOf(blizzard, BLIZZARD_LINES, cat), { stats: {}, read: [COOLANT, HEALTH], unreadable: [] });
    assert.deepEqual(statsOf(blizzard, ['Item Type: Cooler', 'Kühlleistung: 67.50', 'Integrität: 1836.00'], cat), { stats: { [COOLANT]: '12.5', [HEALTH]: '2' }, read: [COOLANT, HEALTH], unreadable: [] });
    assert.deepEqual(statsOf(blizzard, ['Coolant Rating: 67.50', 'Integrity: 1B00.00'], cat), { stats: { [COOLANT]: '12.5' }, read: [COOLANT], unreadable: ['Integrity'] });
    assert.deepEqual(statsOf(blizzard, ['Registered To You'], cat), { stats: {}, read: [], unreadable: [] }, 'no stat lines: an item without stats');
  });
});

describe('sightings', () => {
  it('a component with the gains read, keyed by page, row, units and content', () => {
    const s = sightingOf(1, read('Mil/3/A Blizzard', ['Item Type: Cooler', 'Coolant Rating: 67.50', 'Integrity: 1800.00']), catalog());
    assert.deepEqual([s?.componentUuid, s?.stats, s?.page, s?.row, s?.col, s?.problem, s?.label], [BLIZZARD, { [COOLANT]: '12.5' }, 2, 1, 2, null, 'Blizzard · Cooler · S3 · A Military']);
    assert.equal(s?.key, `2|1|2|1|${BLIZZARD}|{"${COOLANT}":"12.5"}`);
    const looted = sightingOf(1, read('Mil/3/A Blizzard', BLIZZARD_LINES), catalog());
    assert.deepEqual([looted?.stats, looted?.readStats, looted?.problem], [{}, [COOLANT, HEALTH], null]);
  });

  it('names what keeps a sighting from a proposal', () => {
    const cat = catalog();
    assert.equal(sightingOf(1, read('Mil/3/A Frostbite', ['Item Type: Cooler']), cat)?.problem, 'unknownComponent');
    assert.equal(sightingOf(1, read('Blizzard', ['Item Type: Cooler']), cat)?.problem, 'ambiguousComponent');
    const bad = sightingOf(1, read('Mil/3/A Blizzard', ['Coolant Rating: 80.00', 'Integrity: 1800.00']), cat);
    assert.deepEqual([bad?.problem, bad?.unreadable, bad?.stats], ['statsUnreadable', ['Coolant Rating'], null]);
    assert.equal(sightingOf(1, read('Mil/3/A Blizzard', BLIZZARD_LINES, null), cat), null, 'no cell under the cursor');
    assert.equal(sightingOf(1, read(null), cat), null);
  });

  it('counts a component on a tile it stayed on, after two agreeing reads, by tile and content', () => {
    const cat = catalog();
    const scan = new ComponentScan();
    const blizzard = ['Coolant Rating: 67.50'];
    assert.equal(scan.feed(1, read('Mil/3/A Blizzard', blizzard), cat), null, 'the cursor just came to the tile');
    assert.equal(scan.feed(2, read('Mil/3/A Blizzard', blizzard), cat), null, 'first read waits');
    // A glitch in between starts over (a trailing letter is a unit, so the number must break)
    assert.equal(scan.feed(3, read('Mil/3/A Blizzard', ['Coolant Rating: 6Z.50']), cat), null);
    assert.equal(scan.feed(4, read('Mil/3/A Blizzard', blizzard), cat), null);
    assert.ok(scan.feed(5, read('Mil/3/A Blizzard', blizzard), cat));
    assert.equal(scan.feed(6, read('Mil/3/A Blizzard', blizzard), cat), null, 'known');
    // The same component on the tile below, beside it, and on the next page: sightings of their own
    for (const [at, cell, page] of [[7, { row: 2, col: 2 }, 2], [10, { row: 1, col: 3 }, 2], [13, { row: 1, col: 2 }, 3]] as const) {
      assert.equal(scan.feed(at, read('Mil/3/A Blizzard', blizzard, cell, page), cat), null, 'arrived');
      scan.feed(at + 1, read('Mil/3/A Blizzard', blizzard, cell, page), cat);
      assert.ok(scan.feed(at + 2, read('Mil/3/A Blizzard', blizzard, cell, page), cat));
    }
    assert.equal(scan.sightings.size, 4);
    // Back on the first tile (as after a scroll: the Rust side counts the scroll into the row): known
    scan.feed(16, read('Mil/3/A Blizzard', blizzard), cat);
    scan.feed(17, read('Mil/3/A Blizzard', blizzard), cat);
    assert.equal(scan.feed(18, read('Mil/3/A Blizzard', blizzard), cat), null);
    assert.equal(scan.sightings.size, 4);
    // The previous tile's tooltip, still shown for a read after the cursor moved on to a wide tile,
    // counts nowhere; the wide tile's own does
    const left = { row: 5, col: 0, span: 2 };
    const right = { row: 5, col: 2, span: 2 };
    scan.feed(19, read('Mil/3/A Frostbite', ['Item Type: Cooler'], left), cat);
    scan.feed(20, read('Mil/3/A Frostbite', ['Item Type: Cooler'], left), cat);
    assert.equal(scan.feed(21, read('Mil/3/A Frostbite', ['Item Type: Cooler'], right), cat), null);
    scan.feed(22, read('Mil/3/A Blizzard', blizzard, right), cat);
    assert.ok(scan.feed(23, read('Mil/3/A Blizzard', blizzard, right), cat));
    assert.equal(scan.list().filter((s) => s.row === 5).map((s) => `${s.title} ${s.col}`).join(), 'Mil/3/A Blizzard 2');
    // A filter turns a sighting down before it is counted
    for (let at = 24; at < 27; at++) assert.equal(scan.feed(at, read('Mil/1/B Sovereign IP-10', ['Power Pips: 17'], { row: 0, col: 0 }), cat, () => false), null);
    assert.equal(scan.sightings.size, 5);
    assert.equal(scan.list()[0]?.atMs, 23);
    scan.clear();
    assert.equal(scan.sightings.size, 0);
  });
});

describe('proposals', () => {
  it('one per complete sighting, one piece each, stats only when there are any', () => {
    const cat = catalog();
    const scan = new ComponentScan();
    // Three reads each: the cursor arrives, then two agreeing reads
    for (let i = 0; i < 3; i++) scan.feed(i, read('Mil/3/A Blizzard', ['Coolant Rating: 67.50', 'Integrity: 1836.00']), cat);
    for (let i = 3; i < 6; i++) scan.feed(i, read('Mil/3/A Blizzard', BLIZZARD_LINES, { row: 2, col: 0 }), cat);
    for (let i = 6; i < 9; i++) scan.feed(i, read('Mil/3/A Frostbite', ['Item Type: Cooler'], { row: 2, col: 1 }), cat);
    const proposals = proposalsOf(scan.list());
    assert.deepEqual(proposals.map((p) => [p.componentUuid, p.stats, p.readStats]), [[BLIZZARD, {}, [COOLANT, HEALTH]], [BLIZZARD, { [COOLANT]: '12.5', [HEALTH]: '2' }, [COOLANT, HEALTH]]]);
    assert.deepEqual(addRequest(proposals[1]!, LOC, ['9400']), { subjectUuid: BLIZZARD, locationUuid: LOC, quality: 0, amount: '1', stats: { [COOLANT]: '12.5', [HEALTH]: '2' }, guildIds: ['9400'] });
    assert.deepEqual(addRequest(proposals[0]!, LOC), { subjectUuid: BLIZZARD, locationUuid: LOC, quality: 0, amount: '1' });
  });
});
