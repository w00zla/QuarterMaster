"""Kontaktbogen: Ausschnitte mit ihren Label-Boxen. Aufruf: viz.py <data dir> <split> <out.png> [n] [seed]"""
import json, os, random, sys
import cv2
import numpy as np

COLORS = [(0, 255, 255), (255, 0, 255), (0, 255, 0), (255, 160, 0)]
data, split, out = sys.argv[1], sys.argv[2], sys.argv[3]
n = int(sys.argv[4]) if len(sys.argv) > 4 else 6
coco = json.load(open(os.path.join(data, f"{split}.json")))
by_img = {}
for a in coco["annotations"]:
    by_img.setdefault(a["image_id"], []).append(a)
imgs = random.Random(int(sys.argv[5]) if len(sys.argv) > 5 else 1).sample(coco["images"], n)
tiles = []
for im in imgs:
    img = cv2.imread(os.path.join(data, split, im["file_name"]))
    for a in by_img.get(im["id"], []):
        x, y, w, h = a["bbox"]
        cv2.rectangle(img, (int(x), int(y)), (int(x + w), int(y + h)), COLORS[a["category_id"] - 1], 1)
    cv2.putText(img, im["file_name"], (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
    tiles.append(img)
rows = [np.hstack(tiles[i:i + 2]) for i in range(0, len(tiles), 2)]
cv2.imwrite(out, np.vstack(rows))
