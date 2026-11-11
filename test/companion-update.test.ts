// The companion's app update, pure side (companion/src/updateLogic.ts): the "cannot update itself" error code of the Rust side
// and what the update panel's button opens; the state logic itself is the web app's (test/webapp-shell.test.ts). And that the
// two languages hold the update texts, German with real umlauts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CANNOT_UPDATE, cannotUpdateVersion, outdatedButtonOpens } from '../companion/src/updateLogic.ts';

describe('companion update', () => {
  it('reads the version out of the "cannot update itself" error and nothing else', () => {
    assert.equal(cannotUpdateVersion('cannot-update:2.2.0'), '2.2.0');
    assert.equal(cannotUpdateVersion('cannot-update:2.2.0-beta.1'), '2.2.0-beta.1');
    assert.equal(cannotUpdateVersion(null), null);
    assert.equal(cannotUpdateVersion('HTTP 404 Not Found'), null);
    assert.equal(cannotUpdateVersion('channel list: cannot-update:1'), null);
  });

  it('keeps the code in step with the Rust side', () => {
    const rust = readFileSync(fileURLToPath(new URL('../companion/src-tauri/src/update.rs', import.meta.url)), 'utf8');
    assert.ok(rust.includes(`pub const CANNOT_UPDATE: &str = "${CANNOT_UPDATE}";`));
  });

  it('opens the update dialog while a version waits, else the releases page', () => {
    for (const state of ['available', 'downloading', 'installing'] as const) {
      assert.equal(outdatedButtonOpens({ state, available: '2.2.0' }), 'dialog', state);
    }
    for (const state of ['idle', 'checking', 'current', 'error'] as const) {
      assert.equal(outdatedButtonOpens({ state, available: null }), 'releases', state);
    }
    // An error of an installation that cannot update itself found no version to install
    assert.equal(outdatedButtonOpens({ state: 'error', available: null }), 'releases');
    assert.equal(outdatedButtonOpens(null), 'releases');
  });

  it('has the update texts in both languages, the German with umlauts', () => {
    const source = readFileSync(fileURLToPath(new URL('../companion/src/i18n.ts', import.meta.url)), 'utf8');
    const keys = ['settings.autoUpdate', 'update.button', 'update.channel', 'update.current', 'update.available', 'update.notes',
      'update.checking', 'update.downloading', 'update.installing', 'update.check', 'update.install', 'update.mark', 'update.cannot'];
    for (const key of keys) {
      assert.equal(source.split(`"${key}":`).length - 1, 2, `${key}: one text per language`);
    }
    assert.ok(source.includes('Verfügbare Version') && source.includes('Diese Installation kann sich nicht selbst aktualisieren.'));
  });
});
