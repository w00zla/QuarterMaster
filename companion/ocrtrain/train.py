"""Fine-Tuning des HF-Ports von PP-OCRv6 tiny rec (320 Klassen) mit CTC auf synthetischen Zeilen.
local/detector/.venv/Scripts/python.exe -I companion/ocrtrain/train.py --data synth [--data more] --out run1 [--epochs 10] [--lr 1e-4] [--bs 128] [--train-bn]
Nach jeder Epoche: synth-val und eine feste Stichprobe der echten Zeilen (eval.py); das beste Modell
nach der echten Zeichenfehlerrate wird als <out>/best.pt gespeichert, jede Epoche als <out>/last.pt."""
import argparse, json, math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2
import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset
import common
import eval as ev

DATA = os.path.join(common.ROOT, "local", "ocr-train")  # Datensätze und Läufe, relativ dazu


class Lines(Dataset):
    def __init__(self, dirs: list[str]):
        self.items = []
        for d in dirs:
            for r in common.read_tsv(os.path.join(DATA, d, "labels.tsv"), ["file", "label"]):
                label = r["label"].replace("μ", "µ")
                ids = common.encode(label)
                if ids:
                    self.items.append((os.path.join(DATA, d, r["file"]), ids))

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        path, ids = self.items[i]
        return common.prep(cv2.imread(path)), ids


def collate(b):
    x = common.batch([a for a, _ in b])
    targets = torch.tensor([i for _, ids in b for i in ids], dtype=torch.long)
    lengths = torch.tensor([len(ids) for _, ids in b], dtype=torch.long)
    return x, targets, lengths


def freeze_bn(model):
    """BatchNorm-Statistiken und -Gewichte bleiben wie vortrainiert (die echten Bilder, nicht die synthetischen)."""
    for m in model.modules():
        if isinstance(m, (torch.nn.BatchNorm1d, torch.nn.BatchNorm2d)):
            m.eval()
            for p in m.parameters():
                p.requires_grad_(False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", action="append", required=True)
    ap.add_argument("--val", default="synth-val")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--bs", type=int, default=128)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--train-bn", action="store_true")
    ap.add_argument("--real", type=int, default=3000, help="echte Zeilen für die Auswahl des besten Modells")
    a = ap.parse_args()
    out = os.path.join(DATA, a.out)
    os.makedirs(out, exist_ok=True)
    dev = "cuda"
    model = common.load_model().to(dev)
    data = Lines(a.data)
    loader = DataLoader(data, batch_size=a.bs, shuffle=True, num_workers=a.workers, collate_fn=collate, drop_last=True, persistent_workers=True)
    opt = torch.optim.AdamW([p for p in model.parameters()], lr=a.lr, weight_decay=1e-4)
    steps = a.epochs * len(loader)
    warm = len(loader) // 2
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / steps))))
    ctc = torch.nn.CTCLoss(blank=0, zero_infinity=True)
    real_rows = ev.eval_rows(a.real, seed=123)
    val_rows = [{"file": r["file"], "label": r["label"], "source": "synth"} for r in common.read_tsv(os.path.join(DATA, a.val, "labels.tsv"), ["file", "label"])][:2000]
    # Lager- und Raffinerie-Zeilen mit den Lesungen des Modells vor dem Fine-Tuning: nichts verlernen
    TEACH = f"{common.ROOT}/local/ocr-eval-teacher"
    teach_rows = [r for r in common.read_tsv(f"{TEACH}/labels.tsv") if common.encode(r["label"]) is not None]

    def evaluate():
        model.eval()
        def read(xs):
            with torch.no_grad():
                return [common.decode(p) for p in common.logits(model, common.batch(xs).to(dev)).cpu().numpy()]
        real = ev.report(real_rows, ev.run(read, real_rows))
        old = ev.EVAL
        ev.EVAL = os.path.join(DATA, a.val)
        synth = ev.report(val_rows, ev.run(read, val_rows))
        ev.EVAL = TEACH
        teach = ev.report(teach_rows, ev.run(read, teach_rows))
        ev.EVAL = old
        return real, synth, teach

    real, synth, teach = evaluate()
    log = [{"epoch": 0, "real": real, "synth": synth, "teacher": teach}]
    print(f"epoch 0  real {ev.show(real)}\n  synth {ev.show(synth)}\n  teacher {ev.show(teach)}", flush=True)
    score = lambda real, teach: real["all"]["cer"] + teach["all"]["cer"]
    best = score(real, teach)
    for epoch in range(1, a.epochs + 1):
        model.train()
        if not a.train_bn:
            freeze_bn(model)
        t0, total, n = time.time(), 0.0, 0
        for x, targets, lengths in loader:
            x = x.to(dev, non_blocking=True)
            lp = common.logits(model, x).log_softmax(2).permute(1, 0, 2)  # T, N, C
            in_len = torch.full((x.shape[0],), lp.shape[0], dtype=torch.long)
            loss = ctc(lp, targets.to(dev), in_len.to(dev), lengths.to(dev))
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step()
            sched.step()
            total += loss.item()
            n += 1
        real, synth, teach = evaluate()
        log.append({"epoch": epoch, "loss": total / n, "real": real, "synth": synth, "teacher": teach})
        print(f"epoch {epoch}  loss {total / n:.4f}  {time.time() - t0:.0f} s  lr {sched.get_last_lr()[0]:.2e}\n  real {ev.show(real)}\n  synth {ev.show(synth)}\n  teacher {ev.show(teach)}", flush=True)
        torch.save(model.state_dict(), os.path.join(out, "last.pt"))
        if score(real, teach) < best:
            best = score(real, teach)
            torch.save(model.state_dict(), os.path.join(out, "best.pt"))
            print(f"  best so far (real + teacher cer {best:.4f})", flush=True)
        json.dump(log, open(os.path.join(out, "log.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
