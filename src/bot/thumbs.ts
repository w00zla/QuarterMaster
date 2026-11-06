// Item thumbnails in the bot's panels and the logs channel. The bot uploads nothing: it hands Discord the public
// URL of the `l` file (Discord shows the accessory at ~85 px, enlarges it on click, fetches each URL once and
// caches it). Which UUIDs have one comes from THUMBS_DIR/thumbs.json (shared with the web app, held in memory);
// where Discord fetches them from is THUMBS_URL, else the web app's /thumbs on a public WEBAPP_ORIGIN. Neither:
// no thumbnails, the bot looks as before.
import { fileURLToPath } from 'node:url';
import { ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder } from 'discord.js';
import { thumbFile } from '../thumbs.ts';
import { thumbIndex } from '../thumbs-index.ts';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** The public base of the thumbnails directory (s/, m/, l/ below it), or null: THUMBS_URL, else a public WEBAPP_ORIGIN + /thumbs. */
export function thumbsBase(env: Record<string, string | undefined>): string | null {
  const explicit = env.THUMBS_URL?.trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const origin = env.WEBAPP_ORIGIN?.trim();
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  // Discord cannot reach a local web app
  return LOCAL_HOSTS.includes(url.hostname) ? null : `${url.origin}/thumbs`;
}

/** The URL of a UUID's large thumbnail under `base`, or null without a base or without a thumbnail. */
export function thumbUrlOf(base: string | null, index: ReadonlyMap<string, string>, uuid: string | null | undefined): string | null {
  if (!base || !uuid) return null;
  const key = uuid.toLowerCase();
  const hash = index.get(key);
  return hash ? `${base}/l/${thumbFile(key, hash)}` : null;
}

let index: { dir: string; get: () => ReadonlyMap<string, string> } | null = null;

/** A catalog UUID's thumbnail URL for Discord, or null. Base and directory are read per call (tests may change the env). */
export function thumbUrl(uuid: string | null | undefined): string | null {
  const base = thumbsBase(process.env);
  if (!base || !uuid) return null;
  const dir = process.env.THUMBS_DIR || fileURLToPath(new URL('../../local/thumbs', import.meta.url));
  if (index?.dir !== dir) index = { dir, get: thumbIndex(dir) };
  return thumbUrlOf(base, index.get(), uuid);
}

/** Text with a thumbnail beside it (a section: 3 components). */
export const thumbSection = (text: string, url: string) =>
  new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(url));

/** A panel's head: the text, with the thumbnail beside it when there is one. */
export function addHead(container: ContainerBuilder, text: string, url: string | null): ContainerBuilder {
  return url ? container.addSectionComponents(thumbSection(text, url))
    : container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
}
