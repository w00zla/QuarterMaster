"""Warehouse debug recordings -> a COCO layout dataset (sc-ohseearr's `training/layout`, recipe
sc-warehouse-layout).

The labels come from what a recording already knows (the boxes of the text detector of the read that recorded
it, the fitted tiles, the tooltip), by the rules of that read (src-tauri/src/inventory.rs at the time):
  badge   - the light box "X 2" at a tile's top right (pixels, like badge_box)
  quality - the quality text "526Q" at a tile's bottom left
  title   - the tooltip's title line
  tipline - the tooltip's other text lines (capacity, chip name, chip quality, SCU, ...)
Every frame is scaled to a fixed height (VIRTUAL_H) and cut into windows of the size of the app's "around the
cursor" area: one like the app's, plus random ones in the pane. Validation: the last 20 % of each recording
(split in time: frames in a row look alike).
Only for recordings of the read before the layout detector (up to companion 1.3.1: every box with its text);
newer recordings hold the detector's own boxes ("[badge]", "[quality]", the tooltip's lines), not taken yet.

Python only through the uv venv (from the repository root):
  local/detector/.venv/Scripts/python.exe -I tools/dataset-export/warehouse_coco.py <out dir> <recording dir>...
      [--neg <dir>...] [--neg-val <dir>...]
--neg / --neg-val: screenshots without a warehouse (character inventory, refinery) as windows without labels, for
training / validation. Output: <out>/{train,val}.json and <out>/{train,val}/*.png.
"""
import glob
import json
import os
import random
import re
import sys

import cv2
import numpy as np

VIRTUAL_H = 720
CROP_W, CROP_H = 480, 320
RANDOM_CROPS = 2
NEGATIVE_CROPS = 4
VAL_SHARE = 0.2
STRONG_FIT = 6
MIN_VISIBLE = 0.6

# From inventory.rs
PANE_LEFT, READ_TOP, READ_BOTTOM = 0.45, 0.25, 0.95
AROUND = 1.6
TEXT_MIN_H, TEXT_MAX_H = 0.011, 0.032
BADGE_MAX_W = 0.06
QUALITY_BAND = (-0.08, 0.76, 0.55, 1.02)
BADGE_AREA = (0.66, -0.02, 1.06, 0.19)
BADGE_SEARCH = (0.55, -0.15, 1.12, 0.32)
BADGE_CONTRAST, BADGE_MIN_SHARE = 60, 0.25
BADGE_COVER = 0.05

CLASSES = ["badge", "quality", "title", "tipline"]


def part(t, f):
    w, h = t[2] - t[0], t[3] - t[1]
    return (t[0] + f[0] * w, t[1] + f[1] * h, t[0] + f[2] * w, t[1] + f[3] * h)


def rect(r):
    return (r["x0"], r["y0"], r["x1"], r["y1"])


def area(r):
    return max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])


def inter(a, b):
    return (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))


def covered(a, b):
    """The share of b that a covers."""
    return area(inter(a, b)) / max(area(b), 1e-6)


def contains(r, x, y):
    return r[0] <= x <= r[2] and r[1] <= y <= r[3]


def center(r):
    return ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)


def parse_quality(text):
    t = re.sub(r"[\s.\-:,]", "", text)
    if not t:
        return None
    last = t[-1]
    if last in "0123456789":
        digits, suffix = t, False
    elif last.isalpha() and last not in "xX":
        digits, suffix = t[:-1], True
    else:
        return None
    if not digits or len(digits) > 5 or not re.fullmatch(r"[0-9]+", digits) or digits.startswith("0"):
        return None
    v = int(digits)
    if suffix:
        return v if 1 <= v <= 1000 or (len(digits) == 4 and digits.endswith("0")) else None
    if len(digits) < 3:
        return None
    return v if v <= 1000 or (digits.endswith("0") and 1 <= int(digits[:-1]) <= 1000) else None


def parse_badge(text):
    t = re.sub(r"\s", "", text)
    if not t or t[0] not in "Xx×":
        return False
    rest = t[1:].translate(str.maketrans("Il|DOo", "111000"))
    return rest == "" or (re.fullmatch(r"[0-9]+", rest) is not None and len(rest) <= 4 and int(rest) >= 1)


def badge_box(frame, r):
    """The largest light 4-connected area in r (like badge_box in inventory.rs)."""
    h, w = frame.shape[:2]
    x0, y0 = int(min(max(r[0], 0), w - 1)), int(min(max(r[1], 0), h - 1))
    x1, y1 = int(min(max(r[2], 0), w)), int(min(max(r[3], 0), h))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    c = frame[y0:y1, x0:x1].astype(np.uint32)
    luma = (299 * c[..., 2] + 587 * c[..., 1] + 114 * c[..., 0]) // 1000
    lo, hi = int(luma.min()), int(luma.max())
    if hi - lo < BADGE_CONTRAST:
        return None
    light = (luma > (lo + hi) // 2).astype(np.uint8)
    n, _, stats, _ = cv2.connectedComponentsWithStats(light, connectivity=4)
    if n < 2:
        return None
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    bx, by, bw, bh = stats[i, 0], stats[i, 1], stats[i, 2], stats[i, 3]
    ch, cw = light.shape
    if bw < bh or bh < BADGE_MIN_SHARE * ch or bx == 0 or by == 0 or bx + bw == cw or by + bh == ch:
        return None
    return (x0 + bx, y0 + by, x0 + bx + bw, y0 + by + bh)


def frame_labels(j, frame):
    """A frame's label boxes in frame pixels: [(class, rect)]."""
    s = j["height"]
    g = j["grid"]
    boxes = [(rect(b["rect"]), b["text"]) for b in j["boxes"]]
    # The tiles over the whole height: the fit only knows fully visible rows, but cut-off rows carry badges and
    # qualities too
    fit = [rect(t["rect"]) for t in g["tiles"]]
    xs = sorted({(t[0], t[2]) for t in fit})
    top, th, py = min(t[1] for t in fit), fit[0][3] - fit[0][1], g["pitchY"]
    first = -int(np.ceil((top + th) / py))
    last = int(np.ceil((s - top) / py))
    tiles = [(x0, top + k * py, x1, top + k * py + th) for k in range(first, last + 1) for x0, x1 in xs]
    tip = g["tooltip"]
    tip_rect = None
    out = []
    used = set()
    text_sized = lambda r: TEXT_MIN_H * s <= r[3] - r[1] <= TEXT_MAX_H * s
    # Tooltip: the title sits at (x, y); the other lines below it within the panel's width and at most three
    # lines deep (the area in the JSON includes badges and qualities under and behind the tooltip: those are no
    # tooltip lines)
    if tip:
        title = next((i for i, (r, t) in enumerate(boxes) if abs(r[0] - tip["x"]) < 0.5 and abs(r[1] - tip["y"]) < 0.5), None)
        # Without a read title the read of the time took the chip's name: the topmost text line above it, left
        # aligned with it, is the title
        while title is not None:
            tr = boxes[title][0]
            line = tr[3] - tr[1]
            above = [i for i, (r, t) in enumerate(boxes) if r[1] < tr[1] - 0.5 * line and r[1] > tr[1] - 3.5 * line and abs(r[0] - tr[0]) < 1.5 * line and sum(c.isalpha() for c in t) >= 3 and not parse_badge(t)]
            if not above:
                break
            title = min(above, key=lambda i: boxes[i][0][1])
        if title is not None:
            tr = boxes[title][0]
            out.append(("title", tr))
            used.add(title)
            line = min(max(tr[3] - tr[1], TEXT_MIN_H * s), TEXT_MAX_H * s)
            panel = (tr[0] - line, tr[1], tr[0] + 0.25 * s, tr[3] + 3.5 * line)
            tip_rect = tr
            for i, (r, t) in enumerate(boxes):
                tok = t.split()
                is_tile_text = parse_badge(t) or (tok and parse_quality(tok[0]) is not None and len(tok[0]) >= 4)
                if i not in used and t.strip() and covered(panel, r) > 0.8 and not is_tile_text:
                    out.append(("tipline", r))
                    used.add(i)
                    tip_rect = (min(tip_rect[0], r[0]), min(tip_rect[1], r[1]), max(tip_rect[2], r[2]), max(tip_rect[3], r[3]))
            # The tooltip's frame reaches a little beyond its texts
            pad = 0.012 * s
            tip_rect = (tip_rect[0] - pad, tip_rect[1] - pad, tip_rect[2] + pad, tip_rect[3] + pad)
    for tile in tiles:
        # Quality: a text of quality shape in the band at the bottom left, not behind the tooltip
        band = part(tile, QUALITY_BAND)
        for i, (r, t) in enumerate(boxes):
            tok = t.split()
            if i not in used and tok and text_sized(r) and contains(band, *center(r)) and parse_quality(tok[0]) is not None and not (tip_rect and covered(tip_rect, r) > 0.3):
                out.append(("quality", r))
                used.add(i)
        # Badge: the light box, around a detector box of badge size or in the badge area
        ba = part(tile, BADGE_AREA)
        search = part(tile, BADGE_SEARCH)
        near = [r for r, t in boxes if text_sized(r) and r[2] - r[0] <= BADGE_MAX_W * s and contains(search, *center(r))]
        near.sort(key=lambda r: abs(center(r)[0] - center(ba)[0]) + abs(center(r)[1] - center(ba)[1]))
        b = None
        if near:
            r = near[0]
            m = (r[3] - r[1]) * 0.5
            b = badge_box(frame, (r[0] - m, r[1] - m, r[2] + m, r[3] + m))
            # The pixels missed the box (a frame line, a light neighbour), but the text is a badge
            if b is None and any(parse_badge(t) for rr, t in boxes if rr == r):
                p = 0.15 * (r[3] - r[1])
                b = (r[0] - p, r[1] - p, r[2] + p, r[3] + p)
        b = b or badge_box(frame, ba) or badge_box(frame, search)
        if b and not (tip_rect and covered(tip_rect, b) > 0):
            out.append(("badge", b))
    return out


def crops(j, rng):
    """Windows (frame pixels) of the size of the cursor area: like the app's, plus random ones."""
    w, s = j["width"], j["height"]
    k = s / VIRTUAL_H
    cw, ch = CROP_W * k, CROP_H * k
    pane = (PANE_LEFT * w, READ_TOP * s, w, min(READ_BOTTOM * s, s))
    g = j["grid"]
    out = []
    if j.get("cursor"):
        cx, cy = j["cursor"]
        x0 = min(max(cx - AROUND * g["pitchX"], pane[0]), pane[2] - cw)
        y0 = min(max(cy - AROUND * g["pitchY"], pane[1]), pane[3] - ch)
        out.append((x0, y0, x0 + cw, y0 + ch))
    for _ in range(RANDOM_CROPS):
        x0 = rng.uniform(pane[0], pane[2] - cw)
        y0 = rng.uniform(pane[1], pane[3] - ch)
        out.append((x0, y0, x0 + cw, y0 + ch))
    return out


def negative_crops(path, rng, n):
    """Windows of a screenshot without a warehouse (character inventory, refinery): background only."""
    f = cv2.imread(path)
    k = VIRTUAL_H / f.shape[0]
    f = cv2.resize(f, (int(round(f.shape[1] * k)), VIRTUAL_H), interpolation=cv2.INTER_AREA)
    w = f.shape[1]
    out = []
    for _ in range(n):
        x0 = int(rng.uniform(PANE_LEFT * w, w - CROP_W))
        y0 = int(rng.uniform(READ_TOP * VIRTUAL_H, READ_BOTTOM * VIRTUAL_H - CROP_H))
        out.append(f[y0:y0 + CROP_H, x0:x0 + CROP_W])
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    args, neg = sys.argv[1:], {"train": [], "val": []}
    split = None
    rest = []
    for a in args:
        if a in ("--neg", "--neg-val"):
            split = "train" if a == "--neg" else "val"
        elif split:
            neg[split].append(a)
        else:
            rest.append(a)
    if len(rest) < 2:
        sys.exit(__doc__)
    out_dir, recs = rest[0], rest[1:]
    rng = random.Random(7)
    coco = {split: {"images": [], "annotations": [], "categories": [{"id": i + 1, "name": n} for i, n in enumerate(CLASSES)]} for split in ("train", "val")}
    counts = {split: {c: 0 for c in CLASSES} for split in coco}
    for split in coco:
        os.makedirs(os.path.join(out_dir, split), exist_ok=True)
    for rec in recs:
        files = sorted(glob.glob(os.path.join(rec, "read-*.json")), key=lambda p: int(p.rsplit("-", 1)[1][:-5]))
        reads = [(f, json.load(open(f, encoding="utf-8"))) for f in files]
        reads = [(f, j) for f, j in reads if j.get("grid") and j["grid"]["fitWeight"] >= STRONG_FIT]
        n_val = int(len(reads) * VAL_SHARE)
        for n, (f, j) in enumerate(reads):
            split = "val" if n >= len(reads) - n_val else "train"
            frame = cv2.imread(f[:-5] + ".jpg")
            labels = frame_labels(j, frame)
            k = VIRTUAL_H / j["height"]
            for c, crop in enumerate(crops(j, rng)):
                ix0, iy0 = int(round(crop[0])), int(round(crop[1]))
                ix1, iy1 = ix0 + int(round(CROP_W / k)), iy0 + int(round(CROP_H / k))
                img = cv2.resize(frame[iy0:iy1, ix0:ix1], (CROP_W, CROP_H), interpolation=cv2.INTER_AREA)
                name = f"{os.path.basename(rec)[-4:]}-{os.path.basename(f)[:-5]}-{c}.png"
                cv2.imwrite(os.path.join(out_dir, split, name), img)
                image_id = len(coco[split]["images"])
                coco[split]["images"].append({"id": image_id, "file_name": name, "width": CROP_W, "height": CROP_H})
                for cls, r in labels:
                    vis = inter(r, (ix0, iy0, ix1, iy1))
                    if area(r) == 0 or area(vis) / area(r) < MIN_VISIBLE:
                        continue
                    x0, y0 = (vis[0] - ix0) * k, (vis[1] - iy0) * k
                    bw, bh = (vis[2] - vis[0]) * k, (vis[3] - vis[1]) * k
                    coco[split]["annotations"].append({"id": len(coco[split]["annotations"]), "image_id": image_id, "category_id": CLASSES.index(cls) + 1, "bbox": [x0, y0, bw, bh], "area": bw * bh, "iscrowd": 0})
                    counts[split][cls] += 1
    for split, dirs in neg.items():
        for d in dirs:
            for path in sorted(glob.glob(os.path.join(d, "*.jpg"))):
                for c, img in enumerate(negative_crops(path, rng, NEGATIVE_CROPS)):
                    name = f"neg-{os.path.basename(d).replace(' ', '_')}-{os.path.basename(path)[:-4]}-{c}.png"
                    cv2.imwrite(os.path.join(out_dir, split, name), img)
                    coco[split]["images"].append({"id": len(coco[split]["images"]), "file_name": name, "width": CROP_W, "height": CROP_H})
    for split, data in coco.items():
        json.dump(data, open(os.path.join(out_dir, f"{split}.json"), "w"))
        print(split, len(data["images"]), "images", counts[split])


if __name__ == "__main__":
    main()
