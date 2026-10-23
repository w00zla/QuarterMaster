// Parsing of the game's global.ini localization files.

// Localization folder name -> language code; the app keeps German and English only, other folders are skipped
export const LANGUAGE_CODES: Record<string, string> = {
  'english': 'en',
  'german_(germany)': 'de',
};

/** The languages the app keeps texts of (game texts and external sources). */
export const LANGS: readonly string[] = Object.values(LANGUAGE_CODES);

// Placeholder keys that mean "no text"
const SENTINEL_KEYS = new Set(['loc_empty', 'loc_placeholder', 'loc_uninitialized']);

/** Normalizes a loc reference ("@Item_Name,P" or "item_name") to its lookup key, or null for none/sentinels. */
export function locKey(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.length < 2 || !ref.startsWith('@')) return null;
  const key = ref.slice(1).split(',')[0]!.toLowerCase();
  return key && !SENTINEL_KEYS.has(key) ? key : null;
}

/**
 * Parses global.ini (UTF-8 with BOM, CRLF). Keys are lower-cased and stripped of
 * suffixes like ",P". The first occurrence of a key wins.
 */
export function parseGlobalIni(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).split(',')[0]!.trim().toLowerCase();
    if (key && !entries.has(key)) entries.set(key, line.slice(eq + 1));
  }
  return entries;
}

/** Loc text as displayed: the game writes line breaks as a literal "\\n". */
export function displayText(raw: string): string {
  return raw.replace(/\\n/g, '\n').trim();
}

/** Non-English files contain "! GERMAN_(GERMANY) TRANSLATION NOT FOUND FOR LOCID: x !" instead of omitting the key. */
export function isMissingTranslation(text: string): boolean {
  return /TRANSLATION NOT FOUND FOR LOCID/i.test(text);
}
