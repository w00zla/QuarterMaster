import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageFlags } from 'discord.js';
import { BOARD_LINES, boardMessage, textTable, type BoardData } from '../src/bot/board.ts';

const G = '960000000000000001';
const metrics = {
  members: 12, blueprints: 87,
  resources: { kinds: 23, scu: '1284.5', locations: 6 },
  items: { kinds: 2, pieces: '38', locations: 3 },
  components: { kinds: 0, pieces: '0', locations: 0 },
};
const data = (materials: BoardData['materials']): BoardData => ({ orgName: 'Red_Hollow', subtitle: null, metrics, obtainable: 312, materials });
const resource = (i: number) => ({ kind: 'resource' as const, uuid: `r${i}`, component: false, name: `Ore_${i}`, total: String(100 - i), bestQuality: 800, holders: 2 });

type Node = {
  type: number; content?: string; custom_id?: string; url?: string; label?: string; accent_color?: number;
  components?: Node[]; accessory?: Node; media?: { url: string };
};
const nodes = (p: ReturnType<typeof boardMessage>): Node[] => {
  const out: Node[] = [];
  const walk = (n: Node) => {
    out.push(n);
    n.components?.forEach(walk);
    if (n.accessory) walk(n.accessory);
  };
  p.components.map((c) => c.toJSON() as unknown as Node).forEach(walk);
  return out;
};
const text = (p: ReturnType<typeof boardMessage>) => nodes(p).filter((n) => n.type === 10).map((n) => n.content).join('\n');
const buttons = (p: ReturnType<typeof boardMessage>) => nodes(p).filter((n) => n.type === 2).map((n) => [n.label, n.custom_id ?? n.url]);

describe('board message', () => {
  const at = new Date('2026-10-10T12:00:00Z');

  it('shows head, figures, then one section per kind with total, best quality with its level and holder count', () => {
    const p = boardMessage(data([
      resource(1),
      { kind: 'resource', uuid: 'r2', component: false, name: 'Quantanium', total: '42.5', bestQuality: 1000, holders: 1 },
      { kind: 'item', uuid: 'i1', component: false, name: 'Weapon Barrel', total: '8', bestQuality: 480, holders: 3 },
    ]), G, 'en', at);
    assert.equal(p.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(p.allowedMentions, { parse: [] });
    assert.equal(nodes(p)[0]!.accent_color, 0xe0913a);
    assert.equal(text(p), [
      '## Red\\_Hollow',
      '👥 **12** Members · 📘 **87 / 312** Blueprints\n⛏️ **1284.5 SCU** Resources · 23 kinds · 6 locations\n📦 **38 pcs** Harvestables · 2 kinds · 3 locations'
        + '\n🧰 **0 pcs** Gear · 0 kinds · 0 locations',
      '### ⛏️ Resources\n- **Ore\\_1** · 99 SCU · ★★★★ 800 · 2 holders\n- **Quantanium** · 42.5 SCU · ♛ 1000 · 1 holders',
      '### 📦 Harvestables\n- **Weapon Barrel** · 8 pcs · ◌ 480 · 3 holders',
      `-# Updated <t:${at.getTime() / 1000}:R>`,
    ].join('\n'));
  });

  it('shows ship components in a section of their own, without a quality', () => {
    const cooler = { kind: 'item' as const, uuid: 'c1', component: true, name: 'Glacier', total: '3', bestQuality: 0, holders: 2 };
    const list = text(boardMessage(data([{ kind: 'item', uuid: 'i1', component: false, name: 'Weapon Barrel', total: '8', bestQuality: 480, holders: 3 }, cooler]), G, 'de', at));
    assert.ok(list.includes('### 📦 Sammelobjekte\n- **Weapon Barrel** · 8 Stk. · ◌ 480 · 3 Halter\n### 🧰 Ausrüstung\n- **Glacier** · 3 Stk. · 2 Halter'));
    const table = text(boardMessage(data([cooler]), G, 'en', at, null, 'table'));
    assert.ok(table.includes('### 🧰 Gear\n```\nGear item   Amount   Holders\nGlacier      3 pcs   2\n```'));
  });

  it('shows the subtitle as a small line below the title', () => {
    assert.match(text(boardMessage({ ...data([]), subtitle: 'Fleet *stock*' }, G, 'en', at)), /^## Red\\_Hollow\n-# Fleet \\\*stock\\\*\n/);
  });

  it('puts the server icon next to the head when there is one', () => {
    const icon = 'https://cdn.discordapp.com/icons/1/abc.png?size=128';
    const withIcon = nodes(boardMessage(data([]), G, 'de', at, icon));
    assert.equal(withIcon.find((n) => n.type === 11)?.media?.url, icon);
    assert.ok(!nodes(boardMessage(data([]), G, 'de', at)).some((n) => n.type === 9 || n.type === 11));
  });

  it(`lists at most ${BOARD_LINES} materials per kind and counts the rest`, () => {
    const p = boardMessage(data(Array.from({ length: BOARD_LINES + 3 }, (_, i) => resource(i))), G, 'de', at);
    const lines = text(p).split('\n');
    assert.equal(lines.filter((l) => l.startsWith('- ')).length, BOARD_LINES);
    assert.ok(lines.includes('-# +3 weitere'));
    assert.ok(lines.includes('### ⛏️ Ressourcen'));
    assert.ok(!lines.includes('### 📦 Sammelobjekte'));
  });

  it('table style: figures and materials as code-block tables, amounts right-aligned, the stars last', () => {
    const p = boardMessage(data([
      { kind: 'resource', uuid: 'r1', component: false, name: 'Laranite', total: '312', bestQuality: 790, holders: 4 },
      { kind: 'resource', uuid: 'r2', component: false, name: 'Quantanium_with_`ticks`_and_a_long_name', total: '42.5', bestQuality: 1000, holders: 1 },
    ]), G, 'en', at, null, 'table');
    const t = text(p);
    assert.ok(t.includes([
      '```',
      'Members                12      Blueprints   87 / 312',
      'Resources      1284.5 SCU      Kinds        23',
      'Harvestables       38 pcs      Kinds        2',
      'Gear                0 pcs      Kinds        0',
      '```',
    ].join('\n')));
    // Names are cut, never Markdown-escaped, and cannot close the block
    assert.ok(t.includes([
      '### ⛏️ Resources',
      '```',
      'Material                   Amount   Holders   Best quality',
      'Laranite                  312 SCU         4    790 ★★★',
      "Quantanium_with_'tick…   42.5 SCU         1   1000 ♛",
      '```',
    ].join('\n')));
    assert.ok(!t.includes('📦'));
  });

  it('pads table columns, the last one as it is', () => {
    assert.equal(textTable([['a', '1', 'x'], ['bbb', '22', 'yy']], [false, true, false]), 'a      1   x\nbbb   22   yy');
  });

  it('says so when nothing is shared', () => {
    assert.match(text(boardMessage(data([]), G, 'en', at)), /Nothing shared in this org yet\./);
  });

  it('has "Show all" and, with the web app configured, deep links into the org\'s views', () => {
    const before = process.env.WEBAPP_ORIGIN;
    try {
      process.env.WEBAPP_ORIGIN = 'https://qm.example';
      assert.deepEqual(buttons(boardMessage(data([]), G, 'en', at)), [
        ['Show all', 'qm-res:org'],
        ['All gear', 'qm-gear:org'],
        ['Resources', `https://qm.example/resources?scope=${G}`],
        ['Gear', `https://qm.example/gear?scope=${G}`],
        ['Blueprints', `https://qm.example/blueprints?scope=${G}`],
      ]);
      delete process.env.WEBAPP_ORIGIN;
      assert.deepEqual(buttons(boardMessage(data([]), G, 'en', at)), [['Show all', 'qm-res:org'], ['All gear', 'qm-gear:org']]);
    } finally {
      if (before === undefined) delete process.env.WEBAPP_ORIGIN;
      else process.env.WEBAPP_ORIGIN = before;
    }
  });
});
