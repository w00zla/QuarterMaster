// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
// The roster keeper: per-org freshness (app.org.roster_checked_at) and the per-guild order of syncs and events.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connect, type Db } from '../src/db/client.ts';
import { RosterKeeper } from '../src/bot/roster-keeper.ts';
import type { MemberInfo } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '700000000000000021';
const MEMBER_ROLE = '710000000000000021';
const OFFICER_ROLE = '710000000000000022';
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
  let reachable: boolean;
  let keeper: RosterKeeper;
  const logs: string[] = [];

  const checkedAt = async () => {
    const { at } = (await db.execute<{ at: string | null }>(sql`SELECT roster_checked_at AS at FROM app.org WHERE guild_id = ${G}`))[0]!;
    return at === null ? null : new Date(at);
  };
  const memberRow = async (userId: string) => (await db.execute<{ active: boolean; officer: boolean }>(
    sql`SELECT active, officer FROM app.member WHERE guild_id = ${G} AND user_id = ${userId}`))[0];

  before(async () => {
    ({ db, close } = connect(url));
    for (const schema of ['uex', 'web', 'bot', 'app', 'catalog', 'drizzle']) await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await migrate(db, { migrationsFolder: new URL('../drizzle', import.meta.url).pathname });
    await ensureGuild(db, G, 'Keeper Org');
    await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE], officerRoleIds: [OFFICER_ROLE] });
  });
  beforeEach(async () => {
    await keeper?.stop();
    await db.execute(sql`DELETE FROM app.member`);
    await db.execute(sql`UPDATE app.org SET roster_checked_at = now() - interval '1 hour'`);
    reachable = true;
    logs.length = 0;
    keeper = new RosterKeeper(db, () => reachable, (m) => logs.push(m), { fetchGapMs: 0 });
  });
  after(async () => {
    await keeper?.stop();
    await close?.();
  });

  it('vouches after a successful full sync, refreshes on every beat while reachable', async () => {
    await keeper.fullSync(G, 'Keeper Org', async () => [info(ANN, [OFFICER_ROLE])]);
    await keeper.beat();
    const first = await checkedAt();
    assert.ok(first && Date.now() - first.getTime() < 60_000);
    assert.deepEqual(await memberRow(ANN), { active: true, officer: true });
    await db.execute(sql`UPDATE app.org SET roster_checked_at = now() - interval '1 hour'`);
    reachable = false;
    await keeper.beat();
    assert.ok(Date.now() - (await checkedAt())!.getTime() > 3_000_000, 'not refreshed while unreachable');
  });

  it('clears the mark the moment a sync starts, keeps it cleared when the sync fails', async () => {
    const hold = gate();
    const sync = keeper.fullSync(G, 'Keeper Org', async () => {
      await hold.opened;
      throw new Error('fetch timed out');
    });
    await keeper.beat();
    assert.equal(await checkedAt(), null);
    hold.open();
    await sync;
    await keeper.beat();
    assert.equal(await checkedAt(), null);
    assert.ok(logs.some((l) => l.includes('Roster sync failed')));
  });

  it('applies a member event that arrives during a full sync after it', async () => {
    // Bea leaves while the sync still works from a member list that has her as officer
    const sync = keeper.fullSync(G, 'Keeper Org', async () => {
      void keeper.memberEvent(G, BEA, null);
      return [info(ANN, [MEMBER_ROLE]), info(BEA, [OFFICER_ROLE])];
    });
    await sync;
    await keeper.memberEvent(G, ANN, info(ANN, [MEMBER_ROLE])); // waits for the queue
    assert.equal(await memberRow(BEA), undefined);
  });

  it('only the last of several pending syncs vouches', async () => {
    const hold = gate();
    const started = gate();
    const first = keeper.fullSync(G, 'Keeper Org', async () => {
      started.open();
      await hold.opened;
      return [info(ANN, [MEMBER_ROLE])];
    });
    // The first one is fetching: a new request must sync again afterwards
    await started.opened;
    const second = keeper.fullSync(G, 'Keeper Org', async () => [info(ANN, [MEMBER_ROLE])]);
    hold.open();
    await first;
    await keeper.beat();
    assert.equal(await checkedAt(), null, 'the first sync must not vouch while the second is pending');
    await second;
    await keeper.beat();
    assert.ok(await checkedAt());
  });

  it('a failed member event makes the org stale; stop() too', async () => {
    await keeper.fullSync(G, 'Keeper Org', async () => [info(ANN, [MEMBER_ROLE])]);
    await keeper.beat();
    assert.ok(await checkedAt());
    // Not a snowflake: the user row's CHECK fails
    await keeper.memberEvent(G, 'not-a-snowflake', info('not-a-snowflake', [MEMBER_ROLE]));
    await keeper.beat();
    assert.equal(await checkedAt(), null);

    await keeper.fullSync(G, 'Keeper Org', async () => [info(ANN, [MEMBER_ROLE])]);
    await keeper.beat();
    assert.ok(await checkedAt());
    await keeper.stop();
    assert.equal(await checkedAt(), null);
  });

  it('joins requests while a sync waits, and spaces the member list fetches of a guild', async () => {
    keeper = new RosterKeeper(db, () => reachable, (m) => logs.push(m), { fetchGapMs: 300 });
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
    await keeper.beat();
    assert.ok(await checkedAt());
  });

  it('a guild without setup has nothing to vouch for', async () => {
    const OTHER = '700000000000000029';
    await keeper.fullSync(OTHER, 'No Setup', async () => assert.fail('must not fetch members'));
    await keeper.beat();
    assert.equal((await db.execute(sql`SELECT 1 FROM app.org WHERE guild_id = ${OTHER}`)).length, 0);
  });
});
