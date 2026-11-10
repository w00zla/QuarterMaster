import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gameLabel } from '../src/catalog/game-label.ts';
import { loadSnapshot } from '../src/catalog/import/load.ts';
import { fixtureSnapshot } from './fixtures.ts';

const manifest = (Data: Record<string, unknown>) => ({ Data });

describe('gameLabel', () => {
  it('forms the label from branch and change number', () => {
    assert.equal(gameLabel(manifest({ Branch: 'sc-alpha-4.10.2', RequestedP4ChangeNum: '12913470' })), '4.10.2.12913470');
    assert.equal(gameLabel(manifest({ Branch: 'sc-alpha-4.10.0-hotfix', RequestedP4ChangeNum: 12572603 })), '4.10.0-hotfix.12572603');
  });

  it('keeps a branch without the prefix', () => {
    assert.equal(gameLabel(manifest({ Branch: '4.11.0', RequestedP4ChangeNum: '1' })), '4.11.0.1');
  });

  it('names what is missing', () => {
    assert.throws(() => gameLabel(manifest({ RequestedP4ChangeNum: '1' })), /lacks a valid Branch$/);
    assert.throws(() => gameLabel(manifest({ Branch: 'sc-alpha-4.10.2' })), /lacks a valid RequestedP4ChangeNum$/);
    assert.throws(() => gameLabel({}), /Branch and RequestedP4ChangeNum/);
    assert.throws(() => gameLabel(null), /Branch and RequestedP4ChangeNum/);
  });
});

describe('loadSnapshot label', () => {
  const load = (label: string | null, manifest: unknown) => {
    const s = fixtureSnapshot();
    s.game.label = label;
    s.game.manifest = manifest;
    return loadSnapshot(new TextEncoder().encode(JSON.stringify(s))).snapshot.game.label;
  };

  it('derives a missing label from the embedded manifest', () => {
    assert.equal(load(null, manifest({ Branch: 'sc-alpha-4.10.2', RequestedP4ChangeNum: '12913470' })), '4.10.2.12913470');
  });

  it('keeps a label the snapshot carries', () => {
    assert.equal(load('4.9.0.1', {}), '4.9.0.1');
  });

  it('fails when a missing label cannot be derived', () => {
    assert.throws(() => load(null, {}), /none can be derived.*Branch and RequestedP4ChangeNum/);
  });
});
