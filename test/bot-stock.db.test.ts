// Runs against TEST_DATABASE_URL only; the bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connect, type Db } from '../src/db/client.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { listPage, runPending } from '../src/bot/commands/stock.ts';
import { UserError } from '../src/bot/errors.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { stockList } from '../src/stock/lookup.ts';
import { add, type Actor } from '../src/stock/service.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '940000000000000001';
const [MEMBER_ROLE, OFFICER_ROLE] = ['941000000000000001', '941000000000000002'];
const [MIA, OLGA] = ['942000000000000001', '942000000000000002'];
const mia: Actor = { userId: MIA, guildId: G, officer: false };
const olga: Actor = { userId: OLGA, guildId: G, officer: true };
const metal = { kind: 'resource' as const, uuid: U.metal, locationUuid: U.station };

describe('/qm-stock confirmed bookings and lists (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    ({ db, close } = connect(url));
    for (const schema of ['bot', 'app', 'catalog', 'drizzle']) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    await ensureGuild(db, G, 'Stock Cmd Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE], officerRoleIds: [OFFICER_ROLE] });
    await syncMember(db, G, settings, MIA, { userId: MIA, displayName: 'Mia', roleIds: [MEMBER_ROLE], bot: false });
    await syncMember(db, G, settings, OLGA, { userId: OLGA, displayName: 'Olga', roleIds: [OFFICER_ROLE], bot: false });
  });
  after(async () => close?.());

  it('books confirmed removals and tells what is left', async () => {
    const b = (await add(db, mia, { ...metal, quality: 820, amount: '12,5' })).batch!;
    assert.equal(await runPending(db, mia, { op: 'remove', batchId: b.id, amount: '2', expected: b.quantity }, 'en'),
      '➖ Removed 2 SCU: Test Metal · Q820 · Total: 10.5 SCU · Test Station · Pers. · In stock (Pers.): 10.5 SCU');
    assert.equal(await runPending(db, mia, { op: 'remove', batchId: b.id, amount: null, expected: '10.5' }, 'de'),
      '➖ Entnommen 10.5 SCU: Testmetall · Q820 · 10.5 SCU · Test Station · Pers. · Batch leer · Im Bestand (Pers.): 0 SCU');
  });

  it('refuses a confirmation against a batch that changed since it was shown', async () => {
    const b = (await add(db, mia, { ...metal, quality: 700, amount: '3' })).batch!;
    await add(db, mia, { ...metal, quality: 700, amount: '1' });
    await assert.rejects(runPending(db, mia, { op: 'adjust', batchId: b.id, amount: '1', expected: '3' }, 'en'),
      (err: unknown) => err instanceof UserError && err.key === 'stock.err.batchChanged');
  });

  it('describes moves and corrections by their result', async () => {
    const b = (await add(db, mia, { ...metal, quality: 600, amount: '5' })).batch!;
    assert.equal(await runPending(db, mia, { op: 'move', batchId: b.id, amount: '2', expected: b.quantity, toOrg: true }, 'en'),
      '🔀 Moved 2 SCU → Test Metal · Q600 · Total: 2 SCU · Test Station · Org (Mia) · In stock (Org): 2 SCU');
    assert.equal(await runPending(db, mia, { op: 'adjust', batchId: b.id, amount: '4', expected: '3' }, 'en'),
      '✏️ Corrected by +1 SCU: Test Metal · Q600 · Total: 4 SCU · Test Station · Pers. · In stock (Pers.): 8 SCU');
  });

  it('lists org stock grouped by material with holders, personal stock without', async () => {
    await add(db, olga, { kind: 'item', uuid: U.gem, locationUuid: U.station, quality: 300, amount: '7', org: true });
    const org = listPage(await stockList(db, { scope: { guildId: G } }, 'en'), true, 0, 'en', 'tok').content.split('\n');
    assert.equal(org[0], '**Org stock** (2 batches)');
    assert.ok(org.includes('- Q600 · 2 SCU · Test Station · Mia'));
    assert.ok(org.includes('- Q300 · 7 pcs · Test Station · Olga'));
    const own = listPage(await stockList(db, { scope: { personalOf: MIA } }, 'de'), false, 0, 'de', 'tok').content;
    assert.match(own, /^\*\*Dein persönlicher Bestand\*\* \(2 Batches\)\n__Testmetall__ · Gesamt: 8 SCU\n- Q700 · 4 SCU · Test Station\n- Q600 · 4 SCU · Test Station$/);
    assert.ok(org.includes('__Test Metal__ · Total: 2 SCU'));
  });
});
