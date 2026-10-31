"""Misst einen Erkenner auf den echten, gelabelten Zeilen (local/ocr-eval/labels.tsv).
local/detector/.venv/Scripts/python.exe -I companion/ocrtrain/eval.py onnx:<model.onnx> | hf | ckpt:<state_dict.pt>  [--limit n] [--errors k]
Gesamt, je Quelle (title/desc/stat) und für Zeilen mit "&"; μ und µ gelten als gleich."""
import argparse, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2
import numpy as np
import onnxruntime as ort
import torch
import common

EVAL = f"{common.ROOT}/local/ocr-eval"


def eval_rows(limit: int | None, seed: int = 0) -> list[dict]:
    rows = common.read_tsv(f"{EVAL}/labels.tsv")
    rows = [r for r in rows if common.encode(r["label"]) is not None]
    if limit:
        random.Random(seed).shuffle(rows)
        rows = rows[:limit]
    return rows


def reader(spec: str):
    if spec.startswith("onnx:"):
        s = ort.InferenceSession(spec[5:], providers=["CPUExecutionProvider"])
        return lambda xs: [common.decode(p) for p in s.run(None, {s.get_inputs()[0].name: common.batch(xs).numpy()})[0]]
    model = common.load_model(spec[5:] if spec.startswith("ckpt:") else None).eval()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(dev)

    def read(xs):
        with torch.no_grad():
            return [common.decode(p) for p in common.logits(model, common.batch(xs).to(dev)).cpu().numpy()]
    return read


def run(read, rows: list[dict], bs: int = 32) -> list[str]:
    """Liest die Zeilen in Stapeln ähnlicher Breite (wie die App); die Reihenfolge von rows bleibt."""
    arrays = [common.prep(cv2.imread(f"{EVAL}/{r['file']}")) for r in rows]
    order = sorted(range(len(rows)), key=lambda i: arrays[i].shape[2])
    out = [""] * len(rows)
    for k in range(0, len(order), bs):
        idx = order[k : k + bs]
        for i, t in zip(idx, read([arrays[i] for i in idx])):
            out[i] = t
    return out


def report(rows: list[dict], reads: list[str]) -> dict:
    fix = lambda s: s.replace("μ", "µ")
    pairs = [(fix(r["label"]), fix(t)) for r, t in zip(rows, reads)]
    res = {"all": common.metrics(pairs)}
    for src in ("title", "desc", "stat"):
        sel = [p for p, r in zip(pairs, rows) if r["source"] == src]
        if sel:
            res[src] = common.metrics(sel)
    amp = [p for p in pairs if "&" in p[0]]
    if amp:
        res["&"] = common.metrics(amp)
    return res


def show(res: dict) -> str:
    return "  ".join(f"{k}: n {v['n']} exact {v['exact']:.3f} nospace {v['nospace']:.3f} cer {v['cer']:.4f}" for k, v in res.items())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--errors", type=int, default=0)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    rows = eval_rows(a.limit)
    reads = run(reader(a.model), rows)
    for k, v in report(rows, reads).items():
        print(f"{k:6s} n {v['n']:6d}  exact {v['exact']:.3f}  nospace {v['nospace']:.3f}  cer {v['cer']:.4f}")
    errs = [(r["label"], t) for r, t in zip(rows, reads) if r["label"].replace(" ", "").replace("μ", "µ") != t.replace(" ", "").replace("μ", "µ")]
    for l, t in random.Random(1).sample(errs, min(a.errors, len(errs))):
        print(f"  {l!r} <- {t!r}")
