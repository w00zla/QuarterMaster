// Where a ship component's unmodified stat values sit in its DataCore record (`catalog.raw_record`),
// per crafted property: the game's tooltip shows these absolute values ("Coolant Rating: 60.00"), the
// stock stores a crafted component's gain over them in percent or steps (`component-stats.ts`). The
// companion app reads the tooltip and needs the base to tell the gain. Checked 2026-10-18 against the
// user's inventory screenshots (HeatSafe 22 / 110, Blizzard 60 / 1800, Atlas 259.05 / 200, CoverAll
// 10560 / 660). Properties missing here have no known tooltip format (weapons, tractor, salvage
// heads): their base stays null and the companion registers such components without stats only when
// the tooltip shows none.

export interface BasePath {
  // A Postgres jsonpath into the record (lax mode: the first match counts)
  path: string;
  // Record value × scale = the tooltip's value
  scale: number;
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
};

/** The tooltip's value for a record value; null when the record holds no number there. */
export function baseValue(key: string, raw: unknown): number | null {
  const spec = BASE_PATHS[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!spec || !Number.isFinite(n)) return null;
  return n * spec.scale;
}
