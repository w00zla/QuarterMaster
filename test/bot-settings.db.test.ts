// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connect, type Db } from '../src/db/client.ts';
import {
  ensureGuild, getGuildSettings, markGuildLeft, markGuildPresent, reconcilePresence, updateGuildSettings,
} from '../src/bot/settings.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '300000000000000001';

describe('bot guild settings (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    ({ db, close } = connect(url));
    for (const schema of ['ext', 'web', 'bot', 'app', 'catalog', 'drizzle']) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  });
  after(async () => close?.());

  it('creates org and bot settings with defaults on first use, idempotently', async () => {
    const first = await ensureGuild(db, G, 'Test Org');
    assert.deepEqual(first, { memberRoleIds: [], baseLang: 'en', logsChannelId: null, logsLevel: 'org' });
    await ensureGuild(db, G, 'Renamed Org');
    const [row] = await db.execute<{ name: string }>(sql`SELECT name FROM app.org WHERE guild_id = ${G}`);
    assert.equal(row!.name, 'Renamed Org');
  });

  it('updates roles in app.org and bot settings in bot.guild, leaving the rest alone', async () => {
    await updateGuildSettings(db, G, { memberRoleIds: ['400000000000000001', '400000000000000002'] });
    await updateGuildSettings(db, G, { baseLang: 'de', logsChannelId: '500000000000000001' });
    const s = await updateGuildSettings(db, G, { logsLevel: 'off' });
    assert.deepEqual(s, {
      memberRoleIds: ['400000000000000001', '400000000000000002'],
      baseLang: 'de',
      logsChannelId: '500000000000000001',
      logsLevel: 'off',
    });
    assert.deepEqual((await updateGuildSettings(db, G, { logsChannelId: null })).logsChannelId, null);
  });

  it('records whether the bot is on the server: events and the startup check', async () => {
    const [A, B, C] = ['700000000000000031', '700000000000000032', '700000000000000033'];
    for (const id of [A, B, C]) await ensureGuild(db, id, `g${id.slice(-1)}`);
    const left = async () => (await db.execute<{ guild_id: string }>(
      sql`SELECT guild_id FROM bot.guild WHERE left_at IS NOT NULL AND guild_id IN (${A}, ${B}, ${C}) ORDER BY guild_id`)).map((r) => r.guild_id);
    await markGuildLeft(db, A);
    assert.deepEqual(await left(), [A]);
    await markGuildPresent(db, A);
    assert.deepEqual(await left(), []);
    // Startup: on A and C; B removed the bot while it was offline
    await markGuildLeft(db, C);
    await reconcilePresence(db, [A, C]);
    assert.deepEqual(await left(), [B]);
    await reconcilePresence(db, []);
    assert.deepEqual(await left(), [A, B, C]);
  });

  it('rejects values the schema does not allow', async () => {
    await assert.rejects(updateGuildSettings(db, G, { logsLevel: 'all' as never }));
    await assert.rejects(updateGuildSettings(db, G, { logsChannelId: 'not-a-snowflake' }));
    assert.equal((await getGuildSettings(db, G)).logsLevel, 'off');
  });
});
