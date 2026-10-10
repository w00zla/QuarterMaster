// Material names as people and the refinery terminal write them ("TITANIUM", "quanta") resolved against
// the catalog's names of bookable resources. Pure: shared by the bot and the companion app (no server
// imports here).

/** Letters and digits only, upper case (as the companion's Rust side compares texts). */
export const norm = (text: string) => text.normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();

export interface MaterialNames {
  // Normalized name -> UUID (every language the names come in)
  names: Map<string, string>;
}

export const emptyNames = (): MaterialNames => ({ names: new Map() });

/** Adds one name (call once per language). */
export function addName(cat: MaterialNames, name: string, uuid: string): void {
  cat.names.set(norm(name), uuid);
}

/** The material a name means: the exact name, else the one material whose name starts with it. */
export function findMaterial(cat: MaterialNames, name: string): string | null {
  const key = norm(name);
  if (!key) return null;
  const exact = cat.names.get(key);
  if (exact) return exact;
  const uuids = new Set([...cat.names].filter(([n]) => n.startsWith(key)).map(([, uuid]) => uuid));
  return uuids.size === 1 ? [...uuids][0]! : null;
}
