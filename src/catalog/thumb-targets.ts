// The thumbnail targets: everything the app shows a thumbnail for. One definition for packshot's target list
// (thumb-targets-cli.ts) and the admin's "missing thumbnails" (src/adminapp/thumbs.ts):
//  - items: the gear (`componentItemSql`, the stock service's rule), the harvestables used as recipe inputs
//    (e.g. Hadanite) and the shop items (`shopItemSql`, whose thumbnails the item finder shows),
//  - resources with a thumbnail entity (`rttThumbnailEntityClass`: an ore and its refined material share one).
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { locText, rows } from '../db/query.ts';
import { componentItemSql } from '../stock/service.ts';
import { shopItemSql } from './components.ts';

export interface ThumbItem { uuid: string; class_name: string; type: string; sub_type: string | null; name: string }
// entity: a file reference (file://…/thumbnailentity_resource_rock_gold.json)
export interface ThumbResource { uuid: string; entity: string; name: string }

/** The items and resources that should have a thumbnail, names in `lang` (else the class name or key). */
export async function thumbTargets(db: Db, lang: string): Promise<{ items: ThumbItem[]; resources: ThumbResource[] }> {
  const items = await rows<ThumbItem>(db, sql`SELECT i.uuid, i.class_name, i.type, i.sub_type,
      coalesce(${locText(lang, sql`i.name_key`)}, i.class_name) AS name FROM catalog.item i
    WHERE i.retired_at IS NULL AND (EXISTS (SELECT 1 FROM catalog.blueprint_input bi WHERE bi.item_uuid = i.uuid)
      OR ${componentItemSql('i.uuid')} OR ${sql.raw(shopItemSql('i'))}) ORDER BY i.type, i.sub_type, i.class_name`);
  const resources = await rows<ThumbResource>(db, sql`SELECT r.uuid, r.data->>'rttThumbnailEntityClass' AS entity,
      coalesce(${locText(lang, sql`r.name_key`)}, r.key) AS name
    FROM catalog.resource r WHERE r.retired_at IS NULL AND coalesce(r.data->>'rttThumbnailEntityClass', '') <> '' ORDER BY r.key`);
  return { items, resources };
}
