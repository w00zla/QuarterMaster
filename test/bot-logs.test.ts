import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { logLine, messagesOf, type LogNames, type LogRow } from '../src/bot/logs.ts';

const names: LogNames = { material: () => 'Quantanium', location: (u) => (u === 'L2' ? 'Baijini Point' : 'Area18') };
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
