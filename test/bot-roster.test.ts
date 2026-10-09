import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { APIInteractionGuildMember } from 'discord.js';
import { accessOf, memberInfo } from '../src/bot/roster.ts';

const settings = { memberRoleIds: ['m1', 'm2'] };

describe('roster access', () => {
  it('needs one configured member role', () => {
    assert.deepEqual(accessOf(['m2'], settings), { member: true });
    assert.deepEqual(accessOf(['x'], settings), { member: false });
    assert.deepEqual(accessOf(['m1'], { memberRoleIds: [] }), { member: false });
  });

  it('reads raw API members: nickname, then global name, then username', () => {
    const api = (nick: string | null, global: string | null) => ({
      nick, roles: ['m1'], user: { id: '600000000000000001', username: 'user', global_name: global },
    }) as unknown as APIInteractionGuildMember;
    assert.deepEqual(memberInfo(api('Nick', 'Global')), { userId: '600000000000000001', displayName: 'Nick', roleIds: ['m1'], bot: false });
    assert.equal(memberInfo(api(null, 'Global')).displayName, 'Global');
    assert.equal(memberInfo(api(null, null)).displayName, 'user');
  });
});
