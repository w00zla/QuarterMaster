import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commands } from '../src/bot/commands.ts';
import { getState, putState } from '../src/bot/state.ts';

type Json = { name: string; description: string; description_localizations?: { de?: string }; options?: Json[]; choices?: unknown[] };

describe('command definitions', () => {
  it('stay within Discord limits (names, descriptions in both languages, option counts)', () => {
    const check = (o: Json, path: string) => {
      assert.match(o.name, /^[a-z0-9_-]{1,32}$/, `${path}: name`);
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `${path}: description length ${o.description.length}`);
      const de = o.description_localizations?.de ?? '';
      assert.ok(de.length >= 1 && de.length <= 100, `${path}: German description length ${de.length}`);
      assert.ok((o.options?.length ?? 0) <= 25, `${path}: too many options`);
      for (const c of o.options ?? []) check(c, `${path} ${c.name}`);
    };
    for (const c of commands) {
      assert.match(c.data.name, /^qm-/);
      check(c.data as unknown as Json, `/${c.data.name}`);
    }
  });
});

describe('button state', () => {
  it('belongs to its user, expires, and can be taken once', async () => {
    const token = putState('u1', { x: 1 }, 1000);
    assert.deepEqual(getState(token, 'u2'), { ok: false, reason: 'foreign' });
    assert.deepEqual(getState(token, 'u1'), { ok: true, value: { x: 1 } });
    assert.deepEqual(getState(token, 'u1', true), { ok: true, value: { x: 1 } });
    assert.deepEqual(getState(token, 'u1'), { ok: false, reason: 'expired' });
    const short = putState('u1', 1, -1);
    assert.deepEqual(getState(short, 'u1'), { ok: false, reason: 'expired' });
  });
});
