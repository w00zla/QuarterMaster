// The update planner: pure, every branch. Manifests are made up here (only tag, previous, schema and sizes matter).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tagOf, type Manifest } from '../src/datapack/manifest.ts';
import { FeedInconsistent, MAX_CHAIN, planUpdate, type UpdatePlan } from '../src/datapack/plan.ts';

const LABEL = '1.0.1000';
const APP = 7;
const tag = (n: number) => tagOf(LABEL, n);
const file = (name: string, size: number) => ({ name, size, sha256: 'a'.repeat(64) });

/** Release n: previous n-1 (null for 1), the sizes of its catalog, thumbs update and full pack. */
function release(n: number, o: { previous?: string | null; schema?: number; full?: number; catalog?: number; thumbs?: number } = {}): Manifest {
  return {
    format: 1,
    tag: tag(n),
    previous: o.previous === undefined ? (n > 1 ? tag(n - 1) : null) : o.previous,
    game: { label: LABEL, build: 1000 },
    schemaVersion: o.schema ?? APP,
    files: {
      full: file(`quartermaster-data-${LABEL}-${n}.zip`, o.full ?? 1000),
      catalog: file('catalog.json.gz', o.catalog ?? 100),
      thumbs: { ...file('thumbs-update.zip', o.thumbs ?? 10), count: 1 },
    },
  };
}

/** A feed of releases 1..count (overrides per n), and the tags asked for. */
function feedOf(count: number, overrides: Record<number, Parameters<typeof release>[1]> = {}) {
  const asked: string[] = [];
  const all = new Map<string, Manifest>();
  for (let n = 1; n <= count; n++) all.set(tag(n), release(n, overrides[n]));
  return { asked, manifestOf: async (t: string) => { asked.push(t); return all.get(t) ?? null; }, all };
}

const plan = (installed: string | null, newest: number, feed: ReturnType<typeof feedOf>, appSchemaVersion = APP): Promise<UpdatePlan> =>
  planUpdate({ installed, appSchemaVersion, newest: tag(newest), manifestOf: feed.manifestOf });
const tags = (p: UpdatePlan) => (p.kind === 'chain' ? p.manifests.map((m) => m.tag) : null);

describe('planUpdate', { timeout: 20_000 }, () => {
  it('nothing installed: the full pack', async () => {
    const p = await plan(null, 3, feedOf(3));
    assert.equal(p.kind, 'full');
    assert.equal(p.kind === 'full' && p.manifest.tag, tag(3));
    assert.equal(p.kind === 'full' && p.reason, 'nothingInstalled');
  });

  it('the same tag: up to date, without asking for a manifest', async () => {
    const feed = feedOf(3);
    assert.deepEqual(await plan(tag(3), 3, feed), { kind: 'upToDate', tag: tag(3) });
    assert.deepEqual(feed.asked, []);
  });

  it('one step: a chain of the newest release; bytes = its catalog + its thumbs update', async () => {
    const p = await plan(tag(2), 3, feedOf(3));
    assert.deepEqual(tags(p), [tag(3)]);
    assert.equal(p.kind === 'chain' && p.bytes, 110);
  });

  it('three steps: the thumbs updates of every release since, oldest first; only the newest catalog counts', async () => {
    const p = await plan(tag(1), 4, feedOf(4, { 2: { thumbs: 20, catalog: 5000 }, 3: { thumbs: 30 }, 4: { thumbs: 40 } }));
    assert.deepEqual(tags(p), [tag(2), tag(3), tag(4)]);
    assert.equal(p.kind === 'chain' && p.bytes, 100 + 20 + 30 + 40);
  });

  it('10 steps back is still a chain, 11 is the full pack', async () => {
    const ten = await plan(tag(1), 11, feedOf(11, { 11: { full: 100_000 } }));
    assert.equal(ten.kind, 'chain');
    assert.equal(ten.kind === 'chain' && ten.manifests.length, MAX_CHAIN);
    assert.equal(MAX_CHAIN, 10);
    const eleven = await plan(tag(1), 12, feedOf(12, { 12: { full: 100_000 } }));
    assert.equal(eleven.kind, 'full');
    assert.equal(eleven.kind === 'full' && eleven.reason, 'chainTooLong');
  });

  it('a gap (a manifest is missing): the full pack', async () => {
    const feed = feedOf(5);
    feed.all.delete(tag(3));
    const p = await plan(tag(1), 5, feed);
    assert.equal(p.kind === 'full' && p.reason, 'chainBroken');
  });

  it('a manifest that is another release than asked for: the full pack', async () => {
    const feed = feedOf(4);
    feed.all.set(tag(3), release(2));
    const p = await plan(tag(1), 4, feed);
    assert.equal(p.kind === 'full' && p.reason, 'chainBroken');
  });

  it('`previous` null before the installed tag is reached: the full pack', async () => {
    const p = await plan(tag(1), 3, feedOf(3, { 2: { previous: null } }));
    assert.equal(p.kind === 'full' && p.reason, 'chainBroken');
  });

  it('the chain is bigger than the full pack, or equal: the full pack; one byte less: the chain', async () => {
    const big = await plan(tag(1), 2, feedOf(2, { 2: { full: 500, catalog: 300, thumbs: 300 } }));
    assert.equal(big.kind === 'full' && big.reason, 'chainNotSmaller');
    const equal = await plan(tag(1), 2, feedOf(2, { 2: { full: 400, catalog: 300, thumbs: 100 } }));
    assert.equal(equal.kind === 'full' && equal.reason, 'chainNotSmaller');
    const less = await plan(tag(1), 2, feedOf(2, { 2: { full: 401, catalog: 300, thumbs: 100 } }));
    assert.equal(less.kind, 'chain');
  });

  it('an installed tag that is not in the newest release\'s history (newer, other game version): the full pack', async () => {
    const newer = await plan(tag(9), 3, feedOf(3));
    assert.equal(newer.kind === 'full' && newer.reason, 'chainBroken');
    const other = await plan('data-0.9.9-4', 3, feedOf(3));
    assert.equal(other.kind, 'full');
  });

  it('a pack with another schema: appTooOld, newer or older than the app, whatever is installed', async () => {
    const newer = await plan(tag(1), 2, feedOf(2, { 2: { schema: APP + 1 } }));
    assert.equal(newer.kind, 'appTooOld');
    assert.equal(newer.kind === 'appTooOld' && newer.pack, 'newer');
    assert.equal(newer.kind === 'appTooOld' && newer.manifest.tag, tag(2));
    const older = await plan(null, 2, feedOf(2, { 2: { schema: APP - 1 } }));
    assert.equal(older.kind === 'appTooOld' && older.pack, 'older');
  });

  it('the feed names a release without a manifest, or with another one: an error', async () => {
    await assert.rejects(plan(tag(1), 5, feedOf(2)), FeedInconsistent);
    const feed = feedOf(3);
    feed.all.set(tag(3), release(2));
    await assert.rejects(plan(tag(1), 3, feed), FeedInconsistent);
  });

  it('a manifest lookup that throws (network) is not swallowed', async () => {
    await assert.rejects(planUpdate({ installed: tag(1), appSchemaVersion: APP, newest: tag(2), manifestOf: async () => { throw new Error('boom'); } }), /boom/);
  });
});
