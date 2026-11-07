# dataset-export

Training and evaluation data for sc-ohseearr's `training/` from this app's debug recordings (its ADR 0011). The
data stay in sc-ohseearr's data root (`$SC_OHSEEARR_DATA`, else `../sc-ohseearr/local`); nothing here needs Python.

- **Gear tooltip lines** (the recognizer's evaluation set `ocr-eval`): `components_dump --dataset <out>` writes the
  tooltip lines of every frame as line crops, `<out>/crops/<set>/<frame>_<k>.png`, and `<out>/index.tsv` (file, set,
  frame, k, kind, box, score, frame size, the text as read). A folder is named `<set>=<dir>`. The sets of 2026-10-31
  (data root `D`):

  ```sh
  cargo run --release --manifest-path src-tauri/Cargo.toml --example components_dump -- --dataset D/ocr-eval \
    2503=D/stock_scan_debug/qm-inventory-debug-1793452503 4173=D/stock_scan_debug/qm-inventory-debug-1793454173 \
    8932=D/stock_scan_debug/qm-inventory-debug-1793448932 inv1=D/screenshots/inventory \
    "inv3=D/screenshots/inventory 3" "inv4=D/screenshots/inventory 4"
  ```

  Against the former Python export over the same reads (2026-11-07, 26,445 lines): `index.tsv` byte for byte the
  same; the crops' pixels differ slightly (another JPEG decoder: 98.3 % of the channel values equal, at most 3 off).
- **Labels** for those lines: `ocr-eval-label.ts` (below).
- The teacher line sets and the tooltip background bank are made in sc-ohseearr (`training/tools/`), the warehouse
  layout COCO set exists (a COCO export of the current recording format is not built yet).

## ocr-eval-label.ts

Labels the real tooltip line crops of the recognizer evaluation (`<data root>/ocr-eval/index.tsv`) from sources
independent of the OCR: a title = the catalog's English item name, a stat line = catalog stat name + value read, a
description line = the nearest word span of the item's description in the player's `global.ini`.

```sh
node tools/dataset-export/ocr-eval-label.ts \
  --catalog <en.json> [--catalog <de.json> ...] --pack <global.ini> [--dir <data root>/ocr-eval] [--out <labels.tsv>]
```

- `--catalog`: the web app's `GET /api/companion/catalog` response (or the companion's kept copy in its app data
  folder, `api/_api_catalog_lang_en.json`); the first one must be English.
- `--pack`: the global.ini the game ran with.
- Output: `<dir>/labels.tsv` (or `--out`). Descriptions of variant items whose pack entry cannot be told apart
  are skipped: a missing label is fine, a wrong one is not.
