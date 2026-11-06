// Texts the app defines itself because the game data has none. Pure: used by the server,
// the web UI and the bot.

/**
 * Loc keys of app-defined texts start with this prefix. They live only in the `app`
 * localization source (seeded by migrations, maintained via the admin UI) and are never
 * taken from a global.ini: the importers skip such keys.
 */
export const APP_KEY_PREFIX = 'qm_';
export const isAppKey = (key: string): boolean => key.startsWith(APP_KEY_PREFIX);

/**
 * Blueprint categories carry a size (VehicleComponentS1); the size is shown separately, so
 * the UI groups by the category without it. Keep in sync with BLUEPRINT_CATEGORY_GROUP_SQL.
 */
export const blueprintCategoryGroup = (key: string): string => key.replace(/S\d+$/, '');
export const BLUEPRINT_CATEGORY_GROUP_SQL = "regexp_replace(c.key, 'S[0-9]+$', '')";

/** Loc key of a blueprint category group's name (the game has none). */
export const BLUEPRINT_CATEGORY_KEY_PREFIX = `${APP_KEY_PREFIX}blueprint_category_`;
export const blueprintCategoryLocKey = (group: string): string => `${BLUEPRINT_CATEGORY_KEY_PREFIX}${group.toLowerCase()}`;

/**
 * Loc key of an item class's name (app text; the game only states classes inside descriptions):
 * "Energy (Laser)" -> qm_item_class_energy_laser. Keep in sync with itemClassKeySql.
 */
const ITEM_CLASS_KEY_PREFIX = `${APP_KEY_PREFIX}item_class_`;
export const itemClassLocKey = (itemClass: string): string =>
  `${ITEM_CLASS_KEY_PREFIX}${itemClass.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
export const itemClassKeySql = (column: string): string =>
  `'${ITEM_CLASS_KEY_PREFIX}' || trim(both '_' from regexp_replace(lower(${column}), '[^a-z0-9]+', '_', 'g'))`;

/** Game loc keys of item types and sub types: item_type<type>, item_subtype<sub type> (lower case). */
export const ITEM_TYPE_KEY_PREFIX = 'item_type';
export const ITEM_SUBTYPE_KEY_PREFIX = 'item_subtype';

/** Display name of an item type or sub type: the game text, else derived; none for UNDEFINED. */
export function typeLabel(type: string | null, text: string | null): string | null {
  if (!type || type === 'UNDEFINED') return null;
  return text ?? labelFromKey(type);
}

/** Fallback name from a technical key: "VehicleComponentS1" -> "Vehicle Component S1", "FPSArmours" -> "FPS Armours". */
export function labelFromKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}

/**
 * A game description in one language: the German pack (sc-deutsch) states some lines in both
 * ("Typ (En): Light Helmet" and "Typ (De): Helm (leicht)", "Fokus (En)/(De)"); of such a label only the
 * line in `lang` stays, without its tag ("Typ: Helm (leicht)"). A label without a line in `lang` keeps its lines.
 */
export function descriptionInLang(text: string, lang: string): string {
  const tagged = /^(.+?) \((en|de)\):[ \t]*(.*)$/i;
  const lines = text.split('\n');
  const inLang = new Set(lines.map((l) => l.match(tagged)).filter((m) => m && m[2]!.toLowerCase() === lang).map((m) => m![1]));
  return lines.flatMap((line) => {
    const m = line.match(tagged);
    if (!m || !inLang.has(m[1])) return [line];
    return m[2]!.toLowerCase() === lang ? [`${m[1]}: ${m[3]}`] : [];
  }).join('\n');
}
