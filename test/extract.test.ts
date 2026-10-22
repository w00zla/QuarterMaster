import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayText, isMissingTranslation, locKey, parseGlobalIni } from '../src/catalog/extract/localization.ts';
import { refPath } from '../src/catalog/extract/records.ts';
import { snapshotSchema } from '../src/catalog/snapshot.ts';
import { FPS, FPS_RECORDS, RECORDS, U, fixtureSnapshot } from './fixtures.ts';

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
      name: 'Default', qualityDistributionUuid: U.distribution, qualityLocationOverrideUuid: null, qualityQuantizationUuid: U.quantization,
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

  it('takes named FPS gear outside the blueprints, but no stackables, templates, nameless records or clothing', () => {
    const fps = fixtureSnapshot({ ...RECORDS, ...FPS_RECORDS });
    assert.deepEqual(fps.items.map((i) => i.uuid).sort(), [U.output, U.gem, FPS.rifle, FPS.helmet, FPS.optic].sort());
    const helmet = fps.items.find((i) => i.uuid === FPS.helmet)!;
    assert.deepEqual([helmet.type, helmet.subType], ['Char_Armor_Helmet', 'Light']);
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
    assert.deepEqual(s.locations.map((l) => l.uuid).sort(), [U.star, U.station, U.orphan].sort());
    assert.deepEqual(s.locations.find((l) => l.uuid === U.station), {
      uuid: U.station, key: 'Test_Station', nameKey: 'test_station', descriptionKey: 'test_station_desc', parentUuid: U.star,
      type: 'Manmade', navIcon: 'Station', hideInStarmap: false, respawnLocationType: 'Hospital',
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
    const sourceOnly = /^(contracts|missionscenarios|missiontype|missiondata|factions|reputation)\//;
    assert.equal(s.rawRecords.length, Object.keys(RECORDS).filter((p) => !sourceOnly.test(p)).length);
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
