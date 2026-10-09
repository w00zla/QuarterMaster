// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { langOverride } from '../src/bot/lang.ts';
import { loadProfile, saveProfile } from '../src/bot/profile.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '830000000000000001';
const ROLE = '831000000000000001';
const [NOORG, MEMBER, EMPTY] = ['832000000000000001', '832000000000000002', '832000000000000003'];

const userRow = async (db: Db, userId: string) =>
  (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM app.app_user WHERE user_id = ${userId}`))[0]!.n;

describe('/qm-profile storage (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
  });
  after(async () => close?.());

  it('saves a profile for a user without any org and reads it back', async () => {
    assert.deepEqual(await loadProfile(db, NOORG), { rsiHandle: null, lang: null });
    await saveProfile(db, NOORG, { rsiHandle: 'No_Org', lang: 'de' });
    assert.deepEqual(await loadProfile(db, NOORG), { rsiHandle: 'No_Org', lang: 'de' });
    assert.equal(await langOverride(db, NOORG), 'de');
    await saveProfile(db, NOORG, { rsiHandle: null, lang: null });
    assert.deepEqual(await loadProfile(db, NOORG), { rsiHandle: null, lang: null });
    assert.equal(await langOverride(db, NOORG), null);
  });

  it('leaves no user row behind for an empty profile', async () => {
    await saveProfile(db, EMPTY, { rsiHandle: null, lang: null });
    assert.equal(await userRow(db, EMPTY), 0);
  });

  it('keeps a member\'s profile when they lose the role (the cleanup counts it as data)', async () => {
    await ensureGuild(db, G, 'Profile Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [ROLE] });
    await syncMember(db, G, settings, MEMBER, { userId: MEMBER, displayName: 'Mo', roleIds: [ROLE], bot: false });
    await saveProfile(db, MEMBER, { rsiHandle: null, lang: 'en' });
    assert.equal(await syncMember(db, G, settings, MEMBER, null), 'deleted');
    assert.equal(await userRow(db, MEMBER), 1);
    assert.deepEqual(await loadProfile(db, MEMBER), { rsiHandle: null, lang: 'en' });
  });
});
