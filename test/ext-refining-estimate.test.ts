// Refinery job estimates (pure).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateJob } from '../src/ext/refining-estimate.ts';

describe('refinery job estimate', () => {
  const dinyx = { yieldPct: 93.3, secondsPerScu: 69120 };

  it('scales time with the amount and rounds the yield to cSCU', () => {
    assert.deepEqual(estimateJob(2, dinyx), { seconds: 138240, yieldScu: 1.87 });
    assert.deepEqual(estimateJob(0.5, { yieldPct: 70, secondsPerScu: 2880 }), { seconds: 1440, yieldScu: 0.35 });
  });

  it('multiplies the station bonus into the yield (assumption)', () => {
    assert.equal(estimateJob(10, dinyx, 5).yieldScu, 9.8);
    assert.equal(estimateJob(10, dinyx, -8).yieldScu, 8.58);
  });
});
