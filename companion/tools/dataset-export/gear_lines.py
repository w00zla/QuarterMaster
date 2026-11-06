"""Character inventory (gear) tooltips -> line crops: the input of the recognizer's evaluation set.

Reads the output of the `components_dump` example (one `components_dump-<set>.txt` per set of debug recordings or
screenshots) and cuts every tooltip line (title and lines, matched to the detector box with the same text and
position) from its frame. Writes `<out>/crops/<set>/<frame>_<k>.png` and `<out>/index.tsv` (file, set, frame, k,
kind, box, score, frame size, the line's text as read). The labels come from elsewhere: `ocr-eval-label.ts`
(Quartermaster's catalog and language pack) turns index.tsv into `labels.tsv` (header: file, set, source, d,
label, read), the line dataset sc-ohseearr's `training/rec` evaluates on (recipe sc-rec-latin, set `gear`).

Python only through the uv venv (from the repository root):
  local/detector/.venv/Scripts/python.exe -I tools/dataset-export/gear_lines.py --dumps <dir> [--out local/ocr-eval]
      [--set <name>=<image folder>]...
Without --set: the sets of 2026-10-31 (three gear recordings, three screenshot folders under local/).
"""
import argparse
import math
import os
import re
import sys
import statistics

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOCAL = os.path.join(ROOT, "local")
REC = os.path.join(LOCAL, "stock_scan_debug", "qm-inventory-debug-")
DEFAULT_SETS = {"2503": REC + "1793452503", "4173": REC + "1793454173", "8932": REC + "1793448932",
                "inv1": os.path.join(LOCAL, "screenshots", "inventory"),
                "inv3": os.path.join(LOCAL, "screenshots", "inventory 3"),
                "inv4": os.path.join(LOCAL, "screenshots", "inventory 4")}
BOX = re.compile(r"^\s*(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(-?\d+\.\d+)\s{2}(.*)$")
LINE = re.compile(r"^\s*(-?\d+)\s+(-?\d+)\s{2}(.*)$")


def imread(p):
    return cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)


def frames_of(dump: str) -> list[dict]:
    """The frames of a components_dump output: name, title, lines (x, y, text), boxes (x, y, w, h, score, text)."""
    frames, cur = [], None
    for ln in open(dump, encoding="utf-8").read().split("\n"):
        ln = ln.rstrip("\r")
        if ln.startswith("== "):
            cur = {"name": ln[3:].split(": page", 1)[0], "title": None, "lines": [], "boxes": [], "mode": "head"}
            frames.append(cur)
            continue
        if cur is None:
            continue
        if ln.strip() == "boxes:":
            cur["mode"] = "boxes"
            continue
        if cur["mode"] == "head":
            if ln.startswith("  title: "):
                cur["title"] = ln[9:]
            elif ln.strip() == "no tooltip" or ln.startswith("  phases:"):
                pass
            else:
                m = LINE.match(ln)
                if m and cur["title"] is not None:
                    cur["lines"].append((int(m[1]), int(m[2]), m[3]))
        else:
            m = BOX.match(ln)
            if m:
                cur["boxes"].append((int(m[1]), int(m[2]), int(m[3]), int(m[4]), m[5], m[6]))
    return frames


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dumps", required=True, help="folder with components_dump-<set>.txt")
    ap.add_argument("--out", default=os.path.join(LOCAL, "ocr-eval"))
    ap.add_argument("--set", action="append", default=[], metavar="NAME=FOLDER")
    a = ap.parse_args()
    sets = dict(s.split("=", 1) for s in a.set) or DEFAULT_SETS
    rows, report = [], {}
    for st, folder in sets.items():
        frames = frames_of(os.path.join(a.dumps, f"components_dump-{st}.txt"))
        nf = nc = unmatched = 0
        hs, examples = [], []
        os.makedirs(os.path.join(a.out, "crops", st), exist_ok=True)
        for f in frames:
            if f["title"] is None:
                continue
            img = None
            for ext in (".jpg", ".png"):
                p = os.path.join(folder, f["name"] + ext)
                if os.path.exists(p):
                    img = imread(p)
                    break
            if img is None:
                examples.append(f"no image {f['name']}")
                unmatched += 1 + len(f["lines"])
                continue
            nf += 1
            H, W = img.shape[:2]
            used, k = set(), 0
            want = [("title", f["title"], None, None)] + [("line", t, x, y) for x, y, t in f["lines"]]
            for kind, text, x, y in want:
                cands = [i for i, b in enumerate(f["boxes"]) if b[5] == text and i not in used and
                         (kind == "title" or (abs(b[0] - x) <= 1 and abs(b[1] - y) <= 1))]
                if kind == "title":
                    cands.sort(key=lambda i: f["boxes"][i][1])
                if not cands:
                    unmatched += 1
                    if len(examples) < 8:
                        why = "no box with that text" if not any(b[5] == text for b in f["boxes"]) else "text found but position differs"
                        examples.append(f"{st}/{f['name']} {kind} {text!r}: {why}")
                    continue
                i = cands[0]
                used.add(i)
                bx, by, bw, bh, sc, _ = f["boxes"][i]
                x0, y0 = max(0, math.floor(bx)), max(0, math.floor(by))
                x1, y1 = min(W, math.ceil(bx + bw)), min(H, math.ceil(by + bh))
                if x1 <= x0 or y1 <= y0:
                    unmatched += 1
                    examples.append(f"{st}/{f['name']} empty crop")
                    continue
                fn = f"crops/{st}/{f['name']}_{k}.png"
                cv2.imencode(".png", img[y0:y1, x0:x1])[1].tofile(os.path.join(a.out, fn))
                rows.append([fn, st, f["name"], k, kind, bx, by, bw, bh, sc, W, H, text.replace("\t", " ")])
                hs.append(y1 - y0)
                nc += 1
                k += 1
        report[st] = (nf, nc, unmatched, (min(hs), statistics.median(hs), max(hs)) if hs else None, examples)
    with open(os.path.join(a.out, "index.tsv"), "w", encoding="utf-8", newline="") as o:
        o.write("\t".join("file set frame k kind x0 y0 w h score frame_w frame_h text".split()) + "\n")
        for r in rows:
            o.write("\t".join(map(str, r)) + "\n")
    for st, (nf, nc, unmatched, heights, examples) in report.items():
        print(f"{st}: {nf} frames, {nc} lines, {unmatched} unmatched, heights (min, median, max) {heights}")
        for e in examples:
            print("   ", e)


if __name__ == "__main__":
    main()
