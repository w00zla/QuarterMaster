// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Client } from 'discord.js';
import { connect, type Db } from '../src/db/client.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { addBlueprint } from '../src/bot/blueprints.ts';
import { LogsPoster } from '../src/bot/logs.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { add, move, refineStart, remove, share, type Actor } from '../src/stock/service.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const [G, H] = ['960000000000000001', '960000000000000002'];
const [CHANNEL_G, CHANNEL_H] = ['961000000000000001', '961000000000000002'];
const ROLE = '962000000000000001';
const [MIA, OLGA] = ['963000000000000001', '963000000000000002'];
const mia: Actor = { userId: MIA, guildId: G, source: 'bot' };
const metal = { kind: 'resource' as const, uuid: U.metal, locationUuid: U.station };

/** A client whose channels record what is sent; unknown channels fail like a deleted one. */
function fakeClient(sent: Map<string, string[]>) {
  return {
    channels: {
      async fetch(id: string) {
        if (!sent.has(id)) throw new Error('Unknown Channel');
        return { isSendable: () => true, send: async (m: { content: string }) => void sent.get(id)!.push(m.content) };
      },
    },
  } as unknown as Client;
}

describe('logs channel (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;
  const logged: string[] = [];
  const quiet = (m: string) => void logged.push(m);

  before(async () => {
    ({ db, close } = connect(url));
    for (const schema of ['ext', 'web', 'bot', 'app', 'catalog', 'drizzle']) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    for (const g of [G, H]) {
      await ensureGuild(db, g, g === G ? 'Org G' : 'Org H');
      const settings = await updateGuildSettings(db, g, { memberRoleIds: [ROLE] });
      for (const [userId, displayName] of [[MIA, 'Mia'], [OLGA, 'Olga']] as const) {
        await syncMember(db, g, settings, userId, { userId, displayName, roleIds: [ROLE], bot: false });
      }
    }
  });
  after(async () => close?.());

  it('posts what happens to an org\'s offer, nothing private, and never the past', async () => {
    // Before the channel exists: not posted later
    await add(db, mia, { ...metal, quality: 800, amount: '1', org: true });
    await updateGuildSettings(db, G, { logsChannelId: CHANNEL_G, baseLang: 'en' });
    await updateGuildSettings(db, H, { logsChannelId: CHANNEL_H, baseLang: 'de' });

    // Private: unshared stock, a refinery job, a blueprint
    const own = (await add(db, mia, { ...metal, quality: 700, amount: '5' })).batch!;
    await remove(db, mia, { batchId: own.id, amount: '1' });
    await refineStart(db, mia, { locationUuid: U.station, rows: [{ oreUuid: U.ore, quality: 600, amount: '8' }] });
    await addBlueprint(db, MIA, U.blueprint, 'bot');
    // The org's offer: shared in G (with the booking), then also in H, used up partly, given in G
    const shared = (await add(db, mia, { ...metal, quality: 900, amount: '10', org: true })).batch!;
    await add(db, mia, { ...metal, quality: 900, amount: '2' });
    await share(db, mia, { batchId: shared.id, guildIds: [G, H] });
    await remove(db, mia, { batchId: shared.id, amount: '3' });
    await move(db, mia, { batchId: shared.id, amount: '4', toOwnerUserId: OLGA });

    const sent = new Map([[CHANNEL_G, [] as string[]], [CHANNEL_H, [] as string[]]]);
    const poster = new LogsPoster(fakeClient(sent), db, quiet);
    await poster.round();
    const who = `<@${MIA}>`;
    assert.deepEqual(sent.get(CHANNEL_G)!.join('\n').split('\n'), [
      `📢 ${who} shared **10 SCU** · **Test Metal** Q900 · Test Station`,
      `📥 ${who} added **2 SCU** · **Test Metal** Q900 · Test Station · now 12 SCU`,
      `📤 ${who} took out **3 SCU** · **Test Metal** Q900 · Test Station · 9 SCU left`,
      `📦 ${who} gave **4 SCU** · **Test Metal** Q900 to <@${OLGA}> · Test Station`,
    ]);
    assert.deepEqual(sent.get(CHANNEL_H)!.join('\n').split('\n'), [
      `📢 ${who} teilt **12 SCU** · **Testmetall** Q900 · Test Station`,
      `📤 ${who} entnimmt **3 SCU** · **Testmetall** Q900 · Test Station · noch 9 SCU`,
      `📦 ${who} gibt ab: **4 SCU** · **Testmetall** Q900 · Test Station`,
    ]);

    // Nothing twice
    await poster.round();
    assert.equal(sent.get(CHANNEL_G)!.length + sent.get(CHANNEL_H)!.length, 2);
  });

  it('skips the lines of a channel that cannot be used, and starts anew when the channel changes', async () => {
    const sent = new Map([[CHANNEL_G, [] as string[]]]);
    const poster = new LogsPoster(fakeClient(sent), db, quiet);
    const b = (await add(db, mia, { ...metal, quality: 500, amount: '3', org: true })).batch!;
    await share(db, mia, { batchId: b.id, guildIds: [G, H] });
    // H's channel is gone: its lines are dropped, not kept for later
    await poster.round();
    assert.equal(sent.get(CHANNEL_G)!.length, 1);
    assert.ok(logged.some((m) => m.includes(CHANNEL_H)));
    sent.set(CHANNEL_H, []);
    await poster.round();
    assert.deepEqual(sent.get(CHANNEL_H), []);

    // Logs off, a booking, logs on again: the booking in between is not posted
    await updateGuildSettings(db, G, { logsLevel: 'off' });
    await remove(db, mia, { batchId: b.id, amount: '1' });
    await poster.round();
    await updateGuildSettings(db, G, { logsLevel: 'org' });
    await poster.round();
    assert.equal(sent.get(CHANNEL_G)!.length, 1);
  });
});
