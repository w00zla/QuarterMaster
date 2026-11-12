// Writes the updater feed (`latest.json`, Tauri's format) of one release to stdout, from the signed bundles `tauri build`
// made: the Windows installer and the Linux AppImage with their `.sig` files, collected in one folder under the names
// release-lib.mjs `assetNames` gives. A platform whose files are missing is left out; none at all is an error.
// The URLs name the assets of exactly that release (its tag), so a channel's feed never points at another release.
//   node scripts/latest-json.mjs <tag> <assets dir> [notes file] > latest.json
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetNames, parseTag, releaseUrl } from './release-lib.mjs';

const [tag, dir, notesFile] = process.argv.slice(2);
const t = tag && parseTag(tag);
if (!t || t.product === 'data' || !dir) {
  console.error('usage: latest-json.mjs <app-v... | companion-v... tag> <assets dir> [notes file]');
  process.exit(2);
}
const names = assetNames(t.product, t.version);
const platforms = {};
for (const [key, asset] of [['windows-x86_64', names.windows], ['linux-x86_64', names.linux]]) {
  const bundle = join(dir, asset);
  if (!existsSync(bundle) || !existsSync(`${bundle}.sig`)) {
    console.error(`skipping ${key}: ${asset} or its .sig is not in ${dir}`);
    continue;
  }
  platforms[key] = { signature: readFileSync(`${bundle}.sig`, 'utf8').trim(), url: releaseUrl(tag, asset) };
}
if (!Object.keys(platforms).length) {
  console.error(`no signed bundle in ${dir}`);
  process.exit(1);
}
const notes = notesFile ? readFileSync(notesFile, 'utf8') : '';
console.log(JSON.stringify({ version: t.version, notes, pub_date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), platforms }, null, 2));
