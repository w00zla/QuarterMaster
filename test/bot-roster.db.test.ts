// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { connect, type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { syncGuild, syncMember, type MemberInfo } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings, type GuildSettings } from '../src/bot/settings.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '700000000000000001';
const MEMBER_ROLE = '710000000000000001';
const [ALICE, BOB, CAROL, DAVE] = ['720000000000000001', '720000000000000002', '720000000000000003', '720000000000000004'];
const info = (userId: string, roleIds: string[], displayName = `n${userId.slice(-1)}`, bot = false): MemberInfo =>
  ({ userId, displayName, roleIds, bot });

describe('roster sync (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;
  let settings: GuildSettings;

  const row = async (userId: string) => (await db.execute<{ active: boolean; display_name: string; inactive: boolean }>(
    sql`SELECT active, display_name, inactive_since IS NOT NULL AS inactive FROM app.member WHERE guild_id = ${G} AND user_id = ${userId}`))[0];
  const userExists = async (userId: string) =>
    (await db.execute(sql`SELECT 1 FROM app.app_user WHERE user_id = ${userId}`)).length === 1;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    await ensureGuild(db, G, 'Roster Org');
    settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE] });
  });
  after(async () => close?.());

  it('adds role holders, skips everyone else and bots', async () => {
    assert.equal(await syncMember(db, G, settings, ALICE, info(ALICE, [MEMBER_ROLE], 'Alice')), 'active');
    assert.equal(await syncMember(db, G, settings, BOB, info(BOB, [MEMBER_ROLE])), 'active');
    assert.equal(await syncMember(db, G, settings, CAROL, info(CAROL, ['other'])), 'none');
    assert.equal(await syncMember(db, G, settings, DAVE, info(DAVE, [MEMBER_ROLE], 'Botty', true)), 'none');
    assert.deepEqual(await row(ALICE), { active: true, display_name: 'Alice', inactive: false });
    assert.equal(await row(CAROL), undefined);
    assert.equal(await row(DAVE), undefined);
  });

  it('keeps the display name current', async () => {
    await syncMember(db, G, settings, ALICE, info(ALICE, [MEMBER_ROLE], 'Alice Renamed'));
    assert.equal((await row(ALICE))!.display_name, 'Alice Renamed');
  });

  it('deletes an unreferenced member and their user row when the role is gone', async () => {
    assert.equal(await syncMember(db, G, settings, BOB, info(BOB, [])), 'deleted');
    assert.equal(await row(BOB), undefined);
    assert.equal(await userExists(BOB), false);
  });

  it('keeps a member who shares stock in the org inactive, and reactivates them with the role', async () => {
    await db.execute(sql`WITH b AS (INSERT INTO app.stock_batch (owner_user_id, kind, resource_uuid, location_uuid, quality, quantity)
      VALUES (${ALICE}, 'resource', ${U.metal}, ${U.station}, 800, 1) RETURNING id)
      INSERT INTO app.stock_share (batch_id, guild_id) SELECT id, ${G} FROM b`);
    assert.equal(await syncMember(db, G, settings, ALICE, null), 'inactive');
    assert.deepEqual(await row(ALICE), { active: false, display_name: 'Alice Renamed', inactive: true });
    assert.equal(await userExists(ALICE), true);
    assert.equal(await syncMember(db, G, settings, ALICE, info(ALICE, [MEMBER_ROLE], 'Alice Renamed')), 'active');
    assert.deepEqual(await row(ALICE), { active: true, display_name: 'Alice Renamed', inactive: false });
  });

  it('keeps the user row while they still have blueprints', async () => {
    await syncMember(db, G, settings, CAROL, info(CAROL, [MEMBER_ROLE]));
    await db.execute(sql`INSERT INTO app.user_blueprint (user_id, blueprint_uuid) VALUES (${CAROL}, ${U.blueprint})`);
    assert.equal(await syncMember(db, G, settings, CAROL, null), 'deleted');
    assert.equal(await userExists(CAROL), true);
  });

  it('keeps the user row while they have personal stock or an RSI handle, without any org', async () => {
    const [EVE, FRANK] = ['720000000000000005', '720000000000000006'];
    await syncMember(db, G, settings, EVE, info(EVE, [MEMBER_ROLE]));
    await syncMember(db, G, settings, FRANK, info(FRANK, [MEMBER_ROLE]));
    // Unshared stock has no org: it does not keep the member row, only the user
    await db.execute(sql`INSERT INTO app.stock_batch (owner_user_id, kind, resource_uuid, location_uuid, quality, quantity)
      VALUES (${EVE}, 'resource', ${U.metal}, ${U.station}, 700, 2)`);
    await db.execute(sql`UPDATE app.app_user SET rsi_handle = 'frank' WHERE user_id = ${FRANK}`);
    assert.equal(await syncMember(db, G, settings, EVE, null), 'deleted');
    assert.equal(await syncMember(db, G, settings, FRANK, null), 'deleted');
    assert.equal(await userExists(EVE), true);
    assert.equal(await userExists(FRANK), true);
  });

  it('full sync: adds new role holders and handles members who left while offline', async () => {
    // Alice (referenced) left, Bob got the member role, Carol is on the server without a role
    const counts = await syncGuild(db, G, settings, [info(BOB, [MEMBER_ROLE]), info(CAROL, ['other']), info(DAVE, ['other'])]);
    assert.deepEqual(counts, { active: 1, inactive: 1, deleted: 0, none: 0 });
    assert.equal((await row(ALICE))!.active, false);
    assert.equal((await row(BOB))!.active, true);
  });

  it('a concurrent first write keeps the user row, the member change still commits', async () => {
    const GINA = '720000000000000007';
    await syncMember(db, G, settings, GINA, info(GINA, [MEMBER_ROLE]));
    const other = connect(url);
    try {
      let sync: Promise<string> | undefined;
      // The write holds a key lock on the user row until it commits; the roster's user delete waits
      // for it and then fails on the foreign key
      await other.db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO app.stock_batch (owner_user_id, kind, resource_uuid, location_uuid, quality, quantity)
          VALUES (${GINA}, 'resource', ${U.metal}, ${U.station}, 500, 1)`);
        sync = syncMember(db, G, settings, GINA, null);
        await new Promise((r) => setTimeout(r, 300));
      });
      assert.equal(await sync, 'deleted');
      assert.equal(await row(GINA), undefined);
      assert.equal(await userExists(GINA), true);
    } finally {
      await other.close();
    }
  });
});
