// The companion's connection decisions (companion/src/connection.ts): which server is used, which game folder, what
// each answer of the API contract check leads to; and that its two languages hold the same texts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMPANION_API, COMPANION_API_MIN } from '../src/webapp/api-types.ts';
import {
  connectionOf, gameDirOf, isConnectionCode, missingSetting, otherServer, outdatedKeys, outdatedOf, refusalOf,
} from '../companion/src/connection.ts';

describe('companion connection', () => {
  it('is online unless the config says local (older config files have no entry)', () => {
    assert.equal(connectionOf(null), 'online');
    assert.equal(connectionOf({}), 'online');
    assert.equal(connectionOf({ connection: 'online' }), 'online');
    assert.equal(connectionOf({ connection: 'elsewhere' }), 'online');
    assert.equal(connectionOf({ connection: 'local' }), 'local');
  });

  it('online needs server and key, the local app neither', () => {
    assert.equal(missingSetting(null), 'noServer');
    assert.equal(missingSetting({ connection: 'online', server: '', token: 'qmt_x' }), 'noServer');
    assert.equal(missingSetting({ connection: 'online', server: 'https://qm.example.com', token: '' }), 'noToken');
    assert.equal(missingSetting({ connection: 'online', server: 'https://qm.example.com', token: 'qmt_x' }), null);
    assert.equal(missingSetting({ connection: 'local', server: '', token: '' }), null);
  });

  it('takes the game folder from the paired app only in the local mode, and only when it has one', () => {
    const paired = { origin: 'http://127.0.0.1:28460', gameDir: 'F:/Games/LIVE' };
    assert.equal(gameDirOf({ connection: 'online', gameDir: 'D:/SC/LIVE' }, paired), 'D:/SC/LIVE');
    assert.equal(gameDirOf({ connection: 'local', gameDir: 'D:/SC/LIVE' }, paired), 'F:/Games/LIVE');
    assert.equal(gameDirOf({ connection: 'local', gameDir: 'D:/SC/LIVE' }, { ...paired, gameDir: null }), 'D:/SC/LIVE');
    assert.equal(gameDirOf({ connection: 'local', gameDir: 'D:/SC/LIVE' }, null), 'D:/SC/LIVE');
  });

  it('another connection or another online address is another server (the save restarts the app)', () => {
    const online = { connection: 'online', server: 'https://qm.example.com' };
    const local = { connection: 'local', server: 'https://qm.example.com' };
    assert.equal(otherServer(online, local), true);
    assert.equal(otherServer(local, online), true);
    assert.equal(otherServer(online, { ...online, server: 'https://other.example.com' }), true);
    assert.equal(otherServer(online, { ...online }), false);
    assert.equal(otherServer(online, { ...online, server: ' https://qm.example.com ' }), false);
    // The local app needs no address: the stored one does not count there
    assert.equal(otherServer(local, { ...local, server: 'https://other.example.com' }), false);
    // Older config files have no connection entry: online
    assert.equal(otherServer({ server: 'https://qm.example.com' }, online), false);
  });
});

describe('companion API contract answers', () => {
  it('426: the companion is outdated', () => {
    const body = { error: 'companionOutdated', apiMin: COMPANION_API_MIN + 1 };
    assert.deepEqual(outdatedOf(426, body), { side: 'companion', apiMin: COMPANION_API_MIN + 1 });
    assert.equal(refusalOf(426, body), 'companionOutdated');
    // A 426 without a readable body still stops the app
    assert.deepEqual(outdatedOf(426, null), { side: 'companion', apiMin: 0 });
  });

  it('409 serverOutdated: the server or the local app is outdated', () => {
    const body = { error: 'serverOutdated', apiMax: COMPANION_API - 1 };
    assert.deepEqual(outdatedOf(409, body), { side: 'server', apiMax: COMPANION_API - 1 });
    assert.equal(refusalOf(409, body), 'serverOutdated');
  });

  it('any other 409 is a route\'s own refusal, not the contract\'s', () => {
    assert.equal(outdatedOf(409, { error: 'overridden' }), null);
    assert.equal(refusalOf(409, { error: 'overridden' }), 'overridden');
    assert.equal(outdatedOf(409, null), null);
    assert.equal(refusalOf(409, null), 'HTTP 409');
  });

  it('good answers pass, other refusals throw their code', () => {
    assert.equal(outdatedOf(200, { apiMin: 5 }), null);
    assert.equal(refusalOf(200, { error: 'ignored' }), null);
    assert.equal(refusalOf(304, null), null);
    assert.equal(refusalOf(404, { error: 'noCatalog' }), 'noCatalog');
    assert.equal(refusalOf(500, 'oops'), 'HTTP 500');
  });

  it('refusals of the connection itself are its state, a route\'s refusal is not', () => {
    for (const code of ['noServer', 'noToken', 'invalidServer', 'insecureServer', 'invalidToken', 'network', 'noLocalApp', 'companionOutdated', 'serverOutdated']) {
      assert.equal(isConnectionCode(code), true, code);
    }
    for (const code of ['noCatalog', 'overridden', 'HTTP 500', 'unknownBlueprint']) assert.equal(isConnectionCode(code), false, code);
  });

  it('words the outdated side by the server in use', () => {
    const companion = { side: 'companion', apiMin: 2 } as const;
    const server = { side: 'server', apiMax: 1 } as const;
    assert.deepEqual(outdatedKeys(companion, 'online'), { title: 'outdated.title', text: 'err.companionOutdated' });
    assert.deepEqual(outdatedKeys(companion, 'local'), { title: 'outdated.title', text: 'err.companionOutdated' });
    assert.deepEqual(outdatedKeys(server, 'online'), { title: 'outdated.title.server', text: 'err.serverOutdated' });
    assert.deepEqual(outdatedKeys(server, 'local'), { title: 'outdated.title.app', text: 'err.appOutdated' });
  });
});

describe('companion texts', () => {
  // i18n.ts needs the webview (vue, navigator): read as text. Two object literals, `en` first, then `de`
  const source = readFileSync(fileURLToPath(new URL('../companion/src/i18n.ts', import.meta.url)), 'utf8');
  const split = source.indexOf('\nconst de');
  const entries = (text: string) => new Map([...text.matchAll(/^ {2}"([^"]+)": "((?:[^"\\]|\\.)*)",?$/gm)].map((m) => [m[1]!, m[2]!]));
  const en = entries(source.slice(0, split));
  const de = entries(source.slice(split));

  it('both languages hold the same keys', () => {
    assert.ok(split > 0 && en.size > 300, `${en.size} English texts found`);
    assert.deepEqual([...de.keys()].filter((k) => !en.has(k)), [], 'only in German');
    assert.deepEqual([...en.keys()].filter((k) => !de.has(k)), [], 'only in English');
  });

  it('every text the connection decisions name exists, and no text is empty', () => {
    const keys = [
      'settings.connection', 'settings.connection.online', 'settings.connection.local', 'conn.short.noLocalApp', 'err.noLocalApp',
      'outdated.title', 'outdated.title.server', 'outdated.title.app', 'err.companionOutdated', 'err.serverOutdated', 'err.appOutdated',
      'outdated.releases',
    ];
    for (const key of keys) assert.ok(en.get(key) && de.get(key), key);
    assert.deepEqual([...en, ...de].filter(([, text]) => text === '').map(([key]) => key), []);
  });

  it('German texts use real umlauts', () => {
    assert.equal(de.get('settings.token'), 'Zugangsschlüssel');
    assert.equal(de.get('conn.short.noLocalApp'), 'App läuft nicht');
    assert.equal(de.get('err.appOutdated'), 'Die App ist älter als der Companion.');
  });
});
