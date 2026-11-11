// The singleuser UI's logic that lives in plain modules (webapp/src): the start tile's state, the navigation per
// capability, the settings view's decisions, time formatting, and that both languages have the same texts. No DOM, no DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { DataUpdateState, LocalSettingsState, UexState } from '../src/webapp/api-types.ts';
import { navGroups, routeAllowed, userControls, type NavCaps } from '../webapp/src/navigation.ts';
import { dataTag, appTooOld, canFetchNow, firstRun, folderView, gameDirChange, KEY_MASK, keyDecision, nextFetch, packTag, uexRefused, uexTag } from '../webapp/src/settingsLogic.ts';
import { progressShare, tileModel, UNREACHABLE_AFTER, type TileInput } from '../webapp/src/startTile.ts';
import { dayTime, megabytes, shortTime } from '../webapp/src/localTime.ts';

const state = (over: Partial<DataUpdateState> = {}): DataUpdateState => ({ phase: 'idle', installed: null, progress: null, last: null, ...over });
const at = '2026-11-11T12:00:00.000Z';
const tile = (over: Partial<TileInput> & { data?: DataUpdateState | null }) =>
  tileModel({ data: null, failedPolls: 0, autoUpdate: true, ...over });

describe('start tile', () => {
  it('is hidden once a data pack is installed, whatever else is going on', () => {
    const installed = { tag: 'data-1', gameLabel: '4.10.2.1' };
    assert.deepEqual(tile({ data: state({ installed }) }), { visible: false });
    assert.deepEqual(tile({ data: state({ installed, phase: 'downloading' }), failedPolls: 3 }), { visible: false });
  });

  it('starts at the first segment until a state came in, then says the server is gone after repeated failures', () => {
    assert.deepEqual(tile({ data: null }), { visible: true, view: 'steps', step: 1, segments: 4, text: 'start.starting', progress: null });
    assert.equal((tile({ data: null, failedPolls: UNREACHABLE_AFTER - 1 }) as { view: string }).view, 'steps');
    assert.deepEqual(tile({ data: null, failedPolls: UNREACHABLE_AFTER }), { visible: true, view: 'unreachable' });
  });

  it('maps checking, downloading (with the amount) and installing to the steps', () => {
    assert.deepEqual(tile({ data: state({ phase: 'checking' }) }), { visible: true, view: 'steps', step: 2, segments: 4, text: 'start.loading', progress: null });
    const progress = { done: 12, total: 45 };
    assert.deepEqual(tile({ data: state({ phase: 'downloading', progress }) }), { visible: true, view: 'steps', step: 2, segments: 4, text: 'start.loading', progress });
    assert.deepEqual(tile({ data: state({ phase: 'installing' }) }), { visible: true, view: 'steps', step: 3, segments: 4, text: 'start.setup', progress: null });
  });

  it('counts a request that fails while a download or installation was seen as still installing, never as an error', () => {
    for (const phase of ['downloading', 'installing', 'checking'] as const) {
      for (const failedPolls of [1, UNREACHABLE_AFTER, 100]) {
        const m = tile({ data: state({ phase, progress: phase === 'downloading' ? { done: 1, total: 2 } : null }), failedPolls });
        assert.deepEqual(m, { visible: true, view: 'steps', step: 3, segments: 4, text: 'start.setup', progress: null }, `${phase} after ${failedPolls} failures`);
      }
    }
  });

  it('shows the no-connection state for offline or failed runs with nothing installed', () => {
    for (const outcome of [{ outcome: 'offline' }, { outcome: 'failed', reason: 'corrupt' }] as const) {
      assert.deepEqual(tile({ data: state({ last: { at, ...outcome } }) }), { visible: true, view: 'offline' });
    }
  });

  it('shows "missing" where nothing is going to fetch the data, "tooOld" for a pack the app cannot read', () => {
    assert.deepEqual(tile({ data: state({ last: { at, outcome: 'noChannel' } }) }), { visible: true, view: 'missing' });
    assert.deepEqual(tile({ data: state(), autoUpdate: false }), { visible: true, view: 'missing' });
    // Updates on, no run yet: it is about to start
    assert.deepEqual(tile({ data: state(), autoUpdate: true }), { visible: true, view: 'steps', step: 1, segments: 4, text: 'start.starting', progress: null });
    assert.deepEqual(tile({ data: state(), autoUpdate: null }), { visible: true, view: 'steps', step: 1, segments: 4, text: 'start.starting', progress: null });
    assert.deepEqual(tile({ data: state({ last: { at, outcome: 'appTooOld', tag: 'data-2', pack: 'newer' } }) }), { visible: true, view: 'tooOld' });
  });

  it('says the server is gone when an idle state is followed by repeated failures', () => {
    assert.deepEqual(tile({ data: state(), failedPolls: UNREACHABLE_AFTER }), { visible: true, view: 'unreachable' });
    // fewer failures: still what the last state said
    assert.equal((tile({ data: state({ last: { at, outcome: 'offline' } }), failedPolls: 1 }) as { view: string }).view, 'offline');
  });

  it('shares the download out as 0 to 1', () => {
    assert.equal(progressShare(null), 0);
    assert.equal(progressShare({ done: 0, total: 0 }), 0);
    assert.equal(progressShare({ done: 12, total: 48 }), 0.25);
    assert.equal(progressShare({ done: 60, total: 48 }), 1);
  });
});

describe('navigation per capability', () => {
  const online: NavCaps = { login: 'discord', orgs: true, uex: true };
  const single: NavCaps = { login: 'none', orgs: false, uex: false };
  const keys = (c: NavCaps | null) => navGroups(c).map((g) => g.map((i) => i.to));

  it('has the buy/sell tab only with UEX data (and while the capabilities are unknown, as online)', () => {
    assert.deepEqual(keys(online)[2], ['/crafting', '/mining', '/trade']);
    assert.deepEqual(keys(null)[2], ['/crafting', '/mining', '/trade']);
    assert.deepEqual(keys(single)[2], ['/crafting', '/mining']);
    assert.deepEqual(keys({ ...single, uex: true })[2], ['/crafting', '/mining', '/trade']);
    assert.deepEqual(keys(single)[0], ['/']);
    assert.deepEqual(keys(single)[1], ['/gear', '/resources', '/refinery', '/blueprints']);
  });

  it('offers the settings button instead of the user, profile, logout and companion controls without a login', () => {
    assert.deepEqual(userControls(online), { settings: false, companion: true, user: true, profile: true, logout: true, history: true });
    assert.deepEqual(userControls(single), { settings: true, companion: false, user: false, profile: false, logout: false, history: true });
  });

  it('lets the settings route exist only without a login and the trade route only with UEX', () => {
    assert.equal(routeAllowed('/settings', online), false);
    assert.equal(routeAllowed('/settings', single), true);
    assert.equal(routeAllowed('/trade', online), true);
    assert.equal(routeAllowed('/trade', single), false);
    assert.equal(routeAllowed('/trade', { ...single, uex: true }), true);
    assert.equal(routeAllowed('/resources', single), true);
    assert.equal(routeAllowed('/settings', null), true);
  });
});

describe('settings decisions', () => {
  const folder = (f: LocalSettingsState['gameFolder']) => f;
  const pack = (p: Partial<LocalSettingsState['languagePack']>): LocalSettingsState['languagePack'] => ({ state: 'none', pending: false, ...p });

  it('applies the game folder field only when its trimmed value changed; empty clears the setting', () => {
    assert.deepEqual(gameDirChange('  D:\\Games  ', 'D:\\Games'), { apply: false });
    assert.deepEqual(gameDirChange('', null), { apply: false });
    assert.deepEqual(gameDirChange('E:\\SC', 'D:\\Games'), { apply: true, value: 'E:\\SC' });
    assert.deepEqual(gameDirChange('   ', 'D:\\Games'), { apply: true, value: null });
  });

  it('tags the game folder: found, no game (invalid or refused), nothing while unset; the folder is the primary control unless found', () => {
    assert.deepEqual(folderView(folder({ state: 'ok', gameVersion: '4.10.2.1' }), false), { tag: { kind: 'ok', text: 'folder.found' }, message: false, needsFolder: false });
    assert.deepEqual(folderView(folder({ state: 'invalid', problem: 'noDataP4k' }), false), { tag: { kind: 'err', text: 'folder.noGame' }, message: true, needsFolder: true });
    assert.deepEqual(folderView(folder({ state: 'unset' }), false), { tag: null, message: false, needsFolder: true });
    // The server refused the typed path (422) while the saved one is fine: the typed one is shown as wrong
    assert.deepEqual(folderView(folder({ state: 'ok' }), true), { tag: { kind: 'err', text: 'folder.noGame' }, message: true, needsFolder: true });
  });

  it('opens the settings view on its own only without a usable game folder', () => {
    assert.equal(firstRun({ gameFolder: { state: 'unset' } }), true);
    assert.equal(firstRun({ gameFolder: { state: 'invalid' } }), true);
    assert.equal(firstRun({ gameFolder: { state: 'ok' } }), false);
  });

  it('tags the language pack: restart first, then active, else none', () => {
    assert.deepEqual(packTag(pack({ state: 'loaded', active: true })).text, 'pack.active');
    assert.deepEqual(packTag(pack({ state: 'loaded', active: true, pending: true })).text, 'pack.restart');
    assert.deepEqual(packTag(pack({ state: 'none' })).text, 'pack.none');
    assert.deepEqual(packTag(pack({ state: 'problem', problem: 'iniEmpty' })).text, 'pack.none');
  });

  it('tags the game data: loading while busy, no connection after offline/failed, up to date after a check', () => {
    const installed = { tag: 't', gameLabel: '4.10' };
    assert.equal(dataTag(null), null);
    assert.equal(dataTag(state({ installed, phase: 'downloading' }))?.text, 'data.loading');
    assert.equal(dataTag(state({ installed, last: { at, outcome: 'offline' } }))?.text, 'start.noConnection');
    assert.equal(dataTag(state({ installed, last: { at, outcome: 'failed', reason: 'internal' } }))?.text, 'start.noConnection');
    assert.equal(dataTag(state({ installed, last: { at, outcome: 'upToDate' } }))?.text, 'data.upToDate');
    assert.equal(dataTag(state({ installed, last: { at, outcome: 'installed', tag: 't' } }))?.text, 'data.upToDate');
    assert.equal(dataTag(state({ installed })), null);
    assert.equal(dataTag(state({ installed, last: { at, outcome: 'noChannel' } })), null);
  });

  it('shows the bold notice for a newer pack and an unsupported pack format only', () => {
    assert.equal(appTooOld(null), false);
    assert.equal(appTooOld(state({ last: { at, outcome: 'appTooOld', tag: 'd', pack: 'newer' } })), true);
    assert.equal(appTooOld(state({ last: { at, outcome: 'appTooOld', tag: 'd', pack: 'older' } })), false);
    assert.equal(appTooOld(state({ last: { at, outcome: 'failed', reason: 'unsupported' } })), true);
    assert.equal(appTooOld(state({ last: { at, outcome: 'failed', reason: 'corrupt' } })), false);
    assert.equal(appTooOld(state({ last: { at, outcome: 'upToDate' } })), false);
  });

  it('decides what saving the key field does: nothing for the mask, set, or remove (only with a key)', () => {
    assert.equal(keyDecision(KEY_MASK, true), 'none');
    assert.equal(keyDecision('', false), 'none');
    assert.equal(keyDecision('   ', false), 'none');
    assert.equal(keyDecision('', true), 'remove');
    assert.equal(keyDecision('abc123', false), 'save');
    assert.equal(keyDecision('abc123', true), 'save');
  });

  it('tags UEX: off without a key, refused, no connection, else active', () => {
    const u = (over: Partial<UexState> = {}): UexState => ({ phase: 'idle', lastPull: null, nextPull: null, last: null, ...over });
    assert.equal(uexTag({ uexKeySet: false }, u()).text, 'uex.off');
    assert.equal(uexTag({ uexKeySet: true }, u()).text, 'uex.active');
    assert.equal(uexTag({ uexKeySet: true }, null).text, 'uex.active');
    assert.equal(uexTag({ uexKeySet: true }, u({ last: { outcome: 'refused', at } })).text, 'uex.refused');
    assert.equal(uexTag({ uexKeySet: true }, u({ last: { outcome: 'offline', at } })).text, 'start.noConnection');
    assert.equal(uexTag({ uexKeySet: true }, u({ phase: 'pulling', last: { outcome: 'ok', at } })).text, 'uex.active');
    assert.equal(uexRefused({ uexKeySet: true }, u({ last: { outcome: 'refused', at } })), true);
    assert.equal(uexRefused({ uexKeySet: false }, u({ last: { outcome: 'refused', at } })), false);
  });

  it('lets "fetch now" work with a key and no pull running; the next fetch exists only while one is planned', () => {
    const u = (phase: UexState['phase']): UexState => ({ phase, lastPull: null, nextPull: at, last: null });
    assert.equal(canFetchNow({ uexKeySet: true }, u('idle')), true);
    assert.equal(canFetchNow({ uexKeySet: true }, u('pulling')), false);
    assert.equal(canFetchNow({ uexKeySet: false }, u('off')), false);
    assert.equal(canFetchNow({ uexKeySet: true }, null), false);
    assert.equal(nextFetch(u('idle')), at);
    assert.equal(nextFetch(u('pulling')), null);
    assert.equal(nextFetch(u('off')), null);
  });
});

describe('time formatting', () => {
  // Local times of the machine that runs the test: built from local parts, so the expectation holds in every zone
  const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();
  const now = new Date(2026, 10, 11, 15, 0);

  it('shows today as the clock only, yesterday and tomorrow with the day, other days with the date', () => {
    assert.equal(shortTime(local(2026, 11, 11, 14, 32), now, 'de'), '14:32');
    assert.equal(shortTime(local(2026, 11, 10, 21, 5), now, 'de'), 'Gestern, 21:05');
    assert.equal(shortTime(local(2026, 11, 10, 21, 5), now, 'en').startsWith('Yesterday, '), true);
    assert.equal(shortTime(local(2026, 11, 12, 8, 0), now, 'de'), 'Morgen, 08:00');
    assert.equal(shortTime(local(2026, 11, 3, 9, 7), now, 'de'), '03.11.2026, 09:07');
  });

  it('gives nothing for a missing or invalid time', () => {
    assert.equal(shortTime(null, now, 'de'), '');
    assert.equal(shortTime(undefined, now, 'de'), '');
    assert.equal(shortTime('not a time', now, 'de'), '');
    assert.equal(dayTime(null, now, 'de'), '');
  });

  it('writes "today" out where a bare clock would be unclear', () => {
    assert.equal(dayTime(local(2026, 11, 11, 14, 32), now, 'de'), 'Heute, 14:32');
    assert.equal(dayTime(local(2026, 11, 10, 21, 5), now, 'de'), 'Gestern, 21:05');
  });

  it('writes the download amount in megabytes with the unit once', () => {
    assert.equal(megabytes(12 * 1048576, 45 * 1048576, 'de'), '12 / 45 MB');
    assert.equal(megabytes(2.1 * 1048576, 3.8 * 1048576, 'de'), '2,1 / 3,8 MB');
    assert.equal(megabytes(2.1 * 1048576, 3.8 * 1048576, 'en'), '2.1 / 3.8 MB');
    // More than the total (a size that moved on): not shown beyond it
    assert.equal(megabytes(50 * 1048576, 45 * 1048576, 'en'), '45 / 45 MB');
  });
});

describe('UI texts', () => {
  const source = readFileSync(new URL('../webapp/src/i18n.ts', import.meta.url), 'utf8');
  const block = (start: RegExp) => {
    const from = source.search(start);
    assert.ok(from >= 0, `block ${start} not found`);
    const to = source.indexOf('\n};', from);
    const texts = new Map<string, string>();
    for (const m of source.slice(from, to).matchAll(/^\s+"([^"]+)":\s*(".*"),?\s*$/gm)) texts.set(m[1]!, m[2]!);
    return texts;
  };
  const en = block(/^const en = \{/m);
  const de = block(/^const de: Record<Key, string> = \{/m);

  it('has the same keys in German and English, with the same placeholders', () => {
    assert.ok(en.size > 400);
    assert.deepEqual([...de.keys()].filter((k) => !en.has(k)), [], 'only in German');
    assert.deepEqual([...en.keys()].filter((k) => !de.has(k)), [], 'only in English');
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const [k, v] of en) assert.equal(holes(de.get(k)!), holes(v), k);
  });

  it('writes German with real umlauts', () => {
    assert.equal(JSON.parse(de.get('start.setup')!), 'Spieldaten werden eingerichtet …');
    assert.equal(JSON.parse(de.get('uex.key')!), 'Zugangsschlüssel');
    assert.equal(JSON.parse(de.get('pack.restart')!), 'Neustart nötig');
  });
});
