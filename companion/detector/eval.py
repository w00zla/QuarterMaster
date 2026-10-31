"""Misst den Layout-Detektor (ONNX) auf den Validierungs-Ausschnitten: Treffer je Klasse gegen die
Labels (IoU ≥ 0.5) und Zeit pro Lauf auf der CPU (Threads wie in der App); dazu tiny-Det auf der
Eingabegröße, die die App heute für denselben Bereich nimmt (zum Vergleich).
Aufruf: eval.py <model.onnx> <data dir> [--scale f] [--threads n] [--tiny det-tiny.onnx]
--scale: die Ausschnitte vor dem Lauf verkleinern (z. B. 0.75 = 540 statt 720 px Frame-Höhe).
"""
import argparse, json, os, time
import cv2
import numpy as np
import onnxruntime as ort

CLASSES = ["badge", "quality", "title", "tipline"]
STRIDES = [8, 16, 32, 64]
REG_MAX = 7
MEAN = np.array([103.53, 116.28, 123.675], np.float32)
STD = np.array([57.375, 57.12, 58.395], np.float32)


def session(path, threads):
    o = ort.SessionOptions()
    o.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    o.intra_op_num_threads = threads
    return ort.InferenceSession(path, o, providers=["CPUExecutionProvider"])


def priors(w, h):
    out = []
    for s in STRIDES:
        fw, fh = -(-w // s), -(-h // s)
        ys, xs = np.mgrid[0:fh, 0:fw]
        out.append(np.stack([xs.ravel() * s, ys.ravel() * s, np.full(fw * fh, s)], 1))
    return np.concatenate(out).astype(np.float32)


def decode(out, pri, thr=0.35, iou=0.5):
    """NanoDet-Plus-Ausgabe [N, C + 4·(REG_MAX+1)] -> [(class, score, x0, y0, x1, y1)] nach NMS je Klasse."""
    nc = len(CLASSES)
    scores, reg = out[:, :nc], out[:, nc:].reshape(-1, 4, REG_MAX + 1)
    cls = scores.argmax(1)
    sc = scores.max(1)
    keep = sc >= thr
    if not keep.any():
        return []
    reg = reg[keep]
    e = np.exp(reg - reg.max(2, keepdims=True))
    dist = (e / e.sum(2, keepdims=True) * np.arange(REG_MAX + 1)).sum(2) * pri[keep, 2:3]
    cx, cy = pri[keep, 0], pri[keep, 1]
    boxes = np.stack([cx - dist[:, 0], cy - dist[:, 1], cx + dist[:, 2], cy + dist[:, 3]], 1)
    res = []
    for c in range(nc):
        m = cls[keep] == c
        if not m.any():
            continue
        b, s = boxes[m], sc[keep][m]
        idx = cv2.dnn.NMSBoxes([[float(x0), float(y0), float(x1 - x0), float(y1 - y0)] for x0, y0, x1, y1 in b], s.tolist(), thr, iou)
        for i in np.array(idx).ravel():
            res.append((c, float(s[i]), *map(float, b[i])))
    return res


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy
    return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("model")
    p.add_argument("data")
    p.add_argument("--scale", type=float, default=1.0)
    p.add_argument("--threads", type=int, default=3)
    p.add_argument("--tiny")
    a = p.parse_args()
    sess = session(a.model, a.threads)
    inp = sess.get_inputs()[0]
    _, _, H, W = inp.shape
    pri = priors(W, H)
    coco = json.load(open(os.path.join(a.data, "val.json")))
    gts = {}
    for an in coco["annotations"]:
        x, y, w, h = an["bbox"]
        gts.setdefault(an["image_id"], []).append((an["category_id"] - 1, x, y, x + w, y + h))
    tp, fp, fn = np.zeros(4, int), np.zeros(4, int), np.zeros(4, int)
    times = []
    for im in coco["images"]:
        img = cv2.imread(os.path.join(a.data, "val", im["file_name"]))
        # Auf die Modellgröße: --scale verkleinert den Inhalt, der Rest bleibt schwarz
        sw, sh = int(round(img.shape[1] * a.scale)), int(round(img.shape[0] * a.scale))
        canvas = np.zeros((H, W, 3), np.uint8)
        small = cv2.resize(img, (sw, sh), interpolation=cv2.INTER_AREA)
        canvas[:min(sh, H), :min(sw, W)] = small[:H, :W]
        x = ((canvas.astype(np.float32) - MEAN) / STD).transpose(2, 0, 1)[None]
        t0 = time.perf_counter()
        out = sess.run(None, {inp.name: x})[0][0]
        times.append(time.perf_counter() - t0)
        dets = [(c, s, x0 / a.scale, y0 / a.scale, x1 / a.scale, y1 / a.scale) for c, s, x0, y0, x1, y1 in decode(out, pri)]
        gt = gts.get(im["id"], [])
        matched = set()
        for c, s, *b in sorted(dets, key=lambda d: -d[1]):
            best = max(((iou(b, g[1:]), j) for j, g in enumerate(gt) if g[0] == c and j not in matched), default=(0, None))
            if best[0] >= 0.5:
                matched.add(best[1])
                tp[c] += 1
            else:
                fp[c] += 1
        for j, g in enumerate(gt):
            if j not in matched:
                fn[g[0]] += 1
    t = np.array(times[3:]) * 1000
    print(f"{os.path.basename(a.model)} {W}x{H} scale {a.scale}: {len(times)} images, {np.median(t):.1f} ms median, {np.percentile(t, 90):.1f} ms p90 ({a.threads} threads)")
    for c, n in enumerate(CLASSES):
        print(f"  {n:8s} recall {tp[c] / max(tp[c] + fn[c], 1):.3f}  precision {tp[c] / max(tp[c] + fp[c], 1):.3f}  (tp {tp[c]}, fp {fp[c]}, fn {fn[c]})")
    if a.tiny:
        # tiny-Det auf der Eingabe, die die App heute für denselben Bereich nimmt: 480×320 bei 720 px
        # Frame-Höhe = 1600×1067 bei 2400 px (DET_HEIGHT), auf Vielfache von 32
        ts = session(a.tiny, a.threads)
        ti = ts.get_inputs()[0]
        x = np.random.rand(1, 3, 1088, 1600).astype(np.float32)
        tt = []
        for _ in range(8):
            t0 = time.perf_counter()
            ts.run(None, {ti.name: x})
            tt.append(time.perf_counter() - t0)
        print(f"tiny det 1600x1088: {np.median(tt[2:]) * 1000:.1f} ms median ({a.threads} threads)")


if __name__ == "__main__":
    main()
