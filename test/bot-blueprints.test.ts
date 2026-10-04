import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLabels, searchBlueprints, type BlueprintEntry } from '../src/bot/blueprints.ts';
import { listPage } from '../src/bot/commands/blueprints.ts';

let n = 0;
const entry = (over: Partial<BlueprintEntry>): Omit<BlueprintEntry, 'label'> => ({
  uuid: `u${++n}`, key: `BP_CRAFT_k${n}`, name: 'Thing', nameEn: 'Thing', size: null, gradeLetter: null, itemClass: null,
  manufacturerCode: null, isDefault: false, retired: false, categoryLabel: 'Armor', ...over,
});

describe('blueprint labels', () => {
  it('joins name, size, grade + class and manufacturer', () => {
    const [e] = buildLabels([entry({ name: 'BroadSpec', size: 3, gradeLetter: 'B', itemClass: 'Industrial', manufacturerCode: 'CHCO' })]);
    assert.equal(e!.label, 'BroadSpec · S3 · B Industrial · CHCO');
    assert.equal(buildLabels([entry({ name: 'Plain' })])[0]!.label, 'Plain');
  });

  it('tells colliding labels apart by the differing tokens of the blueprint key', () => {
    const labels = buildLabels([
      entry({ name: 'Serac', size: 4, key: 'BP_CRAFT_COOL_ORIG_S04_890J_SCItem' }),
      entry({ name: 'Serac', size: 4, key: 'BP_CRAFT_COOL_RSI_S04_Polaris_SCItem' }),
      entry({ name: 'Serac', size: 3, key: 'BP_CRAFT_COOL_X_S03' }),
    ]).map((e) => e.label);
    assert.deepEqual(labels, ['Serac · S4 · ORIG 890J', 'Serac · S4 · RSI Polaris', 'Serac · S3']);
  });

  it('keeps labels within Discord limits', () => {
    assert.equal(buildLabels([entry({ name: 'x'.repeat(150) })])[0]!.label.length, 100);
  });
});

describe('blueprint search', () => {
  const entries = buildLabels([
    entry({ name: 'Glacis', nameEn: 'Glacis', size: 4 }),
    entry({ name: 'Argus Helm', nameEn: 'Argus Helmet', manufacturerCode: 'VGL' }),
    entry({ name: 'Helm Zwei', nameEn: 'Helmet Two', manufacturerCode: 'VGL' }),
  ]);

  it('needs every word, in the label or the English name', () => {
    assert.deepEqual(searchBlueprints(entries, 'helmet vgl').map((e) => e.name), ['Helm Zwei', 'Argus Helm']);
    assert.deepEqual(searchBlueprints(entries, 'glacis s4').map((e) => e.name), ['Glacis']);
    assert.deepEqual(searchBlueprints(entries, 'nothing'), []);
  });

  it('ranks names starting with the first word first, then alphabetical, and limits', () => {
    assert.deepEqual(searchBlueprints(entries, 'helm').map((e) => e.name), ['Helm Zwei', 'Argus Helm']);
    assert.equal(searchBlueprints(entries, '', 2).length, 2);
  });
});

describe('/qm-bp list page', () => {
  const many = buildLabels([
    ...Array.from({ length: 25 }, (_, i) => entry({ name: `Armor ${String(i).padStart(2, '0')}`, categoryLabel: 'Armor' })),
    entry({ name: 'Mystery', categoryLabel: null }),
    entry({ name: 'Cannon', categoryLabel: 'Weapons', retired: true }),
  ]);

  it('groups by category with "other" last and repeats the group header on each page', () => {
    const p1 = listPage(many, 'Hans', '1', 0, 'en');
    assert.match(p1.content, /^\*\*Blueprints of Hans\*\* \(27\)\n__Armor__\n- Armor 00/);
    assert.match(p1.content, /Page 1 of 2/);
    const p2 = listPage(many, 'Hans', '1', 1, 'en').content;
    assert.match(p2, /__Armor__\n- Armor 20/);
    assert.ok(p2.indexOf('__Weapons__') < p2.indexOf('__Other__'));
    assert.match(p2, /- Cannon ⚠️ \*no longer in the game\*/);
  });

  it('pages with buttons that know the owner and the target page', () => {
    const ids = listPage(many, 'Hans', '42', 1, 'de').components[0]!.toJSON().components
      .map((c) => [(c as { custom_id: string }).custom_id, (c as { disabled?: boolean }).disabled]);
    assert.deepEqual(ids, [['qm-bp:list:42:0', false], ['qm-bp:list:42:2', true]]);
    assert.deepEqual(listPage(many.slice(0, 3), 'Hans', '42', 0, 'en').components, []);
  });

  it('says so when nothing is registered and escapes names', () => {
    assert.equal(listPage([], 'Ha_ns', '1', 0, 'de').content, 'Ha\\_ns hat noch keine Blueprints registriert.');
  });
});
