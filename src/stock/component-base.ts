// Where a component's unmodified stat values sit in its DataCore record (`catalog.raw_record`),
// per crafted property: the game's tooltip shows these absolute values ("Coolant Rating: 60.00"), the
// stock stores a crafted component's gain over them in percent or steps (`component-stats.ts`). The
// API consumers that read the tooltip need the base to tell the gain. Checked 2026-10-18 against the
// user's inventory screenshots (HeatSafe 22 / 110, Blizzard 60 / 1800, Atlas 259.05 / 200, CoverAll
// 10560 / 660), the FPS gear 2026-10-22 (Gallant 900 RPM, CQ7 650 -> 713.49 crafted, Artimex Canuto
// 0.30 / -61 / +91 / 145.80). Properties missing here have no known tooltip format (tractor, salvage
// heads): their base stays null and such components are to be registered without stats only when
// the tooltip shows none. Properties the tooltip shows as a change in percent (`tooltipForm`) need none.

interface BasePath {
  // A Postgres jsonpath into the record (lax mode: the first match counts)
  path: string;
  // A jsonpath to a link ("file://…/libs/foundry/records/…json") in the item's record: `path` is then
  // read in the linked record
  link?: string;
  // offset + record value × scale = the tooltip's value; with `reciprocal` scale / record value (a
  // period: "1.2" seconds per shot = 50 RPM)
  scale: number;
  offset?: number;
  reciprocal?: boolean;
  // Where the record holds no number at `path`: these, the first that holds one counts
  fallbacks?: BasePath[];
}

const COMPONENT = (type: string) => `$.Components[*] ? (@._Type_ == "${type}")`;
const GENERATION = (resource: string) =>
  `${COMPONENT('ItemResourceComponentParams')}.states[*].deltas[*].generation ? (@.resource == "${resource}").resourceAmountPerSecond`;

/** Crafted property key -> where its base value is. */
const BASE_PATHS: Record<string, BasePath> = {
  GPP_Health_MaxHealth: { path: `${COMPONENT('SHealthComponentParams')}.Health`, scale: 1 },
  GPP_ItemResource_CoolantGeneration: { path: `${GENERATION('Coolant')}.standardResourceUnits`, scale: 1 },
  GPP_ItemResource_PowerGeneration: { path: `${GENERATION('Power')}.units`, scale: 1 },
  GPP_Shield_MaxHealth: { path: `${COMPONENT('SCItemShieldGeneratorParams')}.MaxShieldHealth`, scale: 1 },
  GPP_Quantum_Speed: { path: `${COMPONENT('SCItemQuantumDriveParams')}.params.driveSpeed`, scale: 1e-6 },
  GPP_Quantum_FuelRequirement: { path: `${COMPONENT('SCItemQuantumDriveParams')}.quantumFuelRequirement`, scale: 1000 },
  GPP_Radar_MaxAimAssistDistance: { path: `${COMPONENT('SCItemRadarComponentParams')}.aimAssist.distanceMaxAssignment`, scale: 1 },
  GPP_Radar_MinAimAssistDistance: { path: `${COMPONENT('SCItemRadarComponentParams')}.aimAssist.distanceMinAssignment`, scale: 1 },
  // The first fire mode's rate; a looping sequence (29 weapons in 4.10: Lumin V, Killshot, Ravager,
  // Scalpel, Animus) has none there, its first entry's pace is the tooltip's rate, not the shots' inside
  // it: Lumin V 625 RPM (its bursts 700), Killshot 535 (600), Scalpel 1.2 seconds = 50 RPM (2026-10-31,
  // the user's recordings). UNCHECKED, possibly wrong (no tooltip seen yet; 2026-10-31): a charged first
  // action's shot after the charge (Arrowhead 70, Devastator 60, Salvo 170; the charge time not counted)
  // and a parallel one's first shot (Tripledown: three of 60 at once). A beam (Ripper "Sunblock") holds
  // no rate anywhere: left null
  GPP_Weapon_FireRate: {
    path: `${COMPONENT('SCItemWeaponComponentParams')}.fireActions[0].fireRate`,
    scale: 1,
    fallbacks: [
      { path: `${COMPONENT('SCItemWeaponComponentParams')}.fireActions[0].sequenceEntries[0] ? (@.unit == "RPM").delay`, scale: 1 },
      { path: `${COMPONENT('SCItemWeaponComponentParams')}.fireActions[0].sequenceEntries[0] ? (@.unit == "Seconds").delay`, scale: 60, reciprocal: true },
      { path: `${COMPONENT('SCItemWeaponComponentParams')}.fireActions[0] ? (@._Type_ == "SWeaponActionFireChargedParams").weaponAction.fireRate`, scale: 1 },
      { path: `${COMPONENT('SCItemWeaponComponentParams')}.fireActions[0] ? (@._Type_ == "SWeaponActionParallelParams").weaponActions[0].fireRate`, scale: 1 },
    ],
  },
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

/** Every place a base can be: [property key, its rank (0 = `path`, then the fallbacks), the place]. */
export function basePaths(): [string, number, BasePath][] {
  return Object.entries(BASE_PATHS).flatMap(([key, p]) => [p, ...(p.fallbacks ?? [])].map((place, rank) => [key, rank, place] as [string, number, BasePath]));
}

/** The tooltip's value for a record value found at the place of `rank` (`basePaths`); null when the
 * record holds no number there. */
export function baseValue(key: string, raw: unknown, rank = 0): number | null {
  const spec = basePaths().find(([k, r]) => k === key && r === rank)?.[2];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!spec || !Number.isFinite(n) || (spec.reciprocal && n === 0)) return null;
  // Rounded: 1 - 0.7 is 0.30000000000000004
  return Math.round(((spec.offset ?? 0) + (spec.reciprocal ? spec.scale / n : n * spec.scale)) * 1e9) / 1e9;
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
