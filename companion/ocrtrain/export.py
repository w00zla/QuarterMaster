"""Exportiert ein Fine-Tuning (state_dict) nach ONNX wie das Original: Eingang x [N, 3, 48, W] mit benannten
dynamischen Dimensionen (die App fixiert sie für DirectML über diese Namen), Ausgang Wahrscheinlichkeiten [N, T, 320].
local/detector/.venv/Scripts/python.exe -I companion/ocrtrain/export.py <best.pt> <out.onnx>; prüft die Ausgabe gegen PyTorch."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import onnxruntime as ort
import torch
import common

ckpt, out = sys.argv[1], sys.argv[2]
model = common.Exported(common.load_model(ckpt).eval()).eval()
x = torch.from_numpy(np.random.default_rng(0).random((2, 3, 48, 640), np.float32) * 2 - 1)
torch.onnx.export(model, (x,), out, input_names=["x"], output_names=["softmax"], opset_version=17, dynamo=False,
                  dynamic_axes={"x": {0: "batch", 3: "width"}, "softmax": {0: "batch", 1: "steps"}})
s = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
for w in (320, 640, 1280):
    xi = torch.from_numpy(np.random.default_rng(w).random((3, 3, 48, w), np.float32) * 2 - 1)
    with torch.no_grad():
        ref = model(xi).numpy()
    got = s.run(None, {"x": xi.numpy()})[0]
    print(f"width {w}: shape {got.shape}, max |diff| {np.abs(got - ref).max():.2e}")
print("input", s.get_inputs()[0].name, s.get_inputs()[0].shape, "output", s.get_outputs()[0].shape, os.path.getsize(out), "bytes")
