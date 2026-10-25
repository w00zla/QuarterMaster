// The item thumbnails as the admin sees them: which UUIDs have one (THUMBS_DIR/thumbs.json, the same index
// the web app serves from), when the manifest was written, and which of the items and materials that should
// have one lack it (the render targets of src/icons/cli.ts: gear items by the stock service's rule, materials
// with a thumbnail entity). A new game patch brings items without a render: they show up here.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { locText as text, rows } from '../db/query.ts';
import { componentItemSql } from '../stock/service.ts';
import type { ThumbsResponse } from './api-types.ts';

export async function getThumbs(db: Db, lang: string, dir: string | null, index: ReadonlyMap<string, string>): Promise<ThumbsResponse> {
  let updatedAt: string | null = null;
  try {
    if (dir) updatedAt = statSync(join(dir, 'thumbs.json')).mtime.toISOString();
  } catch {
    // No manifest yet
  }
  const targets = await rows<{ uuid: string; kind: 'item' | 'resource'; name: string; type: string | null }>(db, sql`
    SELECT i.uuid, 'item' AS kind, coalesce(${text(lang, sql`i.name_key`)}, i.class_name) AS name, i.type
    FROM catalog.item i WHERE i.retired_at IS NULL AND ${componentItemSql('i.uuid')}
    UNION ALL
    SELECT r.uuid, 'resource', coalesce(${text(lang, sql`r.name_key`)}, r.key), NULL
    FROM catalog.resource r WHERE r.retired_at IS NULL AND coalesce(r.data->>'rttThumbnailEntityClass', '') <> ''`);
  const missing = targets.filter((t) => !index.has(t.uuid)).sort((a, b) => a.name.localeCompare(b.name));
  return { updatedAt, count: index.size, targets: targets.length, hashes: Object.fromEntries(index), missing };
}
