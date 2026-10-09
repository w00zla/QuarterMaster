import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { profileModal } from '../src/bot/commands/profile.ts';
import { parseRsiHandle } from '../src/bot/profile.ts';

describe('/qm-profile', () => {
  it('takes the web app\'s RSI handle rule; empty means none', () => {
    assert.equal(parseRsiHandle('  Star_Pilot-7 '), 'Star_Pilot-7');
    assert.equal(parseRsiHandle(''), null);
    assert.equal(parseRsiHandle('   '), null);
    assert.equal(parseRsiHandle('ab'), undefined);
    assert.equal(parseRsiHandle('no spaces'), undefined);
    assert.equal(parseRsiHandle('x'.repeat(61)), undefined);
  });

  it('prefills the handle and the current language in the modal', () => {
    type Node = { type: number; custom_id?: string; value?: string; options?: { value: string; default?: boolean }[]; component?: Node; components?: Node[] };
    const json = profileModal({ rsiHandle: 'Star_Pilot', lang: 'de' }, 'en').toJSON() as unknown as { custom_id: string; title: string; components: Node[] };
    assert.equal(json.custom_id, 'qm-profile:save');
    assert.equal(json.title, 'Your profile');
    const [rsi, lang] = json.components.map((label) => label.component!);
    assert.equal(rsi!.value, 'Star_Pilot');
    assert.deepEqual(lang!.options!.map((o) => [o.value, o.default ?? false]), [['auto', false], ['en', false], ['de', true]]);
    const empty = profileModal({ rsiHandle: null, lang: null }, 'de').toJSON() as unknown as { components: Node[] };
    assert.equal(empty.components[0]!.component!.value, undefined);
    assert.deepEqual(empty.components[1]!.component!.options!.filter((o) => o.default).map((o) => o.value), ['auto']);
  });
});
