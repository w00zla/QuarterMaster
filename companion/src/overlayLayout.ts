// The scan overlay's display (settings "Darstellung"/"Display", config overlayDisplay) and how many rows
// its fixed tile shows below the location line (overlay.rs size: 340×190 / 360×210). Pure (also run by
// the root's node tests).

export type OverlayDisplay = "thumbs" | "compact";

/** "compact": 8 rows of 20 px (190 px high, as before thumbnails). "thumbs" (210 px high): the latest item
 * as a 60 px top row and 6 rows below it; the refinery has no single latest item, its rows fill the tile
 * (9). `rows` counts the rows below the top row. */
export function overlayLayout(display: OverlayDisplay, refinery: boolean): { top: boolean; rows: number } {
  if (display === "compact") return { top: false, rows: 8 };
  return refinery ? { top: false, rows: 9 } : { top: true, rows: 6 };
}
