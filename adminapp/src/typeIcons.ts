// Icon per item type (AttachDef.Type). Unknown types (e.g. after a patch) get the generic item icon.
import type { IconName } from "./components/Icon.vue";

const TYPE_ICONS: Record<string, IconName> = {
  Char_Armor_Helmet: "type-helmet",
  Char_Armor_Torso: "type-torso",
  Char_Armor_Arms: "type-arms",
  Char_Armor_Legs: "type-legs",
  Char_Armor_Backpack: "type-backpack",
  Char_Armor_Undersuit: "type-undersuit",
  Char_Clothing_Torso_0: "type-shirt",
  Char_Clothing_Torso_1: "type-shirt",
  Char_Clothing_Legs: "type-legs",
  Char_Clothing_Feet: "type-footwear",
  Cooler: "type-cooler",
  PowerPlant: "type-power",
  Shield: "type-shield",
  QuantumDrive: "type-quantum",
  Radar: "type-radar",
  WeaponGun: "type-gun",
  WeaponPersonal: "type-personal-weapon",
  WeaponAttachment: "type-attachment",
  WeaponMining: "type-mining-laser",
  MiningModifier: "type-module",
  SalvageModifier: "type-module",
  SalvageHead: "type-salvage",
  TractorBeam: "type-tractor",
  DockingCollar: "type-docking",
  Container: "type-crate",
  Cargo: "type-crate",
  Misc: "item",
};

export const typeIcon = (type: string | null | undefined): IconName => (type && TYPE_ICONS[type]) || "item";
