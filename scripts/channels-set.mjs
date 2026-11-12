// Points channels.json at a published release tag (release.yml; runnable by hand): the stable tag or the channel entry
// of app / companion, or `data.stable`. docs/releasing.md.
//   node scripts/channels-set.mjs <tag> [channels.json]
import { pointAt, readChannels, writeChannels } from './release-lib.mjs';

const [tag, file = 'channels.json'] = process.argv.slice(2);
if (!tag) {
  console.error('usage: channels-set.mjs <tag> [channels.json]');
  process.exit(2);
}
const json = readChannels(file);
const { changed, message } = pointAt(json, tag);
if (changed) writeChannels(file, json);
console.log(changed ? message : `unchanged: ${message}`);
