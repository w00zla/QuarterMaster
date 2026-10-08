// Refinery job estimates (pure), against in-game quotes (CRU-L1, 2026-10-07/08).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateJob } from '../src/ext/refining-estimate.ts';

describe('refinery job estimate', () => {
  const dinyx = { yieldPct: 45, secondsPerScu: 768 };

  it('scales time with the amount and cuts the yield off to cSCU like the terminal', () => {
    assert.deepEqual(estimateJob(2, dinyx), { seconds: 1536, yieldScu: 0.9 });
    // Quote rows: 3.89 SCU -> 175 cSCU (175.05), 0.46 -> 20 (20.7), 12.01 -> 540 (540.45)
    assert.equal(estimateJob(3.89, dinyx).yieldScu, 1.75);
    assert.equal(estimateJob(0.46, dinyx).yieldScu, 0.2);
    assert.equal(estimateJob(12.01, dinyx).yieldScu, 5.4);
    assert.equal(estimateJob(1, { yieldPct: 31.5, secondsPerScu: 8 }).yieldScu, 0.31);
  });

  it('does not lose a unit to floating point noise', () => {
    assert.equal(estimateJob(1, dinyx).yieldScu, 0.45);
    assert.equal(estimateJob(0.1, { yieldPct: 45, secondsPerScu: 30 }).seconds, 3);
  });

  it('multiplies the station bonus into the yield', () => {
    // Hephaestanite at CRU-L1 (-2 %): 2.07 SCU -> 91 cSCU (91.29)
    assert.equal(estimateJob(2.07, dinyx, -2).yieldScu, 0.91);
    assert.equal(estimateJob(10, dinyx, 5).yieldScu, 4.72);
  });
});
