// The companion app's gear scan (src/components.ts): tooltips of the character
// inventory as the OCR delivers them (as in the user's screenshots of 2026-10-18) turned into
// sightings with converted stats and into proposals, one per tile; FPS gear and stacks as of 2026-10-22.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CatalogStat, CompanionCatalogResponse, StockBatch } from '../src/apiTypes.ts';
import {
  addRequest, buildComponentCatalog, ComponentScan, findComponents, inStockOf, parseField, parseNumber, proposalsOf, SETTLED_MS, sightingOf, statFromTooltip, statNameKeys, statsOf,
  type ComponentCatalog, type ComponentProposal, type ComponentRead,
} from '../src/components.ts';

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
  ({ uuid, name, nameKey: `statname_${name.toLowerCase().replace(/\W/g, '')}`, kind, min: 0, max, base, tooltip: 'value' });
const coolant = (base: number) => stat(COOLANT, 'Coolant Rating', base, 'multiplier', 20.8);
const health = (base: number) => stat(HEALTH, 'Integrity', base);

const material = (uuid: string, name: string, size: number, gradeLetter: string, stats: CatalogStat[]): CompanionCatalogResponse['materials'][number] => ({
  uuid, kind: 'item', name, nameKey: `item_name_${name.toLowerCase()}`, type: 'Cooler', typeLabel: 'Cooler', component: true,
  label: `${name} · Cooler · S${size} · ${gradeLetter} Military`, size, gradeLetter, stats, thumb: null,
});

function responses(): CompanionCatalogResponse[] {
  const en: CompanionCatalogResponse['materials'] = [
    material(BLIZZARD, 'Blizzard', 3, 'A', [coolant(60), health(1800)]),
    material(BLIZZARD_S2, 'Blizzard', 2, 'A', [coolant(40), health(1200)]),
    material(BLIZZARD_VARIANT, 'Blizzard', 3, 'A', []),
    material(SOVEREIGN, 'Sovereign IP-10', 1, 'B', [stat(PIPS, 'Power Pips', 16, 'additive', 2), health(400)]),
    material(ATLAS, 'Atlas', 1, 'A', [stat(SPEED, 'Quantum Speed', 259.0545), health(200)]),
    // A resource: never a component
    { uuid: '00000000-0000-4000-8000-0000000000f1', kind: 'resource', name: 'Blizzard', nameKey: null, type: null, typeLabel: null, component: false, label: 'Blizzard', size: null, gradeLetter: null, stats: [], thumb: null },
  ];
  const de = en.map((m) => ({ ...m, stats: m.stats.map((s) => ({ ...s, name: s.uuid === COOLANT ? 'Kühlleistung' : s.uuid === HEALTH ? 'Integrität' : s.name })) }));
  const base: Omit<CompanionCatalogResponse, 'materials'> = { locations: [], blueprints: [] };
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
    assert.deepEqual(findComponents(cat, 'Mil/3/a Blizzard').map((c) => c.uuid), [BLIZZARD], 'the grade read in lower case');
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

  it('mirrors a stat whose improvement is a drop (quantum fuel burn): lower is the gain', () => {
    const fuel = { ...stat(SPEED, 'Quantum Fuel Burn', 7.55), min: -20, max: 0 };
    assert.equal(statFromTooltip(fuel, '7.55 per Km'), '0');
    assert.equal(statFromTooltip(fuel, '6.80 per Km'), '-9.9');
    assert.equal(statFromTooltip(fuel, '8.00 per Km'), null, 'worse than the base');
    assert.equal(statFromTooltip(fuel, '5.00 per Km'), null, 'beyond the blueprint');
  });

  it('reads the stats of a component off its lines in any language, ignoring the rest', () => {
    const cat = catalog();
    const blizzard = cat.components.find((c) => c.uuid === BLIZZARD)!;
    // An unmodified component: both stats read, no gain
    assert.deepEqual(statsOf(blizzard, BLIZZARD_LINES, cat), { stats: {}, read: [COOLANT, HEALTH], unreadable: [] });
    assert.deepEqual(statsOf(blizzard, ['Item Type: Cooler', 'Kühlleistung: 67.50', 'Integrität: 1836.00'], cat), { stats: { [COOLANT]: '12.5', [HEALTH]: '2' }, read: [COOLANT, HEALTH], unreadable: [] });
    assert.deepEqual(statsOf(blizzard, ['Coolant Rating: 67.50', 'Integrity: 1B00.00'], cat), { stats: { [COOLANT]: '12.5' }, read: [COOLANT], unreadable: ['Integrity'] });
    // Accents the OCR added (PP-OCRv6 tiny), and the umlauts it dropped
    assert.deepEqual(statsOf(blizzard, ['Coolant Ratìng: 67.50', 'Integritat: 1836.00'], cat).read, [COOLANT, HEALTH]);
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

  it('counts the read of a tile just come to when the cursor had rested at the grab', () => {
    const cat = catalog();
    const scan = new ComponentScan();
    const blizzard = ['Coolant Rating: 67.50'];
    const all = () => true;
    assert.equal(scan.feed(1, read('Mil/3/A Blizzard', blizzard), cat, all, SETTLED_MS - 1), null, 'not rested long enough');
    assert.equal(scan.feed(2, read('Mil/3/A Blizzard', blizzard, { row: 2, col: 0 }), cat, all, SETTLED_MS), null, 'first read waits');
    assert.ok(scan.feed(3, read('Mil/3/A Blizzard', blizzard, { row: 2, col: 0 }), cat, all, SETTLED_MS), 'two reads');
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

  it('counts the pieces the stock holds per component and stats: 5 hovered, 4 stored, one new', () => {
    const p = (id: string, stats: Record<string, string> = {}): ComponentProposal => ({ id, componentUuid: BLIZZARD, label: '', stats, readStats: [], amount: 1, fps: false });
    const batch = (quantity: string, stats: Record<string, string> | null, extra: Partial<StockBatch> = {}): StockBatch => ({
      id: 1, sharedIn: [], part: false, kind: 'item', component: true, stats, subjectUuid: BLIZZARD, material: '', locationUuid: LOC, location: '', state: 'stored',
      quality: 0, quantity, unit: 'pcs', holderUserId: 'u', holderName: null, canChange: true, refine: null, ...extra,
    });
    // Newest first, as listed
    const plain = [p('e'), p('d'), p('c'), p('b'), p('a')];
    const stock = [batch('3', null), batch('1', { [COOLANT]: '0.0' }), batch('9', null, { locationUuid: '00000000-0000-4000-8000-0000000000c2' }), batch('9', null, { canChange: false })];
    // 4 plain ones here (a "0.0" gain is none): the earliest four, e new
    assert.deepEqual([...inStockOf(plain, stock, LOC, new Set())].sort(), ['a', 'b', 'c', 'd']);
    // e registered here counts first, then the earliest: d is the new one
    assert.deepEqual([...inStockOf(plain, stock, LOC, new Set(['e']))].sort(), ['a', 'b', 'c', 'e']);
    // Other stats are another component: "12.50" stored matches "12.5" read, the second one is new
    const crafted = [p('g', { [COOLANT]: '12.5' }), p('f', { [COOLANT]: '12.5' })];
    assert.deepEqual([...inStockOf(crafted, [batch('1', { [COOLANT]: '12.50' })], LOC, new Set())], ['f']);
  });
});

// FPS gear as the user's screenshots of 2026-10-22 show it (local/screenshots/inventory 4)
describe('FPS gear', () => {
  const CQ7 = '00000000-0000-4000-8000-000000000011';
  const CANUTO = '00000000-0000-4000-8000-000000000012';
  const SION = '00000000-0000-4000-8000-000000000013';
  const [DAMAGE, FIRE_RATE, KICK, SMOOTH, MITIGATION, TEMP_MIN] = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((n) => `00000000-0000-4000-8000-0000000000${n}`) as [string, string, string, string, string, string];
  const fpsStat = (uuid: string, name: string, base: number | null, tooltip: CatalogStat['tooltip'], min: number, max: number): CatalogStat =>
    ({ uuid, name, nameKey: null, kind: 'multiplier', min, max, base, tooltip });
  const item = (uuid: string, name: string, type: string, stats: CatalogStat[]): CompanionCatalogResponse['materials'][number] => ({
    uuid, kind: 'item', name, nameKey: null, type, typeLabel: type, component: true, label: name, size: null, gradeLetter: null, stats, thumb: null,
  });
  const base: Omit<CompanionCatalogResponse, 'materials'> = { locations: [], blueprints: [] };
  const cat = buildComponentCatalog([{ ...base, materials: [
    item(CQ7, 'CQ7 Rifle', 'WeaponPersonal', [
      fpsStat(DAMAGE, 'Impact Force', null, 'change', 0, 7.5), fpsStat(FIRE_RATE, 'Fire Rate', 650, 'value', 0, 12),
      fpsStat(KICK, 'Recoil Kick', null, 'change', -36, 0), fpsStat(SMOOTH, 'Recoil Smoothness', null, 'negatedChange', -36, 0),
    ]),
    item(CANUTO, 'Artimex Arms Canuto', 'Char_Armor_Arms', [fpsStat(MITIGATION, 'Damage Mitigation', 0.3, 'value', 0, 10), fpsStat(TEMP_MIN, 'Min Temp', -61, 'value', 0, 20)]),
    item(SION, 'Sion Compensator1', 'WeaponAttachment', []),
    material(BLIZZARD, 'Blizzard', 3, 'A', [coolant(60), health(1800)]),
  ] }], {});

  it('tells FPS gear from ship components and folds the OCR\'s look-alikes in a title', () => {
    assert.deepEqual(cat.components.map((c) => c.fps), [true, true, true, false]);
    assert.deepEqual(findComponents(cat, 'Sion Compensatorl').map((c) => c.uuid), [SION], 'l for 1');
    assert.deepEqual(findComponents(cat, 'Si0n Compensator1').map((c) => c.uuid), [SION], '0 for O');
    assert.deepEqual(findComponents(cat, 'Mil/3/A BIizzard').map((c) => c.uuid), [BLIZZARD]);
    assert.deepEqual(findComponents(cat, 'Sion Cómpensatorl').map((c) => c.uuid), [SION], 'an accent added');
  });

  it('reads percent changes as they are (negated where the game negates them), absolute values over the base', () => {
    const cq7 = cat.components.find((c) => c.uuid === CQ7)!;
    // The crafted CQ7: 713.49 RPM of 650, +6.11 %, a kick factor of 0.7156 shown as -28.44 % and, negated, +28.44 %
    const lines = ['Fire Rate: 713.49 RPM', 'Impact Force: +6.11 %', 'Recoil Kick: -28.44 %', 'Recoil Smoothness: +28.44 %'];
    assert.deepEqual(statsOf(cq7, lines, cat).stats, { [DAMAGE]: '6.1', [FIRE_RATE]: '9.8', [KICK]: '-28.4', [SMOOTH]: '-28.4' });
    // Unmodified: "-0.00 %" and the base are no gain
    const plain = statsOf(cq7, ['Fire Rate: 650.00 RPM', 'Impact Force: +0.00 %', 'Recoil Kick: +0.00 %', 'Recoil Smoothness: -0.00 %'], cat);
    assert.deepEqual([plain.stats, plain.read.length, plain.unreadable], [{}, 4, []]);
    // Worse than unmodified or beyond the blueprint: not readable
    assert.equal(statFromTooltip(cq7.stats[2]!, '+5.00 %'), null);
    assert.equal(statFromTooltip(cq7.stats[0]!, '+9.00 %'), null);
    // Armor: a share and a negative temperature (a colder minimum is the gain)
    const canuto = cat.components.find((c) => c.uuid === CANUTO)!;
    assert.deepEqual(statsOf(canuto, ['Damage Mitigation: 0.30', 'Min Temp: -61.00℃'], cat), { stats: {}, read: [MITIGATION, TEMP_MIN], unreadable: [] });
    assert.deepEqual(statsOf(canuto, ['Damage Mitigation: 0.33', 'Min Temp: -67.10 ℃'], cat).stats, { [MITIGATION]: '10', [TEMP_MIN]: '10' });
  });

  it('a stack of attachments: its count on the tile, a new count on the same tile updates it, booked as that many pieces', () => {
    const scan = new ComponentScan();
    const stack = (count: number | null): ComponentRead => ({ ...read('Sion Compensatorl', ['Volume: 60 µSCU', 'Type: Ballistic Compensator', 'Attachment Point: Barrel', 'Size: 1']), cell: { row: 5, col: 1, span: 1, rect, count } });
    for (let at = 0; at < 2; at++) assert.equal(scan.feed(at, stack(2), cat), null);
    const s = scan.feed(2, stack(2), cat);
    assert.deepEqual([s?.componentUuid, s?.count, s?.fps], [SION, 2, true]);
    // One piece taken out: the same sighting, now 1 (after two agreeing reads)
    assert.equal(scan.feed(3, stack(null), cat), null);
    assert.equal(scan.feed(4, stack(null), cat)?.count, 1);
    assert.equal(scan.sightings.size, 1);
    scan.feed(5, stack(3), cat);
    scan.feed(6, stack(3), cat);
    const [p] = proposalsOf(scan.list());
    assert.deepEqual([p?.amount, p?.fps], [3, true]);
    assert.deepEqual(addRequest(p!, LOC), { subjectUuid: SION, locationUuid: LOC, quality: 0, amount: '3' });
    // 2 stored hold no stack of 3, 3 do
    const batch = (quantity: string): StockBatch => ({
      id: 1, sharedIn: [], part: false, kind: 'item', component: true, stats: null, subjectUuid: SION, material: '', locationUuid: LOC, location: '', state: 'stored',
      quality: 0, quantity, unit: 'pcs', holderUserId: 'u', holderName: null, canChange: true, refine: null,
    });
    assert.equal(inStockOf([p!], [batch('2')], LOC, new Set()).size, 0);
    assert.equal(inStockOf([p!], [batch('3')], LOC, new Set()).size, 1);
  });
});
