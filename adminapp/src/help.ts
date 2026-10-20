// Help texts for the info icons (HelpTip), in one place.
export const HELP = {
  // Overview tiles
  blueprints: "Crafting recipes from the game data: what an item needs and how long it takes.",
  items: "Only items that blueprints craft or use as ingredients, not every item in the game.",
  resources: "All resource types of the game, ores included. Recipes take the refined material.",
  manufacturers: "Makers of the items that blueprints craft or use as ingredients. Only manufacturers referenced by a blueprint are stored.",
  categories: "Coarse group of the blueprint: the game's blueprint category without its size (the size has its own column). The game has no names for them; these are the app's own.",
  stats: "Item properties that material quality changes when crafting, e.g. Integrity or Quantum Speed. Recipe slots point to these.",
  qualityTables: "Quality bands per material: 0–1000 split into 8 ranges, each with a mapped value. Stored from the game data, not used by the app yet.",
  rawRecords: "The unmodified game records everything else is derived from, kept so new data can be used without extracting again.",

  // Lifecycle
  retired: "No longer in the game data. Kept so existing references stay valid; it comes back if the game brings it back.",
  imports: "Catalog imports in which this entry was first and last seen.",
  importList: "Each run of the catalog import from a game snapshot. A forced import overrode a safeguard.",
  importCounts: "Per catalog table: added, changed, unchanged, revived (back in the game data after being retired) and retired (no longer in the game data).",
  anomalies: "What the extractor noticed in the game data: unknown structures, missing texts, broken references. Affected data is skipped or only kept raw.",

  // Blueprints
  defaultBlueprint: "Blueprints every player has from the start.",
  manufacturerCode: "Manufacturer of the crafted item.",
  slots: "Ingredient slots of the recipe.",
  grade: "Quality grade A–D as the game shows it. Only ship components have one.",
  itemClass: "Class as the game shows it: Military, Civilian, Industrial, Stealth or Competition for ship components; Ballistic, Energy, Laser or Electron for personal weapons.",
  key: "Technical name in the game data.",
  recipe: "Each slot takes one of its inputs. The input's quality (0–1000) moves the listed stats: ×a → ×b is the multiplier from the start to the end of the quality range. Min Q is the lowest quality a slot accepts.",
  slotsRequired: "Only this many of the slots have to be filled.",
  qualityGated: "Recipes where at least one material needs a minimum quality.",
  topMaterials: "Resources and items needed by the most active recipes.",
  noSource: "Blueprints that are neither default nor in any reward pool of the game data. They may still be handed out by the game servers; the client data does not say.",
  registeredNoSource: "Blueprints without a known source that users registered anyway (bot, web app, companion app), with the number of users in parentheses. Each one shows the game data misses a source.",
  gaps: "Names without text: none in the selected language (shown in English instead) or none at all (shown by their technical name). Plus what no recipe uses.",
  unusedResources: "Resources no active blueprint needs. Ores are among them: recipes take the refined material.",

  // Resources
  inRecipes: "Only resources used by at least one active blueprint.",
  ores: "Unrefined ores. Recipes take the refined material; ores are not tracked in resources.",
  usedIn: "Active blueprints using this resource.",
  boxSizes: "Cargo box sizes the game offers for this resource.",

  // Items
  ingredients: "Only items used as ingredients by at least one active blueprint.",
  crafted: "Active blueprints that craft this item.",
  ingredientIn: "Active blueprints using this item as an ingredient.",

  // Texts
  sources: "Game texts come from the game itself (priority 0) and from imported text files such as community translations. Per language and text, the source with the highest priority wins. Click a row to switch the language.",
  textSearch: "Searches keys and texts of the selected language and shows the effective text with its source.",
  appSource: "Texts the app defines itself because the game has none, e.g. blueprint category names. They never come from a global.ini; maintained in the admin UI.",
  effective: "The text shown for this language: the one from the source with the highest priority. Dimmed texts are overruled.",

  // Imports
  newImport: "Upload a file and run a dry run first: it shows exactly what would change. Import only becomes available once the dry run of that file with those options passed.",
  catalogImport: "A catalog snapshot (catalog-<channel>-<build>.json.gz) made by the extractor from a game install.",
  forceImport: "Override the safeguards against many retired or changed entries, and re-import identical data. Needs a new dry run.",
  allowDowngrade: "Allow a snapshot of an older game build than the last import. Needs a new dry run.",
  locImport: "An externally maintained global.ini, e.g. a community translation, as an extra text source. The source with the highest priority wins per text.",
} as const;
