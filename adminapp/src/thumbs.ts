// The item thumbnails' hashes, loaded once per page load (GET /api/thumbs): the detail panels show the large one.
import { ref } from "vue";
import { get } from "./api";
import { thumbPath } from "../../src/thumbs";
import type { ThumbsResponse } from "../../src/adminapp/api-types";

const hashes = ref<Record<string, string>>({});
let loading: Promise<void> | null = null;

/** Starts loading the hashes (once); a failure leaves the panels without images. */
export function loadThumbs() {
  loading ??= get<ThumbsResponse>("/thumbs").then((r) => void (hashes.value = r.hashes)).catch(() => {
    loading = null;
  });
}

/** The large thumbnail's path for a catalog UUID, or null without one. */
export function thumbOf(uuid: string | null | undefined): string | null {
  const hash = uuid ? hashes.value[uuid.toLowerCase()] : undefined;
  return uuid && hash ? thumbPath("l", uuid, hash) : null;
}
