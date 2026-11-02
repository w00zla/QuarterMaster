#!/usr/bin/env bash
# Entpackt Blender, legt portable/ hinein und macht packshot ausführbar. Idempotent.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

tarball=$(find . -maxdepth 1 -name 'blender-*-linux-x64.tar.xz' | head -n 1)
if [ -z "$tarball" ]; then
  echo "FEHLER: kein blender-*-linux-x64.tar.xz im Ordner" >&2
  exit 1
fi
if [ ! -d portable ]; then
  echo "FEHLER: portable/ fehlt" >&2
  exit 1
fi

tmp=$(mktemp -d ./blender-extract.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
echo "Blender entpacken ($tarball) ..."
tar -xf "$tarball" -C "$tmp" --strip-components=1
rm -rf ./blender
mv "$tmp" ./blender
trap - EXIT

rm -rf ./blender/portable
cp -r ./portable ./blender/portable
chmod +x packshot

echo "Fertig. Weiter mit: ./check.sh"
