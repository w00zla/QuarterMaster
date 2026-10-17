import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { boardTitleModal, missingBoardPermissions, missingLogsPermissions, patchFor, setupCommand, setupPanel } from '../src/bot/commands/setup.ts';
import type { GuildSettings } from '../src/bot/settings.ts';

const settings: GuildSettings = {
  memberRoleIds: ['100000000000000001', '100000000000000002'],
  baseLang: 'de',
  logsChannelId: '200000000000000001',
  logsLevel: 'stock',
  boardChannelId: '200000000000000002',
  boardStyle: 'table',
  boardTitle: 'Red *Hollow*',
  boardSubtitle: 'Fleet stock',
};

type Node = { type: number; content?: string; components?: Node[] } & Record<string, unknown>;
const nodes = (p: ReturnType<typeof setupPanel>): Node[] => {
  const out: Node[] = [];
  const walk = (n: Node) => { out.push(n); n.components?.forEach(walk); };
  p.components.map((c) => c.toJSON() as unknown as Node).forEach(walk);
  return out;
};
// The panel's text and its selects (one per action row)
const textOf = (p: ReturnType<typeof setupPanel>) => nodes(p).filter((n) => n.type === 10).map((n) => n.content).join('\n');
const selectsOf = (p: ReturnType<typeof setupPanel>) => nodes(p).filter((n) => n.type === 1).map((r) => r.components![0]!);

describe('/qm-setup', () => {
  it('is hidden for non-admins and server-only', () => {
    assert.equal(setupCommand.data.name, 'qm-setup');
    assert.equal(setupCommand.data.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
    assert.deepEqual(setupCommand.data.contexts, [0]);
  });

  it('shows the current values and never pings', () => {
    const panel = setupPanel(settings, 'en', { logs: { missing: [] }, board: { missing: [] } });
    assert.equal(panel.flags, MessageFlags.IsComponentsV2);
    const text = textOf(panel);
    // One section per area; the text only adds what the selects cannot show (what an area is for, channel checks)
    assert.equal(text, [
      '## ⚙️ Quartermaster setup\n-# Changes are saved immediately.',
      '### 👥 Members',
      '### 🌐 Language\n-# Base language (public output)',
      '### 📜 Logs\n-# Posts changes to the stock shared in this org and to its members\' blueprints into a channel\n✅ the bot can post there',
      '### 📋 Board\n-# One message in a channel showing what the org shares, always up to date\n✅ the bot can post there',
    ].join('\n'));
    assert.match(textOf(setupPanel({ ...settings, boardTitle: null, boardSubtitle: null }, 'en', { logs: null, board: { missing: [] } })), /### 📋 Board\n-# .*\n✅/);
    assert.deepEqual(panel.allowedMentions, { parse: [] });
  });

  it('has one preselected select per setting', () => {
    const rows = selectsOf(setupPanel(settings, 'de', { logs: null, board: null }));
    assert.deepEqual(rows.map((c) => c.custom_id), [
      'qm-setup:memberRoles', 'qm-setup:baseLang', 'qm-setup:logsChannel', 'qm-setup:logsLevel', 'qm-setup:boardChannel', 'qm-setup:boardStyle', 'qm-setup:boardTitle',
    ]);
    const [member, lang, channel, level, board, style] = rows;
    assert.deepEqual((board!.default_values as { id: string }[]).map((v) => v.id), [settings.boardChannelId]);
    assert.deepEqual((style!.options as { label: string; value: string; default: boolean }[]).map((o) => [o.value, o.label, o.default]), [
      ['list', 'Board: Liste', false], ['table', 'Board: Tabelle', true],
    ]);
    assert.deepEqual([rows[6]!.custom_id, rows[6]!.label], ['qm-setup:boardTitle', 'Board-Titel']);
    assert.deepEqual((member!.default_values as { id: string }[]).map((v) => v.id), settings.memberRoleIds);
    assert.deepEqual((channel!.default_values as { id: string }[]).map((v) => v.id), [settings.logsChannelId]);
    assert.deepEqual((lang!.options as { value: string; default: boolean }[]).filter((o) => o.default).map((o) => o.value), ['de']);
    assert.deepEqual((level!.options as { label: string; value: string }[]).map((o) => [o.value, o.label]), [
      ['off', 'Logs: Aus'], ['stock', 'Logs: Geteilter Bestand: Freigaben, Übergaben, Buchungen'],
      ['blueprints', 'Logs: Blueprints: eingetragen, ausgetragen'], ['all', 'Logs: Geteilter Bestand und Blueprints'],
    ]);
  });

  it('reports missing channel permissions in the user language', () => {
    const perms = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    assert.deepEqual(missingLogsPermissions(perms), ['perm.embedLinks', 'perm.attachFiles']);
    const panel = setupPanel(settings, 'de', { logs: { missing: missingLogsPermissions(perms) }, board: { missing: [] } });
    assert.match(textOf(panel), /⚠️ dem Bot fehlen Rechte: Links einbetten, Dateien anhängen/);
    assert.match(textOf(setupPanel(settings, 'en', { logs: 'unknown', board: null })), /### 📜 Logs\n-# .*\n⚠️ channel not found/);
    assert.match(textOf(setupPanel({ ...settings, logsChannelId: null, boardChannelId: null }, 'en', { logs: null, board: null })), /### 📜 Logs\n-# [^\n]*\n### 📋 Board\n-# [^\n]*$/);
    // The board only posts and edits its own message
    assert.deepEqual(missingBoardPermissions(perms), []);
    assert.deepEqual(missingBoardPermissions(new PermissionsBitField([PermissionFlagsBits.ViewChannel])), ['perm.sendMessages']);
  });

  it('asks for the board title and subtitle in a modal, prefilled, empty allowed', () => {
    const fields = (s: GuildSettings) => (boardTitleModal(s, 'en').toJSON().components as unknown as { component: Record<string, unknown> }[])
      .map((c) => [c.component.custom_id, c.component.value, c.component.required, c.component.max_length]);
    assert.deepEqual(fields(settings), [['title', 'Red *Hollow*', false, 100], ['subtitle', 'Fleet stock', false, 100]]);
    assert.deepEqual(fields({ ...settings, boardTitle: null, boardSubtitle: null }), [['title', undefined, false, 100], ['subtitle', undefined, false, 100]]);
  });

  it('maps selections to settings and rejects unknown values', () => {
    assert.deepEqual(patchFor('memberRoles', ['1', '2']), { memberRoleIds: ['1', '2'] });
    assert.deepEqual(patchFor('logsChannel', []), { logsChannelId: null });
    assert.deepEqual(patchFor('boardChannel', ['200000000000000003']), { boardChannelId: '200000000000000003' });
    assert.deepEqual(patchFor('boardStyle', ['list']), { boardStyle: 'list' });
    assert.equal(patchFor('boardStyle', ['grid']), null);
    assert.deepEqual(patchFor('baseLang', ['de']), { baseLang: 'de' });
    assert.equal(patchFor('baseLang', ['fr']), null);
    assert.deepEqual(patchFor('logsLevel', ['blueprints']), { logsLevel: 'blueprints' });
    assert.equal(patchFor('logsLevel', ['org']), null);
    assert.equal(patchFor('nope', ['x']), null);
  });
});
