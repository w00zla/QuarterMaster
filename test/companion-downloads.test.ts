import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { companionDownloads, companionDownloadsSource, RELEASES_URL, stableCompanionVersion } from '../src/webapp/companion-downloads.ts';

const BASE = 'https://github.com/w00zla/quartermaster/releases/download/companion-v2.1.0/';

describe('companion downloads', () => {
  it('takes the stable companion version from channels.json', () => {
    assert.equal(stableCompanionVersion({ companion: { stable: 'companion-v2.1.0', channels: [] } }), '2.1.0');
    assert.equal(stableCompanionVersion({ companion: { stable: 'companion-v2.2.0-beta.3' } }), '2.2.0-beta.3');
    assert.equal(stableCompanionVersion({ companion: { stable: null } }), null);
    assert.equal(stableCompanionVersion({ companion: { stable: 'app-v1.0.0' } }), null);
    assert.equal(stableCompanionVersion({ companion: { stable: 'companion-v2.1.0/../x' } }), null);
    assert.equal(stableCompanionVersion(null), null);
  });

  // The names the release carries: scripts/release-lib.mjs `downloads` (the README's downloads block of companion-v2.1.0)
  it('links the files the release carries, the main one first per platform', () => {
    assert.deepEqual(companionDownloads('2.1.0'), {
      version: '2.1.0',
      windows: [
        { label: 'Installer', url: `${BASE}Quartermaster-Companion_2.1.0_x64-setup.exe` },
        { label: 'Standalone', url: `${BASE}Quartermaster-Companion_2.1.0_x64-standalone.zip` },
      ],
      linux: [
        { label: 'AppImage', url: `${BASE}Quartermaster-Companion_2.1.0_amd64.AppImage` },
        { label: 'deb', url: `${BASE}Quartermaster-Companion_2.1.0_amd64.deb` },
        { label: 'rpm', url: `${BASE}Quartermaster-Companion-2.1.0-1.x86_64.rpm` },
      ],
    });
  });

  it('keeps the answer ten minutes, a failure one, and never throws', async () => {
    let t = 0;
    let calls = 0;
    let reply: () => Response = () => Response.json({ companion: { stable: 'companion-v2.1.0' } });
    const fake = (async () => {
      calls++;
      return reply();
    }) as unknown as typeof fetch;
    const source = companionDownloadsSource(fake, () => t);
    assert.equal((await source()).version, '2.1.0');
    t = 9 * 60_000;
    await source();
    assert.equal(calls, 1);
    t = 11 * 60_000;
    reply = () => { throw new Error('offline'); };
    assert.deepEqual(await source(), { releasesUrl: RELEASES_URL, version: null, windows: [], linux: [] });
    assert.equal(calls, 2);
    t += 30_000;
    await source();
    assert.equal(calls, 2);
    t += 31_000;
    reply = () => new Response('nope', { status: 404 });
    assert.equal((await source()).version, null);
    assert.equal(calls, 3);
  });
});
