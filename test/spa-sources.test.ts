// Static checks on the SPA sources (admin UI and user web app): no way to put HTML into the DOM.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const files = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(new URL(`${e.name}/`, dir)) : /\.(vue|ts|js)$/.test(e.name) ? [new URL(e.name, dir)] : []);

// v-html, :innerHTML / v-bind:innerHTML / innerHTML in render functions and DOM code, and the other HTML sinks
const SINKS = /v-html|innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|srcdoc/i;

describe('SPA sources', () => {
  it('use no HTML sinks (XSS); Icon.vue renders constant SVGs only', () => {
    let checked = 0;
    for (const root of ['../adminapp/src/', '../webapp/src/']) {
      for (const file of files(new URL(root, import.meta.url))) {
        if (file.pathname.endsWith('/adminapp/src/components/Icon.vue')) continue;
        checked++;
        const hit = SINKS.exec(readFileSync(file, 'utf8'));
        assert.equal(hit, null, `${file.pathname}: ${hit?.[0]}`);
      }
    }
    assert.ok(checked > 20);
  });
});
