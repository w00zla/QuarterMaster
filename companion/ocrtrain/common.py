"""Gemeinsames fürs Fine-Tuning von PP-OCRv6 tiny rec: Wörterbuch (320 Klassen wie sc-ohseearr/models/sc-rec-latin), Vorverarbeitung
wie die App (BGR, Höhe 48, x/127.5-1, rechts mit 0 aufgefüllt, mindestens 320 breit), das HF-Modell mit auf die
320 Klassen geschnittenem Kopf (Logits ohne Softmax fürs Training), Dekodierung und Metriken."""
import csv
import os
import cv2
import numpy as np
import torch
import torch.nn.functional as F
from transformers import PPOCRV6TinyRecForTextRecognition
from transformers.models.pp_ocrv6_tiny_rec import modeling_pp_ocrv6_tiny_rec as hf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))).replace("\\", "/")
HF_REPO = "PaddlePaddle/PP-OCRv6_tiny_rec_safetensors"
H, MIN_W, MAX_W = 48, 320, 1920

_full = [l.rstrip("\r\n") for l in open(f"{ROOT}/src-tauri/resources/ocr/rec_dict-tiny.txt", encoding="utf-8")]
LATIN = [l.rstrip("\r\n") for l in open(f"{ROOT}/../sc-ohseearr/models/sc-rec-latin/dict.txt", encoding="utf-8")]
# Klassen: 0 = Blank, die Zeichen, zuletzt das Leerzeichen (wie die App)
CHARS = [""] + LATIN + [" "]
INDEX = {c: i for i, c in enumerate(CHARS) if c}
# Die Spalten des Originalkopfs (6906) für diese Klassen, wie cut-rec.py
KEEP = [0] + [_full.index(c) + 1 for c in LATIN] + [len(_full) + 1]


def _logits_forward(self, hidden_states, **kwargs):
    hidden_states = hidden_states.squeeze(2)
    hidden_states = self.act_fn(self.norm1(self.conv1(hidden_states)))
    hidden_states = self.act_fn(self.norm2(self.conv2(hidden_states)))
    return self.fc2(self.fc1(hidden_states.transpose(1, 2)))


# Der Kopf liefert Logits; Softmax erst beim Export (Wrapper unten)
hf.PPOCRV6TinyRecHead.forward = _logits_forward


def load_model(checkpoint: str | None = None) -> torch.nn.Module:
    """Das HF-Modell mit dem Kopf auf 320 Klassen; mit `checkpoint` dessen Gewichte (state_dict)."""
    m = PPOCRV6TinyRecForTextRecognition.from_pretrained(HF_REPO)
    fc2 = m.head.fc2
    new = torch.nn.Linear(fc2.in_features, len(KEEP))
    with torch.no_grad():
        new.weight.copy_(fc2.weight[KEEP])
        new.bias.copy_(fc2.bias[KEEP])
    m.head.fc2 = new
    if checkpoint:
        m.load_state_dict(torch.load(checkpoint, map_location="cpu"))
    return m


def logits(model, x):
    return model(x).last_hidden_state


class Exported(torch.nn.Module):
    """Für den ONNX-Export: Wahrscheinlichkeiten wie das Original."""
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, x):
        return F.softmax(logits(self.model, x), dim=2)


def prep(img_bgr: np.ndarray) -> np.ndarray:
    """Eine Zeile wie die App: Höhe 48, Breite nach Seitenverhältnis (aufgerundet), bilinear; CHW float."""
    h, w = img_bgr.shape[:2]
    nw = int(min(MAX_W, max(1, np.ceil(H * w / h))))
    x = cv2.resize(img_bgr, (nw, H), interpolation=cv2.INTER_LINEAR).astype(np.float32) / 127.5 - 1
    return x.transpose(2, 0, 1)


def batch(arrays: list[np.ndarray]) -> torch.Tensor:
    """Rechts mit 0 aufgefüllt auf die breiteste Zeile (mindestens 320), wie die App auf der CPU."""
    w = max(MIN_W, max(a.shape[2] for a in arrays))
    out = np.zeros((len(arrays), 3, H, w), np.float32)
    for i, a in enumerate(arrays):
        out[i, :, :, : a.shape[2]] = a
    return torch.from_numpy(out)


def encode(text: str) -> list[int] | None:
    """Klassenindizes eines Labels; None, wenn ein Zeichen fehlt."""
    try:
        return [INDEX[c] for c in text]
    except KeyError:
        return None


def decode(probs: np.ndarray) -> str:
    out, last = [], 0
    for i in probs.argmax(-1):
        if i != last and i != 0:
            out.append(CHARS[i])
        last = i
    return "".join(out)


def lev(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        for j in range(1, len(b) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1])))
        prev = cur
    return prev[-1]


def read_tsv(path: str, fields: list[str] | None = None) -> list[dict]:
    """Eine TSV-Datei; ohne Kopfzeile mit `fields`."""
    return list(csv.DictReader(open(path, encoding="utf-8"), fieldnames=fields, delimiter="\t", quoting=csv.QUOTE_NONE))


def metrics(pairs: list[tuple[str, str]]) -> dict:
    """pairs: (label, read). Zeilen exakt, ohne Leerzeichen gleich, Zeichenfehlerrate (ohne Leerzeichen)."""
    n = len(pairs)
    exact = sum(l == r for l, r in pairs)
    nospace = sum(l.replace(" ", "") == r.replace(" ", "") for l, r in pairs)
    errs = sum(lev(l.replace(" ", ""), r.replace(" ", "")) for l, r in pairs)
    chars = sum(len(l.replace(" ", "")) for l, _ in pairs)
    return {"n": n, "exact": exact / n, "nospace": nospace / n, "cer": errs / max(1, chars)}
