import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { missingLogsPermissions, patchFor, setupCommand, setupPanel } from '../src/bot/commands/setup.ts';
import type { GuildSettings } from '../src/bot/settings.ts';

const settings: GuildSettings = {
  memberRoleIds: ['100000000000000001', '100000000000000002'],
  officerRoleIds: [],
  baseLang: 'de',
  logsChannelId: '200000000000000001',
  logsLevel: 'org',
};

describe('/qm-setup', () => {
  it('is hidden for non-admins and server-only', () => {
    assert.equal(setupCommand.data.name, 'qm-setup');
    assert.equal(setupCommand.data.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
    assert.deepEqual(setupCommand.data.contexts, [0]);
  });

  it('shows the current values and never pings', () => {
    const panel = setupPanel(settings, 'en', { missing: [] });
    assert.match(panel.content, /Member roles: <@&100000000000000001>, <@&100000000000000002>/);
    assert.match(panel.content, /Officer roles: none/);
    assert.match(panel.content, /Base language \(public output\): Deutsch/);
    assert.match(panel.content, /Logs: <#200000000000000001> · Org stock bookings · ✅/);
    assert.deepEqual(panel.allowedMentions, { parse: [] });
  });

  it('has one preselected select per setting', () => {
    // Plain JSON view of the first component per row
    const rows = setupPanel(settings, 'de', null).components.map((r) => r.toJSON().components[0] as unknown as Record<string, unknown>);
    assert.deepEqual(rows.map((c) => c.custom_id), [
      'qm-setup:memberRoles', 'qm-setup:officerRoles', 'qm-setup:baseLang', 'qm-setup:logsChannel', 'qm-setup:logsLevel',
    ]);
    const [member, , lang, channel, level] = rows;
    assert.deepEqual((member!.default_values as { id: string }[]).map((v) => v.id), settings.memberRoleIds);
    assert.deepEqual((channel!.default_values as { id: string }[]).map((v) => v.id), [settings.logsChannelId]);
    assert.deepEqual((lang!.options as { value: string; default: boolean }[]).filter((o) => o.default).map((o) => o.value), ['de']);
    assert.deepEqual((level!.options as { label: string; value: string }[]).map((o) => [o.value, o.label]), [
      ['off', 'Logs: Aus'], ['org', 'Logs: Buchungen von Org-Bestand'],
    ]);
  });

  it('reports missing channel permissions in the user language', () => {
    const perms = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    assert.deepEqual(missingLogsPermissions(perms), ['perm.embedLinks', 'perm.attachFiles']);
    const panel = setupPanel(settings, 'de', { missing: missingLogsPermissions(perms) });
    assert.match(panel.content, /⚠️ dem Bot fehlen Rechte: Links einbetten, Dateien anhängen/);
    assert.match(setupPanel(settings, 'en', 'unknown').content, /channel not found/);
    assert.match(setupPanel({ ...settings, logsChannelId: null }, 'en', null).content, /Logs: none/);
  });

  it('maps selections to settings and rejects unknown values', () => {
    assert.deepEqual(patchFor('memberRoles', ['1', '2']), { memberRoleIds: ['1', '2'] });
    assert.deepEqual(patchFor('logsChannel', []), { logsChannelId: null });
    assert.deepEqual(patchFor('baseLang', ['de']), { baseLang: 'de' });
    assert.equal(patchFor('baseLang', ['fr']), null);
    assert.equal(patchFor('logsLevel', ['all']), null);
    assert.equal(patchFor('nope', ['x']), null);
  });
});
