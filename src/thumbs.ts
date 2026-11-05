// Item-Thumbnails (rein, geteilt mit den SPAs und dem Companion): vorberechnete AVIFs in drei Größen, benannt
// nach Katalog-UUID und Inhalts-Hash; eine URL ändert ihren Inhalt nie (für immer cachebar). Der Katalog sagt,
// welche UUIDs eins haben (CatalogMaterial.thumb, CatalogBlueprint.thumb); ohne Hash wird nichts angefragt.
// Gepackt von tools/thumbs, ausgeliefert von der Web-App unter /thumbs (docs/webapp.md "Thumbnails").

// Pixel der Datei je Größe: doppelt so viel wie die CSS-Größe der Anzeige (S 20 px neben dem Namen,
// M 48 px in der Thumbnail-Ansicht und der obersten Overlay-Zeile, L 128 px in Tooltips)
export const THUMB_SIZES = { s: 40, m: 96, l: 256 } as const;
export type ThumbSize = keyof typeof THUMB_SIZES;

export const THUMB_HASH = /^[0-9a-f]{8}$/;
export const THUMB_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8})\.avif$/;

/** Dateiname eines Thumbnails (in jeder Größe derselbe). */
export const thumbFile = (uuid: string, hash: string) => `${uuid.toLowerCase()}.${hash}.avif`;

/** Pfad eines Thumbnails auf der Web-App (die SPA: same origin; der Companion setzt seinen Server davor). */
export const thumbPath = (size: ThumbSize, uuid: string, hash: string) => `/thumbs/${size}/${thumbFile(uuid, hash)}`;
