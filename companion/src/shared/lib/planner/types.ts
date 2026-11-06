// Crafting planner data, shared by the server, the web UI and (later) the bot.
// Pure types: no imports from server code.

export interface ModifierRange {
  // "Linear" (multiplier) or "LinearIntegerAdditive" (integer steps); others are reported
  type: string;
  startQuality: number;
  endQuality: number;
  values: Record<string, number>;
}

export interface PlannerInput {
  kind: 'resource' | 'item';
  uuid: string;
  key: string;
  name: string;
  // Per craft: SCU for resources, count for items (decimal string)
  quantity: string;
  minQuality: number;
}

export interface PlannerModifier {
  propertyUuid: string;
  key: string;
  name: string;
  unit: string | null;
  ranges: ModifierRange[];
}

export interface PlannerSlot {
  index: number;
  key: string;
  name: string;
  requiredCount: number;
  inputs: PlannerInput[];
  modifiers: PlannerModifier[];
}

export interface PlannerRecipe {
  uuid: string;
  key: string;
  name: string;
  outputType: string | null;
  outputTypeLabel: string | null;
  outputSubTypeLabel: string | null;
  size: number | null;
  grade: number | null;
  // As the game shows them (from the description); null where the game has none
  gradeLetter: string | null;
  itemClass: string | null;
  manufacturer: string | null;
  // Every player has it from the start
  isDefault: boolean;
  // Blueprint category, its group (without size) and the group's display name
  category: string | null;
  categoryGroup: string | null;
  categoryLabel: string | null;
  craftSeconds: number;
  // How many of the slots must be filled (usually all)
  requiredSlots: number;
  slots: PlannerSlot[];
  retired: boolean;
}

export interface PlannerData {
  // Quality the game assumes when nothing is chosen
  defaultQuality: number;
  recipes: PlannerRecipe[];
}

/** One line of a plan, as the user enters it. */
export interface PlanEntry {
  blueprintUuid: string;
  count: number;
  // Chosen slot indexes, only for "N of M slots" recipes; default: the first N
  slots?: number[];
  // Material quality per slot index (0–1000); default: PlannerData.defaultQuality
  quality?: Record<number, number>;
}

export interface SlotResult {
  index: number;
  key: string;
  name: string;
  selected: boolean;
  quality: number;
  // Inputs with their total quantity for the entry's count
  inputs: (PlannerInput & { total: string })[];
  belowMinQuality: boolean;
}

export interface StatResult {
  propertyUuid: string;
  key: string;
  name: string;
  unit: string | null;
  kind: 'multiplier' | 'additive';
  // Combined over all selected slots (multiplier: factor, additive: sum)
  value: number;
  perSlot: { slotIndex: number; value: number }[];
  // Whether the value moves the way higher quality pushes it (higher quality = better)
  favorable: boolean | null;
}

// Warnings as codes with their values: each UI words them in its own language
export type PlanWarning =
  | { code: 'slots'; required: number; total: number }
  | { code: 'retired' }
  | { code: 'alternatives'; slot: string }
  | { code: 'belowMin'; quality: number; slot: string }
  | { code: 'unsupported'; stat: string; slot: string };

export interface EntryResult {
  blueprintUuid: string;
  name: string;
  count: number;
  craftSeconds: number;
  slots: SlotResult[];
  stats: StatResult[];
  warnings: PlanWarning[];
}

export interface Material {
  kind: 'resource' | 'item';
  uuid: string;
  key: string;
  name: string;
  total: string;
  // Strictest minimum quality over all uses
  minQuality: number;
  usedBy: { blueprintUuid: string; name: string; count: number; total: string }[];
}

export interface PlanResult {
  entries: EntryResult[];
  materials: Material[];
  craftSeconds: number;
  warnings: { code: 'notInCatalog'; blueprintUuid: string }[];
}
