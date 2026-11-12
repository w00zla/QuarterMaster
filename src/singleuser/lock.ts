// One process per data folder: PGlite has no second opener. A lock file in the data folder is taken at start and
// removed at a clean exit. A lock whose owner is gone is taken over. Everything the decision needs is passed in.
import { linkSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canListen } from './port.ts';

export const LOCK_FILE = 'server.lock';
/** How long a process that holds the lock but does not listen yet may be starting, before its pid counts as reused. */
export const STARTING_MS = 120_000;

export type LockInfo = { pid: number; port: number; startedAt: number };

export type LockProbes = {
  /** Whether a process with this pid exists. */
  alive: (pid: number) => boolean;
  /** Whether something listens on 127.0.0.1:port. */
  portBusy: (port: number) => Promise<boolean>;
  now: () => number;
};

export const lockFile = (data: string) => join(data, LOCK_FILE);

/** `process.kill(pid, 0)` sends nothing: it only says whether the pid exists (EPERM = it exists, but is not ours). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const realProbes: LockProbes = { alive: pidAlive, portBusy: async (port) => !(await canListen(port)), now: Date.now };

/**
 * Whether the owner of a lock is still there. Its pid must exist; a pid can be reused by an unrelated process after a
 * crash, so it also has to listen on the port it recorded, or be young enough to still be starting.
 */
export async function holderIsLive(info: LockInfo, probes: LockProbes = realProbes): Promise<boolean> {
  if (!probes.alive(info.pid)) return false;
  if (await probes.portBusy(info.port)) return true;
  return probes.now() - info.startedAt < STARTING_MS;
}

function readLock(file: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>;
    return Number.isInteger(parsed.pid) && Number.isInteger(parsed.port) && typeof parsed.startedAt === 'number' ? (parsed as LockInfo) : null;
  } catch {
    return null;
  }
}

export type LockResult = { taken: true } | { taken: false; holder: LockInfo };

/**
 * Takes the lock. The file appears complete or not at all (written aside, then hard-linked into place: the link fails when
 * the name exists). An existing lock of a live holder refuses; a stale or unreadable one is removed and the take repeated once.
 */
export async function acquireLock(file: string, info: LockInfo, probes: LockProbes = realProbes): Promise<LockResult> {
  const aside = `${file}.${info.pid}.tmp`;
  writeFileSync(aside, JSON.stringify(info));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(aside, file);
        return { taken: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const holder = readLock(file);
      if (holder && holder.pid !== info.pid && (await holderIsLive(holder, probes))) return { taken: false, holder };
      rmSync(file, { force: true });
    }
    // Lost the race for the stale lock to another starter: that one is the holder now
    const holder = readLock(file);
    return { taken: false, holder: holder ?? info };
  } finally {
    unlinkSync(aside);
  }
}

/** Removes the lock when it is ours. Never throws on a missing file. */
export function releaseLock(file: string, pid: number): void {
  if (readLock(file)?.pid === pid) rmSync(file, { force: true });
}
