// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { checkReply } from '../src/bot/commands/crafting.ts';
import { UserError } from '../src/bot/errors.ts';
import { syncMember } from '../src/bot/roster.ts';
import { ensureGuild, updateGuildSettings } from '../src/bot/settings.ts';
import { add, share, type Actor } from '../src/stock/service.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const G = '960000000000000001';
const MEMBER_ROLE = '961000000000000001';
const [MIA, OLGA, NOORG] = ['962000000000000001', '962000000000000002', '962000000000000003'];
const mia: Actor = { userId: MIA, guildId: G, source: 'bot' };
const olga: Actor = { userId: OLGA, guildId: G, source: 'bot' };
const metal = { kind: 'resource' as const, uuid: U.metal, locationUuid: U.station };
const text = (p: Awaited<ReturnType<typeof checkReply>>) => JSON.stringify(p.components[0]!.toJSON());

describe('/qm-crafting check (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    await prepareDb(url);
    ({ db, close } = connectAs(url, 'qm_app'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    await ensureGuild(db, G, 'Crafting Org');
    const settings = await updateGuildSettings(db, G, { memberRoleIds: [MEMBER_ROLE] });
    await syncMember(db, G, settings, MIA, { userId: MIA, displayName: 'Mia', roleIds: [MEMBER_ROLE], bot: false });
    await syncMember(db, G, settings, OLGA, { userId: OLGA, displayName: 'Olga', roleIds: [MEMBER_ROLE], bot: false });
  });
  after(async () => close?.());

  it('checks the recipe against your stock plus what is shared in your orgs, at the quality asked', async () => {
    // 2 × 0.046 SCU metal = 0.092: Mia holds 0.05 at Q600, Olga shares 0.05 at Q800, unshared stock of Olga does not count
    await add(db, mia, { ...metal, quality: 600, amount: '0.05' });
    const shared = (await add(db, olga, { ...metal, quality: 800, amount: '0.05' })).batch!;
    await share(db, olga, { batchId: shared.id, guildIds: [G] });
    await add(db, olga, { ...metal, quality: 900, amount: '5' });

    const at600 = text(await checkReply(db, 'en', MIA, U.blueprint, 2, 600));
    assert.match(at600, /× 2/);
    assert.match(at600, /Quality \*\*600\*\* · Crafting time \*\*5m\*\*/);
    assert.match(at600, /\*\*Test Metal\*\* · 0.092 SCU · Q ≥ 600 ★★ · ✅ covered/);
    // At 700 only Olga's shared batch is good enough
    assert.match(text(await checkReply(db, 'en', MIA, U.blueprint, 2, 700)), /Q ≥ 700 ★★★ · ❌ missing \*\*0.042 SCU\*\*/);
    // Someone without any org sees only their own stock (none here)
    assert.match(text(await checkReply(db, 'de', NOORG, U.blueprint, 1, null)), /Q ≥ 500 ★ · ❌ fehlt \*\*0.046 SCU\*\*/);
  });

  it('refuses a blueprint that is not in the catalog', async () => {
    await assert.rejects(checkReply(db, 'en', MIA, '10000000-0000-0000-0000-0000000000ff', 1, null),
      (err: unknown) => err instanceof UserError && err.key === 'bp.unknown');
  });
});
