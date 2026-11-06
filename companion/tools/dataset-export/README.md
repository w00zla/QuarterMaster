# dataset-export

Exports training and evaluation data for sc-ohseearr's `training/` from this app's debug recordings and example
dumps. All data stay in `local/`. The Python scripts run only through the uv venv
(`local/detector/.venv/Scripts/python.exe -I tools/dataset-export/<script>.py …`); their docstrings hold the options.

- `warehouse_coco.py`: warehouse debug recordings → a COCO layout dataset (recipe `sc-warehouse-layout`).
- `gear_lines.py`: `components_dump` outputs → line crops of the gear tooltips and `index.tsv` (the recognizer's
  evaluation set, labelled by `ocr-eval-label.ts`).
- `teacher_lines.py`: warehouse and refinery lines read by the teacher model with high confidence → line datasets
  against forgetting in the recognizer's fine-tune (recipe `sc-rec-latin`).
- `tooltip_backgrounds.py`: gear tooltip areas with their text inpainted → the background bank for synthetic lines.

## ocr-eval-label.ts

Labels the real tooltip line crops of the recognizer evaluation (`local/ocr-eval/index.tsv`) from sources independent
of the OCR: a title = the catalog's English item name, a stat line = catalog stat name + value read, a description
line = the nearest word span of the item's description in the player's `global.ini`.

```sh
node tools/dataset-export/ocr-eval-label.ts \
  --catalog <en.json> [--catalog <de.json> ...] --pack <global.ini> [--dir local/ocr-eval] [--out <labels.tsv>]
```

- `--catalog`: the web app's `GET /api/companion/catalog` response (or the companion's kept copy in its app data
  folder, `api/_api_catalog_lang_en.json`); the first one must be English.
- `--pack`: the global.ini the game ran with.
- Output: `<dir>/labels.tsv` (or `--out`). Descriptions of variant items whose pack entry cannot be told apart
  are skipped: a missing label is fine, a wrong one is not.
