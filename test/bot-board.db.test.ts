// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DiscordAPIError, type Client } from 'discord.js';
import { sql } from 'drizzle-orm';
import type { ChangeSource, Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { addBlueprint } from '../src/bot/blueprints.ts';
import { BoardPoster, listenForBoardChanges } from '../src/bot/board.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { orgMetrics } from '../src/stock/org-summary.ts';
import { add, remove, share, type Actor } from '../src/stock/service.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const [G, H] = ['970000000000000001', '970000000000000002'];
const CHANNEL = '971000000000000001';
const ROLE = '972000000000000001';
const [MIA, OLGA] = ['973000000000000001', '973000000000000002'];
const mia: Actor = { userId: MIA, guildId: G, source: 'bot' };
const olga: Actor = { userId: OLGA, guildId: G, source: 'bot' };
const metal = { kind: 'resource' as const, uuid: U.metal, locationUuid: U.station };

type Payload = { components: { toJSON(): unknown }[] };
const textOf = (m: Payload) => JSON.stringify(m.components.map((c) => c.toJSON()));

// Message IDs, unique across the fakes
let next = 974000000000000000n;

/** A channel that records posts and edits; `deleted` messages fail to edit like Discord's. */
function fakeDiscord() {
  const posts: string[] = [];
  const edits: Array<[string, string]> = [];
  const deleted = new Set<string>();
  const client = {
    guilds: { cache: new Map() },
    channels: {
      async fetch(id: string) {
        if (id !== CHANNEL) throw new DiscordAPIError({ code: 10003, message: 'Unknown Channel' }, 10003, 404, 'GET', '', {});
        return {
          isSendable: () => true,
          send: async (m: Payload) => {
            posts.push(textOf(m));
            return { id: String(++next) };
          },
          messages: {
            edit: async (messageId: string, m: Payload) => {
              if (deleted.has(messageId)) throw new DiscordAPIError({ code: 10008, message: 'Unknown Message' }, 10008, 404, 'PATCH', '', {});
              edits.push([messageId, textOf(m)]);
            },
          },
        };
      },
    },
  } as unknown as Client;
  return { client, posts, edits, deleted };
}

describe('board (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let client: ChangeSource;
  let close: () => Promise<void>;
  const logged: string[] = [];
  const quiet = (m: string) => void logged.push(m);
  const messageId = async () =>
    (await db.execute<{ id: string | null }>(sql`SELECT board_message_id AS id FROM bot.guild WHERE guild_id = ${G}`))[0]!.id;

  before(async () => {
    await prepareDb(url);
    ({ db, close, client } = connectAs(url, 'qm_app'));
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

  it('shows what active members share in the org, nothing private', async () => {
    await add(db, mia, { ...metal, quality: 800, amount: '10', org: true });
    await add(db, olga, { ...metal, quality: 910, amount: '2.5', org: true });
    // Private, and shared in another org only
    await add(db, mia, { ...metal, quality: 500, amount: '99' });
    await add(db, { ...mia, guildId: H }, { ...metal, quality: 600, amount: '7', org: true });
    await addBlueprint(db, MIA, U.blueprint, 'bot');

    const m = (await orgMetrics(db, [G])).get(G)!;
    assert.deepEqual(m, {
      resources: { kinds: 1, scu: '12.5', locations: 1 }, items: { kinds: 0, pieces: '0', locations: 0 },
      components: { kinds: 0, pieces: '0', locations: 0 }, members: 2, blueprints: 1, resourceItemLocations: 1,
    });

    await updateGuildSettings(db, G, { boardChannelId: CHANNEL, baseLang: 'en' });
    const discord = fakeDiscord();
    const poster = new BoardPoster(discord.client, db, quiet);
    await poster.round();
    assert.equal(discord.posts.length, 1);
    assert.match(discord.posts[0]!, /## Org G/);
    assert.match(discord.posts[0]!, /👥 \*\*2\*\* Members · 📘 \*\*1 \/ \d+\*\* Blueprints/);
    assert.match(discord.posts[0]!, /- \*\*Test Metal\*\* · 12\.5 SCU · ★★★★★ \*\*910\*\* · 2 holders/);
    assert.ok(await messageId(), 'the message ID is stored');

    // Nothing marked: no work at all
    await poster.round();
    assert.equal(discord.posts.length + discord.edits.length, 1);
  });

  it('edits only after a change of the org, posts again when the message is gone', async () => {
    const discord = fakeDiscord();
    const poster = new BoardPoster(discord.client, db, quiet);
    await poster.round();
    // A new process edits its board once (it does not know what was shown)
    assert.equal(discord.edits.length, 1);

    // Marked, but the same data: no edit
    poster.markGuild(G);
    await poster.round();
    assert.equal(discord.edits.length, 1);

    // Another org's change: not this board
    poster.markGuild(H);
    await poster.round();
    assert.equal(discord.edits.length, 1);

    const batch = (await add(db, mia, { ...metal, quality: 950, amount: '1', org: true })).batch!;
    poster.markGuild(G);
    await poster.round();
    assert.equal(discord.edits.length, 2);
    assert.match(discord.edits[1]![1], /13\.5 SCU · ★★★★★ \*\*950\*\*/);

    // Deleted in Discord: a new post, its ID stored
    const old = (await messageId())!;
    discord.deleted.add(old);
    await remove(db, mia, { batchId: batch.id, amount: '1' });
    poster.markGuild(G);
    await poster.round();
    assert.equal(discord.posts.length, 1);
    assert.notEqual(await messageId(), old);
  });

  it('a blueprint change marks every org of its user; a new board channel gets a new message', async () => {
    const discord = fakeDiscord();
    const poster = new BoardPoster(discord.client, db, quiet);
    await poster.round();
    await addBlueprint(db, OLGA, U.blueprint2, 'bot');
    poster.markUser(OLGA);
    await poster.round();
    assert.equal(discord.edits.length, 2);

    const before = await messageId();
    await updateGuildSettings(db, G, { boardChannelId: CHANNEL });
    assert.equal(await messageId(), before, 'the same channel keeps its message');
    await updateGuildSettings(db, G, { boardChannelId: null });
    await updateGuildSettings(db, G, { boardChannelId: CHANNEL });
    assert.equal(await messageId(), null);
    poster.markGuild(G);
    await poster.round();
    assert.equal(discord.posts.length, 1);

    // Its own title, back to the org name when cleared
    await updateGuildSettings(db, G, { boardTitle: 'Lager der Flotte', boardSubtitle: 'Nur Geteiltes' });
    poster.markGuild(G);
    await poster.round();
    assert.match(discord.edits.at(-1)![1], /## Lager der Flotte\\n-# Nur Geteiltes/);
    await updateGuildSettings(db, G, { boardTitle: null, boardSubtitle: null });
    poster.markGuild(G);
    await poster.round();
    assert.match(discord.edits.at(-1)![1], /## Org G"/);
  });

  it('hears the database: a share in the org marks its board', async () => {
    const discord = fakeDiscord();
    const poster = new BoardPoster(discord.client, db, quiet);
    await poster.round();
    const posted = discord.posts.length + discord.edits.length;
    const listening = await listenForBoardChanges(client, poster);
    try {
      const b = (await add(db, olga, { ...metal, quality: 990, amount: '3' })).batch!;
      await share(db, olga, { batchId: b.id, guildIds: [G] });
      // Notifications arrive after the commit, asynchronously
      for (let i = 0; i < 50 && discord.posts.length + discord.edits.length === posted; i++) {
        await new Promise((r) => setTimeout(r, 20));
        await poster.round();
      }
      assert.equal(discord.posts.length + discord.edits.length, posted + 1);
      assert.match(discord.edits.at(-1)![1], /★★★★★ \*\*990\*\*/);
    } finally {
      await listening.unlisten();
    }
  });
});
