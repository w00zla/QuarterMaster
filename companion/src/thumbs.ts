// Item thumbnails in the companion (src/thumbs.ts names them): the Rust command `thumb` answers them as
// data: URLs from the app's cache dir, else fetched from the server's /thumbs/… (the webview's CSP keeps
// the server out of img-src). Each image crosses the IPC once per window and session; a failed one is
// asked again by the next element that shows it. Without a hash nothing is asked: no thumbnail.
import type { ThumbSize } from "./shared/lib/thumbs";
import { thumbData } from "./backend";

/** A catalog item with a thumbnail: its UUID and the thumbnail's hash. */
export interface ThumbRef {
  uuid: string;
  hash: string;
}

export const thumbRef = (uuid: string | null | undefined, hash: string | null | undefined): ThumbRef | null =>
  uuid && hash ? { uuid, hash } : null;

const cache = new Map<string, Promise<string | null>>();

/** The thumbnail as a data: URL, null when it cannot be had (the look without it stays). */
export function loadThumb(size: ThumbSize, item: ThumbRef): Promise<string | null> {
  const key = `${size}/${item.uuid}.${item.hash}`;
  let url = cache.get(key);
  if (!url) {
    url = thumbData(size, item.uuid, item.hash).catch(() => {
      cache.delete(key);
      return null;
    });
    cache.set(key, url);
  }
  return url;
}
