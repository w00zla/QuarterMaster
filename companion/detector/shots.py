"""Der Detektor auf fremden Screenshots (ohne Labels): Frame auf 720 px Höhe, 480×320-Fenster über
das Warehouse-Pane, Treffer in Klassenfarbe. Aufruf: shots.py <model.onnx> <out.png> <image>..."""
import os, sys
import cv2
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from eval import MEAN, STD, decode, priors, session

CLASSES = ["badge", "quality", "title", "tipline"]

COLORS = [(0, 255, 255), (255, 0, 255), (0, 255, 0), (255, 160, 0)]
model, out, images = sys.argv[1], sys.argv[2], sys.argv[3:]
sess = session(model, 3)
inp = sess.get_inputs()[0]
_, _, H, W = inp.shape
pri = priors(W, H)
sheets = []
for path in images:
    f = cv2.imread(path)
    k = 720 / f.shape[0]
    f = cv2.resize(f, (int(f.shape[1] * k), 720), interpolation=cv2.INTER_AREA)
    x0s = range(int(0.45 * f.shape[1]), f.shape[1] - W + 1, W - 40)
    y0s = range(int(0.25 * 720), int(0.95 * 720) - H + 1, H - 40) or [int(0.25 * 720)]
    for y0 in y0s:
        for x0 in x0s:
            c = f[y0:y0 + H, x0:x0 + W]
            x = ((c.astype(np.float32) - MEAN) / STD).transpose(2, 0, 1)[None]
            for cls, s, bx0, by0, bx1, by1 in decode(sess.run(None, {inp.name: x})[0][0], pri):
                cv2.rectangle(f, (int(x0 + bx0), int(y0 + by0)), (int(x0 + bx1), int(y0 + by1)), COLORS[cls], 1)
    pane = f[int(0.25 * 720):int(0.95 * 720), int(0.45 * f.shape[1]):]
    cv2.putText(pane, os.path.basename(path), (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
    sheets.append(pane)
w = max(s.shape[1] for s in sheets)
cv2.imwrite(out, np.vstack([cv2.copyMakeBorder(s, 0, 4, 0, w - s.shape[1], cv2.BORDER_CONSTANT) for s in sheets]))
