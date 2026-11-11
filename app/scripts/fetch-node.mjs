// Puts the pinned Node (NODE_VERSION in src/singleuser/app-bundle.ts, the version bundle.json names) where Tauri's
// `externalBin` expects the sidecar: app/src-tauri/binaries/node-<target triple>[.exe] (not in git). When the Node running
// this script has exactly the pinned version, its executable is copied; otherwise the official build is downloaded from
// nodejs.org and checked against the release's SHASUMS256.txt before it is used. Anything that does not match stops here.
// `pnpm app:fetch-node`, docs/app.md "Building".
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = 'https://nodejs.org/dist';

/** The Rust host triple (`rustc -vV`): the suffix Tauri looks for. */
export function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = /^host: (\S+)$/m.exec(out)?.[1];
  if (!host) throw new Error('rustc -vV: no host line');
  return host;
}

/** Where the sidecar goes for a triple. */
export const sidecarPath = (appDir, triple) => join(appDir, 'src-tauri', 'binaries', `node-${triple}${triple.includes('windows') ? '.exe' : ''}`);

/**
 * The official file that holds the executable: on Windows the bare `node.exe`, elsewhere the tarball (the executable is
 * `<folder>/bin/node` inside). `name` is the entry in SHASUMS256.txt, relative to the release's folder.
 */
export function assetFor(platform, arch, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a Node version: ${version}`);
  const cpu = { x64: 'x64', arm64: 'arm64' }[arch];
  if (!cpu) throw new Error(`no official Node build is configured for ${platform}-${arch}`);
  if (platform === 'win32') return { name: `win-${cpu}/node.exe`, archive: null };
  if (platform === 'linux') {
    const folder = `node-v${version}-linux-${cpu}`;
    return { name: `${folder}.tar.xz`, archive: { member: `${folder}/bin/node` } };
  }
  throw new Error(`no official Node build is configured for ${platform}-${arch}`);
}

/** The sha256 SHASUMS256.txt lists for `name`; throws when there is none (never "no checksum, so fine"). */
export function shasumOf(shasums, name) {
  for (const line of shasums.split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1];
  }
  throw new Error(`SHASUMS256.txt has no entry for ${name}`);
}

/** Downloads the asset and returns its bytes only when their sha256 is the listed one. */
export async function downloadVerified({ version, platform, arch, fetch: get = fetch, log = () => {} }) {
  const asset = assetFor(platform, arch, version);
  const base = `${DIST}/v${version}`;
  const read = async (url) => {
    const response = await get(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  log(`downloading ${base}/${asset.name}`);
  const expected = shasumOf((await read(`${base}/SHASUMS256.txt`)).toString('utf8'), asset.name);
  const bytes = await read(`${base}/${asset.name}`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`${asset.name}: sha256 is ${actual}, SHASUMS256.txt says ${expected}: refusing to use it`);
  return { asset, bytes, sha256: actual };
}

/** The version a node executable reports, or null when it does not run. */
function versionOf(file) {
  const result = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Writes the executable aside and renames it into place, so a failed run never leaves half a file under the final name. */
function place(target, write) {
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  rmSync(temp, { force: true });
  write(temp);
  if (process.platform !== 'win32') chmodSync(temp, 0o755);
  renameSync(temp, target);
}

export async function fetchNode({ version, appDir, log = console.log }) {
  const target = sidecarPath(appDir, hostTriple());
  if (existsSync(target) && versionOf(target) === `v${version}`) {
    log(`node ${version}: already at ${target}`);
    return target;
  }
  if (process.version === `v${version}`) {
    place(target, (temp) => copyFileSync(process.execPath, temp));
    log(`node ${version}: copied the running Node (${process.execPath}) to ${target}`);
  } else {
    log(`node ${version}: the running Node is ${process.version}, fetching the official build`);
    const { asset, bytes, sha256 } = await downloadVerified({ version, platform: process.platform, arch: process.arch, log });
    if (asset.archive === null) {
      place(target, (temp) => writeFileSync(temp, bytes));
    } else {
      // The tarball is unpacked in a folder of its own; only the one executable is taken out of it
      const work = mkdtempSync(join(tmpdir(), 'qm-node-'));
      try {
        writeFileSync(join(work, 'node.tar.xz'), bytes);
        execFileSync('tar', ['-xJf', join(work, 'node.tar.xz'), '-C', work, asset.archive.member], { stdio: 'inherit' });
        place(target, (temp) => copyFileSync(join(work, asset.archive.member), temp));
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
    log(`node ${version}: ${asset.name} (sha256 ${sha256}) -> ${target}`);
  }
  const got = versionOf(target);
  if (got !== `v${version}`) {
    rmSync(target, { force: true });
    throw new Error(`${target} reports ${got ?? 'nothing'}, not v${version}: removed`);
  }
  return target;
}

if (import.meta.main) {
  const { NODE_VERSION } = await import('../../src/singleuser/app-bundle.ts');
  await fetchNode({ version: NODE_VERSION, appDir: fileURLToPath(new URL('..', import.meta.url)) });
}
