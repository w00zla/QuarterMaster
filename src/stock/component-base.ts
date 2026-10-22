// Where a component's unmodified stat values sit in its DataCore record (`catalog.raw_record`),
// per crafted property: the game's tooltip shows these absolute values ("Coolant Rating: 60.00"), the
// stock stores a crafted component's gain over them in percent or steps (`component-stats.ts`). The
// companion app reads the tooltip and needs the base to tell the gain. Checked 2026-10-18 against the
// user's inventory screenshots (HeatSafe 22 / 110, Blizzard 60 / 1800, Atlas 259.05 / 200, CoverAll
// 10560 / 660), the FPS gear 2026-10-22 (Gallant 900 RPM, CQ7 650 -> 713.49 crafted, Artimex Canuto
// 0.30 / -61 / +91 / 145.80). Properties missing here have no known tooltip format (tractor, salvage
// heads): their base stays null and the companion registers such components without stats only when
// the tooltip shows none. Properties the tooltip shows as a change in percent (`tooltipForm`) need none.

export interface BasePath {
  // A Postgres jsonpath into the record (lax mode: the first match counts)
  path: string;
  // A jsonpath to a link ("file://…/libs/foundry/records/…json") in the item's record: `path` is then
  // read in the linked record
  link?: string;
  // offset + record value × scale = the tooltip's value
  scale: number;
  offset?: number;
}

const COMPONENT = (type: string) => `$.Components[*] ? (@._Type_ == "${type}")`;
const GENERATION = (resource: string) =>
  `${COMPONENT('ItemResourceComponentParams')}.states[*].deltas[*].generation ? (@.resource == "${resource}").resourceAmountPerSecond`;

/** Crafted property key -> where its base value is. */
export const BASE_PATHS: Record<string, BasePath> = {
  GPP_Health_MaxHealth: { path: `${COMPONENT('SHealthComponentParams')}.Health`, scale: 1 },
  GPP_ItemResource_CoolantGeneration: { path: `${GENERATION('Coolant')}.standardResourceUnits`, scale: 1 },
  GPP_ItemResource_PowerGeneration: { path: `${GENERATION('Power')}.units`, scale: 1 },
  GPP_Shield_MaxHealth: { path: `${COMPONENT('SCItemShieldGeneratorParams')}.MaxShieldHealth`, scale: 1 },
  GPP_Quantum_Speed: { path: `${COMPONENT('SCItemQuantumDriveParams')}.params.driveSpeed`, scale: 1e-6 },
  GPP_Quantum_FuelRequirement: { path: `${COMPONENT('SCItemQuantumDriveParams')}.quantumFuelRequirement`, scale: 1000 },
  GPP_Radar_MaxAimAssistDistance: { path: `${COMPONENT('SCItemRadarComponentParams')}.aimAssist.distanceMaxAssignment`, scale: 1 },
  GPP_Radar_MinAimAssistDistance: { path: `${COMPONENT('SCItemRadarComponentParams')}.aimAssist.distanceMinAssignment`, scale: 1 },
  // The first fire mode's rate; a sequence of modes has none there (the Killshot shows 535 RPM, its
  // sequence says 600: unknown, left null)
  GPP_Weapon_FireRate: { path: `${COMPONENT('SCItemWeaponComponentParams')}.fireActions[0].fireRate`, scale: 1 },
  GPP_Armor_TemperatureMin: { path: `${COMPONENT('SCItemClothingParams')}.TemperatureResistance.MinResistance`, scale: 1 },
  GPP_Armor_TemperatureMax: { path: `${COMPONENT('SCItemClothingParams')}.TemperatureResistance.MaxResistance`, scale: 1 },
  GPP_Armor_RadiationDissipation: { path: `${COMPONENT('SCItemClothingParams')}.RadiationResistance.RadiationDissipationRate`, scale: 1 },
  // The share of physical damage taken off: mediumarmor.json's multiplier 0.7 -> "Damage Mitigation: 0.30"
  GPP_Armor_DamageMitigation: {
    link: `${COMPONENT('SCItemSuitArmorParams')}.damageResistance`,
    path: '$.damageResistance.PhysicalResistance.Multiplier',
    scale: -1,
    offset: 1,
  },
};

/** The tooltip's value for a record value; null when the record holds no number there. */
export function baseValue(key: string, raw: unknown): number | null {
  const spec = BASE_PATHS[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!spec || !Number.isFinite(n)) return null;
  // Rounded: 1 - 0.7 is 0.30000000000000004
  return Math.round(((spec.offset ?? 0) + n * spec.scale) * 1e9) / 1e9;
}

/** How the tooltip shows a stat, from its crafted property's display transformation: its absolute value
 * (converted with the base), or its change in percent ("Impact Force: +6.11 %", "Recoil Kick: -28.44 %"),
 * negated for some ("Recoil Smoothness: +28.44 %" for a factor of 0.72). */
export type TooltipForm = 'value' | 'change' | 'negatedChange';

export function tooltipForm(transformation: unknown): TooltipForm {
  const types: string[] = [];
  const collect = (t: unknown) => {
    if (typeof t !== 'object' || t === null) return;
    const o = t as { _Type_?: unknown; transformations?: unknown };
    if (typeof o._Type_ === 'string') types.push(o._Type_);
    if (Array.isArray(o.transformations)) o.transformations.forEach(collect);
  };
  collect(transformation);
  if (types.includes('CraftingDisplayTransformation_ConvertFactorToNegatedPercentChange')) return 'negatedChange';
  if (types.includes('CraftingDisplayTransformation_ConvertFactorToPercentChange')) return 'change';
  return 'value';
}
