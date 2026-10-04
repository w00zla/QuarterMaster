// Registers the bot's slash commands with Discord (bulk overwrite: commands not in the list are removed).
// Guild-scoped (instant) when DISCORD_DEV_GUILD_ID is set, otherwise global.
import { parseArgs } from 'node:util';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.ts';
import { createRegistry } from './registry.ts';

const HELP = `Usage: pnpm bot:register [options]

  --dry-run   Print the command JSON instead of sending it
  -h, --help

Env: DISCORD_TOKEN, DISCORD_APP_ID; DISCORD_DEV_GUILD_ID registers on that server only`;

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'help': { type: 'boolean', short: 'h', default: false },
    },
  });
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const body = [...createRegistry(commands).values()].map((c) => c.data);
  const { DISCORD_TOKEN, DISCORD_APP_ID, DISCORD_DEV_GUILD_ID } = process.env;
  const scope = DISCORD_DEV_GUILD_ID ? `server ${DISCORD_DEV_GUILD_ID}` : 'global';
  if (args['dry-run']) {
    console.log(JSON.stringify(body, null, 2));
    console.log(`${body.length} command(s), scope: ${scope} (dry run, nothing sent)`);
    return 0;
  }
  if (!DISCORD_TOKEN || !DISCORD_APP_ID) throw new Error('DISCORD_TOKEN and DISCORD_APP_ID must be set (see .env.example)');

  const rest = new REST().setToken(DISCORD_TOKEN);
  const route = DISCORD_DEV_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_APP_ID, DISCORD_DEV_GUILD_ID)
    : Routes.applicationCommands(DISCORD_APP_ID);
  await rest.put(route, { body });
  console.log(`Registered ${body.length} command(s), scope: ${scope}${DISCORD_DEV_GUILD_ID ? '' : ' (may take a while to show up)'}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
