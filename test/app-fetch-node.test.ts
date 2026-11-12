// The desktop app's Node fetcher (app/scripts/fetch-node.mjs): which official file holds the executable, the checksum
// lookup, and that a download is used only when its sha256 is the listed one. No network: `fetch` is injected.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

type Asset = { name: string; archive: { member: string } | null };
type FetchNode = {
  assetFor(platform: string, arch: string, version: string): Asset;
  shasumOf(shasums: string, name: string): string;
  sidecarPath(appDir: string, triple: string): string;
  downloadVerified(options: { version: string; platform: string; arch: string; fetch: (url: string) => Promise<Response> }): Promise<{ asset: Asset; bytes: Buffer; sha256: string }>;
};
// A plain .mjs script (it runs without the repository's TypeScript setup): loaded by its URL, typed here
const script: string = new URL('../app/scripts/fetch-node.mjs', import.meta.url).href;
const { assetFor, shasumOf, sidecarPath, downloadVerified } = (await import(script)) as FetchNode;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('app fetch-node', () => {
  it('names the official file per platform', () => {
    assert.deepEqual(assetFor('win32', 'x64', '26.13.0'), { name: 'win-x64/node.exe', archive: null });
    assert.deepEqual(assetFor('win32', 'arm64', '26.13.0'), { name: 'win-arm64/node.exe', archive: null });
    assert.deepEqual(assetFor('linux', 'x64', '26.13.0'), { name: 'node-v26.13.0-linux-x64.tar.xz', archive: { member: 'node-v26.13.0-linux-x64/bin/node' } });
    assert.throws(() => assetFor('darwin', 'arm64', '26.13.0'), /no official Node build is configured/);
    assert.throws(() => assetFor('win32', 'ia32', '26.13.0'), /no official Node build is configured/);
    assert.throws(() => assetFor('win32', 'x64', 'latest'), /not a Node version/);
    assert.throws(() => assetFor('win32', 'x64', '26.13.0/../x'), /not a Node version/);
  });

  it('puts the sidecar where Tauri looks for it', () => {
    assert.match(sidecarPath('app', 'x86_64-pc-windows-msvc'), /^app[\\/]src-tauri[\\/]binaries[\\/]node-x86_64-pc-windows-msvc\.exe$/);
    assert.match(sidecarPath('app', 'x86_64-unknown-linux-gnu'), /^app[\\/]src-tauri[\\/]binaries[\\/]node-x86_64-unknown-linux-gnu$/);
  });

  it('finds a checksum by the exact name only', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const shasums = `${a}  node-v26.13.0-linux-x64.tar.xz\n${b}  win-x64/node.exe\n${a}  win-x64/node.exe.extra\n`;
    assert.equal(shasumOf(shasums, 'win-x64/node.exe'), b);
    assert.equal(shasumOf(shasums, 'node-v26.13.0-linux-x64.tar.xz'), a);
    assert.throws(() => shasumOf(shasums, 'win-arm64/node.exe'), /no entry/);
    assert.throws(() => shasumOf('', 'win-x64/node.exe'), /no entry/);
    assert.throws(() => shasumOf('not-a-hash  win-x64/node.exe\n', 'win-x64/node.exe'), /no entry/);
  });

  it('uses a download only when its sha256 is the listed one', async () => {
    const good = Buffer.from('the official node.exe');
    const serve = (shasums: string, body: Buffer, seen: string[] = []) => async (url: string) => {
      seen.push(url);
      if (url.endsWith('/SHASUMS256.txt')) return new Response(shasums);
      if (url.endsWith('/win-x64/node.exe')) return new Response(new Uint8Array(body));
      return new Response('not found', { status: 404 });
    };
    const options = { version: '26.13.0', platform: 'win32', arch: 'x64' };

    const seen: string[] = [];
    const got = await downloadVerified({ ...options, fetch: serve(`${sha256(good)}  win-x64/node.exe\n`, good, seen) });
    assert.deepEqual(seen, ['https://nodejs.org/dist/v26.13.0/SHASUMS256.txt', 'https://nodejs.org/dist/v26.13.0/win-x64/node.exe']);
    assert.ok(got.bytes.equals(good));
    assert.equal(got.sha256, sha256(good));

    // Other bytes than the list says, no entry in the list, or no list: refused
    await assert.rejects(downloadVerified({ ...options, fetch: serve(`${sha256(good)}  win-x64/node.exe\n`, Buffer.from('something else')) }), /refusing to use it/);
    await assert.rejects(downloadVerified({ ...options, fetch: serve(`${sha256(good)}  win-arm64/node.exe\n`, good) }), /no entry/);
    await assert.rejects(downloadVerified({ ...options, fetch: async () => new Response('gone', { status: 404 }) }), /HTTP 404/);
  });
});
