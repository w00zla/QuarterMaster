# Aufruf vom Repo-Root: local/detector/.venv/Scripts/python.exe -I companion/ocrtrain/make_crops.py --dumps <Ordner mit components_dump-<Set>.txt>
import re, os, math, statistics, sys, argparse
import cv2, numpy as np
ap = argparse.ArgumentParser()
ap.add_argument("--dumps", required=True, help="Ordner mit components_dump-<Set>.txt")
D = ap.parse_args().dumps
R = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "local")
S = R + r"\stock_scan_debug\qm-inventory-debug-"
SETS = {"2503": S+"1793452503", "4173": S+"1793454173", "8932": S+"1793448932",
        "inv1": R+r"\screenshots\inventory", "inv3": R+r"\screenshots\inventory 3", "inv4": R+r"\screenshots\inventory 4"}
OUT = R + r"\ocr-eval"
BOX = re.compile(r"^\s*(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(-?\d+\.\d+)\s{2}(.*)$")
LINE = re.compile(r"^\s*(-?\d+)\s+(-?\d+)\s{2}(.*)$")
rows = []; report = {}
def imread(p):
    return cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)
for st, folder in SETS.items():
    frames = []; cur = None
    for ln in open(f"{D}/components_dump-{st}.txt", encoding="utf-8").read().split("\n"):
        ln = ln.rstrip("\r")
        if ln.startswith("== "):
            cur = {"name": ln[3:].split(": page", 1)[0], "title": None, "lines": [], "boxes": [], "mode": "head"}
            frames.append(cur); continue
        if cur is None: continue
        if ln.strip() == "boxes:": cur["mode"] = "boxes"; continue
        if cur["mode"] == "head":
            if ln.startswith("  title: "): cur["title"] = ln[9:]
            elif ln.strip() == "no tooltip" or ln.startswith("  phases:"): pass
            else:
                m = LINE.match(ln)
                if m and cur["title"] is not None: cur["lines"].append((int(m[1]), int(m[2]), m[3]))
        else:
            m = BOX.match(ln)
            if m: cur["boxes"].append((int(m[1]), int(m[2]), int(m[3]), int(m[4]), m[5], m[6]))
    nf = nc = unm = 0; hs = []; ex = []
    os.makedirs(f"{OUT}\crops\{st}", exist_ok=True)
    for f in frames:
        if f["title"] is None: continue
        img = None
        for ext in (".jpg", ".png"):
            p = f"{folder}\{f['name']}{ext}"
            if os.path.exists(p): img = imread(p); break
        if img is None: ex.append(f"no image {f['name']}"); unm += 1 + len(f["lines"]); continue
        nf += 1; H, W = img.shape[:2]; used = set(); k = 0
        want = [("title", f["title"], None, None)] + [("line", t, x, y) for x, y, t in f["lines"]]
        for kind, text, x, y in want:
            cands = [i for i, b in enumerate(f["boxes"]) if b[5] == text and i not in used and
                     (kind == "title" or (abs(b[0]-x) <= 1 and abs(b[1]-y) <= 1))]
            if kind == "title": cands.sort(key=lambda i: f["boxes"][i][1])
            if not cands:
                unm += 1
                if len(ex) < 8: ex.append(f"{st}/{f['name']} {kind} {text!r}: " + ("no box with that text" if not any(b[5]==text for b in f["boxes"]) else "text found but position differs"))
                if kind == "title": pass
                else: continue
                continue
            i = cands[0]; used.add(i); bx, by, bw, bh, sc, _ = f["boxes"][i]
            x0 = max(0, math.floor(bx)); y0 = max(0, math.floor(by)); x1 = min(W, math.ceil(bx+bw)); y1 = min(H, math.ceil(by+bh))
            if x1 <= x0 or y1 <= y0: unm += 1; ex.append(f"{st}/{f['name']} empty crop"); continue
            fn = f"crops\{st}\{f['name']}_{k}.png"
            ok, buf = cv2.imencode(".png", img[y0:y1, x0:x1]); buf.tofile(f"{OUT}\{fn}")
            rows.append([fn.replace("\\", "/"), st, f["name"], k, kind, bx, by, bw, bh, sc, W, H, text.replace("\t", " ")])
            hs.append(y1-y0); nc += 1; k += 1
    report[st] = (nf, nc, unm, (min(hs), statistics.median(hs), max(hs)) if hs else None, ex)
with open(f"{OUT}\index.tsv", "w", encoding="utf-8", newline="") as o:
    o.write("\t".join("file set frame k kind x0 y0 w h score frame_w frame_h text".split()) + "\n")
    for r in rows: o.write("\t".join(map(str, r)) + "\n")
for st, v in report.items(): print(st, v)
