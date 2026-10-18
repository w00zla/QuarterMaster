// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
// Ship components: blueprint outputs of the VehicleComponent/VehicleWeapons categories, booked without quality.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { formatAmount } from '../src/stock/amount.ts';
import { materialCatalog, stockList } from '../src/stock/lookup.ts';
import { orgMetrics } from '../src/stock/org-summary.ts';
import { add, COMPONENT_QUALITY, StockError, type Actor } from '../src/stock/service.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '940000000000000001';
const MEMBER_ROLE = '941000000000000001';
const MIA = '942000000000000001';
const mia: Actor = { userId: MIA, guildId: G, source: 'webapp' };

describe('ship components in stock (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    // The fixture's blueprint (output: a cooler) becomes a ship component blueprint
    await db.execute(sql`UPDATE catalog.blueprint_category SET key = 'VehicleComponentS2' WHERE uuid = ${U.category}`);
    await ensureGuild(db, G, 'Component Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE] });
    await syncMember(db, G, settings, MIA, { userId: MIA, displayName: 'Mia', roleIds: [MEMBER_ROLE], bot: false });
  });
  after(async () => close?.());

  it('offers the outputs of component blueprints as components, with a unique label', async () => {
    const materials = await materialCatalog(db, 'en');
    const cooler = materials.get(U.output)!;
    assert.equal(cooler.kind, 'item');
    assert.equal(cooler.component, true);
    assert.equal(cooler.label, 'Test Cooler · S2 · B Military · TEST');
    assert.equal(materials.get(U.gem)!.component, false);
    assert.equal(materials.get(U.metal)!.component, false);
  });

  it('books components with the fixed quality only', async () => {
    const cooler = { kind: 'item' as const, uuid: U.output, locationUuid: U.station, amount: '2' };
    await assert.rejects(add(db, mia, { ...cooler, quality: 500 }), (e: unknown) => e instanceof StockError && e.code === 'invalidQuality');
    await assert.rejects(add(db, mia, { ...cooler, quality: COMPONENT_QUALITY, amount: '1.5' }), (e: unknown) => e instanceof StockError && e.code === 'invalidAmount');
    await add(db, mia, { ...cooler, quality: COMPONENT_QUALITY, org: true });
    await add(db, mia, { kind: 'item', uuid: U.gem, locationUuid: U.station, quality: 100, amount: '3', org: true });
    const list = await stockList(db, { scope: { personalOf: MIA } }, 'en');
    assert.deepEqual(list.map((p) => [p.batch.itemUuid, p.component, formatAmount(p.batch.quantity)]).sort(),
      [[U.gem, false, '3'], [U.output, true, '2']].sort());
  });

  it('counts components apart from items', async () => {
    const m = (await orgMetrics(db, [G])).get(G)!;
    assert.deepEqual(m.items, { kinds: 1, pieces: '3', locations: 1 });
    assert.deepEqual(m.components, { kinds: 1, pieces: '2', locations: 1 });
  });
});
