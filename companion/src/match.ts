// Blueprint names from Game.log to catalog blueprints. Pure (also run by the root's node tests).
//
// The log names the unlocked item in the game's language: English, or the community translation a
// player installed, so the index covers the catalog's names in every language the app loads. Ship
// components carry a "class/size/grade" prefix ("Ind/1/B Guardian") the catalog name lacks; it
// also tells apart components that share a name.

export interface CatalogEntry {
  uuid: string;
  // The output item's name in one language
  name: string;
  size: number | null;
  gradeLetter: string | null;
  isDefault: boolean;
  retired: boolean;
}

// "Ind/1/B Guardian", "Mil/3/A JS-500", "Sth/2/B Bolt"
const PREFIX = /^[A-Za-z]{3}\/(\d+)\/([A-Z])\s+(.+)$/;

export const normalizeName = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();

/** Name -> entries, over all given catalogs (one per language); each entry once per name, retired ones left out. */
export function buildIndex(catalogs: CatalogEntry[][]): Map<string, CatalogEntry[]> {
  const index = new Map<string, CatalogEntry[]>();
  for (const catalog of catalogs) {
    for (const entry of catalog) {
      if (entry.retired) continue;
      const key = normalizeName(entry.name);
      const list = index.get(key) ?? [];
      if (!list.some((e) => e.uuid === entry.uuid)) list.push(entry);
      index.set(key, list);
    }
  }
  return index;
}

/** The catalog blueprints a logged name can be: none (unknown), one, or several (the user picks). */
export function matchUnlock(logName: string, index: Map<string, CatalogEntry[]>): CatalogEntry[] {
  const prefix = PREFIX.exec(logName.trim());
  let hits = index.get(normalizeName(logName)) ?? [];
  if (!hits.length && prefix) hits = index.get(normalizeName(prefix[3]!)) ?? [];
  if (hits.length > 1 && prefix) {
    const narrowed = hits.filter((e) => e.size === Number(prefix[1]) && e.gradeLetter === prefix[2]);
    if (narrowed.length) hits = narrowed;
  }
  return hits;
}
