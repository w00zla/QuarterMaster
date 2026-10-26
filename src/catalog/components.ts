// Which items are gear: ship components and FPS gear, by the item type of their DataCore record
// (`AttachDef.Type`/`SubType`), crafted or not (decided 2026-10-18: looted and bought components are
// stock too, the catalog takes every ship item of these types, not only blueprint outputs; FPS gear
// likewise since 2026-10-22). Shared by the extractor (which items go into the snapshot) and the stock
// service (what is bookable as gear). Pure.

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

/** FPS gear per item type: the sub types that count, null = all. Personal weapons (incl. knives and
 * gadgets like the multitool, tractor and salvage tools), their attachments (optics, barrels,
 * underbarrels, multitool heads), mining gadgets and armor incl. undersuit and backpack. Nothing
 * stackable (decided 2026-10-20, again 2026-10-22): no grenades, magazines, medpens, food. */
export const FPS_TYPES: Readonly<Record<string, readonly string[] | null>> = {
  WeaponPersonal: ['Small', 'Medium', 'Large', 'Knife', 'Gadget'],
  WeaponAttachment: ['IronSight', 'Barrel', 'BottomAttachment', 'Utility'],
  Gadget: ['Gadget'],
  Char_Armor_Helmet: null,
  Char_Armor_Torso: null,
  Char_Armor_Arms: null,
  Char_Armor_Legs: null,
  Char_Armor_Backpack: null,
  Char_Armor_Undersuit: null,
};

export function isFpsType(type: string | null | undefined, subType: string | null | undefined): boolean {
  if (!type || !Object.hasOwn(FPS_TYPES, type)) return false;
  const subTypes = FPS_TYPES[type];
  return !subTypes || (!!subType && subTypes.includes(subType));
}

/** SQL condition: the catalog.item row `alias` has an FPS gear type (as isFpsType). */
export const fpsTypeSql = (alias: string): string => `(${Object.entries(FPS_TYPES).map(([type, subTypes]) =>
  `(${alias}.type = '${type}'${subTypes ? ` AND ${alias}.sub_type IN (${subTypes.map((s) => `'${s}'`).join(', ')})` : ''})`).join(' OR ')})`;
