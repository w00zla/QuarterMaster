import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageFlags, type Interaction } from 'discord.js';
import { UserError } from '../src/bot/errors.ts';
import { localizedDescription, MESSAGES, t, userLang } from '../src/bot/i18n.ts';
import { handleInteraction } from '../src/bot/interactions.ts';
import { bySubcommand, createRegistry, type BotCommand } from '../src/bot/registry.ts';

type Call = [method: string, arg?: unknown];

/** Minimal stand-in for a discord.js interaction: records every response call. */
function fakeInteraction(opts: {
  kind?: 'command' | 'autocomplete' | 'component' | 'modal'; name: string; locale?: string; sub?: string; group?: string; customId?: string;
}) {
  const calls: Call[] = [];
  const i = {
    commandName: opts.name,
    customId: opts.customId ?? '',
    locale: opts.locale ?? 'en-US',
    guildId: 'g1',
    user: { id: 'u1' },
    deferred: false,
    replied: false,
    responded: false,
    ephemeral: null as boolean | null,
    isAutocomplete: () => opts.kind === 'autocomplete',
    isMessageComponent: () => opts.kind === 'component',
    isModalSubmit: () => opts.kind === 'modal',
    isChatInputCommand: () => (opts.kind ?? 'command') === 'command',
    options: {
      getSubcommand: () => opts.sub ?? null,
      getSubcommandGroup: () => opts.group ?? null,
    },
    async reply(arg: unknown) {
      calls.push(['reply', arg]);
      i.replied = true;
    },
    async deferReply(arg: unknown) {
      calls.push(['deferReply', arg]);
      i.deferred = true;
      i.ephemeral = true;
    },
    async deferUpdate() {
      calls.push(['deferUpdate']);
      i.deferred = true;
    },
    async editReply(arg: unknown) {
      calls.push(['editReply', arg]);
    },
    async followUp(arg: unknown) {
      calls.push(['followUp', arg]);
    },
    async update(arg: unknown) {
      calls.push(['update', arg]);
      i.replied = true;
    },
    async showModal(arg: unknown) {
      calls.push(['showModal', arg]);
      i.replied = true;
    },
    async respond(arg: unknown) {
      calls.push(['respond', arg]);
      i.responded = true;
    },
  };
  return { interaction: i as unknown as Interaction, calls };
}

const command = (name: string, execute: BotCommand['execute'], extra: Partial<BotCommand> = {}): BotCommand => ({
  data: { name, ...localizedDescription('error.generic') },
  execute,
  ...extra,
});

const quietLog = () => {
  const logged: string[] = [];
  return { logged, log: (msg: string) => void logged.push(msg) };
};

describe('bot i18n', () => {
  it('maps the client locale to de or en', () => {
    assert.equal(userLang('de'), 'de');
    assert.equal(userLang('de-AT'), 'de');
    assert.equal(userLang('en-US'), 'en');
    assert.equal(userLang('fr'), 'en');
    assert.equal(userLang(null), 'en');
  });

  it('has the same, non-empty keys in both languages', () => {
    const en = Object.keys(MESSAGES.en).sort();
    assert.deepEqual(Object.keys(MESSAGES.de).sort(), en);
    for (const lang of ['en', 'de'] as const) {
      for (const key of en) assert.ok(MESSAGES[lang][key as keyof typeof MESSAGES.en].trim(), `${lang}: ${key} is empty`);
    }
  });

  it('fills placeholders and builds localized descriptions', () => {
    assert.equal(t('de', 'error.unknownCommand'), 'Dieser Befehl ist nicht (mehr) verfügbar.');
    assert.deepEqual(localizedDescription('error.guildOnly'), {
      description: 'This command only works on a server.',
      description_localizations: { de: 'Dieser Befehl funktioniert nur auf einem Server.' },
    });
  });
});

describe('bot router', () => {
  it('routes a command and replies ephemerally in the user language', async () => {
    const registry = createRegistry([command('ping', async (ctx) => ctx.reply(ctx.t('error.guildOnly')))]);
    const { interaction, calls } = fakeInteraction({ name: 'ping', locale: 'de' });
    await handleInteraction(interaction, registry);
    assert.deepEqual(calls, [['reply', { content: 'Dieser Befehl funktioniert nur auf einem Server.', flags: MessageFlags.Ephemeral }]]);
  });

  it('dispatches subcommands', async () => {
    const seen: string[] = [];
    const registry = createRegistry([
      command('stock', bySubcommand({ add: async () => void seen.push('add'), 'org/list': async () => void seen.push('org/list') })),
    ]);
    await handleInteraction(fakeInteraction({ name: 'stock', sub: 'add' }).interaction, registry);
    await handleInteraction(fakeInteraction({ name: 'stock', group: 'org', sub: 'list' }).interaction, registry);
    assert.deepEqual(seen, ['add', 'org/list']);
  });

  it('turns a UserError into its message without logging', async () => {
    const { logged, log } = quietLog();
    const registry = createRegistry([command('x', async () => { throw new UserError('error.guildOnly'); })]);
    const { interaction, calls } = fakeInteraction({ name: 'x' });
    await handleInteraction(interaction, registry, { log });
    assert.deepEqual(calls, [['reply', { content: 'This command only works on a server.', flags: MessageFlags.Ephemeral }]]);
    assert.deepEqual(logged, []);
  });

  it('answers unexpected errors generically and logs them', async () => {
    const { logged, log } = quietLog();
    const registry = createRegistry([command('x', async () => { throw new Error('db down'); })]);
    const { interaction, calls } = fakeInteraction({ name: 'x', locale: 'de' });
    await handleInteraction(interaction, registry, { log });
    assert.deepEqual(calls, [['reply', { content: t('de', 'error.generic'), flags: MessageFlags.Ephemeral }]]);
    assert.equal(logged.length, 1);
  });

  it('follows up when the error comes after the first reply', async () => {
    const { log } = quietLog();
    const registry = createRegistry([
      command('x', async (ctx) => {
        await ctx.reply('first');
        throw new Error('later');
      }),
    ]);
    const { interaction, calls } = fakeInteraction({ name: 'x' });
    await handleInteraction(interaction, registry, { log });
    assert.deepEqual(calls.map((c) => c[0]), ['reply', 'followUp']);
  });

  it('answers unknown commands with a UserError message', async () => {
    const { interaction, calls } = fakeInteraction({ name: 'gone' });
    await handleInteraction(interaction, createRegistry([]));
    assert.deepEqual(calls, [['reply', { content: t('en', 'error.unknownCommand'), flags: MessageFlags.Ephemeral }]]);
  });

  it('defers a slow command and edits the deferred reply', async () => {
    const registry = createRegistry([
      command('slow', async (ctx) => {
        await new Promise((r) => setTimeout(r, 30));
        await ctx.reply('done');
      }),
    ]);
    const { interaction, calls } = fakeInteraction({ name: 'slow' });
    await handleInteraction(interaction, registry, { deferAfterMs: 5 });
    assert.deepEqual(calls, [
      ['deferReply', { flags: MessageFlags.Ephemeral }],
      ['editReply', { content: 'done' }],
    ]);
  });

  it('does not defer a fast command', async () => {
    const registry = createRegistry([command('fast', async (ctx) => ctx.reply('ok'), { ephemeral: false })]);
    const { interaction, calls } = fakeInteraction({ name: 'fast' });
    await handleInteraction(interaction, registry, { deferAfterMs: 50 });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(calls, [['reply', { content: 'ok', flags: undefined }]]);
  });

  it('routes autocomplete and answers empty when a handler is missing or fails', async () => {
    const { log } = quietLog();
    const registry = createRegistry([
      command('a', async () => {}, { autocomplete: async (i, lang) => i.respond([{ name: lang, value: 'v' }]) }),
      command('b', async () => {}),
      command('c', async () => {}, { autocomplete: async () => { throw new Error('boom'); } }),
    ]);
    const a = fakeInteraction({ kind: 'autocomplete', name: 'a', locale: 'de' });
    const b = fakeInteraction({ kind: 'autocomplete', name: 'b' });
    const c = fakeInteraction({ kind: 'autocomplete', name: 'c' });
    for (const x of [a, b, c]) await handleInteraction(x.interaction, registry, { log });
    assert.deepEqual(a.calls, [['respond', [{ name: 'de', value: 'v' }]]]);
    assert.deepEqual(b.calls, [['respond', []]]);
    assert.deepEqual(c.calls, [['respond', []]]);
  });

  it('routes components by the command name prefix of the custom ID', async () => {
    const seen: string[] = [];
    const registry = createRegistry([
      command('qm-x', async () => {}, { component: async (ctx) => { seen.push(ctx.interaction.customId, ctx.lang); await ctx.interaction.update({ content: 'ok' }); } }),
    ]);
    const { interaction, calls } = fakeInteraction({ kind: 'component', name: '', customId: 'qm-x:field', locale: 'de' });
    await handleInteraction(interaction, registry);
    assert.deepEqual(seen, ['qm-x:field', 'de']);
    assert.deepEqual(calls, [['update', { content: 'ok' }]]);
  });

  it('answers component errors ephemerally: UserError as message, others generic and logged', async () => {
    const { logged, log } = quietLog();
    const registry = createRegistry([
      command('qm-u', async () => {}, { component: async () => { throw new UserError('error.manageGuild'); } }),
      command('qm-e', async () => {}, { component: async () => { throw new Error('boom'); } }),
    ]);
    const u = fakeInteraction({ kind: 'component', name: '', customId: 'qm-u:a' });
    const e = fakeInteraction({ kind: 'component', name: '', customId: 'qm-e:a' });
    const gone = fakeInteraction({ kind: 'component', name: '', customId: 'qm-gone:a' });
    for (const x of [u, e, gone]) await handleInteraction(x.interaction, registry, { log });
    assert.deepEqual(u.calls, [['reply', { content: t('en', 'error.manageGuild'), flags: MessageFlags.Ephemeral }]]);
    assert.deepEqual(e.calls, [['reply', { content: t('en', 'error.generic'), flags: MessageFlags.Ephemeral }]]);
    assert.deepEqual(gone.calls, [['reply', { content: t('en', 'error.unknownCommand'), flags: MessageFlags.Ephemeral }]]);
    assert.equal(logged.length, 1);
  });

  it('never defers a subcommand that may open a modal, and opens it', async () => {
    const registry = createRegistry([
      command('m', bySubcommand({
        add: async (ctx) => {
          await new Promise((r) => setTimeout(r, 30));
          await ctx.showModal('modal' as never);
        },
      }), { modalSubcommands: ['add'] }),
    ]);
    const { interaction, calls } = fakeInteraction({ name: 'm', sub: 'add' });
    await handleInteraction(interaction, registry, { deferAfterMs: 5 });
    assert.deepEqual(calls, [['showModal', 'modal']]);
  });

  it('refuses a modal after the first reply as a bug', async () => {
    const { logged, log } = quietLog();
    const registry = createRegistry([command('m', async (ctx) => {
      await ctx.reply('first');
      await ctx.showModal('modal' as never);
    }, { modalSubcommands: [''] })]);
    const { interaction, calls } = fakeInteraction({ name: 'm' });
    await handleInteraction(interaction, registry, { log });
    assert.deepEqual(calls.map((c) => c[0]), ['reply', 'followUp']);
    assert.equal(logged.length, 1);
  });

  it('adds IsComponentsV2 to the ephemeral flag of a panel', async () => {
    const registry = createRegistry([command('p', async (ctx) => ctx.reply({ components: [], flags: MessageFlags.IsComponentsV2 }))]);
    const { interaction, calls } = fakeInteraction({ name: 'p' });
    await handleInteraction(interaction, registry);
    assert.deepEqual(calls, [['reply', { components: [], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }]]);
  });

  it('routes modal submits to the modal handler, errors like components', async () => {
    const { log } = quietLog();
    const seen: string[] = [];
    const registry = createRegistry([
      command('qm-x', async () => {}, { modal: async (ctx) => { seen.push(ctx.interaction.customId); await ctx.interaction.reply({ content: 'ok' }); } }),
      command('qm-y', async () => {}),
    ]);
    const x = fakeInteraction({ kind: 'modal', name: '', customId: 'qm-x:add:1' });
    const y = fakeInteraction({ kind: 'modal', name: '', customId: 'qm-y:add' });
    for (const f of [x, y]) await handleInteraction(f.interaction, registry, { log });
    assert.deepEqual(seen, ['qm-x:add:1']);
    assert.deepEqual(x.calls, [['reply', { content: 'ok' }]]);
    assert.deepEqual(y.calls, [['reply', { content: t('en', 'error.unknownCommand'), flags: MessageFlags.Ephemeral }]]);
  });

  it('answers an error after a deferred reply in that reply, after a deferred update as a follow-up', async () => {
    const { log } = quietLog();
    const registry = createRegistry([command('qm-d', async () => {}, {
      modal: async (ctx) => {
        await ctx.interaction.deferReply({ flags: MessageFlags.Ephemeral });
        throw new UserError('error.notMember');
      },
      component: async (ctx) => {
        await ctx.interaction.deferUpdate();
        throw new Error('boom');
      },
    })]);
    const m = fakeInteraction({ kind: 'modal', name: '', customId: 'qm-d:x' });
    const c = fakeInteraction({ kind: 'component', name: '', customId: 'qm-d:y' });
    for (const f of [m, c]) await handleInteraction(f.interaction, registry, { log });
    assert.deepEqual(m.calls.at(-1), ['editReply', { content: t('en', 'error.notMember'), components: [] }]);
    assert.deepEqual(c.calls.at(-1), ['followUp', { content: t('en', 'error.generic'), flags: MessageFlags.Ephemeral }]);
  });

  it('offers the web app with errors that ask for it, when its origin is configured', async () => {
    const saved = process.env.WEBAPP_ORIGIN;
    try {
      const registry = createRegistry([command('x', async () => { throw new UserError('error.notMember', {}, { webApp: true }); })]);
      process.env.WEBAPP_ORIGIN = 'https://qm.example/';
      const withLink = fakeInteraction({ name: 'x' });
      await handleInteraction(withLink.interaction, registry);
      const reply = withLink.calls[0]![1] as { content: string; components: { toJSON(): { components: { url: string; label: string }[] } }[] };
      assert.equal(reply.content, t('en', 'error.notMember'));
      assert.deepEqual(reply.components.map((r) => r.toJSON().components.map((c) => [c.label, c.url])), [[[t('en', 'ui.openWebApp'), 'https://qm.example']]]);
      delete process.env.WEBAPP_ORIGIN;
      const without = fakeInteraction({ name: 'x' });
      await handleInteraction(without.interaction, registry);
      assert.deepEqual(without.calls, [['reply', { content: t('en', 'error.notMember'), flags: MessageFlags.Ephemeral }]]);
    } finally {
      if (saved === undefined) delete process.env.WEBAPP_ORIGIN;
      else process.env.WEBAPP_ORIGIN = saved;
    }
  });

  it('rejects duplicate command names', () => {
    assert.throws(() => createRegistry([command('x', async () => {}), command('x', async () => {})]), /Duplicate/);
  });
});
