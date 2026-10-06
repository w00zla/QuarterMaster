// The companion app release the server hands out: COMPANION_DIR holds the built files and a manifest
// companion.json {"version": "0.1.0", "windows": "<…_x64-standalone.zip>", "linux": "<….AppImage>"} (standalone
// builds only, like BindSight's: the bare exe zipped, the AppImage). Its version
// is the one the server requires: an older app (or one that does not say) gets 426 and the download
// links. No manifest = no download and no version check.
import { statSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { CompanionPlatform } from './api-types.ts';

export const COMPANION_HEADER = 'x-qm-companion';
export const PLATFORMS: CompanionPlatform[] = ['windows', 'linux'];

export interface CompanionRelease {
  version: string;
  files: Partial<Record<CompanionPlatform, { file: string; size: number }>>;
}

const VERSION = /^\d+\.\d+\.\d+$/;
// A plain file name in the directory: no path parts
const fileName = z.string().min(1).max(200).refine((f) => basename(f) === f && f !== '.' && f !== '..' && !f.includes('\\'));
const manifestSchema = z.object({ version: z.string().regex(VERSION), windows: fileName.optional(), linux: fileName.optional() });

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
    } catch (err) {
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
