#!/usr/bin/env bash
# Runs the OCR examples (inventory_dump, components_dump, ocr_dump) over a fixed selection of
# screenshots and debug recordings in <repo>/local/ and writes raw and normalized outputs, to compare
# two builds of the companion byte for byte (diff the *.norm.txt files and overlays.sha256).
#
#   scripts/regression-dumps.sh <out dir> [repo root]
#
# The repo root defaults to the one this script lives in; its data is read from <root>/local/.
set -euo pipefail

out=${1:?usage: regression-dumps.sh <out dir> [repo root]}
root=${2:-$(cd "$(dirname "$0")/.." && pwd)}
data=$root/local
manifest=$root/src-tauri/Cargo.toml

mkdir -p "$out"
out=$(cd "$out" && pwd)
start=$(date +%s)

cargo build --release --manifest-path "$manifest" --examples
tdir=$(cargo metadata --manifest-path "$manifest" --format-version 1 --no-deps | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')
ex="$tdir/release/examples"
[ -x "$ex/inventory_dump.exe" ] && sfx=.exe || sfx=

# Fixed selection. Warehouse recordings (grid): 165 + 276 + 211 = 652 frames.
wh=(
  "$data/stock_scan_debug/qm-inventory-debug-1793396676"
  "$data/stock_scan_debug/qm-inventory-debug-1793396994"
  "$data/stock_scan_debug/qm-inventory-debug-1793448821"
  "$data/screenshots/inventory"
  "$data/screenshots/inventory/freight_elevator"
  "$data/screenshots/inventory/mats_labeled"
  "$data/screenshots/inventory 2"
  "$data/screenshots/inventory 3"
  "$data/screenshots/inventory 4"
)
# Character inventory recordings (components): 17 + 427 = 444 frames.
ci=(
  "$data/stock_scan_debug/qm-inventory-debug-1793393861"
  "$data/stock_scan_debug/qm-inventory-debug-1793454173"
)

rm -rf "$out/inventory-overlays"
"$ex/inventory_dump$sfx" "$out/inventory-overlays" "${wh[@]}" --threads 3 > "$out/inventory.txt"
"$ex/components_dump$sfx" "${ci[@]}" --threads 3 > "$out/components.txt"

: > "$out/ocr.txt"
while IFS= read -r img; do
  echo "### $img" >> "$out/ocr.txt"
  "$ex/ocr_dump$sfx" "$img" 800 3 >> "$out/ocr.txt" 2>/dev/null
done < <(find "$data/screenshots/fe terminal 1" "$data/screenshots/refinery flow" "$data/screenshots/refinery flow 2" "$data/screenshots/refinery flow 3" -type f \( -iname '*.jpg' -o -iname '*.png' \) | LC_ALL=C sort)

# Overlay and OCR-box files are part of the output: record their hashes.
(cd "$out/inventory-overlays" && find . -type f | LC_ALL=C sort | xargs -d '\n' sha256sum) > "$out/overlays.sha256"

# Normalize: drop the phases lines, the ms values and the averages line.
for n in inventory components; do
  sed -E -e '/^ *phases:/d' \
         -e 's/, [0-9]+ ms\)/)/' -e 's/, [0-9]+ ms$//' \
         -e 's/^([0-9]+ frames, [^:]*): .*/\1/' \
         "$out/$n.txt" > "$out/$n.norm.txt"
done
cp "$out/ocr.txt" "$out/ocr.norm.txt"

echo "frames: inventory $(grep -c '^== ' "$out/inventory.txt"), components $(grep -c '^== ' "$out/components.txt"), ocr images $(grep -c '^### ' "$out/ocr.txt")"
echo "elapsed: $(( $(date +%s) - start )) s"
