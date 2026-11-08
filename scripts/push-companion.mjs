// Copies the companion app release from local/companion/ into the VM's checkout: the files named in
// companion.json first, the manifest last (it raises the required version; copied first, it would send
// outdated apps to downloads that are not there yet). The one push implementation: publish-win-companion.ps1
// calls it after writing the manifest, push-companion.sh is its entry point on Linux. Node and scp run on
// both platforms (Windows: its OpenSSH scp), so no shell quirks are in the way.
//
//   node scripts/push-companion.mjs <user@host>
//
// Environment (same names as in sc-quartermaster):
//   DEPLOY_PATH   the sc-quartermaster checkout on the VM (default /opt/sc-quartermaster)
//   COMPANION_DIR local folder with companion.json and the release files, relative to the repo root or
//                 absolute (default local/companion); on the VM the files go to <DEPLOY_PATH>/local/companion/
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const args = process.argv.slice(2);
if (args.length !== 1) fail("Usage: node scripts/push-companion.mjs <user@host>");
const host = args[0];
const path = process.env.DEPLOY_PATH || "/opt/sc-quartermaster";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, process.env.COMPANION_DIR || "local/companion");
const manifest = join(dir, "companion.json");
if (!existsSync(manifest)) fail(`No ${manifest}`);

const m = JSON.parse(readFileSync(manifest, "utf8"));
if (typeof m.version !== "string" || !m.version) fail(`No version in ${manifest}`);
// windows, linux, the setup and its signature; entries left out are skipped
const files = [m.windows, m.linux, m.windowsSetup, m.windowsSetup && `${m.windowsSetup}.sig`].filter(Boolean);
if (!files.length) fail(`${manifest} names no files`);
for (const f of files) {
  if (typeof f !== "string" || f.includes("/") || f.includes("\\") || !existsSync(join(dir, f)) || !statSync(join(dir, f)).isFile()) fail(`Missing in ${dir}: ${f}`);
}

// Bare file names from inside the folder: a Windows path's drive letter would read as a host to scp
const scp = (names) => {
  const r = spawnSync("scp", [...names, target], { cwd: dir, stdio: "inherit" });
  if (r.error) fail(`scp: ${r.error.message}`);
  if (r.status !== 0) fail(`scp failed (${r.status})`);
};
const target = `${host}:${path}/local/companion/`;
console.log(`==> Companion ${m.version} to ${target}`);
scp(files);
scp(["companion.json"]);
console.log("==> Done: the web app picks the manifest up within seconds");
