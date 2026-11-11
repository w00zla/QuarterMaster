// The settings store, the game folder check, the language pack, the pairing file and the settings routes. Temp folders
// only (never a real game folder, never the real pairing file); no Postgres, no server.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Hono } from 'hono';
import { checkGameFolder, describeGameFolder, languageOf, readGameVersion, readLanguagePack } from '../src/singleuser/game-folder.ts';
import { pairingFile, pairingSchema, readPairing, removePairing, writePairing } from '../src/singleuser/pairing.ts';
import { createSettingsStore } from '../src/singleuser/settings.ts';
import { mountSettingsRoutes, type LoadedPack } from '../src/singleuser/settings-routes.ts';
import type { LocalSettingsState } from '../src/webapp/api-types.ts';
import type { ApiApp } from '../src/webapp/app.ts';

let root: string;
let counter = 0;
const scratch = (name: string) => {
  const dir = join(root, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
before(() => { root = mkdtempSync(join(tmpdir(), 'qm-gamefolder-')); });
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const MANIFEST = JSON.stringify({ Data: { Branch: 'sc-alpha-4.10.2', RequestedP4ChangeNum: '12913470' } });
/** A fake game folder: the two required files. */
function gameFolder(name = 'LIVE', manifest: string | null = MANIFEST): string {
  const dir = join(scratch('game'), name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'Data.p4k'), '');
  if (manifest !== null) writeFileSync(join(dir, 'build_manifest.id'), manifest);
  return dir;
}
const packFile = (dir: string, language: string, content: string | Buffer, data = 'data') => {
  const folder = join(dir, data, 'Localization', language);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'global.ini'), content);
};
/** Every file of a folder, relative: to prove nothing was written there. */
const listing = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();

describe('settings store', () => {
  const quiet = () => {
    const lines: string[] = [];
    return { lines, log: (m: string) => { lines.push(m); } };
  };

  it('defaults without a file, no warning, nothing written', () => {
    const file = join(scratch('s'), 'settings.json');
    const { lines, log } = quiet();
    const store = createSettingsStore(file, {}, log);
    assert.deepEqual(store.get(), { gameDir: null, autoUpdate: true });
    assert.deepEqual(store.overridden(), { gameDir: false, autoUpdate: false });
    assert.deepEqual(lines, []);
    assert.equal(existsSync(file), false);
  });

  it('stores atomically, keeps unknown keys out, and the next start reads it back', () => {
    const dir = scratch('s');
    const file = join(dir, 'nested', 'settings.json');
    const store = createSettingsStore(file, {}, () => {});
    assert.deepEqual(store.update({ gameDir: 'D:\\Games\\LIVE', autoUpdate: false }), { gameDir: 'D:\\Games\\LIVE', autoUpdate: false });
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['settings.json']); // no temp file left
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { gameDir: 'D:\\Games\\LIVE', autoUpdate: false });
    writeFileSync(file, JSON.stringify({ gameDir: '/x', autoUpdate: true, surprise: 1 }));
    const again = createSettingsStore(file, {}, () => {});
    assert.deepEqual(again.get(), { gameDir: '/x', autoUpdate: true });
    again.update({ autoUpdate: false });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { gameDir: '/x', autoUpdate: false });
  });

  it('a broken file is the defaults plus one warning', () => {
    for (const content of ['{ not json', '{"gameDir": 5}', '[]', '']) {
      const file = join(scratch('s'), 'settings.json');
      writeFileSync(file, content);
      const { lines, log } = quiet();
      assert.deepEqual(createSettingsStore(file, {}, log).get(), { gameDir: null, autoUpdate: true }, content);
      assert.equal(lines.length, 1, content);
      assert.match(lines[0]!, /broken/);
    }
  });

  it('the environment overrides, is reported, and is never written to the file', () => {
    const file = join(scratch('s'), 'settings.json');
    const store = createSettingsStore(file, { QM_GAME_DIR: 'E:\\Env\\LIVE', QM_AUTO_UPDATE: '0' }, () => {});
    assert.deepEqual(store.get(), { gameDir: 'E:\\Env\\LIVE', autoUpdate: false });
    assert.deepEqual(store.overridden(), { gameDir: true, autoUpdate: true });
    store.update({});
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { gameDir: null, autoUpdate: true });
    // Anything but 0 is no override
    const other = createSettingsStore(file, { QM_AUTO_UPDATE: '1', QM_GAME_DIR: '' }, () => {});
    assert.deepEqual(other.get(), { gameDir: null, autoUpdate: true });
    assert.deepEqual(other.overridden(), { gameDir: false, autoUpdate: false });
  });
});

describe('game folder check', () => {
  it('valid with both files; the version comes from the manifest', () => {
    const dir = gameFolder();
    assert.deepEqual(checkGameFolder(dir), { ok: true });
    assert.equal(readGameVersion(dir), '4.10.2.12913470');
    assert.deepEqual(describeGameFolder(dir), { state: 'ok', gameVersion: '4.10.2.12913470' });
  });

  it('names what is missing', () => {
    assert.deepEqual(describeGameFolder(null), { state: 'unset' });
    assert.deepEqual(checkGameFolder(join(root, 'does-not-exist')), { ok: false, problem: 'notFolder' });
    assert.deepEqual(checkGameFolder('relative/path'), { ok: false, problem: 'notFolder' });
    const file = join(scratch('f'), 'afile');
    writeFileSync(file, '');
    assert.deepEqual(checkGameFolder(file), { ok: false, problem: 'notFolder' });
    const empty = scratch('empty');
    assert.deepEqual(checkGameFolder(empty), { ok: false, problem: 'noDataP4k' });
    // Data.p4k as a folder is no file
    mkdirSync(join(empty, 'Data.p4k'));
    assert.deepEqual(checkGameFolder(empty), { ok: false, problem: 'noDataP4k' });
    assert.deepEqual(checkGameFolder(gameFolder('LIVE', null)), { ok: false, problem: 'noBuildManifest' });
    assert.deepEqual(describeGameFolder(empty), { state: 'invalid', problem: 'noDataP4k' });
  });

  it('an unreadable manifest is valid, just without a version', () => {
    for (const manifest of ['{ nope', '{}', '{"Data":{"Branch":"sc-alpha-4.10.2"}}']) {
      const dir = gameFolder('LIVE', manifest);
      assert.deepEqual(checkGameFolder(dir), { ok: true });
      assert.equal(readGameVersion(dir), null);
      assert.deepEqual(describeGameFolder(dir), { state: 'ok' });
    }
  });
});

describe('language pack', () => {
  it('user.cfg: the companion parser', () => {
    assert.equal(languageOf('r_DisplayInfo = 0\ng_language = german_(germany)\n'), 'german_(germany)');
    assert.equal(languageOf('G_LANGUAGE=english ; comment'), 'english');
    assert.equal(languageOf('; g_language = french\n  g_language\t=\t german_(germany)  \r\n'), 'german_(germany)');
    assert.equal(languageOf('g_languageAudio = english'), null);
    assert.equal(languageOf('g_language =\ng_language = korean_(south_korea)'), 'korean_(south_korea)');
    assert.equal(languageOf('g_language = first\ng_language = second'), 'first');
    assert.equal(languageOf('g_language = "english"'), '"english"'); // quotes are not special, as for the companion
    assert.equal(languageOf(''), null);
  });

  it('loads the language of user.cfg, UTF-8 and UTF-16, and writes nothing', () => {
    const dir = gameFolder();
    writeFileSync(join(dir, 'user.cfg'), '; my settings\nr_fullscreen = 1\ng_language = german_(germany) ; hello\n');
    packFile(dir, 'german_(germany)', '\uFEFFui_a,P=Hallo\nui_B=Zwei\\nZeilen\nui_c=! GERMAN_(GERMANY) TRANSLATION NOT FOUND FOR LOCID: ui_c !\n');
    const before = listing(dir);
    const pack = readLanguagePack(dir);
    assert.equal(pack.language, 'german_(germany)');
    assert.equal(pack.file, join(dir, 'data', 'Localization', 'german_(germany)', 'global.ini'));
    assert.equal(pack.problem, undefined);
    assert.deepEqual([...pack.texts!], [['ui_a', 'Hallo'], ['ui_b', 'Zwei\nZeilen']]);

    const utf16 = gameFolder();
    writeFileSync(join(utf16, 'user.cfg'), 'g_language = german_(germany)\n');
    packFile(utf16, 'german_(germany)', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ui_a=Gr\u00fc\u00dfe\r\nui_b=Zwei\r\n', 'utf16le')]));
    assert.deepEqual([...readLanguagePack(utf16).texts!], [['ui_a', 'Gr\u00fc\u00dfe'], ['ui_b', 'Zwei']]);
    assert.deepEqual(listing(dir), before);
  });

  it('no user.cfg, no language: English; a pack for english is used when there is one', () => {
    const none = gameFolder();
    assert.deepEqual(readLanguagePack(none), { language: null, file: null, texts: null, problem: 'noUserCfg' });
    writeFileSync(join(none, 'user.cfg'), 'r_fullscreen = 1\ng_languageAudio = english\n');
    assert.deepEqual(readLanguagePack(none), { language: null, file: null, texts: null, problem: 'noLanguage' });

    // The companion's default language is english: a rewording pack in english/ is read without any setting
    const reworded = gameFolder();
    packFile(reworded, 'english', 'ui_a=Reworded\n');
    const pack = readLanguagePack(reworded);
    assert.equal(pack.language, 'english');
    assert.deepEqual([...pack.texts!], [['ui_a', 'Reworded']]);

    // English set and no file: the game's built-in English, not a problem
    const builtIn = gameFolder();
    writeFileSync(join(builtIn, 'user.cfg'), 'g_language = english\n');
    assert.equal(readLanguagePack(builtIn).problem, 'builtInEnglish');
  });

  it('a language without an ini, an unreadable and an empty one are distinct and not fatal', () => {
    const missing = gameFolder();
    writeFileSync(join(missing, 'user.cfg'), 'g_language = german_(germany)\n');
    assert.deepEqual(readLanguagePack(missing), { language: 'german_(germany)', file: null, texts: null, problem: 'iniMissing' });

    // global.ini is a folder: no file at all
    const asFolder = gameFolder();
    writeFileSync(join(asFolder, 'user.cfg'), 'g_language = german_(germany)\n');
    mkdirSync(join(asFolder, 'data', 'Localization', 'german_(germany)', 'global.ini'), { recursive: true });
    assert.equal(readLanguagePack(asFolder).problem, 'iniMissing');

    for (const content of ['', 'this is not an ini file at all\nneither is this\n', '\u0000\u0001\u0002 binary', 'a=! X TRANSLATION NOT FOUND FOR LOCID: a !\n']) {
      const dir = gameFolder();
      writeFileSync(join(dir, 'user.cfg'), 'g_language = german_(germany)\n');
      packFile(dir, 'german_(germany)', content);
      const pack = readLanguagePack(dir);
      assert.equal(pack.problem, 'iniEmpty', JSON.stringify(content));
      assert.equal(pack.texts, null);
      assert.ok(pack.file);
    }
  });

  it('the language is a folder name, never a path; a missing game folder does not throw', () => {
    const dir = gameFolder();
    writeFileSync(join(dir, 'user.cfg'), 'g_language = ..\\..\\x\n');
    assert.equal(readLanguagePack(dir).problem, 'iniMissing');
    assert.equal(readLanguagePack(join(root, 'nope')).problem, 'noUserCfg');
  });

  it('the Data spelling is used when there is no data folder (Linux installs)', () => {
    const dir = gameFolder();
    writeFileSync(join(dir, 'user.cfg'), 'g_language = german_(germany)\n');
    packFile(dir, 'german_(germany)', 'ui_a=Hallo\n', 'Data');
    assert.equal(readLanguagePack(dir).texts?.get('ui_a'), 'Hallo');
  });
});

describe('pairing file', () => {
  it('its place: the override, else the profile', () => {
    assert.equal(pairingFile({ QM_PAIRING_FILE: 'X:\\p.json' }, 'win32', 'C:\\Users\\u'), 'X:\\p.json');
    assert.equal(pairingFile({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\Users\\u'), 'C:\\L\\QuarterMaster\\pairing.json');
    assert.equal(pairingFile({}, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\QuarterMaster\\pairing.json');
    assert.equal(pairingFile({ XDG_DATA_HOME: '/x' }, 'linux', '/home/u'), '/x/quartermaster/pairing.json');
    assert.equal(pairingFile({}, 'linux', '/home/u'), '/home/u/.local/share/quartermaster/pairing.json');
  });

  it('writes (creating the folder, atomically), reads back, removes', () => {
    const dir = scratch('p');
    const file = join(dir, 'deep', 'pairing.json');
    writePairing(file, { origin: 'http://127.0.0.1:28460', gameDir: 'D:\\Games\\LIVE' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { format: 1, origin: 'http://127.0.0.1:28460', gameDir: 'D:\\Games\\LIVE' });
    assert.deepEqual(readdirSync(join(dir, 'deep')), ['pairing.json']);
    writePairing(file, { origin: 'http://127.0.0.1:28461', gameDir: null });
    assert.deepEqual(readPairing(file), { format: 1, origin: 'http://127.0.0.1:28461', gameDir: null });
    removePairing(file);
    assert.equal(existsSync(file), false);
    removePairing(file); // twice is fine
    assert.equal(readPairing(file), null);
    writeFileSync(file, '{"format":2}');
    assert.equal(readPairing(file), null);
    assert.equal(pairingSchema.safeParse({ format: 1, origin: 'http://127.0.0.1:1', gameDir: null }).success, true);
  });
});

describe('settings routes', () => {
  function setup(env: Record<string, string> = {}) {
    const file = join(scratch('r'), 'settings.json');
    const store = createSettingsStore(file, env, () => {});
    const gameDir = store.get().gameDir;
    const loaded: LoadedPack = { gameDir, pack: gameDir ? readLanguagePack(gameDir) : null, active: true };
    const pairings: (string | null)[] = [];
    const api = new Hono() as unknown as ApiApp;
    mountSettingsRoutes({ store, loaded, onGameDirChange: (d) => pairings.push(d) })(api);
    const call = async (method: string, body?: unknown) => {
      const res = await api.request('/local/settings', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as LocalSettingsState & { error?: string; problem?: string } };
    };
    return { call, pairings, file };
  }

  it('GET: nothing set', async () => {
    const { call } = setup();
    assert.deepEqual(await call('GET'), {
      status: 200,
      body: { gameDir: null, autoUpdate: true, overridden: { gameDir: false, autoUpdate: false }, gameFolder: { state: 'unset' }, languagePack: { state: 'none', pending: false } },
    });
  });

  it('PUT: a valid folder is stored, pairing is rewritten, the pack waits for the next start', async () => {
    const { call, pairings, file } = setup();
    const dir = gameFolder();
    const res = await call('PUT', { gameDir: dir });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.gameFolder, { state: 'ok', gameVersion: '4.10.2.12913470' });
    assert.deepEqual(res.body.languagePack, { state: 'none', pending: true });
    assert.deepEqual(pairings, [dir]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).gameDir, dir);
    assert.equal((await call('GET')).body.gameDir, dir);
    // null unsets it
    const unset = await call('PUT', { gameDir: null });
    assert.equal(unset.body.gameFolder.state, 'unset');
    assert.deepEqual(pairings, [dir, null]);
  });

  it('GET: the pack read at start is shown with its count', async () => {
    const dir = gameFolder();
    writeFileSync(join(dir, 'user.cfg'), 'g_language = german_(germany)\n');
    packFile(dir, 'german_(germany)', 'ui_a=Hallo\nui_b=Welt\n');
    const { call } = setup({ QM_GAME_DIR: dir });
    const res = await call('GET');
    assert.deepEqual(res.body.languagePack, { state: 'loaded', language: 'german_(germany)', texts: 2, active: true, pending: false });
  });

  it('PUT: an invalid folder answers 422 with the problem and changes nothing', async () => {
    const { call, pairings, file } = setup();
    const res = await call('PUT', { gameDir: scratch('empty') });
    assert.deepEqual([res.status, res.body.error, res.body.problem], [422, 'gameFolderInvalid', 'noDataP4k']);
    assert.equal((await call('PUT', { gameDir: join(root, 'nope') })).body.problem, 'notFolder');
    assert.deepEqual(pairings, []);
    assert.equal(existsSync(file), false);
    assert.equal((await call('GET')).body.gameDir, null);
  });

  it('PUT: autoUpdate; bad bodies are 400; overridden values are 409', async () => {
    const { call, file } = setup();
    assert.equal((await call('PUT', { autoUpdate: false })).body.autoUpdate, false);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).autoUpdate, false);
    for (const body of [{ autoUpdate: 'no' }, { other: 1 }, [], 'x']) assert.equal((await call('PUT', body)).status, 400, JSON.stringify(body));

    const dir = gameFolder();
    const env = setup({ QM_GAME_DIR: dir, QM_AUTO_UPDATE: '0' });
    const got = await env.call('GET');
    assert.deepEqual([got.body.gameDir, got.body.autoUpdate, got.body.overridden], [dir, false, { gameDir: true, autoUpdate: true }]);
    assert.equal(got.body.languagePack.pending, false);
    assert.deepEqual([(await env.call('PUT', { autoUpdate: true })).status, (await env.call('PUT', { gameDir: null })).status], [409, 409]);
    assert.equal(existsSync(env.file), false);
  });
});
