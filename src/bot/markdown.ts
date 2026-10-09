import { escapeMarkdown as discordEscape } from 'discord.js';

/**
 * Makes a user-controlled string (nicknames, org names, handles) inert in a message: discord.js leaves masked links,
 * headings and lists alone by default, and never touches mentions (`<@…>`, `<#…>`, `<t:…>`).
 */
export const escapeMarkdown = (text: string): string =>
  discordEscape(text, { maskedLink: true, heading: true, bulletedList: true, numberedList: true }).replaceAll('<', '\\<');
