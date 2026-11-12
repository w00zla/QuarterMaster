// Rewrites the README's downloads block from channels.json's stable tags (release.yml, after channels.json; runnable by
// hand). docs/releasing.md.
//   node scripts/readme-downloads.mjs [channels.json] [README.md]
import { readFileSync, writeFileSync } from 'node:fs';
import { downloadsTable, readChannels, replaceDownloads } from './release-lib.mjs';

const [channels = 'channels.json', file = 'README.md'] = process.argv.slice(2);
const readme = readFileSync(file, 'utf8');
const next = replaceDownloads(readme, downloadsTable(readChannels(channels)));
if (next !== readme) writeFileSync(file, next);
console.log(next !== readme ? `${file}: downloads block rewritten` : `unchanged: ${file}'s downloads block is current`);
