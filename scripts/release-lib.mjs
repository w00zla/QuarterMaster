// Shared by the release scripts (docs/releasing.md): tags, versions, the asset names a release carries and the
// updates of channels.json (the feed file on the `channels` branch). Plain Node (no dependencies, no TypeScript): CI runs these without `pnpm install`.
import { readFileSync, writeFileSync } from 'node:fs';

export const REPO = process.env.GITHUB_REPOSITORY || 'w00zla/quartermaster';

// A channel id: the same pattern the version regexp takes for its channel part
const CHANNEL_ID = /^[a-z][a-z0-9-]{0,31}$/;
const NUM = '(0|[1-9][0-9]*)';
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-([a-z][a-z0-9-]{0,31})\\.${NUM})?$`);
// The same pattern as src/datapack/manifest.ts (TAG)
const DATA_TAG = /^data-([A-Za-z0-9][A-Za-z0-9._+-]*)-([1-9][0-9]*)$/;

/** The two desktop apps: tag prefix, the product name in the bundles' file names (spaces turned into `-`) and the title. */
export const PRODUCTS = {
  app: { prefix: 'app-v', bundle: 'Quartermaster', title: 'Quartermaster' },
  companion: { prefix: 'companion-v', bundle: 'Quartermaster-Companion', title: 'Quartermaster Companion' },
};

/**
 * What a release tag is: `{ product: 'app' | 'companion', version, channel, tag }` (channel null = a plain version), or
 * `{ product: 'data', tag, label, n }`; null for anything else.
 */
export function parseTag(tag) {
  for (const [product, { prefix }] of Object.entries(PRODUCTS)) {
    if (!tag.startsWith(prefix)) continue;
    const version = tag.slice(prefix.length);
    const m = VERSION.exec(version);
    if (!m) return null;
    const channel = m[4] ?? null;
    if (channel === 'stable') return null;
    return { product, version, channel, tag };
  }
  const d = DATA_TAG.exec(tag);
  return d ? { product: 'data', tag, label: d[1], n: Number(d[2]) } : null;
}

/** -1, 0, 1: x.y.z first, then a plain version is newer than its pre-releases, then the channel name and its counter. */
export function compareVersions(a, b) {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) throw new Error(`not versions: ${a}, ${b}`);
  for (const i of [1, 2, 3]) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  if (pa[4] === undefined || pb[4] === undefined) return pa[4] === pb[4] ? 0 : pa[4] === undefined ? 1 : -1;
  if (pa[4] !== pb[4]) return pa[4] < pb[4] ? -1 : 1;
  return Math.sign(Number(pa[5]) - Number(pb[5]));
}

/** Data tags: the game label compared by its numbers, then the re-issue number. */
export function compareData(a, b) {
  const byLabel = a.label.localeCompare(b.label, 'en', { numeric: true });
  return byLabel || Math.sign(a.n - b.n);
}

/** The installer and AppImage names `tauri build` makes, as the release carries them. */
export function assetNames(product, version) {
  const { bundle } = PRODUCTS[product];
  return { windows: `${bundle}_${version}_x64-setup.exe`, linux: `${bundle}_${version}_amd64.AppImage` };
}

export const releaseUrl = (tag, asset = '') => `https://github.com/${REPO}/releases/download/${tag}${asset ? `/${asset}` : ''}`;

/** channels.json as an object (the empty shape filled in); a missing file is the empty one. */
export function readChannels(path) {
  let json;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    json = {};
  }
  for (const product of Object.keys(PRODUCTS)) {
    json[product] ??= {};
    json[product].stable ??= null;
    json[product].channels ??= [];
  }
  json.data ??= {};
  json.data.stable ??= null;
  return json;
}

export function writeChannels(path, json) {
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

/**
 * Points channels.json at a published release: `stable` of its product for a plain version, the channel entry for
 * `x.y.z-<channel>.<n>` (created on the channel's first version), `data.stable` for a data tag. A tag that is not newer
 * than the one listed leaves the file alone. Returns `{ changed, message }`.
 */
export function pointAt(json, tag) {
  const t = parseTag(tag);
  if (!t) throw new Error(`${tag} is no release tag (app-vX.Y.Z[-<channel>.<n>], companion-vX.Y.Z[-<channel>.<n>], data-<game label>-<n>)`);
  if (t.product === 'data') {
    const old = json.data.stable === null ? null : parseTag(json.data.stable);
    if (old && compareData(old, t) >= 0) return { changed: false, message: `data is at ${json.data.stable} already; ${tag} is not newer` };
    json.data.stable = tag;
    return { changed: true, message: `data stable -> ${tag}` };
  }
  const entry = json[t.product];
  if (t.channel === null) {
    const old = entry.stable === null ? null : parseTag(entry.stable);
    if (old && compareVersions(old.version, t.version) >= 0) return { changed: false, message: `${t.product} stable is at ${entry.stable} already; ${tag} is not newer` };
    entry.stable = tag;
    return { changed: true, message: `${t.product} stable -> ${tag}` };
  }
  const listed = entry.channels.find((c) => c.id === t.channel);
  if (!listed) {
    entry.channels.push({ id: t.channel, tag });
    return { changed: true, message: `${t.product} channel ${t.channel} created at ${tag}` };
  }
  const old = parseTag(listed.tag);
  if (old && compareVersions(old.version, t.version) >= 0) return { changed: false, message: `${t.product} channel ${t.channel} is at ${listed.tag} already; ${tag} is not newer` };
  listed.tag = tag;
  return { changed: true, message: `${t.product} channel ${t.channel} -> ${tag}` };
}

/**
 * Removes a channel's entry of app / companion (channels.json on the `channels` branch; channels.yml). `stable` cannot be
 * removed. Returns `{ changed, message }`; an entry that is not there leaves the file alone.
 */
export function removeChannel(json, product, id) {
  if (!Object.hasOwn(PRODUCTS, product)) throw new Error(`product must be one of ${Object.keys(PRODUCTS).join(', ')}, not ${product}`);
  if (!CHANNEL_ID.test(id) || id === 'stable') throw new Error(`${id} is no channel id`);
  const channels = json[product].channels;
  const at = channels.findIndex((c) => c.id === id);
  if (at < 0) return { changed: false, message: `${product} has no channel ${id}` };
  const [gone] = channels.splice(at, 1);
  return { changed: true, message: `${product} channel ${id} removed (was ${gone.tag})` };
}
