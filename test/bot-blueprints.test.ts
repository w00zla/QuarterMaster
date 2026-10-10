import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLabels, searchBlueprints, type BlueprintEntry } from '../src/bot/blueprints.ts';
import { MessageFlags } from 'discord.js';
import { listPage, whoPage } from '../src/bot/commands/blueprints.ts';

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

// What a panel shows: the text of its text displays, and its buttons (custom ID or URL, disabled)
type Node = { type: number; content?: string; custom_id?: string; url?: string; disabled?: boolean; components?: Node[] };
const nodes = (p: { components: { toJSON(): unknown }[] }) => {
  const all: Node[] = [];
  const walk = (n: Node) => { all.push(n); n.components?.forEach(walk); };
  p.components.forEach((c) => walk(c.toJSON() as Node));
  return all;
};
const text = (p: Parameters<typeof nodes>[0]) => nodes(p).filter((n) => n.type === 10).map((n) => n.content).join('\n');
const buttons = (p: Parameters<typeof nodes>[0]) => nodes(p).filter((n) => n.type === 2).map((n) => [n.custom_id ?? n.url, n.disabled ?? false]);

const LINK = '/blueprints?scope=personal';

describe('/qm-bp list page', () => {
  const many = buildLabels([
    ...Array.from({ length: 25 }, (_, i) => entry({ name: `Armor ${String(i).padStart(2, '0')}`, categoryLabel: 'Armor' })),
    entry({ name: 'Mystery', categoryLabel: null }),
    entry({ name: 'Cannon', categoryLabel: 'Weapons', retired: true }),
  ]);

  it('is a panel without pings', () => {
    const p = listPage(many, 'Hans', '1', 0, 'en', LINK);
    assert.equal(p.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(p.allowedMentions, { parse: [] });
  });

  it('groups by category with "other" last and repeats the group header on each page', () => {
    const p1 = text(listPage(many, 'Hans', '1', 0, 'en', LINK));
    assert.match(p1, /^\*\*Blueprints of Hans\*\* \(27\)\n__Armor__\n- Armor 00/);
    assert.match(p1, /Page 1 of 2/);
    const p2 = text(listPage(many, 'Hans', '1', 1, 'en', LINK));
    assert.match(p2, /__Armor__\n- Armor 20/);
    assert.ok(p2.indexOf('__Weapons__') < p2.indexOf('__Other__'));
    assert.match(p2, /- Cannon ⚠️ \*no longer in the game\*/);
  });

  it('pages with buttons that know the owner and the target page, plus the web app deep link', () => {
    const before = process.env.WEBAPP_ORIGIN;
    try {
      process.env.WEBAPP_ORIGIN = 'https://qm.example/';
      assert.deepEqual(buttons(listPage(many, 'Hans', '42', 1, 'de', LINK)),
        [['qm-bp:list:42:0', false], ['qm-bp:list:42:2', true], ['https://qm.example/blueprints?scope=personal', false]]);
      assert.deepEqual(buttons(listPage(many.slice(0, 3), 'Hans', '42', 0, 'en', LINK)), [['https://qm.example/blueprints?scope=personal', false]]);
      delete process.env.WEBAPP_ORIGIN;
      assert.deepEqual(buttons(listPage(many.slice(0, 3), 'Hans', '42', 0, 'en', LINK)), []);
    } finally {
      if (before === undefined) delete process.env.WEBAPP_ORIGIN;
      else process.env.WEBAPP_ORIGIN = before;
    }
  });

  it('says so when nothing is registered and escapes names', () => {
    assert.equal(text(listPage([], 'Ha_ns', '1', 0, 'de', LINK)), 'Ha\\_ns hat noch keine Blueprints registriert.');
  });
});

describe('/qm-bp who page', () => {
  const bp = { uuid: '00000000-0000-0000-0000-000000000001', label: 'Arrow_S1' };
  const names = Array.from({ length: 61 }, (_, i) => `M_${String(i).padStart(2, '0')}`);

  it('lists the names, escaped, 60 per page, with page buttons by blueprint UUID', () => {
    const before = process.env.WEBAPP_ORIGIN;
    delete process.env.WEBAPP_ORIGIN;
    try {
      const p1 = whoPage(names, bp, 0, 'en');
      assert.match(text(p1), /^\*\*Arrow\\_S1\*\*: 61 member\(s\)\nM\\_00, M\\_01/);
      assert.ok(!text(p1).includes('M\\_60'));
      assert.deepEqual(buttons(p1), [[`qm-bp:who:${bp.uuid}:-1`, true], [`qm-bp:who:${bp.uuid}:1`, false]]);
      assert.match(text(whoPage(names, bp, 5, 'en')), /M\\_60\n-# Page 2 of 2$/);
      assert.deepEqual(buttons(whoPage(names.slice(0, 2), bp, 0, 'en')), []);
    } finally {
      if (before !== undefined) process.env.WEBAPP_ORIGIN = before;
    }
  });

  it('links to the blueprint\'s crafting check in the web app', () => {
    const before = process.env.WEBAPP_ORIGIN;
    try {
      process.env.WEBAPP_ORIGIN = 'https://qm.example';
      assert.deepEqual(buttons(whoPage(names.slice(0, 2), bp, 0, 'en')), [[`https://qm.example/crafting?add=${bp.uuid}`, false]]);
    } finally {
      if (before === undefined) delete process.env.WEBAPP_ORIGIN;
      else process.env.WEBAPP_ORIGIN = before;
    }
  });
});
