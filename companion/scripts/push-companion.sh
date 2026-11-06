#!/usr/bin/env bash
# Copies the companion app release from local/companion/ into the VM's checkout: the files named
# in companion.json first, the manifest last (it raises the required version; copied first, it
# would send outdated apps to downloads that are not there yet).
#
#   scripts/push-companion.sh <user@host>
#
# Environment (same names as in sc-quartermaster):
#   DEPLOY_PATH   the sc-quartermaster checkout on the VM (default /opt/sc-quartermaster)
#   COMPANION_DIR local folder with companion.json and the release files, relative to the repo root or
#                 absolute (default local/companion); on the VM the files go to <DEPLOY_PATH>/local/companion/
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <user@host>" >&2
  exit 1
fi
host=$1
path=${DEPLOY_PATH:-/opt/sc-quartermaster}

cd "$(dirname "$0")/.."
dir=${COMPANION_DIR:-local/companion}
manifest=$dir/companion.json

if [[ ! -f $manifest ]]; then
  echo "No $manifest" >&2
  exit 1
fi

# version, then one file per line (windows, linux, the setup and its signature; entries left out are
# skipped). One line: on Windows the Volta shim cuts a -e argument at its first line break.
script='const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));'
script+=' if (typeof m.version !== "string" || !m.version) throw new Error("no version in the manifest");'
script+=' console.log(m.version); for (const k of ["windows", "linux"]) if (m[k]) console.log(m[k]);'
script+=' if (m.windowsSetup) console.log(m.windowsSetup + "\n" + m.windowsSetup + ".sig");'
mapfile -t fields < <(node -e "$script" "$manifest")
if [[ ${#fields[@]} -eq 0 ]]; then
  echo "Cannot read $manifest" >&2
  exit 1
fi
version=${fields[0]}
files=("${fields[@]:1}")
if [[ ${#files[@]} -eq 0 ]]; then
  echo "$manifest names no files" >&2
  exit 1
fi
for f in "${files[@]}"; do
  if [[ $f == */* || ! -f $dir/$f ]]; then
    echo "Missing in $dir: $f" >&2
    exit 1
  fi
done

target="$host:$path/local/companion/"
echo "==> Companion $version to $target"
scp "${files[@]/#/$dir/}" "$target"
scp "$manifest" "$target"
echo "==> Done: the web app picks the manifest up within seconds"
