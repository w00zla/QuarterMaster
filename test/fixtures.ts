// Synthetic DataCore records (no real game data) in the shape StarBreaker exports them.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseGlobalIni } from '../src/catalog/extract/localization.ts';
import { normalize } from '../src/catalog/extract/normalize.ts';
import { RecordStore } from '../src/catalog/extract/records.ts';
import type { Snapshot } from '../src/catalog/snapshot.ts';

export const U = {
  rtdb: '10000000-0000-0000-0000-000000000001',
  metal: '10000000-0000-0000-0000-000000000002',
  ore: '10000000-0000-0000-0000-000000000003',
  quantization: '10000000-0000-0000-0000-000000000004',
  distribution: '10000000-0000-0000-0000-000000000005',
  property: '10000000-0000-0000-0000-000000000006',
  catdb: '10000000-0000-0000-0000-000000000007',
  category: '10000000-0000-0000-0000-000000000008',
  globalParams: '10000000-0000-0000-0000-000000000009',
  manufacturer: '10000000-0000-0000-0000-00000000000a',
  output: '10000000-0000-0000-0000-00000000000b',
  gem: '10000000-0000-0000-0000-00000000000c',
  blueprint: '10000000-0000-0000-0000-00000000000d',
  blueprint2: '10000000-0000-0000-0000-00000000000e',
  pool: '10000000-0000-0000-0000-00000000000f',
  starmapTypes: '10000000-0000-0000-0000-000000000010',
  typeStar: '10000000-0000-0000-0000-000000000011',
  typeStation: '10000000-0000-0000-0000-000000000012',
  star: '10000000-0000-0000-0000-000000000013',
  station: '10000000-0000-0000-0000-000000000014',
  orphan: '10000000-0000-0000-0000-000000000015',
  marker: '10000000-0000-0000-0000-000000000016',
};

const R = 'libs/foundry/records/';
const ref = (path: string) => `file://./../../../../${R}${path}`;
const rec = (name: string, id: string, value: Record<string, unknown>) => ({ _RecordName_: name, _RecordId_: id, _RecordTag_: 'Test', _RecordValue_: value });

const metal = {
  _RecordId_: U.metal, _RecordName_: 'ResourceType.TestMetal', _Type_: 'ResourceType',
  displayName: '@items_commodities_testmetal', description: '@items_commodities_testmetal_desc',
  densityType: { _Type_: 'ResourceTypeDensity', densityUnit: { _Type_: 'GramsPerCubicCentimeter', gramsPerCubicCentimeter: 1.0 } },
  properties: [], refinedVersion: null,
  defaultCargoContainers: { _Type_: 'SResourceTypeDefaultCargoContainers', one_eighthSCU: ref('x.json'), oneSCU: ref('y.json'), twoSCU: null },
};

const slot = (debugName: string, displayName: string, options: unknown[], context: unknown[] = []) => ({
  _Type_: 'CraftingCost_Select', context, nameInfo: { _Type_: 'CraftingNameInfo', debugName, displayName }, count: 1, options,
});

const modifier = (ranges: unknown[]) => ({
  _Type_: 'CraftingCostContext_ResultGameplayPropertyModifiers',
  gameplayPropertyModifiers: {
    _Type_: 'CraftingGameplayPropertyModifiers_List',
    gameplayPropertyModifiers: [{
      _Type_: 'CraftingGameplayPropertyModifierCommon', gameplayPropertyRecord: ref('crafting/craftedproperties/gpp_test.json'), valueRanges: ranges,
    }],
  },
});

const blueprintRecord = (id: string, name: string, rootCount: number, slots: unknown[], output: string | null) => rec(`CraftingBlueprintRecord.${name}`, id, {
  _Type_: 'CraftingBlueprintRecord',
  blueprint: {
    _Type_: 'CraftingBlueprint',
    category: { _RecordPath_: ref('crafting/blueprintcategories/blueprintcategorydatabase.json'), _RecordName_: 'BlueprintCategoryRecord.TestCat', _RecordId_: U.category },
    blueprintName: '@LOC_PLACEHOLDER',
    processSpecificData: { _Type_: 'CraftingProcess_Creation', entityClass: output },
    tiers: [{
      _Type_: 'CraftingBlueprintTier',
      recipe: {
        _Type_: 'CraftingRecipe',
        costs: {
          _Type_: 'CraftingRecipeCosts',
          craftTime: { _Type_: 'TimeValue_Partitioned', days: 0, hours: 0, minutes: 2, seconds: 30.0 },
          mandatoryCost: { _Type_: 'CraftingCost_Select', context: [], nameInfo: { debugName: 'ASPECTS' }, count: rootCount, options: slots },
          optionalCosts: [],
        },
      },
      research: { _Type_: 'CraftingResearch', unlockRequirements: null, researchCosts: null },
    }],
  },
});

const starMapObject = (name: string, id: string, fields: Record<string, unknown>) => rec(`StarMapObject.${name}`, id, {
  _Type_: 'StarMapObject', name: `@${name}`, description: '@LOC_UNINITIALIZED', parent: null, type: null,
  navIcon: 'Default', hideInStarmap: false, respawnLocationType: 'None', ...fields,
});
const starMapType = (id: string) => ({ _RecordPath_: ref('starmap/starmapobjecttypes.json'), _RecordName_: `StarMapObjectType.${id}`, _RecordId_: id });

export const RECORDS: Record<string, unknown> = {
  'resourcetypedatabase/resourcetypedatabase.json': rec('ResourceTypeDatabase.Main', U.rtdb, {
    _Type_: 'ResourceTypeDatabase',
    groups: [
      { _RecordId_: '20000000-0000-0000-0000-000000000001', _RecordName_: 'ResourceTypeGroup.Metal', _Type_: 'ResourceTypeGroup', resources: [metal], groups: [] },
      {
        _RecordId_: '20000000-0000-0000-0000-000000000002', _RecordName_: 'ResourceTypeGroup.UnrefinedOres', _Type_: 'ResourceTypeGroup', groups: [],
        resources: [{
          ...metal, _RecordId_: U.ore, _RecordName_: 'ResourceType.Ore_TestMetal', displayName: '@items_commodities_testmetal_ore',
          refinedVersion: metal,
          properties: [null, {
            _Type_: 'ResourceTypeCraftingData', name: 'Default',
            qualityDistribution: { _Type_: 'CraftingQualityDistribution_RecordRef', qualityDistributionRecord: ref('crafting/qualitydistribution/test.json') },
            qualityLocationOverride: null,
            qualityQuantization: { _Type_: 'CraftingQualityQuantization_RecordRef', qualityQuantizationRecord: ref('crafting/qualityquantization/quantization_test.json') },
          }],
        }],
      },
    ],
  }),
  'crafting/qualityquantization/quantization_test.json': rec('CraftingQualityQuantizationRecord.Quantization_Test', U.quantization, {
    _Type_: 'CraftingQualityQuantizationRecord',
    qualityQuantization: { _Type_: 'CraftingQualityQuantization', bands: [
      { _Type_: 'CraftingQualityQuantizationBand', start: 0, end: 499, mappedValue: 400 },
      { _Type_: 'CraftingQualityQuantizationBand', start: 500, end: 1000, mappedValue: 900 },
    ] },
  }),
  'crafting/qualitydistribution/test.json': rec('CraftingQualityDistributionRecord.Test', U.distribution, { _Type_: 'CraftingQualityDistributionRecord' }),
  'crafting/craftedproperties/gpp_test.json': rec('CraftingGameplayPropertyDef.GPP_Test', U.property, {
    _Type_: 'CraftingGameplayPropertyDef', propertyName: '@StatName_GPP_Test', unitFormat: '@StatUnit_Test',
    displayTransformation: { _Type_: 'CraftingDisplayTransformation_Scale', scale: 0.001 }, nameOverrides: [],
  }),
  'crafting/blueprintcategories/blueprintcategorydatabase.json': rec('BlueprintCategoryDatabaseRecord.Main', U.catdb, {
    _Type_: 'BlueprintCategoryDatabaseRecord',
    categories: [{ _RecordId_: U.category, _RecordName_: 'BlueprintCategoryRecord.TestCat', _Type_: 'BlueprintCategoryRecord' }],
  }),
  'crafting/globalparams/craftingglobalparams.json': rec('CraftingGlobalParams.Main', U.globalParams, {
    _Type_: 'CraftingGlobalParams',
    defaultBlueprintSelection: { _Type_: 'DefaultBlueprintSelection_Whitelist', blueprintRecords: [ref('crafting/blueprints/crafting/bp_craft_test.json')] },
  }),
  'crafting/blueprintrewards/pool.json': rec('BlueprintPoolRecord.Pool', U.pool, {
    _Type_: 'BlueprintPoolRecord', blueprintRewards: [null, { _Type_: 'BlueprintReward', weight: 1, blueprintRecord: ref('crafting/blueprints/crafting/bp_craft_test2.json') }],
  }),
  'crafting/blueprints/crafting/bp_craft_test.json': blueprintRecord(U.blueprint, 'BP_CRAFT_Test', 2, [
    slot('FRAME', '@crafting_ui_slotname_frame', [
      { _Type_: 'CraftingCost_Resource', context: [], resource: { _RecordName_: 'ResourceType.TestMetal', _RecordId_: U.metal }, quantity: { _Type_: 'SStandardCargoUnit', standardCargoUnits: 0.046 }, minQuality: 1 },
    ], [modifier([
      null,
      { _Type_: 'CraftingGameplayPropertyModifierValueRange_Linear', startQuality: 0, endQuality: 500, modifierAtStart: 0.8, modifierAtEnd: 1.0 },
      { _Type_: 'CraftingGameplayPropertyModifierValueRange_LinearIntegerAdditive', startQuality: 501, endQuality: 1000, additiveModifierAtStart: 1, additiveModifierAtEnd: 2 },
    ]), null]),
    slot('EMITTER', '@crafting_ui_slotname_emitter', [
      { _Type_: 'CraftingCost_Item', context: [], entityClass: ref('entities/scitem/carryables/test_gem.json'), quantity: 7, minQuality: 0 },
    ]),
    slot('NESTED', '@LOC_PLACEHOLDER', [{ _Type_: 'CraftingCost_Select', options: [] }]),
  ], ref('entities/scitem/ships/test_output.json')),
  'crafting/blueprints/crafting/bp_craft_test2.json': blueprintRecord(U.blueprint2, 'BP_CRAFT_Test2', 1, [], null),
  'entities/scitem/ships/test_output.json': rec('EntityClassDefinition.TEST_Output', U.output, {
    _Type_: 'EntityClassDefinition',
    Components: [{ _Type_: 'SAttachableComponentParams', AttachDef: {
      Type: 'Cooler', SubType: 'UNDEFINED', Size: 2, Grade: 3, Manufacturer: ref('scitemmanufacturer/scitemmanufacturer.test.json'),
      Localization: { Name: '@item_NameTEST_Output', Description: '@item_DescTEST_Output' },
    } }],
  }),
  'entities/scitem/carryables/test_gem.json': rec('EntityClassDefinition.TEST_Gem', U.gem, {
    _Type_: 'EntityClassDefinition',
    Components: [{ _Type_: 'SAttachableComponentParams', AttachDef: { Type: 'Misc', SubType: 'Harvestable', Localization: { Name: '@items_commodities_testgem' } } }],
  }),
  'starmap/starmapobjecttypes.json': rec('StarMapObjectTypes.StarMapObjectTypes', U.starmapTypes, {
    _Type_: 'StarMapObjectTypes',
    types: [
      { _RecordId_: U.typeStar, _RecordName_: `StarMapObjectType.${U.typeStar}`, _Type_: 'StarMapObjectType', name: 'Star' },
      null,
      { _RecordId_: U.typeStation, _RecordName_: `StarMapObjectType.${U.typeStation}`, _Type_: 'StarMapObjectType', name: 'Manmade' },
    ],
  }),
  'starmap/pu/system/test/teststar.json': starMapObject('TestStar', U.star, { type: starMapType(U.typeStar), navIcon: 'Star' }),
  'starmap/pu/station/test_station.json': starMapObject('Test_Station', U.station, {
    description: '@Test_Station_Desc', parent: ref('starmap/pu/system/test/teststar.json'), type: starMapType(U.typeStation),
    navIcon: 'Station', respawnLocationType: 'Hospital',
  }),
  // Dangling parent and an unknown object type
  'starmap/pu/station/test_orphan.json': starMapObject('Test_Orphan', U.orphan, {
    name: '@LOC_UNINITIALIZED', parent: ref('starmap/pu/system/gone.json'), type: starMapType('10000000-0000-0000-0000-0000000000ff'), hideInStarmap: true,
  }),
  // Not a StarMapObject: raw only
  'starmap/smdefaultmissionmarker.json': rec('MissionMarker.Default', U.marker, { _Type_: 'StarMapMissionMarker' }),
  'scitemmanufacturer/scitemmanufacturer.test.json': rec('SCItemManufacturer.TEST', U.manufacturer, {
    _Type_: 'SCItemManufacturer', Code: 'TEST', Localization: { Name: '@manufacturer_NameTEST', Description: '@LOC_EMPTY' },
  }),
};

export const INI_EN = '\uFEFFitems_commodities_testmetal=Test Metal\r\nitems_commodities_testmetal_ore=Test Metal (Ore)\r\n'
  + 'item_NameTEST_Output=Test Cooler \\n\r\ncrafting_ui_slotname_frame,P=Frame\r\nunrelated_key=Not referenced\r\n'
  + 'item_DescTEST_Output=Item Type: Cooler\\nGrade: B\\nClass: Military\\n\\nKeeps things cool.\r\n'
  + 'Test_Station=Test Station\r\n';
export const INI_DE = '\uFEFFitems_commodities_testmetal=Testmetall\r\n'
  + 'item_NameTEST_Output=! GERMAN_(GERMANY) TRANSLATION NOT FOUND FOR LOCID: item_NameTEST_Output !\r\n';

/** Writes the synthetic records to a temp dir and returns their store root. */
export function writeRecords(records: Record<string, unknown> = RECORDS): string {
  const root = mkdtempSync(join(tmpdir(), 'sc-qm-records-'));
  for (const [path, record] of Object.entries(records)) {
    const file = join(root, R, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record));
  }
  return root;
}

export function fixtureSnapshot(records: Record<string, unknown> = RECORDS): Snapshot {
  return normalize({
    store: new RecordStore(writeRecords(records)),
    localizations: new Map([['en', parseGlobalIni(INI_EN)], ['de', parseGlobalIni(INI_DE)]]),
    game: { channel: 'LIVE', build: 1000, branch: 'test', version: '1.0', label: null, manifest: {} },
    extractor: { version: 'test', starbreaker: 'test' },
  });
}
