// The app bundle for the desktop shell: ONE folder that runs with a bare `node.exe`, no node_modules and no repository:
// the server (src/singleuser/main.ts bundled into server.mjs), PGlite's runtime files beside it, the migrations, the built
// SPA, and bundle.json (version, Node pin, flags, files). Packaging only: development keeps running the .ts sources.
// `pnpm app:bundle [--out <dir>]`, docs/singleuser.md "The app bundle".
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The official Node the shell runs the server with (the version this bundle was tested with). */
export const NODE_VERSION = '26.13.0';

/**
 * Flags for `node server.mjs`, measured (docs/singleuser.md "Memory"): a one-megabyte young generation, and an old space cap
 * that a first data install and the normal requests stay far below.
 */
export const NODE_FLAGS = ['--max-semi-space-size=1', '--max-old-space-size=192'];

/** PGlite's runtime files, looked up beside the module that uses them. */
export const PGLITE_FILES = ['pglite.wasm', 'pglite.data', 'initdb.wasm'];

/** The start texts the shell's splash shows (webapp/src/i18n.ts keys), by their short names. */
export const START_TEXT_KEYS = { starting: 'start.starting', languagePack: 'start.languagePack' } as const;

export type StartTexts = Record<'de' | 'en', Record<keyof typeof START_TEXT_KEYS, string>>;

/** Reads the start texts from i18n.ts as text (it needs the webview to run): two object literals, `en` first, then `de`. */
export function startTexts(i18nSource: string): StartTexts {
  const split = i18nSource.indexOf('\nconst de');
  if (split < 0) throw new Error('i18n.ts: the German block was not found');
  const entries = (text: string) => new Map([...text.matchAll(/^ {2}"([^"]+)": ("(?:[^"\\]|\\.)*"),?$/gm)].map((m) => [m[1]!, JSON.parse(m[2]!) as string]));
  const [en, de] = [entries(i18nSource.slice(0, split)), entries(i18nSource.slice(split))];
  const pick = (texts: Map<string, string>) => {
    const out = {} as Record<keyof typeof START_TEXT_KEYS, string>;
    for (const [name, key] of Object.entries(START_TEXT_KEYS) as Array<[keyof typeof START_TEXT_KEYS, string]>) {
      const text = texts.get(key);
      if (!text) throw new Error(`i18n.ts: no text for ${key}`);
      out[name] = text;
    }
    return out;
  };
  return { de: pick(de), en: pick(en) };
}

export type BundleFile = { path: string; size: number };

/** Every file under `dir` with its size, forward slashes, sorted. */
export function listFiles(dir: string): BundleFile[] {
  const out: BundleFile[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ path: relative(dir, full).split('\\').join('/'), size: statSync(full).size });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const newest = (dir: string): number => {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
  }
  return latest;
};

/** The SPA is built when `webapp/dist` is missing or older than anything it is built from. */
function ensureWebBuilt(root: string, log: (m: string) => void): void {
  const index = join(root, 'webapp', 'dist', 'index.html');
  const sources = [join(root, 'webapp', 'src'), join(root, 'adminapp', 'src'), join(root, 'src', 'webapp'), join(root, 'webapp', 'index.html')];
  const latest = Math.max(...sources.filter(existsSync).map((s) => (statSync(s).isDirectory() ? newest(s) : statSync(s).mtimeMs)));
  if (existsSync(index) && statSync(index).mtimeMs >= latest) return;
  log('web app: building (missing or stale)');
  const result = spawnSync('pnpm webapp:build', { cwd: root, stdio: 'inherit', shell: true });
  if (result.status !== 0) throw new Error('pnpm webapp:build failed');
}

export type BundleOptions = { out: string; root?: string; log?: (m: string) => void; skipWebBuild?: boolean };

export async function buildBundle(options: BundleOptions): Promise<{ out: string; files: BundleFile[] }> {
  const root = options.root ?? fileURLToPath(new URL('../../', import.meta.url));
  const log = options.log ?? (() => {});
  const out = resolve(options.out);
  // Only a folder this script made (or an empty one) is replaced
  if (existsSync(out) && readdirSync(out).length > 0) {
    if (!existsSync(join(out, 'bundle.json'))) throw new Error(`${out} exists and is not an app bundle: refusing to replace it`);
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  if (!options.skipWebBuild) ensureWebBuilt(root, log);
  if (!existsSync(join(root, 'webapp', 'dist', 'index.html'))) throw new Error('webapp/dist is missing: run pnpm webapp:build');

  await build({
    entryPoints: [join(root, 'src', 'singleuser', 'main.ts')],
    outfile: join(out, 'server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    // CommonJS packages inside the ESM bundle ask for require; ws's optional native add-ons are not installed
    banner: { js: "import { createRequire as __qmCreateRequire } from 'node:module'; const require = __qmCreateRequire(import.meta.url);" },
    external: ['bufferutil', 'utf-8-validate'],
    define: { __QM_APP_VERSION__: JSON.stringify(pkg.version) },
    legalComments: 'none',
    logLevel: 'warning',
  });
  const pglite = join(root, 'node_modules', '@electric-sql', 'pglite', 'dist');
  for (const file of PGLITE_FILES) cpSync(join(pglite, file), join(out, file));
  cpSync(join(root, 'drizzle'), join(out, 'drizzle'), { recursive: true });
  cpSync(join(root, 'webapp', 'dist'), join(out, 'web'), { recursive: true });

  const texts = startTexts(readFileSync(join(root, 'webapp', 'src', 'i18n.ts'), 'utf8'));
  const files = listFiles(out);
  const info = { app: { version: pkg.version }, node: { version: NODE_VERSION }, nodeFlags: NODE_FLAGS, startTexts: texts, files };
  writeFileSync(join(out, 'bundle.json'), `${JSON.stringify(info, null, 2)}\n`);
  return { out, files: listFiles(out) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const { out, files } = await buildBundle({ out: at >= 0 ? args[at + 1]! : join(root, 'local', 'app-bundle'), log: (m) => console.log(m) });
  console.log(`app bundle: ${out}`);
  for (const f of files.filter((f) => !f.path.includes('/'))) console.log(`  ${f.path}  ${(f.size / 1048576).toFixed(2)} MB`);
  console.log(`  ${files.length} files, ${(files.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1)} MB`);
}
