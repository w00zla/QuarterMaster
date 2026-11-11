// Builds the desktop app for this OS: the server bundle (pnpm app:bundle), the pinned Node as the sidecar
// (pnpm app:fetch-node), then Tauri. docs/app.md "Building".
//   node app/scripts/build.mjs          the release build: the NSIS setup (Windows) or the AppImage (Linux)
//   node app/scripts/build.mjs --fast   a test build without installer: profile `fast` -> src-tauri/target/fast/
//   node app/scripts/build.mjs --dev    tauri dev (the splash served by Tauri's dev server, the Rust side rebuilt on change)
// With TAURI_SIGNING_PRIVATE_KEY in the environment the release build also makes the updater's artifacts (the signature
// and what latest.json needs); without it the installer is built but cannot be published as an update.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mode = process.argv[2] ?? '';
if (!['', '--fast', '--dev'].includes(mode)) throw new Error('usage: build.mjs [--fast | --dev]');
const run = (command, env = {}) => execSync(command, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

run('pnpm app:bundle');
run('pnpm app:fetch-node');

const tauri = 'pnpm --filter sc-quartermaster-app exec tauri';
// The sidecar and the bundle are named in a config of their own: `cargo test` and `cargo clippy` need neither
const config = '--config src-tauri/tauri.bundle.conf.json';
if (mode === '--dev') {
  run(`${tauri} dev ${config}`);
} else if (mode === '--fast') {
  run(`${tauri} build --no-bundle ${config} -- --profile fast`);
} else {
  const windows = process.platform === 'win32';
  const signed = process.env.TAURI_SIGNING_PRIVATE_KEY ? ' --config src-tauri/tauri.updater.conf.json' : '';
  if (!signed) console.log('TAURI_SIGNING_PRIVATE_KEY is not set: building without updater artifacts (no signature, no latest.json input)');
  // NO_STRIP: linuxdeploy's strip does not know newer ELF sections (as for the companion)
  run(`${tauri} build --bundles ${windows ? 'nsis' : 'appimage'} ${config}${signed}`, windows ? {} : { NO_STRIP: 'true' });
}
