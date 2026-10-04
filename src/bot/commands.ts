// All slash commands of the bot.
import { blueprintsCommand } from './commands/blueprints.ts';
import { setupCommand } from './commands/setup.ts';
import type { BotCommand } from './registry.ts';

export const commands: BotCommand[] = [setupCommand, blueprintsCommand];
