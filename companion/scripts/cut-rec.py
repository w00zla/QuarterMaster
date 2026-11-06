"""Schneidet den Ausgabekopf von PP-OCRv6 tiny rec (6906 Klassen, fast nur CJK) auf lateinische Schrift:
CTC-Blank, ASCII, Latin-1, Latin-Ext-A (polnische, tschechische Packs), μ, ▲▼ und das Leerzeichen. Die
letzte MatMul (80 × Klassen) und ihr Bias verlieren die übrigen Spalten; das Softmax danach verteilt
über die verbliebenen Klassen, ihre Reihenfolge (argmax) bleibt. Auf der GPU hielt jede Breiten-Session
die Ausgaben über alle 6906 Klassen (~240 MB VRAM beim Gear-Scan, 2026-10-31). Eingabe ist der Download von
fetch-ocr-models.mjs. Das Wörterbuch geht nach ../sc-ohseearr/models/sc-rec-latin/dict.txt (in git dort, der Zeichensatz der App); das geschnittene
Modell nach local/ocr-train/: die App liest dort das Fine-Tuning auf der Spielschrift (ocrtrain/), das
geschnittene Modell ist dessen Lehrer (teacher_crops.py) und Vergleich.
Aufruf (Python nur über die venv): local/detector/.venv/Scripts/python.exe -I scripts/cut-rec.py
"""
import os
import numpy as np
import onnx
import onnxruntime as ort
from onnx import numpy_helper

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "../src-tauri/resources/ocr")
DST = os.path.join(HERE, "../../sc-ohseearr/models/sc-rec-latin")
MODEL_DST = os.path.join(HERE, "../local/ocr-train")


def kept(ch):
    o = ord(ch)
    # ▲▼: die Tooltips markieren bessere/schlechtere Werte damit (sonst als "A" gelesen)
    return 0x20 < o < 0x7F or 0xA0 <= o < 0x180 or ch in "μ▲▼"


chars = [l.rstrip("\r\n") for l in open(os.path.join(SRC, "rec_dict-tiny.txt"), encoding="utf-8")]
# Klasse 0 = Blank, 1..n = Wörterbuch, n+1 = Leerzeichen
keep = [0] + [i + 1 for i, c in enumerate(chars) if kept(c)] + [len(chars) + 1]

m = onnx.load(os.path.join(SRC, "rec-tiny.onnx"))
inits = {i.name: i for i in m.graph.initializer}
matmul = next(n for n in m.graph.node if n.op_type == "MatMul" and n.name == "MatMul.1")
add = next(n for n in m.graph.node if n.name == "Add.106")
for name in [next(i for i in matmul.input if i in inits), next(i for i in add.input if i in inits)]:
    a = numpy_helper.to_array(inits[name])
    assert a.shape[-1] == len(chars) + 2, (name, a.shape)
    inits[name].CopyFrom(numpy_helper.from_array(a[..., keep].copy(), name))
# Die Klassenzahl auch in den gespeicherten Formen der Zwischenergebnisse (sonst warnt ONNX Runtime)
for v in list(m.graph.value_info) + list(m.graph.output):
    dims = v.type.tensor_type.shape.dim
    if dims and dims[-1].dim_value == len(chars) + 2:
        dims[-1].dim_value = len(keep)
os.makedirs(MODEL_DST, exist_ok=True)
out = os.path.join(MODEL_DST, "rec-tiny-latin-cut.onnx")
onnx.save(m, out)
with open(os.path.join(DST, "dict.txt"), "w", encoding="utf-8", newline="\n") as f:
    f.write("".join(chars[i - 1] + "\n" for i in keep[1:-1]))

# Prüfung: die Wahrscheinlichkeiten des Schnitts = die des Originals über die behaltenen Klassen, neu normiert
x = np.random.default_rng(0).random((2, 3, 48, 320), np.float32) * 2 - 1
run = lambda p: ort.InferenceSession(p, providers=["CPUExecutionProvider"]).run(None, {"x": x})[0]
full, cut = run(os.path.join(SRC, "rec-tiny.onnx")), run(out)
ref = full[..., keep] / full[..., keep].sum(-1, keepdims=True)
assert np.allclose(cut, ref, atol=1e-5), np.abs(cut - ref).max()
print(f"{len(keep)} Klassen ({len(keep) - 2} Zeichen), {os.path.getsize(out)} Bytes, max. Abweichung {np.abs(cut - ref).max():.2e}")
