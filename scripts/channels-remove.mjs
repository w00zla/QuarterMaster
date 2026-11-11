// Removes a channel's entry from channels.json (channels.yml; runnable by hand). docs/releasing.md.
//   node scripts/channels-remove.mjs <app|companion> <channel id> [channels.json]
import { readChannels, removeChannel, writeChannels } from './release-lib.mjs';

const [product, id, file = 'channels.json'] = process.argv.slice(2);
if (!product || !id) {
  console.error('usage: channels-remove.mjs <app|companion> <channel id> [channels.json]');
  process.exit(2);
}
const json = readChannels(file);
const { changed, message } = removeChannel(json, product, id);
if (changed) writeChannels(file, json);
console.log(changed ? message : `unchanged: ${message}`);
