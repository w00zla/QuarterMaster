// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
// The roster keeper: the per-guild order of syncs and events, retries; a server the bot left.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { RosterKeeper } from '../src/bot/roster-keeper.ts';
import type { MemberInfo } from '../src/bot/roster.ts';
import { ensureGuild, markGuildLeft, markGuildPresent, updateGuildSettings } from '../src/bot/settings.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '700000000000000021';
const MEMBER_ROLE = '710000000000000021';
const [ANN, BEA] = ['720000000000000021', '720000000000000022'];
const info = (userId: string, roleIds: string[]): MemberInfo => ({ userId, displayName: `n${userId.slice(-2)}`, roleIds, bot: false });

/** A promise plus its resolve, to hold a member list fetch open. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

describe('roster keeper (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;
  let keeper: RosterKeeper;
  const logs: string[] = [];

  const memberRow = async (userId: string) => (await db.execute<{ active: boolean }>(
    sql`SELECT active FROM app.member WHERE guild_id = ${G} AND user_id = ${userId}`))[0];

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    await ensureGuild(db, G, 'Keeper Org');
    await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE] });
  });
  beforeEach(async () => {
    keeper?.stop();
    await db.execute(sql`DELETE FROM app.member`);
    logs.length = 0;
    keeper = new RosterKeeper(db, (m) => logs.push(m), { fetchGapMs: 0 });
  });
  after(async () => {
    keeper?.stop();
    await close?.();
  });

  it('a full sync brings the roster in line; a failed one is logged for a retry', async () => {
    await keeper.fullSync(G, 'Keeper Org', async () => [info(ANN, [MEMBER_ROLE])]);
    assert.deepEqual(await memberRow(ANN), { active: true });
    await keeper.fullSync(G, 'Keeper Org', async () => {
      throw new Error('fetch timed out');
    });
    assert.ok(logs.some((l) => l.includes('Roster sync failed')));
  });

  it('applies a member event that arrives during a full sync after it', async () => {
    // Bea leaves while the sync still works from a member list that has her as member
    const sync = keeper.fullSync(G, 'Keeper Org', async () => {
      void keeper.memberEvent(G, BEA, null);
      return [info(ANN, [MEMBER_ROLE]), info(BEA, [MEMBER_ROLE])];
    });
    await sync;
    await keeper.memberEvent(G, ANN, info(ANN, [MEMBER_ROLE])); // waits for the queue
    assert.equal(await memberRow(BEA), undefined);
  });

  it('a failed member event is logged for a full sync', async () => {
    await keeper.fullSync(G, 'Keeper Org', async () => [info(ANN, [MEMBER_ROLE])]);
    // Not a snowflake: the user row's CHECK fails
    await keeper.memberEvent(G, 'not-a-snowflake', info('not-a-snowflake', [MEMBER_ROLE]));
    assert.ok(logs.some((l) => l.includes('Roster update failed')));
  });

  it('joins requests while a sync waits, and spaces the member list fetches of a guild', async () => {
    keeper = new RosterKeeper(db, (m) => logs.push(m), { fetchGapMs: 300 });
    const fetches: number[] = [];
    const load = async () => {
      fetches.push(Date.now());
      return [info(ANN, [MEMBER_ROLE])];
    };
    const hold = gate();
    const started = gate();
    const running = keeper.fullSync(G, 'Keeper Org', async () => {
      started.open();
      await hold.opened;
      return load();
    });
    await started.opened;
    // Both wait behind the running sync: one fetch for the two of them
    const second = keeper.fullSync(G, 'Keeper Org', load);
    const third = keeper.fullSync(G, 'Keeper Org', load);
    assert.equal(second, third);
    hold.open();
    await Promise.all([running, second, third]);
    assert.equal(fetches.length, 2);
    assert.ok(fetches[1]! - fetches[0]! >= 290, `fetches ${fetches[1]! - fetches[0]!} ms apart`);
  });

  it('a guild without setup has no roster', async () => {
    const OTHER = '700000000000000029';
    await keeper.fullSync(OTHER, 'No Setup', async () => assert.fail('must not fetch members'));
    assert.equal((await db.execute(sql`SELECT 1 FROM app.org WHERE guild_id = ${OTHER}`)).length, 0);
  });

  it('the bot leaving a server deactivates its members; a sync after it came back activates them again', async () => {
    await keeper.fullSync(G, 'Keeper Org', async () => [info(ANN, [MEMBER_ROLE])]);
    await markGuildLeft(db, G);
    assert.deepEqual(await memberRow(ANN), { active: false });
    await markGuildPresent(db, G);
    await keeper.fullSync(G, 'Keeper Org', async () => [info(ANN, [MEMBER_ROLE])]);
    assert.deepEqual(await memberRow(ANN), { active: true });
  });
});
