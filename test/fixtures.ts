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
  generator: '10000000-0000-0000-0000-000000000017',
  contract: '10000000-0000-0000-0000-000000000018',
  unreleased: '10000000-0000-0000-0000-000000000019',
  template: '10000000-0000-0000-0000-00000000001a',
  missionType: '10000000-0000-0000-0000-00000000001b',
  faction: '10000000-0000-0000-0000-00000000001c',
  rank: '10000000-0000-0000-0000-00000000001d',
  locality: '10000000-0000-0000-0000-00000000001e',
  scenario: '10000000-0000-0000-0000-00000000001f',
  progress: '10000000-0000-0000-0000-000000000020',
  provider: '10000000-0000-0000-0000-000000000022',
  unusedProvider: '10000000-0000-0000-0000-000000000023',
  solarSystem: '10000000-0000-0000-0000-00000000002f',
  qualityOverride: '10000000-0000-0000-0000-000000000039',
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
            qualityLocationOverride: { _Type_: 'CraftingQualityLocationOverride_RecordRef', locationOverrideRecord: ref('crafting/qualitydistribution/test_override.json') },
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
  'crafting/qualitydistribution/test.json': rec('CraftingQualityDistributionRecord.Test', U.distribution, {
    _Type_: 'CraftingQualityDistributionRecord',
    qualityDistribution: { _Type_: 'CraftingQualityDistributionNormal', min: 501, max: 1000, mean: 500, stddev: 150 },
  }),
  // The system's override: its solar system record is a root of its own, not the station's ancestor
  'crafting/qualitydistribution/test_override.json': rec('CraftingQualityLocationOverrideRecord.Test_Override', U.qualityOverride, {
    _Type_: 'CraftingQualityLocationOverrideRecord',
    locationOverride: { _Type_: 'CraftingQualityLocationOverride', locationOverrideList: [{
      _Type_: 'CraftingQualityLocationOverrideEntry', location: ref('starmap/pu/testsolarsystem.json'),
      qualityDistribution: { _Type_: 'CraftingQualityDistributionNormal', min: 1, max: 499, mean: 300, stddev: 50 },
    }] },
  }),
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
  'starmap/pu/testsolarsystem.json': starMapObject('TestSolarSystem', U.solarSystem, {}),
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
  // Blueprint sources: one released contract handing out the pool on accept (half the time), one not for
  // release, one without blueprints; an event tier handing out the same pool
  'contracts/contractgenerator/test/test_generator.json': rec('ContractGenerator.Test', U.generator, {
    _Type_: 'ContractGenerator',
    generators: [{
      _Type_: 'ContractGeneratorHandler_Career', notForRelease: false, debugName: 'Test_Handler',
      required_active_scenarios: [ref('missionscenarios/test_missionscenario.json')],
      defaultAvailability: { _Type_: 'ContractAvailability', prerequisites: [
        { _Type_: 'ContractPrerequisite_Locality', localityAvailable: ref('missiondata/pu_missionlocality/test.json') },
        { _Type_: 'ContractPrerequisite_CompletedContractTags', requiredCompletedContractTags: { _Type_: 'TagList', tags: [] } },
        null,
      ] },
      contractParams: { _Type_: 'ContractParamOverrides', stringParamOverrides: [{ _Type_: 'ContractStringParam', param: 'Title', value: '@Test_Mission_Title' }] },
      factionReputation: ref('factions/factionreputation/test_faction.json'),
      contracts: [
        {
          _Type_: 'CareerContract', id: U.contract, notForRelease: false, debugName: 'Test_Mission',
          template: ref('contracts/contracttemplates/test_template.json'), required_active_scenarios: [],
          paramOverrides: { _Type_: 'ContractParamOverrides', stringParamOverrides: [] },
          additionalPrerequisites: [{ _Type_: 'ContractPrerequisite_Location', locationAvailable: ref('starmap/pu/station/test_station.json') }],
          contractResults: { _Type_: 'ContractResults', contractResults: [
            { _Type_: 'ContractResult_CalculatedReward', missionResults: [true, false, false, false, false] },
            { _Type_: 'BlueprintRewards', blueprintPool: ref('crafting/blueprintrewards/pool.json'), chance: 0.5, missionResults: [false, true, false, false, false] },
          ] },
          minStanding: ref('reputation/standings/test_rank1.json'),
        },
        {
          _Type_: 'CareerContract', id: U.unreleased, notForRelease: true, debugName: 'Test_Unreleased',
          contractResults: { _Type_: 'ContractResults', contractResults: [{ _Type_: 'BlueprintRewards', blueprintPool: ref('crafting/blueprintrewards/pool.json'), chance: 1 }] },
        },
        { _Type_: 'CareerContract', id: '10000000-0000-0000-0000-000000000021', notForRelease: false, debugName: 'Test_NoBlueprints', contractResults: null },
      ],
    }],
  }),
  'contracts/contracttemplates/test_template.json': rec('ContractTemplate.Test', U.template, {
    _Type_: 'ContractTemplate', contractDisplayInfo: { _Type_: 'ContractDisplayInfo', type: ref('missiontype/test_type.json'), illegal: true },
  }),
  'contracts/contractscenarios/testevent_scenarioprogress.json': rec('ScenarioProgress.TestEvent_ScenarioProgress', U.progress, {
    _Type_: 'ScenarioProgress',
    factionRewardTiers: [{ _Type_: 'SScenarioProgressRewardsTiers', tierProgressions: [{ _Type_: 'STierProgressions', tierRewards: [
      { _Type_: 'STierReward', minPoints: 1000, blueprintPool: [ref('crafting/blueprintrewards/pool.json')] },
      { _Type_: 'STierReward', minPoints: 2000, blueprintPool: [] },
    ] }] }],
  }),
  'missionscenarios/test_missionscenario.json': rec('MissionScenario.Test_MissionScenario', U.scenario, {
    _Type_: 'MissionScenario', name: 'Test_Scenario', schedule: { _Type_: 'MissionScenarioSchedule', enabled: false },
  }),
  'missiontype/test_type.json': rec('MissionType.Test', U.missionType, { _Type_: 'MissionType', LocalisedTypeName: '@test_mission_type' }),
  'missiondata/pu_missionlocality/test.json': rec('MissionLocality.Test', U.locality, {
    _Type_: 'MissionLocality', availableLocations: [ref('starmap/pu/system/test/teststar.json')],
  }),
  'factions/factionreputation/test_faction.json': rec('FactionReputation.Test', U.faction, { _Type_: 'FactionReputation', displayName: '@Test_Faction' }),
  'reputation/standings/test_rank1.json': rec('SReputationStandingParams.Test_Rank1', U.rank, {
    _Type_: 'SReputationStandingParams', displayName: '@test_rank1', minReputation: 800,
  }),
  // Mining: a provider with ship rocks (a common one holding the ore twice, a rare one) and a gem rock for
  // hand mining; salvage is no mining; a provider no object container uses
  'harvestable/providerpresets/system/test/hpp_test.json': rec('HarvestableProviderPreset.HPP_Test', U.provider, {
    _Type_: 'HarvestableProviderPreset',
    harvestableGroups: [
      { _Type_: 'HarvestableElementGroup', groupName: 'SpaceShip_Mineables', groupProbability: 6, harvestables: [
        { _Type_: 'HarvestableElement', harvestable: ref('harvestable/harvestablepresets/mining_common_test.json'), relativeProbability: 3 },
        { _Type_: 'HarvestableElement', harvestable: ref('harvestable/harvestablepresets/mining_rare_test.json'), relativeProbability: 1 },
      ] },
      { _Type_: 'HarvestableElementGroup', groupName: 'FPS_Mineables', groupProbability: 25, harvestables: [
        { _Type_: 'HarvestableElement', harvestable: ref('harvestable/harvestablepresets/fpsmining_test_gem.json'), relativeProbability: 1 },
      ] },
      { _Type_: 'HarvestableElementGroup', groupName: 'Salvage_FreshDerelicts', groupProbability: 1, harvestables: [
        { _Type_: 'HarvestableElement', harvestable: ref('harvestable/harvestablepresets/salvage_test.json'), relativeProbability: 1 },
      ] },
    ],
  }),
  'harvestable/providerpresets/system/test/hpp_unused.json': rec('HarvestableProviderPreset.HPP_Unused', U.unusedProvider, {
    _Type_: 'HarvestableProviderPreset',
    harvestableGroups: [{ _Type_: 'HarvestableElementGroup', groupName: 'SpaceShip_Mineables', harvestables: [
      { _Type_: 'HarvestableElement', harvestable: ref('harvestable/harvestablepresets/mining_common_test.json'), relativeProbability: 1 },
    ] }],
  }),
  'harvestable/harvestablepresets/mining_common_test.json': rec('HarvestablePreset.Mining_Common_Test', '10000000-0000-0000-0000-000000000024', {
    _Type_: 'HarvestablePreset', entityClass: ref('entities/mineable/mineablerock_common_test.json'),
  }),
  'harvestable/harvestablepresets/mining_rare_test.json': rec('HarvestablePreset.Mining_Rare_Test', '10000000-0000-0000-0000-000000000025', {
    _Type_: 'HarvestablePreset', entityClass: ref('entities/mineable/mineablerock_rare_test.json'),
  }),
  'harvestable/harvestablepresets/fpsmining_test_gem.json': rec('HarvestablePreset.FPSMining_Test_Gem', '10000000-0000-0000-0000-000000000026', {
    _Type_: 'HarvestablePreset', entityClass: ref('entities/mineable/mineablerock_fps_test_gem.json'),
  }),
  'entities/mineable/mineablerock_common_test.json': rec('EntityClassDefinition.MineableRock_Common_Test', '10000000-0000-0000-0000-000000000027', {
    _Type_: 'EntityClassDefinition', Components: [{ _Type_: 'MineableParams', composition: ref('mining/rockcompositionpresets/commonshipmineables_test.json') }],
  }),
  'entities/mineable/mineablerock_rare_test.json': rec('EntityClassDefinition.MineableRock_Rare_Test', '10000000-0000-0000-0000-000000000028', {
    _Type_: 'EntityClassDefinition', Components: [{ _Type_: 'MineableParams', composition: ref('mining/rockcompositionpresets/rareshipmineables_test.json') }],
  }),
  'entities/mineable/mineablerock_fps_test_gem.json': rec('EntityClassDefinition.MineableRock_FPS_Test_Gem', '10000000-0000-0000-0000-000000000029', {
    _Type_: 'EntityClassDefinition', Components: [
      null,
      { _Type_: 'MineableParams', composition: ref('mining/rockcompositionpresets/fps_composition_test_gem.json') },
      { _Type_: 'EntityComponentBreakable', entityClassOverride: { _Type_: 'BreakableEntityClassParams', entityClass: ref('entities/scitem/carryables/test_gem.json') } },
    ],
  }),
  'mining/rockcompositionpresets/commonshipmineables_test.json': rec('MineableComposition.CommonShipMineables_Test', '10000000-0000-0000-0000-00000000002a', {
    _Type_: 'MineableComposition', compositionArray: [
      { _Type_: 'MineableCompositionPart', mineableElement: ref('mining/mineableelements/test_ore.json'), minPercentage: 2, maxPercentage: 6 },
      { _Type_: 'MineableCompositionPart', mineableElement: ref('mining/mineableelements/test_ore.json'), minPercentage: 40, maxPercentage: 80, probability: 1, qualityScale: 0.49 },
    ],
  }),
  'mining/rockcompositionpresets/rareshipmineables_test.json': rec('MineableComposition.RareShipMineables_Test', '10000000-0000-0000-0000-00000000002b', {
    _Type_: 'MineableComposition', compositionArray: [
      { _Type_: 'MineableCompositionPart', mineableElement: ref('mining/mineableelements/test_ore.json'), minPercentage: 10, maxPercentage: 30, probability: 0.5 },
      { _Type_: 'MineableCompositionPart', mineableElement: ref('mining/mineableelements/gone.json'), minPercentage: 1, maxPercentage: 2 },
    ],
  }),
  'mining/rockcompositionpresets/fps_composition_test_gem.json': rec('MineableComposition.FPS_Composition_Test_Gem', '10000000-0000-0000-0000-00000000002c', {
    _Type_: 'MineableComposition', compositionArray: [
      { _Type_: 'MineableCompositionPart', mineableElement: ref('mining/mineableelements/test_gem.json'), minPercentage: 90, maxPercentage: 100 },
    ],
  }),
  'mining/mineableelements/test_ore.json': rec('MineableElement.Test_Ore', '10000000-0000-0000-0000-00000000002d', {
    _Type_: 'MineableElement', resourceType: { _RecordName_: 'ResourceType.Ore_TestMetal', _RecordId_: U.ore },
  }),
  'mining/mineableelements/test_gem.json': rec('MineableElement.Test_Gem', '10000000-0000-0000-0000-00000000002e', {
    _Type_: 'MineableElement', resourceType: { _RecordName_: 'ResourceType.TestMetal', _RecordId_: U.metal },
  }),
  'scitemmanufacturer/scitemmanufacturer.test.json': rec('SCItemManufacturer.TEST', U.manufacturer, {
    _Type_: 'SCItemManufacturer', Code: 'TEST', Localization: { Name: '@manufacturer_NameTEST', Description: '@LOC_EMPTY' },
  }),
};

const gearItem = (name: string, id: string, def: Record<string, unknown>, more: Record<string, unknown>[] = []) => rec(`EntityClassDefinition.${name}`, id, {
  _Type_: 'EntityClassDefinition', Components: [{ _Type_: 'SAttachableComponentParams', AttachDef: { Size: 1, Grade: 1, ...def } }, ...more],
});

export const FPS = {
  rifle: '10000000-0000-0000-0000-000000000030',
  helmet: '10000000-0000-0000-0000-000000000031',
  optic: '10000000-0000-0000-0000-000000000032',
  magazine: '10000000-0000-0000-0000-000000000033',
  grenade: '10000000-0000-0000-0000-000000000034',
  template: '10000000-0000-0000-0000-000000000035',
  unnamed: '10000000-0000-0000-0000-000000000036',
  jacket: '10000000-0000-0000-0000-000000000037',
  // The helmet's damage resistance (a shared record, kept raw for the damage mitigation's base)
  damage: '10000000-0000-0000-0000-000000000038',
};

/** FPS gear outside the blueprints (looted or bought), with what must stay out of the gear: stackables, templates,
 * nameless records, clothing (the stackables and clothing are shop items, see SHOP_RECORDS). Kept apart from RECORDS: only the tests that need FPS gear add them. */
export const FPS_RECORDS: Record<string, unknown> = {
  'entities/scitem/weapons/fps_weapons/test_rifle.json': gearItem('test_rifle', FPS.rifle,
    { Type: 'WeaponPersonal', SubType: 'Medium', Size: 3, Localization: { Name: '@item_Nametest_rifle' } }),
  'entities/scitem/characters/human/armor/test_helmet.json': gearItem('test_helmet', FPS.helmet,
    { Type: 'Char_Armor_Helmet', SubType: 'Light', Localization: { Name: '@item_Nametest_helmet' } },
    [{ _Type_: 'SCItemSuitArmorParams', damageResistance: 'file://./../../../../../libs/foundry/records/damage/lightarmor.json' }]),
  'damage/lightarmor.json': rec('DamageResistanceMacro.LightArmor', FPS.damage, {
    _Type_: 'DamageResistanceMacro', damageResistance: { _Type_: 'DamageResistance', PhysicalResistance: { _Type_: 'DamageResistanceEntry', Multiplier: 0.8 } },
  }),
  'entities/scitem/weapons/weapon_modifier/test_optic.json': gearItem('test_optic', FPS.optic,
    { Type: 'WeaponAttachment', SubType: 'IronSight', Size: 2, Localization: { Name: '@item_Nametest_optic' } }),
  'entities/scitem/weapons/magazines/test_rifle_mag.json': gearItem('test_rifle_mag', FPS.magazine,
    { Type: 'WeaponAttachment', SubType: 'Magazine', Localization: { Name: '@item_Nametest_rifle_mag' } }),
  'entities/scitem/weapons/throwable/test_grenade.json': gearItem('test_grenade', FPS.grenade,
    { Type: 'WeaponPersonal', SubType: 'Grenade', Localization: { Name: '@item_Nametest_grenade' } }),
  'entities/scitem/weapons/fps_weapons/test_rifle_template.json': gearItem('test_rifle_template', FPS.template,
    { Type: 'WeaponPersonal', SubType: 'Medium', Localization: { Name: '@item_Nametest_rifle' } }),
  'entities/scitem/weapons/melee/test_knife.json': gearItem('test_knife', FPS.unnamed,
    { Type: 'WeaponPersonal', SubType: 'Knife', Localization: { Name: '@LOC_PLACEHOLDER' } }),
  'entities/scitem/characters/human/clothing/test_jacket.json': gearItem('test_jacket', FPS.jacket,
    { Type: 'Char_Clothing_Torso_1', SubType: 'UNDEFINED', Localization: { Name: '@item_Nametest_jacket' } }),
};

export const SHOP = {
  food: '10000000-0000-0000-0000-000000000040',
  miscCarry: '10000000-0000-0000-0000-000000000041',
  miscProp: '10000000-0000-0000-0000-000000000042',
  cargo: '10000000-0000-0000-0000-000000000043',
  blade: '10000000-0000-0000-0000-000000000044',
  unnamed: '10000000-0000-0000-0000-000000000045',
  template: '10000000-0000-0000-0000-000000000046',
};

/** Sold items that are no gear (the item finder): catalog-only, never bookable; with what stays out: Misc
 * outside the carryables, Cargo, nameless records, templates. Add to FPS_RECORDS (jacket, magazine and grenade
 * are shop items too). */
export const SHOP_RECORDS: Record<string, unknown> = {
  'entities/scitem/consumables/test_burrito.json': gearItem('test_burrito', SHOP.food,
    { Type: 'Food', SubType: 'UNDEFINED', Localization: { Name: '@item_Nametest_burrito' } }),
  'entities/scitem/carryables/1h/test_mug.json': gearItem('test_mug', SHOP.miscCarry,
    { Type: 'Misc', SubType: 'UNDEFINED', Localization: { Name: '@item_Nametest_mug' } }),
  'entities/scitem/props/test_crate.json': gearItem('test_crate', SHOP.miscProp,
    { Type: 'Misc', SubType: 'UNDEFINED', Localization: { Name: '@item_Nametest_crate' } }),
  'entities/scitem/cargo/test_box.json': gearItem('test_box', SHOP.cargo,
    { Type: 'Cargo', SubType: 'UNDEFINED', Localization: { Name: '@item_Nametest_box' } }),
  'entities/scitem/ships/controller/test_blade.json': gearItem('test_blade', SHOP.blade,
    { Type: 'FlightController', SubType: 'UNDEFINED', Localization: { Name: '@item_Nametest_blade' } }),
  'entities/scitem/consumables/test_unnamed_drink.json': gearItem('test_unnamed_drink', SHOP.unnamed,
    { Type: 'Drink', SubType: 'UNDEFINED', Localization: { Name: '@LOC_PLACEHOLDER' } }),
  'entities/scitem/consumables/test_drink_template.json': gearItem('test_drink_template', SHOP.template,
    { Type: 'Drink', SubType: 'UNDEFINED', Localization: { Name: '@item_Nametest_drink' } }),
};

export const INI_EN ='\uFEFFitems_commodities_testmetal=Test Metal\r\nitems_commodities_testmetal_ore=Test Metal (Ore)\r\n'
  + 'item_NameTEST_Output=Test Cooler \\n\r\ncrafting_ui_slotname_frame,P=Frame\r\nunrelated_key=Not referenced\r\n'
  // A no-break space after "Class:" as in the QuikCool's text
  + 'item_DescTEST_Output=Item Type: Cooler\\nGrade: B\\nClass: Military\\n\\nKeeps things cool.\r\n'
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
    // The test provider is used by an object container at the station and by one placed nowhere
    containers: {
      places: new Map([[U.provider, new Set([U.station])]]),
      unplaced: [{ container: 'objectcontainers/pu/system/test/lost.socpak', providers: [U.provider] }],
    },
  });
}
