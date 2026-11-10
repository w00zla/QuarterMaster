// Where data releases come from (docs/singleuser.md "Updating the data"): the `DataFeed` interface and its two
// implementations, GitHub (the product) and a folder (development, tests). A feed is not trusted: tags and asset names
// that become URLs or paths are validated, and every downloaded file is checked for size and sha256 while it streams.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DataPackError, parseManifest, parseTag, type Manifest, type ManifestFile } from './manifest.ts';

/** The one place that names the repository the releases live in. */
export const DATA_REPO = { owner: 'w00zla', repo: 'quartermaster' } as const;

export const CHANNELS_FILE = 'channels.json';
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** channels.json and a manifest are small; anything bigger is not one. */
const SMALL_LIMIT = 256 * 1024;

/** The feed cannot be reached or answers with an error status: the caller treats it as "offline". */
export class FeedUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FeedUnavailable';
  }
}

/** The run was cancelled (shutdown). */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

export interface DownloadOptions {
  /** Bytes written so far, for the file. */
  onProgress?: (bytes: number) => void;
  signal?: AbortSignal;
}

export interface DataFeed {
  /** The tag of the stable data release; null = the feed has no data channel. */
  stableTag(signal?: AbortSignal): Promise<string | null>;
  /** The manifest of a release (checked: it is that release's); null = no such release. */
  manifest(tag: string, signal?: AbortSignal): Promise<Manifest | null>;
  /**
   * Writes an asset of a release to `dest`, checking size and sha256 against `file` (its name is the asset's) while
   * streaming. On any failure the partial file is deleted. Checksum or size mismatch: `DataPackError` `checksum`.
   */
  download(tag: string, file: ManifestFile, dest: string, options?: DownloadOptions): Promise<void>;
}

function checkTag(tag: string): string {
  if (!parseTag(tag)) throw new DataPackError('invalid', `Not a data release tag: ${JSON.stringify(tag).slice(0, 80)}`);
  return tag;
}

function checkAsset(name: string): string {
  if (!ASSET_NAME.test(name)) throw new DataPackError('invalid', `Not an asset name: ${JSON.stringify(name).slice(0, 80)}`);
  return name;
}

/** The `data.stable` tag of a parsed channels.json: null when there is no data channel; a bad value is an error. */
function stableOf(json: unknown): string | null {
  const data = (json as { data?: unknown } | null)?.data;
  if (data === undefined || data === null) return null;
  const stable = (data as { stable?: unknown }).stable;
  if (stable === undefined || stable === null) return null;
  if (typeof stable !== 'string' || !parseTag(stable)) throw new DataPackError('invalid', 'channels.json: data.stable is not a data release tag');
  return stable;
}

function manifestOf(tag: string, bytes: Uint8Array): Manifest {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new DataPackError('invalid', `The manifest of ${tag} is not JSON`);
  }
  const manifest = parseManifest(json);
  if (manifest.tag !== tag) throw new DataPackError('invalid', `The manifest of ${tag} is for ${manifest.tag}`);
  return manifest;
}

/**
 * Writes a stream to `dest`, counting bytes and hashing as it goes. More bytes than `file.size` stop it at once (a
 * hostile feed cannot fill the disk); at the end size and sha256 must match. The partial file is deleted on failure.
 */
async function writeVerified(chunks: AsyncIterable<Uint8Array>, dest: string, file: ManifestFile, options: DownloadOptions) {
  const hash = createHash('sha256');
  let done = 0;
  const handle = await open(dest, 'w');
  try {
    for await (const chunk of chunks) {
      if (options.signal?.aborted) throw new Cancelled();
      done += chunk.length;
      if (done > file.size) throw new DataPackError('checksum', `${file.name} is bigger than its manifest says`);
      hash.update(chunk);
      await handle.write(chunk);
      options.onProgress?.(done);
    }
    if (options.signal?.aborted) throw new Cancelled();
    if (done !== file.size) throw new DataPackError('checksum', `${file.name} is ${done} bytes, its manifest says ${file.size}`);
    if (hash.digest('hex') !== file.sha256) throw new DataPackError('checksum', `${file.name} does not match its manifest`);
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(dest, { force: true });
    throw err;
  }
  await handle.close();
}

// --- GitHub ----------------------------------------------------------------------------------

export interface GithubFeedOptions {
  /** `fetch`, passed in (tests: no network). */
  fetch: typeof fetch;
  repo?: { owner: string; repo: string };
  /** Until the response starts (ms). */
  connectTimeoutMs?: number;
  /** Without a byte for this long a download is dropped (ms). */
  stallTimeoutMs?: number;
}

/** True for the hosts GitHub serves release assets from (after its redirect). */
const githubHost = (host: string) => host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com');

export function githubFeed(options: GithubFeedOptions): DataFeed {
  const { fetch: doFetch, repo = DATA_REPO, connectTimeoutMs = 20_000, stallTimeoutMs = 30_000 } = options;
  const channelsUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/main/${CHANNELS_FILE}`;
  const assetUrl = (tag: string, asset: string) => `https://github.com/${repo.owner}/${repo.repo}/releases/download/${checkTag(tag)}/${checkAsset(asset)}`;

  /** A GET with a timeout until the headers; the timer is cleared by the caller's `finish`. `null` = 404. */
  async function get(url: string, outer: AbortSignal | undefined) {
    const ctl = new AbortController();
    const onOuter = () => ctl.abort();
    outer?.addEventListener('abort', onOuter);
    let timer = setTimeout(() => ctl.abort(), connectTimeoutMs);
    const finish = () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    };
    // The stall timer for the body: restarted at every chunk
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(), stallTimeoutMs);
    };
    try {
      if (outer?.aborted) throw new Cancelled();
      const res = await doFetch(url, { signal: ctl.signal, headers: { 'user-agent': 'quartermaster-singleuser' } });
      if (res.url && !githubHost(new URL(res.url).hostname)) {
        await res.body?.cancel().catch(() => {});
        throw new FeedUnavailable('The release was redirected to a host that is not GitHub');
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        finish();
        return { res: null, finish, bump };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new FeedUnavailable(`GitHub answered ${res.status} for ${url}`);
      }
      bump();
      return { res, finish, bump };
    } catch (err) {
      finish();
      if (outer?.aborted) throw new Cancelled();
      if (err instanceof FeedUnavailable || err instanceof DataPackError) throw err;
      throw new FeedUnavailable(`Cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  /** The whole body of a small file; null = 404. */
  async function small(url: string, signal: AbortSignal | undefined): Promise<Buffer | null> {
    const { res, finish, bump } = await get(url, signal);
    if (!res) return null;
    try {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > SMALL_LIMIT) throw new DataPackError('invalid', `${url} is too big`);
        parts.push(Buffer.from(chunk));
        bump();
      }
      return Buffer.concat(parts);
    } catch (err) {
      if (signal?.aborted) throw new Cancelled();
      if (err instanceof DataPackError) throw err;
      throw new FeedUnavailable(`Reading ${url} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      finish();
    }
  }

  return {
    async stableTag(signal) {
      const bytes = await small(channelsUrl, signal);
      if (!bytes) return null;
      let json: unknown;
      try {
        json = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new DataPackError('invalid', 'channels.json is not JSON');
      }
      return stableOf(json);
    },

    async manifest(tag, signal) {
      const bytes = await small(assetUrl(tag, 'manifest.json'), signal);
      return bytes ? manifestOf(tag, bytes) : null;
    },

    async download(tag, file, dest, downloadOptions = {}) {
      const url = assetUrl(tag, file.name);
      const { res, finish, bump } = await get(url, downloadOptions.signal);
      try {
        if (!res) throw new DataPackError('invalid', `${file.name} is not in release ${tag}`);
        const body = res.body as unknown as AsyncIterable<Uint8Array>;
        await writeVerified(body, dest, file, {
          signal: downloadOptions.signal,
          onProgress: (n) => {
            bump();
            downloadOptions.onProgress?.(n);
          },
        });
      } catch (err) {
        if (downloadOptions.signal?.aborted) throw new Cancelled();
        if (err instanceof DataPackError || err instanceof Cancelled) throw err;
        // The connection broke or stalled while streaming
        throw new FeedUnavailable(`Downloading ${url} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      } finally {
        finish();
      }
    },
  };
}

// --- a folder (development and tests) ----------------------------------------------------------

/** `<dir>/channels.json` and `<dir>/<tag>/<asset>`: the layout of a release folder, for development and tests. */
export function folderFeed(dir: string): DataFeed {
  const assetPath = (tag: string, asset: string) => join(dir, checkTag(tag), checkAsset(asset));
  const readSmall = (path: string): Buffer | null => {
    if (!existsSync(path)) return null;
    if (statSync(path).size > SMALL_LIMIT) throw new DataPackError('invalid', `${path} is too big`);
    return readFileSync(path);
  };
  return {
    async stableTag() {
      const bytes = readSmall(join(dir, CHANNELS_FILE));
      if (!bytes) return null;
      let json: unknown;
      try {
        json = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new DataPackError('invalid', 'channels.json is not JSON');
      }
      return stableOf(json);
    },
    async manifest(tag) {
      const bytes = readSmall(assetPath(tag, 'manifest.json'));
      return bytes ? manifestOf(tag, bytes) : null;
    },
    async download(tag, file, dest, options = {}) {
      const path = assetPath(tag, file.name);
      if (!existsSync(path)) throw new DataPackError('invalid', `${file.name} is not in release ${tag}`);
      await writeVerified(createReadStream(path), dest, file, options);
    },
  };
}
