// Runs against TEST_DATABASE_URL only; the web, bot, app and catalog schemas there are dropped and recreated.
// Privileges and their features' data (src/webapp/features.ts, src/adminapp/privileges.ts): who holds a key,
// the generic entries API with its rights (everyone with the key sees all, changes only their own), the image
// upload, the thumb-review subjects, the admin's view and export.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/client.ts';
import { connectAs, prepareDb } from './roles.ts';
import { runImport } from '../src/catalog/import/apply.ts';
import { sha256, stableStringify } from '../src/catalog/import/plan.ts';
import { exportFeature, getPrivilege, getUserPrivileges, grantPrivilege, revokePrivilege } from '../src/adminapp/privileges.ts';
import type { FeatureEntriesResponse, MeResponse, ThumbReviewSubjectsResponse } from '../src/webapp/api-types.ts';
import { createApp } from '../src/webapp/app.ts';
import type { DiscordLogin } from '../src/webapp/discord.ts';
import { BLOB_BODY_LIMIT } from '../src/webapp/features.ts';
import { createSession } from '../src/webapp/session.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://qm.test';
const KEY = 'thumb-review';
const [ANNA, BEN, EVE] = ['760000000000000061', '760000000000000062', '760000000000000063'];
const HASH = 'abcdef01';
const noLogin: DiscordLogin = { start: () => Promise.reject(new Error('unused')), finish: () => Promise.reject(new Error('unused')) };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

describe('privileges and feature data (database)', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Db;
  let webDb: Db;
  let closeDb: () => Promise<void>;
  let closeWeb: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let thumbsDir: string;
  const tokens = new Map<string, string>();
  const entriesPath = `/features/${KEY}/entries`;

  const call = async <T>(user: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      headers: {
        cookie: `__Host-qm_session=${tokens.get(user)}`, origin: ORIGIN, 'sec-fetch-site': 'same-origin',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, body: (type.startsWith('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer())) as T };
  };
  const entries = async (user: string) => (await call<FeatureEntriesResponse>(user, 'GET', entriesPath)).body.entries;
  const mark = (user: string, payload: unknown = { hash: HASH }, subject: string = U.gem) =>
    call<{ ok?: true; error?: string }>(user, 'PUT', `${entriesPath}/${subject}`, { payload });

  before(async () => {
    await prepareDb(url);
    // db plays the admin, the web app runs as qm_web
    ({ db, close: closeDb } = connectAs(url, 'qm_app'));
    ({ db: webDb, close: closeWeb } = connectAs(url, 'qm_web'));
    const snap = fixtureSnapshot();
    await runImport(db, snap, sha256(stableStringify(snap)), { dryRun: false, force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 });
    for (const id of [ANNA, BEN, EVE]) {
      tokens.set(id, await createSession(webDb, { id, username: `u${id.slice(-2)}`, globalName: `Name ${id.slice(-2)}`, avatar: null }));
    }
    thumbsDir = mkdtempSync(join(tmpdir(), 'qm-thumbs-'));
    writeFileSync(join(thumbsDir, 'thumbs.json'), JSON.stringify({ [U.gem]: HASH }));
    app = createApp(webDb, noLogin, { origin: ORIGIN, trustProxy: false, distDir: null, thumbsDir });
    assert.ok(await grantPrivilege(db, ANNA, KEY, null));
    assert.ok(await grantPrivilege(db, BEN, KEY, null));
  });
  after(async () => {
    await closeDb?.();
    await closeWeb?.();
    if (thumbsDir) rmSync(thumbsDir, { recursive: true, force: true });
  });

  it('/api/me lists the privileges in force; an expired one is not', async () => {
    assert.deepEqual((await call<MeResponse>(ANNA, 'GET', '/me')).body.privileges, [KEY]);
    assert.deepEqual((await call<MeResponse>(EVE, 'GET', '/me')).body.privileges, []);
    assert.ok(await grantPrivilege(db, EVE, KEY, new Date(Date.now() - 60_000)));
    assert.deepEqual((await call<MeResponse>(EVE, 'GET', '/me')).body.privileges, []);
    const eve = (await getUserPrivileges(db, EVE)).find((p) => p.key === KEY);
    assert.ok(eve?.grantedAt && eve.expiresAt);
  });

  it('without the key: 403; an unknown key: 404; a retired or unknown key cannot be granted', async () => {
    assert.equal((await call(EVE, 'GET', entriesPath)).status, 403);
    assert.equal((await mark(EVE)).status, 403);
    assert.equal((await call(EVE, 'GET', `/features/${KEY}/subjects`)).status, 403);
    assert.equal((await call(ANNA, 'GET', '/features/nope/entries')).status, 404);
    assert.equal(await grantPrivilege(db, EVE, 'nope', null), false);
  });

  it('marks: the payload and subject are checked, one own row per subject (replaced, not doubled)', async () => {
    assert.equal((await mark(ANNA, { hash: 'XYZ' })).status, 400);
    assert.equal((await mark(ANNA, { hash: HASH, extra: 1 })).status, 400);
    assert.equal((await mark(ANNA, { hash: HASH }, 'not-a-uuid')).status, 400);
    assert.equal((await mark(ANNA)).status, 200);
    assert.equal((await mark(ANNA, { hash: '12345678' })).status, 200);
    const mine = (await entries(ANNA)).filter((e) => e.userId === ANNA);
    assert.equal(mine.length, 1);
    assert.deepEqual(mine[0]!.payload, { hash: '12345678' });
    assert.equal(mine[0]!.own, true);
    assert.equal(mine[0]!.userName, 'Name 61');
  });

  it('every holder sees every row, changes only their own', async () => {
    assert.equal((await mark(BEN)).status, 200);
    const seen = await entries(BEN);
    assert.equal(seen.length, 2);
    assert.equal(seen.find((e) => e.userId === ANNA)?.own, false);
    // Ben's delete takes his own row only
    assert.equal((await call(BEN, 'DELETE', `${entriesPath}/${U.gem}`, {})).status, 200);
    assert.deepEqual((await entries(ANNA)).map((e) => e.userId), [ANNA]);
  });

  it('images: only on the own row, the type\'s signature checked, readable by every holder', async () => {
    const data = PNG.toString('base64');
    assert.equal((await call(BEN, 'PUT', `${entriesPath}/${U.gem}/blob`, { type: 'image/png', data })).status, 404);
    assert.equal((await call(ANNA, 'PUT', `${entriesPath}/${U.gem}/blob`, { type: 'image/webp', data })).status, 400);
    assert.equal((await call(ANNA, 'PUT', `${entriesPath}/${U.gem}/blob`, { type: 'image/gif', data })).status, 400);
    assert.equal((await call(ANNA, 'PUT', `${entriesPath}/${U.gem}/blob`, { type: 'image/png', data })).status, 200);
    const anna = (await entries(BEN)).find((e) => e.userId === ANNA)!;
    assert.equal(anna.blobType, 'image/png');
    const image = await call<Buffer>(BEN, 'GET', `/features/${KEY}/blob/${anna.id}`);
    assert.equal(image.status, 200);
    assert.equal(image.type, 'image/png');
    assert.ok(PNG.equals(image.body));
    // Larger than the upload's limit; other writes keep the small one
    const big = JSON.stringify({ type: 'image/png', data: 'A'.repeat(BLOB_BODY_LIMIT) });
    assert.equal((await call(ANNA, 'PUT', `${entriesPath}/${U.gem}/blob`, big)).status, 413);
    assert.equal((await call(ANNA, 'PUT', `${entriesPath}/${U.gem}`, JSON.stringify({ payload: { hash: HASH }, pad: 'x'.repeat(20_000) }))).status, 413);
  });

  it('thumb-review subjects: the thumbnails the index knows, with name and hash', async () => {
    const { status, body } = await call<ThumbReviewSubjectsResponse>(ANNA, 'GET', `/features/${KEY}/subjects?lang=en`);
    assert.equal(status, 200);
    assert.deepEqual(body.subjects.map((s) => [s.uuid, s.hash]), [[U.gem, HASH]]);
    assert.ok(body.subjects[0]!.name && body.subjects[0]!.className);
  });

  it('admin: holders, entries with the catalog name, the ZIP export; taking back keeps the data', async () => {
    const detail = await getPrivilege(db, KEY, 'en', new Map([[U.gem, HASH]]));
    assert.ok(detail);
    assert.deepEqual(detail.holders.map((h) => [h.userId, h.active]).sort(), [[ANNA, true], [BEN, true], [EVE, false]]);
    assert.equal(detail.entries.length, 1);
    assert.equal(detail.entries[0]!.thumb, HASH);
    assert.ok(detail.entries[0]!.subjectName);
    const archive = await exportFeature(db, KEY, new Map([[U.gem, '99999999']]));
    assert.ok(archive);
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    const text = archive.toString('latin1');
    assert.ok(text.includes('entries.json') && text.includes(`images/${U.gem}_${ANNA}.png`));
    // Marked on 12345678, the thumbnail is 99999999 now: stale
    assert.ok(text.includes('"stale": true'));
    await revokePrivilege(db, ANNA, KEY);
    assert.equal((await call(ANNA, 'GET', entriesPath)).status, 403);
    assert.equal((await entries(BEN)).length, 1);
  });
});
