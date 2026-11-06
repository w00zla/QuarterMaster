// The item thumbnails as the admin sees them: which UUIDs have one (THUMBS_DIR/thumbs.json, the same index
// the web app serves from), when the manifest was written, and which of the items and materials that should
// have one lack it (the same targets packshot renders: src/catalog/thumb-targets.ts). A new game patch brings
// items without a render: they show up here.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/client.ts';
import { thumbTargets } from '../catalog/thumb-targets.ts';
import type { ThumbsResponse } from './api-types.ts';

export async function getThumbs(db: Db, lang: string, dir: string | null, index: ReadonlyMap<string, string>): Promise<ThumbsResponse> {
  let updatedAt: string | null = null;
  try {
    if (dir) updatedAt = statSync(join(dir, 'thumbs.json')).mtime.toISOString();
  } catch {
    // No manifest yet
  }
  const { items, resources } = await thumbTargets(db, lang);
  const targets: { uuid: string; kind: 'item' | 'resource'; name: string; type: string | null }[] = [
    ...items.map((i) => ({ uuid: i.uuid, kind: 'item' as const, name: i.name, type: i.type })),
    ...resources.map((r) => ({ uuid: r.uuid, kind: 'resource' as const, name: r.name, type: null })),
  ];
  const missing = targets.filter((t) => !index.has(t.uuid)).sort((a, b) => a.name.localeCompare(b.name));
  return { updatedAt, count: index.size, targets: targets.length, hashes: Object.fromEntries(index), missing };
}
