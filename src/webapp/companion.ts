// The companion app release the server hands out: COMPANION_DIR holds the built files and a manifest
// companion.json {"version": "0.1.0", "windows": "<…_x64-standalone.zip>", "linux": "<….AppImage>",
// "windowsSetup": "<…_x64-setup.exe>"} (like BindSight's: the bare exe zipped, the AppImage, the NSIS setup
// with its updater signature next to it as <setup>.sig). Its version
// is the one the server requires: an older app (or one that does not say) gets 426 and the download
// links; the installed app then fetches the setup through the update feed (updateFeed). No manifest =
// no download and no version check.
import { statSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { CompanionPlatform } from './api-types.ts';

export const COMPANION_HEADER = 'x-qm-companion';
export const PLATFORMS: CompanionPlatform[] = ['windows', 'linux'];

export interface CompanionRelease {
  version: string;
  files: Partial<Record<CompanionPlatform, { file: string; size: number }>>;
  // The Windows setup and its updater signature (the .sig file's content)
  setup?: { file: string; size: number; signature: string };
}

const VERSION = /^\d+\.\d+\.\d+$/;
// A plain file name in the directory: no path parts
const fileName = z.string().min(1).max(200).refine((f) => basename(f) === f && f !== '.' && f !== '..' && !f.includes('\\'));
const manifestSchema = z.object({
  version: z.string().regex(VERSION), windows: fileName.optional(), linux: fileName.optional(), windowsSetup: fileName.optional(),
});

// The manifest is looked at again at most this often (a new release shows up without a restart)
const RECHECK_MS = 10_000;

/** Reads the release from `dir` (cached, re-read when the manifest changes); null when there is none or it is invalid. */
export function companionRelease(dir: string | null): () => CompanionRelease | null {
  let checkedAt = 0;
  let mtime = -1;
  let release: CompanionRelease | null = null;
  return () => {
    if (!dir || Date.now() - checkedAt < RECHECK_MS) return release;
    checkedAt = Date.now();
    const manifest = join(dir, 'companion.json');
    let now: number;
    try {
      now = statSync(manifest).mtimeMs;
    } catch {
      mtime = -1;
      return (release = null);
    }
    if (now === mtime) return release;
    mtime = now;
    release = null;
    try {
      const parsed = manifestSchema.parse(JSON.parse(readFileSync(manifest, 'utf8')));
      const files: CompanionRelease['files'] = {};
      for (const platform of PLATFORMS) {
        const file = parsed[platform];
        if (file) files[platform] = { file, size: statSync(join(dir, file)).size };
      }
      release = { version: parsed.version, files };
      if (parsed.windowsSetup) {
        const file = parsed.windowsSetup;
        const signature = readFileSync(join(dir, `${file}.sig`), 'utf8').trim();
        if (!signature) throw new Error(`${file}.sig is empty`);
        release.setup = { file, size: statSync(join(dir, file)).size, signature };
      }
    } catch (err) {
      release = null;
      console.error(`Companion manifest ${manifest} ignored: ${err instanceof Error ? err.message : String(err)}`);
    }
    return release;
  };
}

/** Compares two x.y.z versions numerically; anything else counts as older than everything. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (VERSION.test(v) ? v.split('.').map(Number) : [-1, -1, -1]);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export const downloadPath = (file: string) => `/downloads/companion/${encodeURIComponent(file)}`;

// The installed app's update feed (Tauri updater format) next to the files: /downloads/companion/latest.json
export const UPDATE_FEED = 'latest.json';

/** The update feed for the release's setup at `origin`; null without a setup. */
export function updateFeed(release: CompanionRelease | null, origin: string) {
  if (!release?.setup) return null;
  const { file, signature } = release.setup;
  return { version: release.version, platforms: { 'windows-x86_64': { url: `${origin}${downloadPath(file)}`, signature } } };
}
