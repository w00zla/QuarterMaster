"""Kontaktbogen der Fehler: Validierungs-Ausschnitte mit Fehltreffern (rot) und Verfehlten (weiß),
Treffer dünn in Klassenfarbe. Aufruf: errors.py <model.onnx> <data dir> <out.png> [n]"""
import json, os, sys
import cv2
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from eval import CLASSES, MEAN, STD, decode, iou, priors, session

COLORS = [(0, 255, 255), (255, 0, 255), (0, 255, 0), (255, 160, 0)]
model, data, out = sys.argv[1:4]
n = int(sys.argv[4]) if len(sys.argv) > 4 else 6
sess = session(model, 3)
inp = sess.get_inputs()[0]
_, _, H, W = inp.shape
pri = priors(W, H)
coco = json.load(open(os.path.join(data, "val.json")))
gts = {}
for an in coco["annotations"]:
    x, y, w, h = an["bbox"]
    gts.setdefault(an["image_id"], []).append((an["category_id"] - 1, x, y, x + w, y + h))
bad = []
for im in coco["images"]:
    img = cv2.imread(os.path.join(data, "val", im["file_name"]))
    x = ((img.astype(np.float32) - MEAN) / STD).transpose(2, 0, 1)[None]
    dets = decode(sess.run(None, {inp.name: x})[0][0], pri)
    gt = gts.get(im["id"], [])
    matched, errs = set(), 0
    for c, s, *b in sorted(dets, key=lambda d: -d[1]):
        best = max(((iou(b, g[1:]), j) for j, g in enumerate(gt) if g[0] == c and j not in matched), default=(0, None))
        if best[0] >= 0.5:
            matched.add(best[1])
            cv2.rectangle(img, (int(b[0]), int(b[1])), (int(b[2]), int(b[3])), COLORS[c], 1)
        else:
            errs += 1
            cv2.rectangle(img, (int(b[0]), int(b[1])), (int(b[2]), int(b[3])), (0, 0, 255), 2)
            cv2.putText(img, f"{CLASSES[c]} {s:.2f}", (int(b[0]), int(b[1]) - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 255), 1)
    for j, g in enumerate(gt):
        if j not in matched:
            errs += 1
            cv2.rectangle(img, (int(g[1]), int(g[2])), (int(g[3]), int(g[4])), (255, 255, 255), 2)
            cv2.putText(img, f"miss {CLASSES[g[0]]}", (int(g[1]), int(g[4]) + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 255), 1)
    cv2.putText(img, im["file_name"], (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
    bad.append((errs, img))
bad.sort(key=lambda b: -b[0])
tiles = [b[1] for b in bad[:n]]
cv2.imwrite(out, np.vstack([np.hstack(tiles[i:i + 2]) for i in range(0, len(tiles), 2)]))
print("errors per image (worst first):", [b[0] for b in bad[:n]], "total", sum(b[0] for b in bad))
