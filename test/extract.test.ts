import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayText, isMissingTranslation, locKey, parseGlobalIni } from '../src/catalog/extract/localization.ts';
import { partQuality } from '../src/catalog/extract/mining.ts';
import { refPath } from '../src/catalog/extract/records.ts';
import { snapshotSchema } from '../src/catalog/snapshot.ts';
import { isShopItem } from '../src/catalog/components.ts';
import { AMENITY, FPS, FPS_RECORDS, RECORDS, SHOP, SHOP_RECORDS, U, fixtureSnapshot } from './fixtures.ts';

describe('localization', () => {
  it('parses global.ini with BOM, CRLF, suffixes and "=" in values', () => {
    const ini = parseGlobalIni('﻿Key_One=Hello\r\nkey_two,P=A = B\r\nkey_one=duplicate\r\nno equals sign\r\n');
    assert.equal(ini.get('key_one'), 'Hello');
    assert.equal(ini.get('key_two'), 'A = B');
    assert.equal(ini.size, 2);
  });

  it('normalizes loc references and drops sentinels', () => {
    assert.equal(locKey('@Item_Name,P'), 'item_name');
    assert.equal(locKey('@LOC_EMPTY'), null);
    assert.equal(locKey('@LOC_PLACEHOLDER'), null);
    assert.equal(locKey('plain text'), null);
    assert.equal(locKey(null), null);
  });

  it('turns literal \\n into line breaks and detects placeholders', () => {
    assert.equal(displayText('Line 1\\nLine 2\\n'), 'Line 1\nLine 2');
    assert.ok(isMissingTranslation('! GERMAN_(GERMANY) TRANSLATION NOT FOUND FOR LOCID: x !'));
    assert.ok(!isMissingTranslation('Testmetall'));
  });
});

describe('refPath', () => {
  it('normalizes file references', () => {
    assert.equal(refPath('file://./../../../libs/foundry/records/Crafting/X.json'), 'libs/foundry/records/crafting/x.json');
    assert.equal(refPath(null), null);
    assert.equal(refPath('something else'), null);
  });
});

describe('normalize', () => {
  const s = fixtureSnapshot();
  const anomaly = (code: string) => s.anomalies.filter((a) => a.code === code);

  it('produces a valid snapshot', () => {
    const r = snapshotSchema.safeParse(s);
    assert.ok(r.success, r.success ? '' : r.error.message);
  });

  it('normalizes resources incl. ores, groups, boxes and crafting data', () => {
    const metal = s.resources.find((r) => r.uuid === U.metal)!;
    const ore = s.resources.find((r) => r.uuid === U.ore)!;
    assert.deepEqual(metal.groupPath, ['Metal']);
    assert.equal(metal.isOre, false);
    assert.deepEqual(metal.boxSizesScu, [0.125, 1]);
    assert.equal(ore.isOre, true);
    assert.equal(ore.refinedUuid, U.metal);
    assert.deepEqual(ore.craftingData, [{
      name: 'Default', qualityDistributionUuid: U.distribution, qualityLocationOverrideUuid: U.qualityOverride, qualityQuantizationUuid: U.quantization,
    }]);
    assert.equal(s.resources.length, 2);
  });

  it('normalizes blueprints with slots, modifiers, inputs and "N of M" slots', () => {
    const bp = s.blueprints.find((b) => b.uuid === U.blueprint)!;
    assert.equal(bp.key, 'BP_CRAFT_Test');
    assert.equal(bp.isDefault, true);
    assert.equal(bp.outputItemUuid, U.output);
    assert.equal(bp.categoryUuid, U.category);
    const tier = bp.tiers[0]!;
    assert.equal(tier.craftSeconds, 150);
    assert.equal(tier.requiredSlots, 2);
    assert.deepEqual(tier.slots.map((x) => x.key), ['FRAME', 'EMITTER', 'NESTED']);
    const [frame, emitter, nested] = tier.slots;
    assert.deepEqual(frame!.inputs, [{ kind: 'resource', uuid: U.metal, quantity: 0.046, minQuality: 1 }]);
    assert.deepEqual(frame!.modifiers[0]!.ranges.map((r) => r.type), ['Linear', 'LinearIntegerAdditive']);
    assert.deepEqual(frame!.modifiers[0]!.ranges[1]!.values, { additiveModifierAtStart: 1, additiveModifierAtEnd: 2 });
    assert.deepEqual(emitter!.inputs, [{ kind: 'item', uuid: U.gem, quantity: 7, minQuality: 0 }]);
    assert.deepEqual(nested!.inputs, []);
    assert.equal(nested!.nameKey, null);
  });

  it('collects items and manufacturers referenced by blueprints', () => {
    assert.deepEqual(s.items.map((i) => i.uuid).sort(), [U.output, U.gem].sort());
    const out = s.items.find((i) => i.uuid === U.output)!;
    assert.equal(out.manufacturerUuid, U.manufacturer);
    assert.equal(out.size, 2);
    // Grade letter and class come from the English description
    assert.deepEqual([out.gradeLetter, out.itemClass], ['B', 'Military']);
    assert.deepEqual([s.items.find((i) => i.uuid === U.gem)!.gradeLetter, s.items.find((i) => i.uuid === U.gem)!.itemClass], [null, null]);
    assert.deepEqual(s.manufacturers.map((m) => [m.code, m.descriptionKey]), [['TEST', null]]);
  });

  it('takes named FPS gear outside the blueprints, and the stackables and clothing only as shop items, no templates or nameless records', () => {
    const fps = fixtureSnapshot({ ...RECORDS, ...FPS_RECORDS });
    const gear = [U.output, U.gem, FPS.rifle, FPS.helmet, FPS.optic];
    // magazine, grenade and jacket are shop items (catalog-only): in the snapshot, without raw record
    assert.deepEqual(fps.items.map((i) => i.uuid).sort(), [...gear, FPS.magazine, FPS.grenade, FPS.jacket].sort());
    assert.deepEqual(fps.rawRecords.filter((r) => [FPS.magazine, FPS.grenade, FPS.jacket].includes(r.uuid)), []);
    const helmet = fps.items.find((i) => i.uuid === FPS.helmet)!;
    assert.deepEqual([helmet.type, helmet.subType], ['Char_Armor_Helmet', 'Light']);
    // Its damage resistance record is kept raw (the base of the crafted damage mitigation)
    assert.ok(fps.rawRecords.some((r) => r.uuid === FPS.damage && r.path === 'libs/foundry/records/damage/lightarmor.json'));
    assert.ok(!s.rawRecords.some((r) => r.uuid === FPS.damage), 'no armor, no damage record');
  });

  it('flags the shop items', () => {
    const snap = fixtureSnapshot({ ...RECORDS, ...FPS_RECORDS, ...SHOP_RECORDS });
    const shop = (u: string) => snap.items.find((i) => i.uuid === u)!.shop;
    for (const u of [SHOP.food, SHOP.miscCarry, SHOP.blade, FPS.jacket, FPS.magazine, FPS.grenade]) assert.equal(shop(u), true, u);
    for (const u of [U.output, U.gem, FPS.rifle, FPS.helmet, FPS.optic]) assert.equal(shop(u), false, u);
    // Exactly the items without a raw record
    const raw = new Set(snap.rawRecords.map((r) => r.uuid));
    assert.deepEqual(snap.items.filter((i) => i.shop).map((i) => i.uuid).sort(), snap.items.filter((i) => !raw.has(i.uuid)).map((i) => i.uuid).sort());
  });

  it('derives the freight elevator, the reward pool, the crafting default and the volume of harvestables', () => {
    // The amenity is listed by the orphan only (the station has another one, the star none)
    assert.deepEqual(s.locations.filter((l) => l.freightElevator).map((l) => l.uuid), [U.orphan]);
    assert.ok(AMENITY.freightElevator !== AMENITY.other);
    // Blueprint 2 is in the pool, blueprint 1 is not
    assert.deepEqual(s.blueprints.map((b) => [b.uuid, b.inRewardPool]), [[U.blueprint, false], [U.blueprint2, true]]);
    assert.deepEqual(s.crafting, { defaultCompositionQuality: 500 });
    const gem = s.items.find((i) => i.uuid === U.gem)!;
    assert.deepEqual([gem.subType, gem.scuPerPiece], ['Harvestable', 0.001]);
    assert.equal(s.items.find((i) => i.uuid === U.output)!.scuPerPiece, null);
    // A harvestable without a positive volume has none
    const records = structuredClone(RECORDS) as Record<string, any>;
    records['entities/scitem/carryables/test_gem.json']._RecordValue_.Components[0].AttachDef.inventoryOccupancyVolume.microSCU = 0;
    assert.equal(fixtureSnapshot(records).items.find((i) => i.uuid === U.gem)!.scuPerPiece, null);
    // A game without the crafting record
    const without = { ...RECORDS };
    delete without['crafting/globalparams/craftingglobalparams.json'];
    assert.deepEqual(fixtureSnapshot(without).crafting, { defaultCompositionQuality: null });
  });

  it('leaves the plumbing fields empty', () => {
    assert.ok(s.locations.every((l) => l.refinery === false));
  });

  it('reads the base values of the crafted stats from the records', () => {
    const fps = fixtureSnapshot({ ...RECORDS, ...FPS_RECORDS });
    const bases = (u: string) => fps.items.find((i) => i.uuid === u)!.baseStats;
    // Directly in the record: the health component
    assert.deepEqual(bases(U.output), { GPP_Health_MaxHealth: 110 });
    // A fallback with a reciprocal: the first fire mode has no rate, its sequence's first entry takes 1.2 seconds = 50 RPM
    assert.deepEqual(bases(FPS.rifle), { GPP_Weapon_FireRate: 50 });
    // In a linked record: 1 - the physical damage multiplier (0.8) of the armor's damage resistance
    assert.deepEqual(bases(FPS.helmet), { GPP_Armor_DamageMitigation: 0.2 });
    // No number anywhere: absent
    assert.deepEqual(bases(FPS.optic), {});
    assert.deepEqual(bases(U.gem), {});
    // A link to a record that is not there: absent
    const records = structuredClone({ ...RECORDS, ...FPS_RECORDS }) as Record<string, any>;
    delete records['damage/lightarmor.json'];
    assert.deepEqual(fixtureSnapshot(records).items.find((i) => i.uuid === FPS.helmet)!.baseStats, {});
  });

  it('takes the sold non-gear items (SHOP_TYPES), but no Misc outside the carryables, no Cargo, templates or nameless records', () => {
    const snap = fixtureSnapshot({ ...RECORDS, ...FPS_RECORDS, ...SHOP_RECORDS });
    const uuids = snap.items.map((i) => i.uuid);
    for (const u of [SHOP.food, SHOP.miscCarry, SHOP.blade, FPS.jacket]) assert.ok(uuids.includes(u), u);
    for (const u of [SHOP.miscProp, SHOP.cargo, SHOP.unnamed, SHOP.template]) assert.ok(!uuids.includes(u), u);
    assert.deepEqual(snap.items.find((i) => i.uuid === SHOP.food)!.type, 'Food');
    assert.ok(!snap.rawRecords.some((r) => [SHOP.food, SHOP.miscCarry, SHOP.blade].includes(r.uuid)), 'shop items carry no raw record');
  });

  it('tells shop items by type, sub type and path', () => {
    const carry = 'libs/foundry/records/entities/scitem/carryables/1h/x.json';
    assert.ok(isShopItem('Food', 'UNDEFINED', 'libs/foundry/records/entities/scitem/x.json'));
    assert.ok(isShopItem('Misc', null, carry));
    assert.ok(!isShopItem('Misc', null, 'libs/foundry/records/entities/scitem/props/x.json'));
    assert.ok(isShopItem('WeaponAttachment', 'Magazine', carry));
    assert.ok(!isShopItem('WeaponAttachment', 'Barrel', carry));
    assert.ok(isShopItem('WeaponPersonal', 'Grenade', carry));
    // gear types never: the bookable rule goes by type alone
    assert.ok(!isShopItem('WeaponPersonal', 'Gadget', carry));
    assert.ok(!isShopItem('WeaponAttachment', 'Barrel', carry));
    assert.ok(!isShopItem('Cargo', null, carry));
    assert.ok(!isShopItem('Paints', null, carry));
    assert.ok(!isShopItem(null, null, carry));
  });

  it('derives blueprint sources from released contracts and event tiers', () => {
    const none = { contractId: null, contractKey: null, titleKey: null, missionTypeKey: null, factionUuid: null, factionNameKey: null,
      minRankNameKey: null, minReputation: null, localityUuids: [], locationUuids: [], requiresPrevious: false, illegal: false, chance: null, onAccept: false };
    const pool = { blueprintUuid: U.blueprint2, poolUuid: U.pool, poolKey: 'Pool', weight: 1, poolWeight: 1 };
    assert.deepEqual(s.blueprintSources, [
      { ...pool, kind: 'event', ...none, eventKey: 'TestEvent', minPoints: 1000 },
      {
        ...pool, kind: 'mission', contractId: U.contract, contractKey: 'Test_Mission', titleKey: 'test_mission_title', missionTypeKey: 'test_mission_type',
        factionUuid: U.faction, factionNameKey: 'test_faction', minRankNameKey: 'test_rank1', minReputation: 800, localityUuids: [U.star],
        locationUuids: [U.station], requiresPrevious: true, illegal: true, chance: 0.5, onAccept: true, eventKey: 'Test', minPoints: null,
      },
    ]);
  });

  it('normalizes star map objects as locations with parent and type', () => {
    assert.deepEqual(s.locations.map((l) => l.uuid).sort(), [U.star, U.station, U.orphan, U.solarSystem].sort());
    assert.deepEqual(s.locations.find((l) => l.uuid === U.station), {
      uuid: U.station, key: 'Test_Station', nameKey: 'test_station', descriptionKey: 'test_station_desc', parentUuid: U.star,
      type: 'Manmade', navIcon: 'Station', hideInStarmap: false, respawnLocationType: 'Hospital', freightElevator: false, refinery: false,
    });
    const star = s.locations.find((l) => l.uuid === U.star)!;
    assert.deepEqual([star.parentUuid, star.type, star.descriptionKey], [null, 'Star', null]);
    const orphan = s.locations.find((l) => l.uuid === U.orphan)!;
    assert.deepEqual([orphan.nameKey, orphan.parentUuid, orphan.type, orphan.hideInStarmap], [null, null, null, true]);
    assert.deepEqual(anomaly('unresolved_ref').filter((a) => a.record === 'StarMapObject.Test_Orphan').map((a) => a.detail.split(':')[0]), [
      'parent', 'star map object type 10000000-0000-0000-0000-0000000000ff',
    ]);
  });

  it('keeps every exported record raw, incl. pools, but not the contract records behind the sources', () => {
    assert.ok(s.rawRecords.some((r) => r.uuid === U.pool));
    assert.ok(s.rawRecords.some((r) => r.uuid === U.marker));
    const sourceOnly = /^(contracts|missionscenarios|missiontype|missiondata|factions|reputation|harvestable|mining|entities\/mineable)\//;
    assert.equal(s.rawRecords.length, Object.keys(RECORDS).filter((p) => !sourceOnly.test(p)).length);
  });

  it('derives what can be mined where, per provider and method', () => {
    assert.deepEqual(s.miningProviders, [{ uuid: U.provider, key: 'HPP_Test', locationUuids: [U.station] }]);
    const base = { providerUuid: U.provider, itemUuid: null, rarity: 'common' };
    assert.deepEqual(s.mineables, [
      // Hand mining: the gem rock breaks into the gem item; no quality data for the metal
      { ...base, method: 'fps', resourceUuid: U.metal, qualityScale: 1, itemUuid: U.gem, share: 1, minPercent: 90, maxPercent: 100, rarity: null, quality: null },
      // The rich part: the common rock (3 of 4) always, the rare one (1 of 4) half the time. The station's system
      // overrides the quality (its solar system record, not an ancestor): 1–499 maps to the band value 400
      {
        ...base, method: 'ship', resourceUuid: U.ore, qualityScale: 1, share: 0.875, minPercent: 2, maxPercent: 30,
        quality: { min: 400, max: 400, values: [{ value: 400, chance: 1 }] },
      },
      // The lean part (common rock only): quality × 0.49 = 245–490, the band value 400
      {
        ...base, method: 'ship', resourceUuid: U.ore, qualityScale: 0.49, share: 0.75, minPercent: 40, maxPercent: 80,
        quality: { min: 400, max: 400, values: [{ value: 400, chance: 1 }] },
      },
    ]);
    assert.equal(anomaly('unresolved_ref').filter((a) => a.record === 'MineableComposition.RareShipMineables_Test').length, 1);
    // The provider no container places, the container placed nowhere
    assert.deepEqual(anomaly('unplaced_provider').map((a) => a.record), ['HarvestableProviderPreset.HPP_Unused']);
    assert.deepEqual(anomaly('unplaced_container').map((a) => [a.record, a.detail]), [
      ['objectcontainers/pu/system/test/lost.socpak', 'object container without a star map record uses HPP_Test'],
    ]);
  });

  it('reports anomalies instead of failing', () => {
    assert.equal(anomaly('no_output').length, 1);
    assert.equal(anomaly('nested_select').length, 1);
    assert.deepEqual(anomaly('null_entries').map((a) => a.detail).sort(), [
      '1 null list entries skipped in modifier.valueRanges',
      '1 null list entries skipped in resource.properties',
      '1 null list entries skipped in slot.context',
      '1 null list entries skipped in starmap.types',
    ]);
  });

  it('keeps complete text sets and skips placeholders', () => {
    assert.equal(s.localization.en!['item_nametest_output'], 'Test Cooler');
    assert.equal(s.localization.en!['crafting_ui_slotname_frame'], 'Frame');
    assert.equal(s.localization.en!['unrelated_key'], 'Not referenced');
    assert.equal(s.localization.de!['items_commodities_testmetal'], 'Testmetall');
    assert.equal(s.localization.de!['item_nametest_output'], undefined);
    assert.equal(anomaly('missing_translation').length, 1);
  });
});

describe('mining quality', () => {
  // A ship ore's distribution and the bands of a material (values inside their bands)
  const bands = [[0, 399, 310], [400, 599, 525], [600, 699, 646], [700, 799, 718], [800, 899, 853], [900, 949, 925], [950, 998, 957], [999, 1000, 1000]]
    .map(([start, end, mappedValue]) => ({ start: start!, end: end!, mappedValue: mappedValue! }));
  const d = { min: 501, max: 1000, mean: 500, stddev: 163 };

  it('maps the spawn distribution to the band values with their chances', () => {
    const q = partQuality(d, 1, bands)!;
    assert.deepEqual(q.values.map((v) => v.value), [525, 646, 718, 853, 925, 957, 1000]);
    assert.ok(Math.abs(q.values.reduce((s, v) => s + v.chance, 0) - 1) < 0.001);
    // Mostly the lowest band: the distribution's peak sits at its lower end
    assert.ok(q.values[0]!.chance > 0.4 && q.values[0]!.chance > q.values[1]!.chance);
  });

  it('scales a lean part below 500 and keeps the range without bands', () => {
    assert.deepEqual(partQuality(d, 0.49, bands)!.values.map((v) => v.value), [310, 525]);
    assert.deepEqual(partQuality(d, 0.49, []), { min: 245, max: 490, values: [] });
  });
});
