// All slash commands of the bot.
import { setupCommand } from './commands/setup.ts';
import type { BotCommand } from './registry.ts';

export const commands: BotCommand[] = [setupCommand];
