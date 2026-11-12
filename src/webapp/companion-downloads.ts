// GET /api/companion/downloads: the companion app's stable release as direct download links on GitHub, for the web app's
// Companion dialog. The stable tag comes from channels.json on the repository's `channels` branch (the feed the README's
// downloads block and the data updater read, docs/releasing.md); the file names are the ones the release carries
// (scripts/release-lib.mjs `downloads`, which the image does not hold: kept in step by test/companion-downloads.test.ts).
// The answer is kept for ten minutes, a failed read for one; without a known stable release only the releases page is offered.
import type { Hono } from 'hono';
import { CHANNELS_FILE, DATA_REPO } from '../datapack/feed.ts';
import type { CompanionDownload, CompanionDownloadsResponse } from './api-types.ts';
import type { Env } from './routes.ts';

const REPO = `${DATA_REPO.owner}/${DATA_REPO.repo}`;
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
const CHANNELS_URL = `https://raw.githubusercontent.com/${REPO}/channels/${CHANNELS_FILE}`;
const PREFIX = 'companion-v';
const BUNDLE = 'Quartermaster-Companion';
// A plain version (x.y.z) or a channel's (x.y.z-<channel>.<n>), as release-lib.mjs takes them
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[a-z][a-z0-9-]{0,31}\.(0|[1-9][0-9]*))?$/;

const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;
const TIMEOUT_MS = 10_000;

/** The companion's stable version in a parsed channels.json; null when there is none or it is not a companion tag. */
export function stableCompanionVersion(json: unknown): string | null {
  const stable = (json as { companion?: { stable?: unknown } } | null)?.companion?.stable;
  if (typeof stable !== 'string' || !stable.startsWith(PREFIX)) return null;
  const version = stable.slice(PREFIX.length);
  return VERSION.test(version) ? version : null;
}

/** The release's files per platform, the first the main one (installer, AppImage), as the README's downloads block. */
export function companionDownloads(version: string): Omit<CompanionDownloadsResponse, 'releasesUrl'> {
  const url = (name: string) => `https://github.com/${REPO}/releases/download/${PREFIX}${version}/${name}`;
  const link = (label: string, name: string): CompanionDownload => ({ label, url: url(name) });
  return {
    version,
    windows: [link('Installer', `${BUNDLE}_${version}_x64-setup.exe`), link('Standalone', `${BUNDLE}_${version}_x64-standalone.zip`)],
    linux: [
      link('AppImage', `${BUNDLE}_${version}_amd64.AppImage`),
      link('deb', `${BUNDLE}_${version}_amd64.deb`),
      link('rpm', `${BUNDLE}-${version}-1.x86_64.rpm`),
    ],
  };
}

const NONE: CompanionDownloadsResponse = { releasesUrl: RELEASES_URL, version: null, windows: [], linux: [] };

/** Reads channels.json (with `doFetch`, tests pass their own) and keeps the answer; never throws. */
export function companionDownloadsSource(doFetch: typeof fetch, now: () => number = Date.now) {
  let kept: { value: CompanionDownloadsResponse; until: number } | null = null;
  return async (): Promise<CompanionDownloadsResponse> => {
    if (kept && now() < kept.until) return kept.value;
    let value = NONE;
    try {
      const res = await doFetch(CHANNELS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const version = res.ok ? stableCompanionVersion(await res.json()) : null;
      if (version) value = { releasesUrl: RELEASES_URL, ...companionDownloads(version) };
    } catch { /* GitHub not reachable: the releases page only */ }
    kept = { value, until: now() + (value.version ? OK_TTL_MS : FAIL_TTL_MS) };
    return value;
  };
}

export function registerCompanionDownloadRoute(api: Hono<Env>, source: () => Promise<CompanionDownloadsResponse>) {
  api.get('/companion/downloads', async (c) => c.json(await source()));
}
