// /qm-crafting (count parsing, the panel) and /qm-help (the command list per permission), without a database.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { commands } from '../src/bot/commands.ts';
import { checkPanel, parseCount } from '../src/bot/commands/crafting.ts';
import { helpLines, visibleCommands } from '../src/bot/commands/help.ts';
import { computePlan } from '../src/planner/plan.ts';
import { coverageOf, needsOf, withQualityFloor } from '../src/planner/stock.ts';
import type { PlannerData, PlannerRecipe } from '../src/planner/types.ts';

const recipe: PlannerRecipe = {
  uuid: 'bp-1', key: 'bp-1', name: 'Blaster', outputType: null, outputTypeLabel: 'Weapon', outputSubTypeLabel: null, size: 1, grade: null,
  gradeLetter: null, itemClass: null, manufacturer: null, isDefault: false, category: null, categoryGroup: null, categoryLabel: 'Pistols',
  craftSeconds: 90, requiredSlots: 1, retired: false,
  slots: [
    {
      index: 0, key: 'A', name: 'Frame', requiredCount: 1,
      modifiers: [{ propertyUuid: 'p-dmg', key: 'dmg', name: 'Damage', unit: null, ranges: [
        { type: 'Linear', startQuality: 0, endQuality: 1000, values: { modifierAtStart: 0.8, modifierAtEnd: 1.2 } },
      ] }],
      inputs: [{ kind: 'resource', uuid: 'r-metal', key: 'Metal', name: 'Metal', quantity: '0.25', minQuality: 700 }],
    },
    { index: 1, key: 'B', name: 'Grip', requiredCount: 1, modifiers: [], inputs: [{ kind: 'item', uuid: 'i-gem', key: 'Gem', name: 'Gem', quantity: '2', minQuality: 0 }] },
  ],
};
const data: PlannerData = { defaultQuality: 500, recipes: [recipe] };
const text = (p: ReturnType<typeof checkPanel>) => JSON.stringify(p.components[0]!.toJSON());

describe('/qm-crafting', () => {
  it('takes whole counts from 1 to 99 only', () => {
    assert.equal(parseCount(' 12 '), 12);
    for (const bad of ['0', '100', '1.5', '', 'x', '-1']) assert.equal(parseCount(bad), null, bad);
  });

  it('shows the needs against the stock at the raised quality, the stats and the slot note', () => {
    const entry = withQualityFloor(data, { blueprintUuid: 'bp-1', count: 4 });
    const result = computePlan(data, [entry]).entries[0]!;
    const stock = [{ kind: 'resource' as const, subjectUuid: 'r-metal', location: 'Area18', state: 'stored' as const, quality: 750, quantity: '0.4', holderUserId: 'me' }];
    const coverages = needsOf(result).map((n) => coverageOf(n, stock, 'me'));
    const json = text(checkPanel('en', { bp: { uuid: 'bp-1', label: 'Blaster · S1' }, recipe, result, coverages, quality: null, defaultQuality: 500 }));
    assert.match(json, /⚒️ Blaster · S1 × 4/);
    assert.match(json, /Quality \*\*500\*\* \(default\) · Crafting time \*\*6m\*\*/);
    // The default 500 is raised to the slot's minimum 700; 4 × 0.25 = 1 SCU, 0.4 at Q ≥ 700 in stock
    assert.match(json, /\*\*Metal\*\* · 1 SCU · Q ≥ 700 ★★★ · ❌ missing \*\*0.6 SCU\*\*/);
    assert.match(json, /Uses the first 1 of 2 slots/);
    assert.match(json, /🟢 Damage: \*\*\+8\.0%\*\*/);
    assert.match(json, /qm-crafting:edit:bp-1:4:-/);
  });
});

describe('/qm-help', () => {
  it('lists every other command with its subcommands; admin commands only for admins', () => {
    const user = visibleCommands(commands, new PermissionsBitField(PermissionFlagsBits.SendMessages)).map((c) => c.name);
    const admin = visibleCommands(commands, new PermissionsBitField(PermissionFlagsBits.ManageGuild)).map((c) => c.name);
    assert.ok(!user.includes('qm-setup'));
    assert.ok(admin.includes('qm-setup'));
    assert.deepEqual(admin.filter((n) => n !== 'qm-setup'), user);
    assert.ok(user.includes('qm-crafting') && !user.includes('qm-help'));
    const stock = commands.find((c) => c.data.name === 'qm-res')!.data;
    const [de] = helpLines('de', [stock]);
    assert.match(de!, /^\*\*\/qm-res\*\* · Ressourcen/);
    assert.match(de!, /\n- `add` /);
    assert.ok(user.includes('qm-gear'));
  });
});
