// Who is a member, resolved live from the interaction's roles.
// Also keeps the caller's roster row current as a safety net for missed member events.
import type { ChatInputCommandInteraction, MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import type { Db } from '../db/client.ts';
import { UserError } from './errors.ts';
import { accessOf, memberInfo, syncMember, type Access } from './roster.ts';
import { findGuildSettings, type GuildSettings } from './settings.ts';

export interface MemberAccess extends Access {
  guildId: string;
  userId: string;
  settings: GuildSettings;
}

/** For commands that need org membership: refuses outside servers, before setup and for non-members. */
export async function requireMember(
  db: Db, interaction: ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction,
): Promise<MemberAccess> {
  if (!interaction.inGuild()) throw new UserError('error.guildOnly');
  const settings = await findGuildSettings(db, interaction.guildId);
  if (!settings) throw new UserError('error.notSetUp', {}, { webApp: true });
  const info = memberInfo(interaction.member);
  await syncMember(db, interaction.guildId, settings, info.userId, info);
  const access = accessOf(info.roleIds, settings);
  if (!access.member) throw new UserError('error.notMember', {}, { webApp: true });
  return { ...access, guildId: interaction.guildId, userId: info.userId, settings };
}
