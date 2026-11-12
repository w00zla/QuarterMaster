// The companion's radar signature evaluation (companion/src/signatures.ts): which rock kinds a signature a ship's
// scan shows can stand for.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchSignature, matchText, signatureText } from '../companion/src/signatures.ts';

const rock = (name: string, radarSignature: number, method: 'ship' | 'roc' | 'fps' = 'ship') => ({ name, method, radarSignature });

describe('companion: radar signatures', () => {
  it('a signature is a whole multiple of a rock kind\'s', () => {
    const rocks = [rock('Gold', 1200), rock('Agricium', 1800), rock('Quartz', 4285), rock('Hadanite', 600, 'fps')];
    // 3,600 = 3 × 1,200 = 2 × 1,800 = 6 × 600: every mining method's rocks (the hand-mined Hadanite too)
    assert.deepEqual(matchSignature(3600, rocks).map(matchText), ['2 × Agricium', '3 × Gold', '6 × Hadanite']);
    assert.deepEqual(matchSignature(4285, rocks).map(matchText), ['1 × Quartz']);
    // Each with its mining method; the same resource by two methods is two matches
    assert.deepEqual(matchSignature(3600, rocks).map((m) => m.method), ['ship', 'ship', 'fps']);
    assert.deepEqual(matchSignature(1200, [rock('Gold', 1200, 'roc'), rock('Gold', 1200)]).map((m) => [matchText(m), m.method]), [['1 × Gold', 'ship'], ['1 × Gold', 'roc']]);
    assert.deepEqual(matchSignature(1000, rocks), []);
    // Rarities of the same signature are one match; none without a signature
    assert.deepEqual(matchSignature(2400, [rock('Gold', 1200), rock('Gold', 1200), rock('Iron', 0)]).map(matchText), ['2 × Gold']);
  });

  it('written as the game writes it', () => {
    assert.equal(signatureText(42000), '42,000');
    assert.equal(signatureText(3170), '3,170');
  });
});
