// All slash commands of the bot.
import { blueprintsCommand } from './commands/blueprints.ts';
import { profileCommand } from './commands/profile.ts';
import { refineryCommand } from './commands/refinery.ts';
import { setupCommand } from './commands/setup.ts';
import { stockCommand } from './commands/stock.ts';
import type { BotCommand } from './registry.ts';

export const commands: BotCommand[] = [setupCommand, blueprintsCommand, stockCommand, profileCommand, refineryCommand];
