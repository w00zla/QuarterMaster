// The thumbnails the server serves: THUMBS_DIR holds s/, m/, l/ and thumbs.json {uuid: hash}
// (tools/thumbs, to the VM with scripts/push-thumbs.sh). The manifest is re-read when it changes;
// a broken one keeps the previous index (the upload replaces it atomically).
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { THUMB_HASH } from './thumbs.ts';

const RECHECK_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY: ReadonlyMap<string, string> = new Map();

/** Liest uuid -> hash aus `dir`/thumbs.json (gecacht, neu bei Änderung); leer ohne Verzeichnis oder Manifest. */
export function thumbIndex(dir: string | null): () => ReadonlyMap<string, string> {
  let checkedAt = 0;
  let mtime = -1;
  let index = EMPTY;
  return () => {
    if (!dir || Date.now() - checkedAt < RECHECK_MS) return index;
    checkedAt = Date.now();
    const manifest = join(dir, 'thumbs.json');
    let now: number;
    try {
      now = statSync(manifest).mtimeMs;
    } catch {
      mtime = -1;
      return (index = EMPTY);
    }
    if (now === mtime) return index;
    mtime = now;
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      const next = new Map<string, string>();
      for (const [uuid, hash] of Object.entries(parsed)) {
        if (UUID.test(uuid) && typeof hash === 'string' && THUMB_HASH.test(hash)) next.set(uuid, hash);
      }
      index = next;
    } catch (err) {
      console.error(`Thumbnail manifest ${manifest} ignored: ${err instanceof Error ? err.message : String(err)}`);
    }
    return index;
  };
}
