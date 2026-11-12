// The scan overlay's display (settings "Darstellung"/"Display", config overlayDisplay) and how many rows
// its fixed tile shows below the location line (overlay.rs size: 300×150 / 340×210). Pure (also run by
// the root's node tests).

export type OverlayDisplay = "thumbs" | "compact";

/** "compact": 6 rows of 20 px (150 px high). "thumbs" (210 px high): the latest item as a 60 px top row
 * and 6 rows below it; the views without a single latest item (refinery, signatures: `rowsOnly`) fill the tile
 * with rows (9). `rows` counts the rows below the top row. */
export function overlayLayout(display: OverlayDisplay, rowsOnly: boolean): { top: boolean; rows: number } {
  if (display === "compact") return { top: false, rows: 6 };
  return rowsOnly ? { top: false, rows: 9 } : { top: true, rows: 6 };
}
