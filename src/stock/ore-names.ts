// Ore names as people and the refinery terminal write them ("HEPH (RAW)", "heph raw", "Raw Silicon")
// resolved against the catalog's ore names. Pure: shared by the bot and the companion app (no server
// imports here).

/** Letters and digits only, upper case (as the companion's Rust side compares texts). */
export const norm = (text: string) => text.normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();

export interface OreCatalog {
  // Normalized name -> UUID
  ores: Map<string, string>;
  // Every ore name split into stem and qualifier (findOre)
  oreParts: { stem: string; qual: string; uuid: string }[];
}

/** A name's stem and qualifier, normalized: "Hephaestanite (Raw)" and "HEPH (RAW)" ->
 * HEPHAESTANITE/HEPH + RAW, "Raw Silicon" -> SILICON + RAW, "Hephaestanite (R)" -> … + R. */
export function oreParts(name: string): { stem: string; qual: string } {
  const paren = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(name);
  if (paren) return { stem: norm(paren[1]!), qual: norm(paren[2]!) };
  const raw = /^raw\s+(.+)$/i.exec(name.trim());
  if (raw) return { stem: norm(raw[1]!), qual: "RAW" };
  return { stem: norm(name), qual: "" };
}

/** The ore a terminal name means: the exact name, else the one ore whose stem starts with the
 * terminal's (it abbreviates: "HEPH (RAW)") and whose qualifier fits ("Raw" / "R"). */
export function findOre(cat: OreCatalog, name: string): string | null {
  const exact = cat.ores.get(norm(name));
  if (exact) return exact;
  const { stem, qual } = oreParts(name);
  if (!stem) return null;
  const fits = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
  const uuids = new Set(cat.oreParts.filter((o) => o.stem.startsWith(stem) && fits(o.qual, qual)).map((o) => o.uuid));
  return uuids.size === 1 ? [...uuids][0]! : null;
}

/** Adds one ore name (call once per language the names come in). */
export function addOreName(cat: OreCatalog, name: string, uuid: string): void {
  cat.ores.set(norm(name), uuid);
  cat.oreParts.push({ ...oreParts(name), uuid });
}
