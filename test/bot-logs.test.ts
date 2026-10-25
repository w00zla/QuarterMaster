import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { logLine, messagesOf, packSections, sectionMessage, type LogNames, type LogRow } from '../src/bot/logs.ts';

const names: LogNames = { material: () => 'Quantanium', location: (u) => (u === 'L2' ? 'Baijini Point' : 'Area18'), blueprint: () => 'Arclight' };
const row = (r: Partial<LogRow>): LogRow => ({
  id: 1, action: 'add', actorUserId: '100000000000000001', toOwnerUserId: null, guildId: null, targetKind: 'resource',
  targetUuid: 'M', details: { amount: '12.500000', quality: 820, locationUuid: 'L1' }, ...r,
});

describe('logs channel lines', () => {
  it('says who did what with how much of which batch, in the base language', () => {
    assert.equal(logLine(row({}), 'G', names, 'en'), '📥 <@100000000000000001> added **12.5 SCU** · **Quantanium** Q820 · Area18');
    assert.equal(logLine(row({ details: { amount: '2', batchAmount: '14.500000', quality: 820, locationUuid: 'L1' } }), 'G', names, 'de'),
      '📥 <@100000000000000001> bucht dazu: **2 SCU** · **Quantanium** Q820 · Area18 · jetzt 14.5 SCU');
    assert.equal(logLine(row({ action: 'share', guildId: 'G' }), 'G', names, 'de'), '📢 <@100000000000000001> teilt **12.5 SCU** · **Quantanium** Q820 · Area18');
    assert.equal(logLine(row({ action: 'move', details: { amount: '2', quality: 820, locationUuid: 'L1', toLocationUuid: 'L2' } }), 'G', names, 'en'),
      '🔀 <@100000000000000001> moved **2 SCU** · **Quantanium** Q820 · Area18 → Baijini Point');
    assert.equal(logLine(row({ action: 'adjust', details: { amount: '8', from: '10.5', quality: 820, locationUuid: 'L1' } }), 'G', names, 'en'),
      '✏️ <@100000000000000001> corrected **Quantanium** Q820 · Area18: 10.5 → 8 SCU');
    assert.equal(logLine(row({ action: 'remove', targetKind: 'item' }), 'G', names, 'de'), '📤 <@100000000000000001> entnimmt **12.5 Stk.** · **Quantanium** Q820 · Area18');
    assert.equal(logLine(row({ action: 'remove', details: { amount: '3', batchAmount: '0', quality: 820, locationUuid: 'L1' } }), 'G', names, 'en'),
      '📤 <@100000000000000001> took out **3 SCU** · **Quantanium** Q820 · Area18 · batch empty');
  });

  it('shows a component by its label with its stats instead of a quality, and a change of its stats', () => {
    const comp: LogNames = {
      ...names, material: () => 'Glacier · Cooler · S2 · B Military',
      stats: (_u, s) => (s?.p ? `Coolant Rating +${s.p}.0 %` : ''),
    };
    const base = { targetKind: 'item' as const, targetUuid: 'C' };
    assert.equal(logLine(row({ ...base, details: { amount: '1', quality: 0, stats: { p: '5' }, locationUuid: 'L1' } }), 'G', comp, 'en'),
      '📥 <@100000000000000001> added **1 pcs** · **Glacier · Cooler · S2 · B Military** · Coolant Rating +5.0 % · Area18');
    assert.equal(logLine(row({ ...base, action: 'share', guildId: 'G', details: { amount: '2', quality: 0, locationUuid: 'L1' } }), 'G', comp, 'de'),
      '📢 <@100000000000000001> teilt **2 Stk.** · **Glacier · Cooler · S2 · B Military** · Area18');
    assert.equal(logLine(row({ ...base, action: 'adjust', details: { amount: '2', from: '2', quality: 0, stats: { p: '7' }, statsFrom: {}, locationUuid: 'L1' } }),
      'G', comp, 'de'), '✏️ <@100000000000000001> korrigiert **Glacier · Cooler · S2 · B Military** · Area18: ohne Werte → Coolant Rating +7.0 %');
    assert.equal(logLine(row({ ...base, action: 'adjust', details: { amount: '1', from: '2', quality: 0, stats: {}, statsFrom: { p: '7' }, locationUuid: 'L1' } }),
      'G', comp, 'en'), '✏️ <@100000000000000001> corrected **Glacier · Cooler · S2 · B Military** · Area18: 2 → 1 pcs · Coolant Rating +7.0 % → no stats');
  });

  it('names the recipient of a give only in the org it happened in', () => {
    const give = row({ action: 'give', guildId: 'G', toOwnerUserId: '100000000000000002' });
    assert.equal(logLine(give, 'G', names, 'en'), '📦 <@100000000000000001> gave **12.5 SCU** · **Quantanium** Q820 to <@100000000000000002> · Area18');
    assert.equal(logLine(give, 'H', names, 'en'), '📦 <@100000000000000001> gave away **12.5 SCU** · **Quantanium** Q820 · Area18');
  });

  it('packs lines into messages of at most 2000 characters', () => {
    const line = 'x'.repeat(900);
    assert.deepEqual(messagesOf([line, line, line]).map((m) => m.length), [1801, 900]);
    assert.deepEqual(messagesOf([]), []);
    assert.equal(messagesOf(['y'.repeat(2500)])[0]!.length, 2000);
  });
});

describe('logs channel with thumbnails', () => {
  const T = 'https://qm.example/thumbs/l/x.avif';
  const item = (id: number, thumb: string | null, line = `line ${id}`) => ({ id, line, thumb });
  // Every component of a message, nested ones included
  const count = (blocks: Parameters<typeof sectionMessage>[0]) => {
    let n = 0;
    type Node = { components?: Node[]; accessory?: Node };
    const walk = (c: Node) => {
      n++;
      c.components?.forEach(walk);
      if (c.accessory) walk(c.accessory);
    };
    sectionMessage(blocks).components.forEach((c) => walk(c.toJSON() as Node));
    return n;
  };

  it('makes a section per line with a thumbnail and joins the lines without one in order', () => {
    const [m, ...rest] = packSections([item(1, null), item(2, null), item(3, T), item(4, null)]);
    assert.equal(rest.length, 0);
    assert.deepEqual(m!.blocks, [{ text: 'line 1\nline 2', thumb: null }, { text: 'line 3', thumb: T }, { text: 'line 4', thumb: null }]);
    assert.equal(m!.lastId, 4);
    assert.equal(count(m!.blocks), 5);
    const json = sectionMessage(m!.blocks);
    assert.deepEqual(json.allowedMentions, { parse: [] });
    assert.deepEqual(json.components.map((c) => c.toJSON().type), [10, 9, 10]);
  });

  it('keeps each message within 40 components', () => {
    const messages = packSections(Array.from({ length: 30 }, (_, i) => item(i + 1, T)));
    assert.deepEqual(messages.map((m) => m.blocks.length), [13, 13, 4]);
    assert.deepEqual(messages.map((m) => m.lastId), [13, 26, 30]);
    for (const m of messages) assert.ok(count(m.blocks) <= 40);
    // A text display after 13 sections still fits (40 components), a section no longer
    const mixed = packSections([...Array.from({ length: 13 }, (_, i) => item(i + 1, T)), item(14, null), item(15, null), item(16, T)]);
    assert.deepEqual(mixed.map((m) => m.blocks.length), [14, 1]);
    assert.equal(count(mixed[0]!.blocks), 40);
  });

  it('keeps each message within 4000 characters of text and cuts overlong lines', () => {
    const line = 'x'.repeat(1500);
    const messages = packSections([item(1, T, line), item(2, null, line), item(3, null, line)]);
    assert.deepEqual(messages.map((m) => m.blocks.map((b) => b.text.length)), [[1500, 1500], [1500]]);
    assert.deepEqual(messages.map((m) => m.lastId), [2, 3]);
    assert.equal(packSections([item(1, T, 'y'.repeat(5000))])[0]!.blocks[0]!.text.length, 2000);
    assert.deepEqual(packSections([]), []);
  });
});
