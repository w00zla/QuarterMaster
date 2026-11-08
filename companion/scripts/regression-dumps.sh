#!/usr/bin/env bash
# Runs the companion's dump examples (inventory_dump: warehouse, components_dump: character inventory) and
# sc-ohseearr's regress-refinery over the regression sets in sc-ohseearr's data root and writes raw and normalized
# outputs, to compare two builds of the companion byte for byte (diff the *.norm.txt files and overlays.sha256).
#
#   scripts/regression-dumps.sh <out dir> [repo root]
#
# The repo root defaults to the one this script lives in; sc-ohseearr is the sibling checkout
# <root>/../../sc-ohseearr (the one the companion builds against), the data is read from its data root
# ($SC_OHSEEARR_DATA, else <root>/../../sc-ohseearr/local). The sets are the folders each reader's
# `regression.toml` lists (only `regression/<reader>/`, sc-ohseearr ADR 0014).
#
# The refinery reader needs the game's English texts: $REFINERY_ENGLISH (default: the companion's
# global-english.ini in its local data folder) and optionally a language pack, $REFINERY_PACK. Without the
# English table the refinery is skipped (noted on stderr).
set -euo pipefail

out=${1:?usage: regression-dumps.sh <out dir> [repo root]}
root=${2:-$(cd "$(dirname "$0")/.." && pwd)}
data=${SC_OHSEEARR_DATA:-$root/../../sc-ohseearr/local}
manifest=$root/src-tauri/Cargo.toml
ocr_root=$root/../../sc-ohseearr
ocr_manifest=$ocr_root/Cargo.toml
english=${REFINERY_ENGLISH:-${LOCALAPPDATA:-$HOME/.local/share}/com.w00zla.quartermaster.companion/global-english.ini}

mkdir -p "$out"
out=$(cd "$out" && pwd)
start=$(date +%s)

target_dir() {
  cargo metadata --manifest-path "$1" --format-version 1 --no-deps | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p'
}
# The folders of a reader's regression.toml (one quoted path per line), below the data root
sets() {
  sed -n 's/^ *"\(.*\)",\{0,1\} *$/\1/p' "$ocr_root/readers/$1/regression.toml" | while IFS= read -r f; do
    printf '%s\n' "$data/$f"
  done
}
cargo build --release --manifest-path "$manifest" --examples
cargo build --release --manifest-path "$ocr_manifest" -p sc-ohseearr-refinery --example regress-refinery
ex="$(target_dir "$manifest")/release/examples"
[ -x "$ex/inventory_dump.exe" ] && sfx=.exe || sfx=
regress_refinery="$(target_dir "$ocr_manifest")/release/examples/regress-refinery$sfx"

mapfile -t wh < <(sets warehouse)
mapfile -t ci < <(sets gear-inventory)
mapfile -t rf < <(sets refinery)

rm -rf "$out/inventory-overlays"
"$ex/inventory_dump$sfx" "$out/inventory-overlays" "${wh[@]}" --threads 3 > "$out/inventory.txt"
"$ex/components_dump$sfx" "${ci[@]}" --threads 3 > "$out/components.txt"

: > "$out/refinery.txt"
if [ ${#rf[@]} -eq 0 ]; then
  echo "refinery: no regression set (readers/refinery/regression.toml lists none), skipped" >&2
elif [ ! -f "$english" ]; then
  echo "refinery: no English table at $english (set REFINERY_ENGLISH), skipped" >&2
else
  pack=()
  [ -n "${REFINERY_PACK:-}" ] && pack=(--pack "$REFINERY_PACK")
  "$regress_refinery" --english "$english" "${pack[@]}" --diagnostics --threads 3 "${rf[@]}" > "$out/refinery.txt"
fi

# Overlay and OCR-box files are part of the output: record their hashes.
(cd "$out/inventory-overlays" && find . -type f | LC_ALL=C sort | xargs -d '\n' sha256sum) > "$out/overlays.sha256"

# Normalize: drop the phases lines, the ms values and the averages line.
for n in inventory components; do
  sed -E -e '/^ *phases:/d' \
         -e 's/, [0-9]+ ms\)/)/' -e 's/, [0-9]+ ms$//' \
         -e 's/^([0-9]+ frames, [^:]*): .*/\1/' \
         "$out/$n.txt" > "$out/$n.norm.txt"
done
cp "$out/refinery.txt" "$out/refinery.norm.txt"

echo "frames: inventory $(grep -c '^== ' "$out/inventory.txt"), components $(grep -c '^== ' "$out/components.txt"), refinery $(grep -c . "$out/refinery.txt" || true)"
echo "elapsed: $(( $(date +%s) - start )) s"
