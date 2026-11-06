// The companion app's matching of Game.log blueprint names to the catalog (src/match.ts).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildIndex, matchUnlock, type CatalogEntry } from '../src/match.ts';

const bp = (uuid: string, name: string, extra: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({ uuid, name, size: null, gradeLetter: null, isDefault: false, retired: false, ...extra });

describe('companion blueprint matching', () => {
  const en = [
    bp('a', 'Arclight "Stormfall" Pistol'),
    bp('b', 'Guardian', { size: 1, gradeLetter: 'B' }),
    bp('c', 'Guardian', { size: 2, gradeLetter: 'C' }),
    bp('d', 'Glacis'),
    bp('e', 'Glacis'),
    bp('f', 'Old Thing', { retired: true }),
    bp('g', 'Venture Core'),
  ];
  const de = [bp('g', 'Venture Kern'), bp('a', 'Arclight "Stormfall" Pistole')];
  const index = buildIndex([en, de]);
  const uuids = (name: string) => matchUnlock(name, index).map((e) => e.uuid).sort();

  it('matches case and whitespace insensitive, in every loaded language, each entry once', () => {
    assert.deepEqual(uuids('Arclight "Stormfall" Pistol'), ['a']);
    assert.deepEqual(uuids('arclight  "stormfall" PISTOLE '), ['a']);
    assert.deepEqual(uuids('Venture Kern'), ['g']);
    assert.deepEqual(uuids('Venture Core'), ['g']);
  });

  it('strips the ship component prefix and narrows by size and grade', () => {
    assert.deepEqual(uuids('Ind/1/B Guardian'), ['b']);
    assert.deepEqual(uuids('Mil/2/C Guardian'), ['c']);
    // Prefix that fits none: all candidates stay (the user picks)
    assert.deepEqual(uuids('Ind/3/A Guardian'), ['b', 'c']);
  });

  it('leaves several candidates to the user, unknown and retired ones empty', () => {
    assert.deepEqual(uuids('Glacis'), ['d', 'e']);
    assert.deepEqual(uuids('Not In The Game'), []);
    assert.deepEqual(uuids('Old Thing'), []);
  });
});
