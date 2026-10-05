// Static checks on the SPA sources (admin UI and user web app).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const files = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(new URL(`${e.name}/`, dir)) : e.name.endsWith('.vue') ? [new URL(e.name, dir)] : []);

describe('SPA sources', () => {
  it('use no v-html (XSS); Icon.vue renders constant SVGs only', () => {
    for (const root of ['../web/src/', '../webapp/src/']) {
      for (const file of files(new URL(root, import.meta.url))) {
        if (file.pathname.endsWith('/web/src/components/Icon.vue')) continue;
        assert.ok(!readFileSync(file, 'utf8').includes('v-html'), file.pathname);
      }
    }
  });
});
