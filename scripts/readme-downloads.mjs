// Writes the download table into README.md, between `<div id="release_dls">` and its `</div>`, from channels.json
// (release.yml; runnable by hand). HTML tags, not comments: some Markdown editors strip comments. docs/releasing.md.
//   node scripts/readme-downloads.mjs [channels.json] [README.md]
import { readFileSync, writeFileSync } from 'node:fs';
import { downloadTable, readChannels } from './release-lib.mjs';

const [channels = 'channels.json', readme = 'README.md'] = process.argv.slice(2);
const text = readFileSync(readme, 'utf8');
const block = /(<div id="release_dls">)[\s\S]*?(<\/div>)/;
if (!block.test(text)) {
  console.error(`${readme} has no <div id="release_dls"> ... </div>`);
  process.exit(1);
}
const next = text.replace(block, (_, open, close) => `${open}\n\n${downloadTable(readChannels(channels))}\n\n${close}`);
if (next === text) console.log('README.md already up to date');
else {
  writeFileSync(readme, next);
  console.log('README.md download table updated');
}
