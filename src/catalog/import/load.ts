// Reads and checks a snapshot (plain or gzipped JSON): shared by the import CLI and the web API.
import { gunzipSync } from 'node:zlib';
import { snapshotSchema, type Snapshot } from '../snapshot.ts';
import { checkIntegrity, sha256 } from './plan.ts';

export interface LoadedSnapshot {
  snapshot: Snapshot;
  // Of the uncompressed JSON text: identical snapshots are detected by it
  sha256: string;
  timings: Record<string, number>;
}

const isGzip = (bytes: Uint8Array) => bytes[0] === 0x1f && bytes[1] === 0x8b;

/** Throws with a readable message when the data is not a valid, consistent snapshot. */
export function loadSnapshot(bytes: Uint8Array): LoadedSnapshot {
  const timings: Record<string, number> = {};
  const timed = <T>(label: string, fn: () => T): T => {
    const t0 = performance.now();
    const r = fn();
    timings[label] = performance.now() - t0;
    return r;
  };
  const text = timed('read', () => Buffer.from(isGzip(bytes) ? gunzipSync(bytes) : bytes).toString('utf8'));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Not a snapshot: the file is no JSON (plain or gzipped)');
  }
  const parsed = timed('validate', () => snapshotSchema.safeParse(json));
  if (!parsed.success) throw new Error(`Snapshot failed validation:\n${parsed.error.message}`);
  const errors = timed('integrity', () => checkIntegrity(parsed.data));
  if (errors.length > 0) {
    throw new Error(`Snapshot failed integrity checks (${errors.length}):\n  ${errors.slice(0, 20).join('\n  ')}`);
  }
  return { snapshot: parsed.data, sha256: sha256(text), timings };
}
