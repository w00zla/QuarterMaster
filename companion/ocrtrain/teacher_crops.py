"""Echte Lager- und Raffinerie-Zeilen mit dem, was das heutige Modell (geschnitten, ohne Fine-Tuning) dort sicher
liest (Konfidenz >= 0.95): gegen das Vergessen beim Fine-Tuning. Training: Lager-Aufnahme …6676 und die Raffinerie-
Screenshots außer den Frames der Rust-Tests; Eval (local/ocr-eval-teacher): Lager …6994 und die Test-Frames.
local/detector/.venv/Scripts/python.exe -I companion/ocrtrain/teacher_crops.py (vom Repo-Root)"""
import os, re
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))).replace("\\", "/")
import cv2

L = f"{ROOT}/local"
T = f"{L}/ocr-teacher"
GATE = {"20D", "E87", "0F4", "DC5", "2E4", "BB4", "575"}
MIN_SCORE = 0.95
LINE = re.compile(r"^\s*(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$")


def boxes(path):
    for line in open(path, encoding="utf-8"):
        m = LINE.match(line.rstrip("\n"))
        if m and not m[6].startswith("[") and float(m[5]) >= MIN_SCORE and len(m[6].strip()) >= 2:
            yield int(m[1]), int(m[2]), int(m[3]), int(m[4]), m[6].strip()


def cut(img, x, y, w, h):
    H, W = img.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    return img[y0 : min(H, y + h + 1), x0 : min(W, x + w + 1)]


def write(out_dir, items, header):
    os.makedirs(out_dir, exist_ok=True)
    rows = []
    for k, (img_path, box, set_name) in enumerate(items):
        img = cv2.imread(img_path)
        crop = cut(img, *box[:4])
        if crop.size == 0 or crop.shape[0] < 6:
            continue
        name = f"{k:06d}.png"
        cv2.imwrite(os.path.join(out_dir, name), crop)
        rows.append((name, set_name, box[4]))
    with open(os.path.join(out_dir, "labels.tsv"), "w", encoding="utf-8", newline="\n") as f:
        if header:
            f.write("file\tset\tsource\tlabel\n")
            f.writelines(f"{n}\t{s}\tteacher\t{t}\n" for n, s, t in rows)
        else:
            f.writelines(f"{n}\t{t}\n" for n, _, t in rows)
    return len(rows)


def warehouse(rec_id, folder):
    for name in sorted(os.listdir(f"{T}/{folder}")):
        if name.startswith("boxes-"):
            img = f"{L}/stock_scan_debug/qm-inventory-debug-{rec_id}/{name[6:-4]}.jpg"
            for b in boxes(f"{T}/{folder}/{name}"):
                yield img, b, f"wh-{folder[-4:]}"


def refinery(gate: bool):
    for name in sorted(os.listdir(f"{T}/ref")):
        d, stem = name[:-4].split("__")
        if (stem[-3:] in GATE) != gate:
            continue
        folder = f"{L}/screenshots/{d.replace('_', ' ')}"
        img = next(f"{folder}/{f}" for f in os.listdir(folder) if os.path.splitext(f)[0] == stem)
        for b in boxes(f"{T}/ref/{name}"):
            yield img, b, "refinery"


n_train = write(f"{L}/ocr-train/teacher", list(warehouse("1793396676", "inv-6676")) + list(refinery(False)), header=False)
n_eval = write(f"{L}/ocr-eval-teacher", list(warehouse("1793396994", "inv-6994")) + list(refinery(True)), header=True)
print(f"teacher train {n_train} lines, eval {n_eval} lines")
