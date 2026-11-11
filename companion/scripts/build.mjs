// Builds the companion for this OS (docs/companion.md "Release"): node scripts/build.mjs [--fast]
//   (no flag)  the release build: the NSIS setup and the bare exe (Windows) or the AppImage (Linux)
//   --fast     a test build without installer: profile `fast` -> src-tauri/target/fast/
// With TAURI_SIGNING_PRIVATE_KEY in the environment the release build also makes the updater's artifacts (the signature
// and what latest.json needs); without it the installer is built but cannot be published as an update. The fast build
// never makes them.
import { execSync } from "node:child_process";

const mode = process.argv[2] ?? "";
if (!["", "--fast"].includes(mode)) throw new Error("usage: build.mjs [--fast]");
const windows = process.platform === "win32";
const run = (command, env = {}) => execSync(command, { stdio: "inherit", env: { ...process.env, ...env } });

// The setup config adds DirectML.dll next to the exe (Windows only)
// Two updater key pairs: tauri.conf.json carries the production public key, and only a build that says so keeps it
// (QM_UPDATER_KEY=prod, set by the release workflow, whose secret is the production private key). Every other build,
// this machine's, gets the development public key: it accepts updates signed with the development key only, and a
// local build can never pass as a release.
const key = process.env.QM_UPDATER_KEY === "prod" ? "" : " --config src-tauri/tauri.devkey.conf.json";
const setup = (windows ? " --config src-tauri/tauri.setup.conf.json" : "") + key;
if (mode === "--fast") {
  run(`pnpm tauri build --no-bundle${setup} -- --profile fast`);
} else {
  const signed = process.env.TAURI_SIGNING_PRIVATE_KEY ? " --config src-tauri/tauri.updater.conf.json" : "";
  if (!signed) console.log("TAURI_SIGNING_PRIVATE_KEY is not set: building without updater artifacts (no signature, no latest.json input)");
  // NO_STRIP: linuxdeploy's strip does not know newer ELF sections
  run(`pnpm tauri build --bundles ${windows ? "nsis" : "appimage"}${setup}${signed}`, windows ? {} : { NO_STRIP: "true" });
}
