// All slash commands of the bot.
import { blueprintsCommand } from './commands/blueprints.ts';
import { craftingCommand } from './commands/crafting.ts';
import { helpCommand } from './commands/help.ts';
import { profileCommand } from './commands/profile.ts';
import { refineryCommand } from './commands/refinery.ts';
import { setupCommand } from './commands/setup.ts';
import { compsCommand, stockCommand } from './commands/stock.ts';
import type { BotCommand } from './registry.ts';

export const commands: BotCommand[] = [
  setupCommand, profileCommand, blueprintsCommand, stockCommand, compsCommand, refineryCommand, craftingCommand, helpCommand,
];
