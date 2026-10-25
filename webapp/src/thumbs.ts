// Item thumbnails in the lists (docs/webapp.md "Thumbnails"): the hash comes from the catalog (materials by
// uuid; a blueprint shows the item it crafts), no hash = no request (the type icon stays).
import { ref, watch, type Ref } from "vue";
import type { TableView } from "../../adminapp/src/tableColumns";
import { thumbPath, type ThumbSize } from "../../src/thumbs";
import { blueprints, materials } from "./catalog";

export interface ThumbRef {
  uuid: string;
  hash: string | null;
}

export const materialThumb = (uuid: string): ThumbRef => ({ uuid, hash: materials.value.get(uuid)?.thumb ?? null });

export function blueprintThumb(uuid: string): ThumbRef {
  const bp = blueprints.value.get(uuid);
  return bp?.outputUuid ? { uuid: bp.outputUuid, hash: bp.thumb } : { uuid, hash: null };
}

/** Starts loading a thumbnail (a tooltip's: cached by the time its card opens). */
export function preloadThumb(size: ThumbSize, t: ThumbRef) {
  if (t.hash) new Image().src = thumbPath(size, t.uuid, t.hash);
}

/**
 * Whether a table shows its thumbnail column (THUMB_COLUMN), for its column list. The view lives in useTableColumns, which
 * reads the columns while it is created: this flag comes first and follows the view (`follow`) once the
 * columns' state exists, before anything renders.
 */
export function thumbColumnFlag(): { on: Ref<boolean>; follow: (view: Ref<TableView>) => void } {
  const on = ref(false);
  return { on, follow: (view) => watch(view, (v) => (on.value = v === "thumbs"), { immediate: true }) };
}
