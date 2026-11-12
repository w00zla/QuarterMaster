// The data folder's lock (src/singleuser/lock.ts): who counts as the holder, taking over a stale lock, releasing. Pure: the
// probes (is the pid alive, is the port busy, what time is it) are injected; the real processes are in singleuser.test.ts.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { acquireLock, holderIsLive, lockFile, pidAlive, releaseLock, STARTING_MS, type LockInfo, type LockProbes } from '../src/singleuser/lock.ts';

const NOW = 1_000_000_000_000;
const probes = (over: Partial<{ alive: boolean; busy: boolean }> = {}): LockProbes => ({
  alive: () => over.alive ?? true,
  portBusy: async () => over.busy ?? false,
  now: () => NOW,
});
const holder = (over: Partial<LockInfo> = {}): LockInfo => ({ pid: 4242, port: 28461, startedAt: NOW - 10 * STARTING_MS, ...over });

describe('singleuser lock: who is the holder', () => {
  it('is gone when its pid is gone, whatever the port says', async () => {
    assert.equal(await holderIsLive(holder(), probes({ alive: false, busy: true })), false);
  });

  it('is live when the pid exists and the recorded port is in use', async () => {
    assert.equal(await holderIsLive(holder(), probes({ busy: true })), true);
  });

  it('is a reused pid when it exists but the port is free and the lock is old', async () => {
    assert.equal(await holderIsLive(holder(), probes({ busy: false })), false);
  });

  it('is still starting when the pid exists, the port is not open yet and the lock is young', async () => {
    assert.equal(await holderIsLive(holder({ startedAt: NOW - 5_000 }), probes({ busy: false })), true);
    assert.equal(await holderIsLive(holder({ startedAt: NOW - STARTING_MS - 1 }), probes({ busy: false })), false);
  });

  it('knows the pid of this very process', () => {
    assert.equal(pidAlive(process.pid), true);
  });
});

describe('singleuser lock: the file', () => {
  const temp = () => mkdtempSync(join(tmpdir(), 'qm-lock-'));
  const mine = (over: Partial<LockInfo> = {}): LockInfo => ({ pid: 777, port: 28462, startedAt: NOW, ...over });

  it('is taken when there is none, with pid, port and start time, and no temp file is left', async () => {
    const dir = temp();
    try {
      const file = lockFile(dir);
      assert.deepEqual(await acquireLock(file, mine(), probes()), { taken: true });
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), mine());
      assert.deepEqual(readdirSync(dir), ['server.lock']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused while a live holder has it, and names the holder', async () => {
    const dir = temp();
    try {
      const file = lockFile(dir);
      writeFileSync(file, JSON.stringify(holder()));
      assert.deepEqual(await acquireLock(file, mine(), probes({ busy: true })), { taken: false, holder: holder() });
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), holder());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is taken over from a holder that is gone, and from a file that is not a lock', async () => {
    const dir = temp();
    try {
      const file = lockFile(dir);
      writeFileSync(file, JSON.stringify(holder()));
      assert.deepEqual(await acquireLock(file, mine(), probes({ alive: false })), { taken: true });
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 777);
      rmSync(file);
      writeFileSync(file, 'not json');
      assert.deepEqual(await acquireLock(file, mine(), probes({ busy: true })), { taken: true });
      writeFileSync(file, JSON.stringify({ pid: 'x' }));
      rmSync(file);
      writeFileSync(file, JSON.stringify({ pid: 1 }));
      assert.deepEqual(await acquireLock(file, mine(), probes({ busy: true })), { taken: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is released only by its owner', async () => {
    const dir = temp();
    try {
      const file = lockFile(dir);
      await acquireLock(file, mine(), probes());
      releaseLock(file, 1);
      assert.equal(existsSync(file), true);
      releaseLock(file, 777);
      assert.equal(existsSync(file), false);
      releaseLock(file, 777);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
