// Which items are ship components: by the item type of their DataCore record (`AttachDef.Type`),
// crafted or not (decided 2026-10-18: looted and bought components are stock too, the catalog takes
// every ship item of these types, not only blueprint outputs). Shared by the extractor (which items
// go into the snapshot) and the stock service (what is bookable as a component). Pure.

/** The item types that count as ship components: the types the component blueprints produce
 * (coolers, power plants, shields, quantum drives, radars, ship guns, mining lasers, tractor beams,
 * docking collars, salvage and mining modules, containers, salvage heads) plus missiles, missile
 * racks, turrets, quantum interdiction devices and EMPs. */
export const COMPONENT_TYPES: readonly string[] = [
  'Cooler', 'PowerPlant', 'Shield', 'QuantumDrive', 'Radar', 'WeaponGun', 'WeaponMining', 'TractorBeam',
  'DockingCollar', 'SalvageModifier', 'MiningModifier', 'Container', 'SalvageHead',
  'Missile', 'MissileLauncher', 'Turret', 'TurretBase', 'QuantumInterdictionGenerator', 'EMP',
];

export const isComponentType = (type: string | null | undefined): boolean => !!type && COMPONENT_TYPES.includes(type);
