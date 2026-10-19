// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DiscordAPIError, type Client } from 'discord.js';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { addBlueprint, blueprintCatalog, removeBlueprint } from '../src/bot/blueprints.ts';
import { LogsPoster } from '../src/bot/logs.ts';
import { escapeMarkdown } from '../src/bot/markdown.ts';
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
function fakeClient(sent: Map<string, string[]>, failSend?: () => Error | null) {
  return {
    channels: {
      async fetch(id: string) {
        if (!sent.has(id)) throw new DiscordAPIError({ code: 10003, message: 'Unknown Channel' }, 10003, 404, 'GET', '', {});
        return {
          isSendable: () => true,
          send: async (m: { content: string }) => {
            const err = failSend?.();
            if (err) throw err;
            sent.get(id)!.push(m.content);
          },
        };
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
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
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
    await refineStart(db, mia, { locationUuid: U.station, rows: [{ resourceUuid: U.metal, quality: 600, amount: '8' }] });
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

  it('stops posting what a former member does with shares left behind', async () => {
    const MAX = '963000000000000009';
    const max: Actor = { userId: MAX, guildId: G, source: 'bot' };
    const settings = await updateGuildSettings(db, G, {});
    await syncMember(db, G, settings, MAX, { userId: MAX, displayName: 'Max', roleIds: [ROLE], bot: false });
    const sent = new Map([[CHANNEL_G, [] as string[]], [CHANNEL_H, [] as string[]]]);
    const poster = new LogsPoster(fakeClient(sent), db, quiet);
    const b = (await add(db, max, { ...metal, quality: 910, amount: '6', org: true })).batch!;
    await poster.round();
    assert.equal(sent.get(CHANNEL_G)!.length, 1);
    // Max loses the role: the row stays inactive because the share still exists
    await syncMember(db, G, settings, MAX, { userId: MAX, displayName: 'Max', roleIds: [], bot: false });
    await remove(db, max, { batchId: b.id, amount: '1' });
    await poster.round();
    assert.equal(sent.get(CHANNEL_G)!.length, 1);
  });

  it('keeps the lines when Discord or the network fails, without repeating what already went out', async () => {
    const sent = new Map([[CHANNEL_G, [] as string[]]]);
    await new LogsPoster(fakeClient(sent), db, quiet).round(); // catch up with the history so far
    sent.get(CHANNEL_G)!.length = 0;
    // About 3000 characters of lines: two messages
    for (let q = 100; q < 130; q++) await add(db, mia, { ...metal, quality: q, amount: '1', org: true });
    // The second message fails once (not a Discord error): the first stays marked, the rest follows next round
    let sends = 0;
    const flaky = new LogsPoster(fakeClient(sent, () => (++sends === 2 ? new Error('socket hang up') : null)), db, quiet);
    await flaky.round();
    assert.equal(sent.get(CHANNEL_G)!.length, 1);
    await flaky.round();
    assert.equal(sent.get(CHANNEL_G)!.length, 2);
    const lines = sent.get(CHANNEL_G)!.join('\n').split('\n');
    assert.equal(lines.length, 30);
    assert.equal(new Set(lines).size, 30);
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
    await updateGuildSettings(db, G, { logsLevel: 'stock' });
    await poster.round();
    assert.equal(sent.get(CHANNEL_G)!.length, 1);
  });

  it('posts the blueprints of active members with the levels blueprints and all', async () => {
    await updateGuildSettings(db, G, { logsLevel: 'blueprints' });
    await updateGuildSettings(db, H, { logsLevel: 'all' });
    const sent = new Map([[CHANNEL_G, [] as string[]], [CHANNEL_H, [] as string[]]]);
    const poster = new LogsPoster(fakeClient(sent), db, quiet);
    // Not a member anywhere: never posted
    await addBlueprint(db, '963000000000000008', U.blueprint2, 'companion');
    await addBlueprint(db, OLGA, U.blueprint2, 'companion');
    const b = (await add(db, mia, { ...metal, quality: 950, amount: '1' })).batch!;
    await share(db, mia, { batchId: b.id, guildIds: [G, H] });
    await removeBlueprint(db, OLGA, U.blueprint2, 'bot');
    await poster.round();
    const label = async (lang: 'en' | 'de') => escapeMarkdown((await blueprintCatalog(db, lang)).byUuid.get(U.blueprint2)!.label);
    const [en, de] = [await label('en'), await label('de')];
    const olga = `<@${OLGA}>`;
    assert.deepEqual(sent.get(CHANNEL_G)!.join('\n').split('\n'), [
      `📘 ${olga} added blueprint **${en}**`,
      `📕 ${olga} removed blueprint **${en}**`,
    ]);
    assert.deepEqual(sent.get(CHANNEL_H)!.join('\n').split('\n'), [
      `📘 ${olga} trägt Bauplan ein: **${de}**`,
      `📢 <@${MIA}> teilt **1 SCU** · **Testmetall** Q950 · Test Station`,
      `📕 ${olga} trägt Bauplan aus: **${de}**`,
    ]);
  });
});
