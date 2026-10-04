import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { APIInteractionGuildMember } from 'discord.js';
import { accessOf, memberInfo } from '../src/bot/roster.ts';

const settings = { memberRoleIds: ['m1', 'm2'], officerRoleIds: ['o1'] };

describe('roster access', () => {
  it('counts officers as members and needs one configured role', () => {
    assert.deepEqual(accessOf(['m2'], settings), { member: true, officer: false });
    assert.deepEqual(accessOf(['o1'], settings), { member: true, officer: true });
    assert.deepEqual(accessOf(['x'], settings), { member: false, officer: false });
    assert.deepEqual(accessOf(['m1'], { memberRoleIds: [], officerRoleIds: [] }), { member: false, officer: false });
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
