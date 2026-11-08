// Item thumbnails (pure, shared with the SPAs and API consumers such as the companion): precomputed AVIFs in three
// sizes, named by catalog UUID and content hash; a URL never changes its content (cacheable forever). The catalog
// says which UUIDs have one (CatalogMaterial.thumb, CatalogBlueprint.thumb); without a hash nothing is requested.
// Packed by tools/thumbs, served by the web app under /thumbs (docs/webapp.md "Thumbnails").

// Pixels of the file per size: twice the CSS size of the display (S 20 px next to the name,
// M 48 px in the thumbnail view and overlay rows, L 128 px in tooltips)
export const THUMB_SIZES = { s: 40, m: 96, l: 256 } as const;
export type ThumbSize = keyof typeof THUMB_SIZES;

export const THUMB_HASH = /^[0-9a-f]{8}$/;
export const THUMB_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8})\.avif$/;

/** File name of a thumbnail (the same in every size). */
export const thumbFile = (uuid: string, hash: string) => `${uuid.toLowerCase()}.${hash}.avif`;

/** Path of a thumbnail on the web app (the SPA: same origin; API consumers put their server in front). */
export const thumbPath = (size: ThumbSize, uuid: string, hash: string) => `/thumbs/${size}/${thumbFile(uuid, hash)}`;
