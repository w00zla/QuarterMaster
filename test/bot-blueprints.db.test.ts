// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { addBlueprint, blueprintCatalog, ownedBlueprints, removeBlueprint, whoHas } from '../src/bot/blueprints.ts';
import { searchMembers, syncMember, type MemberInfo } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '800000000000000001';
const ROLE = '810000000000000001';
const [ANNA, BEN, CARL] = ['820000000000000001', '820000000000000002', '820000000000000003'];
const info = (userId: string, displayName: string): MemberInfo => ({ userId, displayName, roleIds: [ROLE], bot: false });

describe('blueprint registry (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    await ensureGuild(db, G, 'BP Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [ROLE] });
    for (const [id, name] of [[ANNA, 'Anna'], [BEN, 'Ben'], [CARL, 'Carl']] as const) await syncMember(db, G, settings, id, info(id, name));
  });
  after(async () => close?.());

  it('loads the catalog with labels in the language', async () => {
    const catalog = await blueprintCatalog(db, 'en');
    assert.equal(catalog.entries.length, 2);
    assert.ok(catalog.byUuid.get(U.blueprint)!.label.length > 0);
  });

  it('adds and removes blueprints idempotently', async () => {
    assert.equal(await addBlueprint(db, ANNA, U.blueprint, 'bot'), true);
    assert.equal(await addBlueprint(db, ANNA, U.blueprint, 'bot'), false);
    // A user row the roster cleanup removed (no data left) comes back with the first blueprint
    const NEW = '720000000000000099';
    assert.equal(await addBlueprint(db, NEW, U.blueprint, 'bot'), true);
    assert.equal((await db.execute(sql`SELECT 1 FROM app.app_user WHERE user_id = ${NEW}`)).length, 1);
    await removeBlueprint(db, NEW, U.blueprint, 'bot');
    assert.deepEqual([...await ownedBlueprints(db, ANNA)], [U.blueprint]);
    assert.equal(await removeBlueprint(db, ANNA, U.blueprint, 'bot'), true);
    assert.equal(await removeBlueprint(db, ANNA, U.blueprint, 'bot'), false);
    // History: one row per real change, none for the no-ops
    const found = await db.execute<{ source: string; action: string; target: string }>(sql`
      SELECT source, action, target_uuid AS target FROM app.history WHERE owner_user_id = ${ANNA} AND category = 'blueprint' ORDER BY id`);
    assert.deepEqual(found.map((r) => [r.source, r.action, r.target]), [['bot', 'add', U.blueprint], ['bot', 'remove', U.blueprint]]);
  });

  it('suggests active org members by display name or RSI handle', async () => {
    await db.execute(sql`UPDATE app.app_user SET rsi_handle = 'SpaceCarl' WHERE user_id = ${CARL}`);
    const names = async (q: string) => (await searchMembers(db, G, q)).map((m) => m.displayName);
    assert.deepEqual(await names(''), ['Anna', 'Ben', 'Carl']);
    assert.deepEqual(await names('an'), ['Anna']);
    assert.deepEqual(await names('spacec'), ['Carl']);
    assert.deepEqual(await names('n'), ['Anna', 'Ben']);
    assert.deepEqual(await searchMembers(db, '899999999999999999', ''), []);
  });

  it('lists only active members of the org as owners, alphabetical', async () => {
    for (const id of [CARL, ANNA, BEN]) await addBlueprint(db, id, U.blueprint2, 'bot');
    await db.execute(sql`UPDATE app.member SET active = false WHERE user_id = ${BEN}`);
    assert.deepEqual(await whoHas(db, G, U.blueprint2), ['Anna', 'Carl']);
    assert.deepEqual(await whoHas(db, '899999999999999999', U.blueprint2), []);
  });
});

describe('blueprint catalog without magazines (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    // The first blueprint crafts a magazine here
    const snap = fixtureSnapshot();
    const output = snap.blueprints.find((b) => b.uuid === U.blueprint)!.outputItemUuid;
    snap.items = snap.items.map((i) => (i.uuid === output ? { ...i, type: 'WeaponAttachment', subType: 'Magazine' } : i));
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
  });
  after(async () => close?.());

  it('leaves magazine blueprints out and names them', async () => {
    // German: the block above cached the English catalog (checked again after a minute only)
    const catalog = await blueprintCatalog(db, 'de');
    assert.deepEqual(catalog.entries.map((e) => e.uuid), [U.blueprint2]);
    assert.equal(catalog.magazineNames.length, 1);
  });
});
