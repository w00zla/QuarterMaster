// The desktop shell contract on the SPA's side (webapp/src/shellLogic.ts): nothing is available without the shell's global,
// the commands and payloads the SPA sends, how the shell's answers and events are read, and the update dialog's buttons and
// status line per state. A fake global stands in for `window.__TAURI__`; no DOM, no Vue.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bindShell, externalLinkUrl, failedUpdate, parseUpdateState, parseWindowMessage, settingsFitSize, statusLine, updateBusy, updateButtons,
  updateFound, windowMode,
  type LinkClick, type TauriGlobal, type UpdatePhase, type UpdateState,
} from '../webapp/src/shellLogic.ts';

const PHASES: UpdatePhase[] = ['idle', 'checking', 'current', 'available', 'downloading', 'installing', 'error'];
const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  state: 'idle', current: '1.0.0', available: null, notes: null, progress: null, error: null, channel: 'stable', channels: ['stable', 'beta'], ...over,
});

/** A shell that records its calls and answers from a table. */
function fakeShell(answers: Record<string, unknown> = {}) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const unlistened: string[] = [];
  const tauri: TauriGlobal = {
    core: {
      invoke: async (command, args) => {
        calls.push([command, args]);
        const answer = answers[command];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    event: {
      listen: async (event, handler) => {
        listeners.set(event, handler);
        return () => void unlistened.push(event);
      },
    },
  };
  return { tauri, calls, listeners, unlistened };
}

describe('shell contract: without the shell', () => {
  it('is not available without the global, without core, or without invoke', () => {
    assert.equal(bindShell(undefined), null);
    assert.equal(bindShell(null), null);
    assert.equal(bindShell({}), null);
    assert.equal(bindShell({ core: {} }), null);
    assert.equal(bindShell({ core: { invoke: 'nope' as never } }), null);
  });
});

describe('shell contract: commands and payloads', () => {
  it('sends the documented command names with their payloads', async () => {
    const { tauri, calls } = fakeShell({ pick_folder: 'D:\\Games', pick_file: 'D:\\pack.zip', window_is_maximized: true });
    const shell = bindShell(tauri)!;
    assert.equal(await shell.pickFolder(), 'D:\\Games');
    assert.equal(await shell.pickFile(['zip']), 'D:\\pack.zip');
    assert.equal(await shell.pickFile(), 'D:\\pack.zip');
    await shell.minimize();
    await shell.toggleMaximize();
    await shell.close();
    assert.equal(await shell.isMaximized(), true);
    await shell.startResize('SouthEast');
    await shell.openExternal('https://uexcorp.space/');
    await shell.updateCheck();
    await shell.updateInstall();
    await shell.updateSetChannel('beta');
    assert.deepEqual(calls, [
      ['pick_folder', {}],
      ['pick_file', { extensions: ['zip'] }],
      ['pick_file', { extensions: [] }],
      ['window_minimize', {}],
      ['window_toggle_maximize', {}],
      ['window_close', {}],
      ['window_is_maximized', {}],
      ['window_start_resize', { direction: 'SouthEast' }],
      ['open_external', { url: 'https://uexcorp.space/' }],
      ['update_check', {}],
      ['update_install', {}],
      ['update_set_channel', { id: 'beta' }],
    ]);
  });

  it('reads a cancelled picker (null, empty, anything but a path) as null', async () => {
    for (const answer of [null, undefined, '', 5]) {
      const shell = bindShell(fakeShell({ pick_folder: answer, pick_file: answer }).tauri)!;
      assert.equal(await shell.pickFolder(), null);
      assert.equal(await shell.pickFile(['zip']), null);
    }
  });

  it('reads the maximize state strictly', async () => {
    assert.equal(await bindShell(fakeShell({ window_is_maximized: false }).tauri)!.isMaximized(), false);
    assert.equal(await bindShell(fakeShell({ window_is_maximized: 'yes' }).tauri)!.isMaximized(), false);
  });

  it('passes a failed required command on to the caller', async () => {
    const shell = bindShell(fakeShell({ window_close: new Error('no window') }).tauri)!;
    await assert.rejects(shell.close(), /no window/);
  });

  it('passes a refused URL on to the caller', async () => {
    const refusing = bindShell(fakeShell({ open_external: new Error('only https URLs are opened') }).tauri)!;
    await assert.rejects(refusing.openExternal('http://example.com/'), /only https/);
  });
});

describe('shell contract: the settings window', () => {
  it('sends open_settings, settings_window_fit and window_focus_main', async () => {
    const { tauri, calls } = fakeShell();
    const shell = bindShell(tauri)!;
    await shell.openSettings();
    await shell.fitSettings(672, 812);
    await shell.focusMain();
    assert.deepEqual(calls, [['open_settings', {}], ['settings_window_fit', { width: 672, height: 812 }], ['window_focus_main', {}]]);
  });

  it('knows the settings window by its query, once; anything else is the main window', () => {
    assert.equal(windowMode('?window=settings'), 'settings');
    assert.equal(windowMode('?a=1&window=settings'), 'settings');
    assert.equal(windowMode(''), 'main');
    assert.equal(windowMode('?window=main'), 'main');
    assert.equal(windowMode('?window=Settings'), 'main');
  });

  it('asks for the measured height with the fixed width, never below the minimum, with a little slack, and never for no size', () => {
    assert.deepEqual(settingsFitSize(800), { width: 560, height: 802 });
    assert.deepEqual(settingsFitSize(799.2), { width: 560, height: 802 });
    assert.deepEqual(settingsFitSize(100), { width: 560, height: 400 });
    for (const bad of [0, -5, NaN, Infinity]) assert.equal(settingsFitSize(bad), null);
  });

  it('reads only its own messages from the channel', () => {
    assert.deepEqual(parseWindowMessage({ type: 'changed' }), { type: 'changed' });
    assert.deepEqual(parseWindowMessage({ type: 'open-update', extra: 1 }), { type: 'open-update' });
    for (const other of [null, undefined, 'changed', 5, {}, { type: 'x' }, { type: 1 }]) assert.equal(parseWindowMessage(other), null);
  });
});

describe('shell contract: the update state', () => {
  it('reads update_state, and treats a missing or broken updater as no updater', async () => {
    const full = state({ state: 'available', available: '1.1.0', notes: 'Fixes', progress: 0.5, channel: 'beta' });
    assert.deepEqual(await bindShell(fakeShell({ update_state: full }).tauri)!.updateState(), full);
    assert.equal(await bindShell(fakeShell({ update_state: new Error('unknown command') }).tauri)!.updateState(), null);
    assert.equal(await bindShell(fakeShell({ update_state: { state: 'weird' } }).tauri)!.updateState(), null);
    assert.equal(await bindShell(fakeShell({}).tauri)!.updateState(), null);
  });

  it('listens to update-changed, passes valid states on, drops the rest, and stops listening on request', async () => {
    const { tauri, listeners, unlistened } = fakeShell();
    const seen: UpdateState[] = [];
    const stop = await bindShell(tauri)!.onUpdateChanged((s) => seen.push(s));
    const emit = listeners.get('update-changed')!;
    emit({ payload: state({ state: 'downloading', progress: 0.25 }) });
    emit({ payload: 'garbage' });
    emit({ payload: null });
    assert.deepEqual(seen.map((s) => [s.state, s.progress]), [['downloading', 0.25]]);
    stop();
    assert.deepEqual(unlistened, ['update-changed']);
  });

  it('has nothing to listen to when the shell has no event API', async () => {
    const stop = await bindShell({ core: { invoke: async () => null } })!.onUpdateChanged(() => {});
    assert.equal(typeof stop, 'function');
    stop();
  });

  it('parses leniently: missing fields become null or empty, progress is clamped, channels keep only texts', () => {
    assert.deepEqual(parseUpdateState({ state: 'current' }), state({ state: 'current', current: '', channel: '', channels: [] }));
    assert.equal(parseUpdateState({ state: 'downloading', progress: 7 })!.progress, 1);
    assert.equal(parseUpdateState({ state: 'downloading', progress: -1 })!.progress, 0);
    assert.equal(parseUpdateState({ state: 'downloading', progress: Number.NaN })!.progress, null);
    assert.deepEqual(parseUpdateState({ state: 'idle', channels: ['stable', 3, null, 'beta'] })!.channels, ['stable', 'beta']);
    assert.equal(parseUpdateState(null), null);
    assert.equal(parseUpdateState('idle'), null);
  });

  it('shows a command the shell could not start as an error of the updater, keeping the rest', () => {
    const failed = failedUpdate(state({ state: 'available', available: '1.1.0' }), new Error('cannot start'));
    assert.deepEqual([failed.state, failed.error, failed.available], ['error', 'cannot start', '1.1.0']);
    assert.equal(failedUpdate(state(), 'plain text').error, 'plain text');
  });
});

describe('update dialog: buttons per state', () => {
  const view = (phase: UpdatePhase) => updateButtons(phase).map((b) => `${b.action}${b.disabled ? ' (disabled)' : ''}`);

  it('always starts with Close, parked on the left', () => {
    for (const phase of PHASES) {
      const [close] = updateButtons(phase);
      assert.deepEqual(close, { action: 'close', kind: 'outline', disabled: false, left: true }, phase);
    }
  });

  it('offers Check Update until a version is found, disabled while it checks', () => {
    assert.deepEqual(view('idle'), ['close', 'check']);
    assert.deepEqual(view('current'), ['close', 'check']);
    assert.deepEqual(view('error'), ['close', 'check']);
    assert.deepEqual(view('checking'), ['close', 'check (disabled)']);
  });

  it('offers Install once a version is found, disabled while it downloads or installs', () => {
    assert.deepEqual(view('available'), ['close', 'install']);
    assert.deepEqual(view('downloading'), ['close', 'install (disabled)']);
    assert.deepEqual(view('installing'), ['close', 'install (disabled)']);
    assert.equal(updateButtons('available')[1]!.kind, 'primary');
  });

  it('has exactly one action button next to Close in every state, so the footer never changes its shape', () => {
    for (const phase of PHASES) assert.equal(updateButtons(phase).length, 2, phase);
  });
});

describe('update dialog: busy, mark and status line', () => {
  it('is busy while checking, downloading or installing', () => {
    assert.deepEqual(PHASES.filter(updateBusy), ['checking', 'downloading', 'installing']);
  });

  it('marks a found version in the states that carry one', () => {
    assert.equal(updateFound(state({ state: 'available', available: '1.1.0' })), true);
    assert.equal(updateFound(state({ state: 'downloading', available: '1.1.0' })), true);
    assert.equal(updateFound(state({ state: 'installing', available: '1.1.0' })), true);
    assert.equal(updateFound(state({ state: 'available', available: null })), false);
    assert.equal(updateFound(state({ state: 'current', available: '1.1.0' })), false);
    assert.equal(updateFound(state({ state: 'error', available: '1.1.0' })), false);
  });

  it('says what is going on, with the percent only while downloading, and the error as it is', () => {
    assert.deepEqual(statusLine(state({ state: 'checking' })), { text: 'update.checking', error: null, percent: null });
    assert.deepEqual(statusLine(state({ state: 'downloading', progress: 0.424 })), { text: 'update.downloading', error: null, percent: 42 });
    assert.deepEqual(statusLine(state({ state: 'downloading', progress: null })), { text: 'update.downloading', error: null, percent: null });
    assert.deepEqual(statusLine(state({ state: 'installing', progress: 1 })), { text: 'update.installing', error: null, percent: null });
    assert.deepEqual(statusLine(state({ state: 'error', error: 'Signature mismatch (os error 5)' })), { text: null, error: 'Signature mismatch (os error 5)', percent: null });
    for (const phase of ['idle', 'current', 'available'] as const) assert.deepEqual(statusLine(state({ state: phase })), { text: null, error: null, percent: null });
  });
});

describe('shell contract: links that leave the app', () => {
  const link = (over: Partial<LinkClick> = {}): LinkClick => ({ href: 'https://uexcorp.space/', target: '_blank', button: 0, defaultPrevented: false, ...over });

  it('sends a primary or middle click on a target=_blank https link to the shell, as the normalized URL', () => {
    assert.equal(externalLinkUrl(link(), true), 'https://uexcorp.space/');
    assert.equal(externalLinkUrl(link({ button: 1 }), true), 'https://uexcorp.space/');
    assert.equal(externalLinkUrl(link({ target: '_BLANK', href: 'https://github.com/w00zla/quartermaster/releases?x=1#y' }), true), 'https://github.com/w00zla/quartermaster/releases?x=1#y');
  });

  it('leaves everything to the browser without the shell', () => {
    assert.equal(externalLinkUrl(link(), false), null);
  });

  it('leaves links that stay in the app, or are not https, alone', () => {
    for (const over of [
      { target: null }, { target: '' }, { target: '_self' }, { target: 'other' },
      { href: null }, { href: '' }, { href: 'not a url' },
      { href: 'http://example.com/' }, { href: 'blob:http://127.0.0.1:28460/1234' }, { href: 'file:///c:/x' },
      { href: 'javascript:alert(1)' }, { href: 'mailto:a@b.c' }, { href: 'http://127.0.0.1:28460/stock' },
    ]) {
      assert.equal(externalLinkUrl(link(over), true), null, JSON.stringify(over));
    }
  });

  it('ignores other mouse buttons and clicks something else already handled', () => {
    assert.equal(externalLinkUrl(link({ button: 2 }), true), null);
    assert.equal(externalLinkUrl(link({ button: 3 }), true), null);
    assert.equal(externalLinkUrl(link({ defaultPrevented: true }), true), null);
  });
});
