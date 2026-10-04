import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ENTITY_NAMES, checkIntegrity, diffEntities, diffTexts, evaluateSafeguards, stableStringify, toEntitySets,
  type EntityDiff, type EntityName, type SafeguardOptions,
} from '../src/catalog/import/plan.ts';
import { U, fixtureSnapshot } from './fixtures.ts';

const OPTIONS: SafeguardOptions = { force: false, allowDowngrade: false, maxRetireRatio: 0.1, maxChangeRatio: 0.5 };

const emptyDiffs = () => Object.fromEntries(ENTITY_NAMES.map((n) => [n, diffEntities([], new Map())])) as Record<EntityName, EntityDiff>;

describe('stableStringify', () => {
  it('is independent of key order', () => {
    assert.equal(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] }), stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});

describe('diffEntities', () => {
  it('classifies added, changed, unchanged, revived and retired rows', () => {
    const existing = new Map([
      ['a', { contentHash: 'h1', retired: false }],
      ['b', { contentHash: 'old', retired: false }],
      ['c', { contentHash: 'h3', retired: true }],
      ['d', { contentHash: 'h4', retired: false }],
      ['e', { contentHash: 'h5', retired: true }],
    ]);
    const d = diffEntities([
      { uuid: 'a', contentHash: 'h1' }, { uuid: 'b', contentHash: 'h2' }, { uuid: 'c', contentHash: 'h3' }, { uuid: 'x', contentHash: 'hx' },
    ], existing);
    assert.deepEqual([d.added, d.changed, d.unchanged, d.revived, d.retired], [['x'], ['b'], ['a'], ['c'], ['d']]);
    assert.equal(d.activeBefore, 3);
  });
});

describe('diffTexts', () => {
  it('detects added, changed and removed texts', () => {
    const d = diffTexts(
      { k1: 'same', k2: 'new', k3: 'x' },
      new Map([['k1', 'same'], ['k2', 'old'], ['gone', 'y'], ['constructor', 'z']]),
    );
    assert.equal(d.total, 3);
    assert.equal(d.unchanged, 1);
    assert.deepEqual(d.changed, [['k2', 'new']]);
    assert.deepEqual(d.added, [['k3', 'x']]);
    assert.deepEqual(d.removed, ['gone', 'constructor']);
  });
});

describe('evaluateSafeguards', () => {
  const s = fixtureSnapshot();
  const last = { id: 7, channel: 'LIVE', gameBuild: 1000, snapshotSha256: 'abc' };

  it('treats an identical snapshot as no-op unless forced', () => {
    assert.equal(evaluateSafeguards({ game: s.game, sha256: 'abc', last, diffs: emptyDiffs(), options: OPTIONS }).noop, true);
    const forced = evaluateSafeguards({ game: s.game, sha256: 'abc', last, diffs: emptyDiffs(), options: { ...OPTIONS, force: true } });
    assert.equal(forced.noop, false);
    assert.equal(forced.warnings.length, 1);
  });

  it('blocks downgrades unless allowed', () => {
    const older = { ...s.game, build: 999 };
    assert.deepEqual(evaluateSafeguards({ game: older, sha256: 'new', last, diffs: emptyDiffs(), options: OPTIONS }).violations.map((v) => v.code), ['downgrade']);
    assert.equal(evaluateSafeguards({ game: older, sha256: 'new', last, diffs: emptyDiffs(), options: { ...OPTIONS, allowDowngrade: true } }).violations.length, 0);
  });

  it('blocks mass retire and mass change, ignoring tiny numbers and raw record changes', () => {
    const diffs = emptyDiffs();
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`);
    diffs.blueprint = { ...diffs.blueprint, activeBefore: 100, retired: ids(11) };
    diffs.item = { ...diffs.item, activeBefore: 100, changed: ids(51) };
    diffs.blueprintCategory = { ...diffs.blueprintCategory, activeBefore: 4, retired: ids(2) };
    diffs.rawRecord = { ...diffs.rawRecord, activeBefore: 100, changed: ids(100) };
    const r = evaluateSafeguards({ game: s.game, sha256: 'new', last, diffs, options: OPTIONS });
    assert.deepEqual(r.violations.map((v) => `${v.code}:${v.message.split(':')[0]}`), ['mass_change:item', 'mass_retire:blueprint']);
    assert.equal(evaluateSafeguards({ game: s.game, sha256: 'new', last, diffs, options: { ...OPTIONS, force: true } }).violations.length, 0);
  });
});

describe('checkIntegrity', () => {
  it('accepts the fixture snapshot', () => {
    assert.deepEqual(checkIntegrity(fixtureSnapshot()), []);
  });

  it('reports dangling references and duplicates', () => {
    const s = fixtureSnapshot();
    s.blueprints[0]!.tiers[0]!.slots[0]!.inputs[0]!.uuid = '00000000-0000-0000-0000-000000000000';
    s.items.push({ ...s.items[0]! });
    const errors = checkIntegrity(s);
    assert.ok(errors.some((e) => e.includes('unknown resource 00000000')));
    assert.ok(errors.some((e) => e.startsWith('duplicate item uuid')));
  });
});

describe('toEntitySets', () => {
  it('hashes the recipe into the blueprint and passes numerics as strings', () => {
    const a = toEntitySets(fixtureSnapshot());
    const s = fixtureSnapshot();
    s.blueprints.find((b) => b.uuid === U.blueprint)!.tiers[0]!.craftSeconds += 1;
    const b = toEntitySets(s);
    const hash = (sets: typeof a) => sets.blueprint.find((r) => r.uuid === U.blueprint)!.contentHash;
    assert.notEqual(hash(a), hash(b));
    assert.equal('tiers' in a.blueprint[0]!, false);
    assert.deepEqual(a.resource.find((r) => r.uuid === U.metal)!.boxSizesScu, ['0.125', '1']);
  });
});
