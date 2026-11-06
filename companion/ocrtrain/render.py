"""Synthetische Textzeilen im Look der Star-Citizen-Inventar-Tooltips (für das Fine-Tuning des PP-OCRv6-tiny-Recognizers).

Rendert in nativer Pixelgröße (wie der Detektor die Zeile aus dem Frame schneidet), NICHT auf 48 px skaliert:
das macht der Trainings-Loader wie die App.

  local/detector/.venv/Scripts/python.exe -I ocrtrain/render.py --n 100000 --out local/ocr-train/synth --seed 0 --pack <global.ini> [--mix v2] [--workers 14]
  local/detector/.venv/Scripts/python.exe -I ocrtrain/render.py --compare local/ocr-train/compare_synth.png --out local/ocr-train/synth   (Vergleichsbild synth vs. echt)

Nur lokal: Font (kommerziell) und Spieltexte bleiben in local/.
"""
import argparse, csv, glob, math, multiprocessing as mp, os, random, re, sys, time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))).replace("\\", "/")
LOCAL = ROOT + "/local"
FONT = LOCAL + "/fonts-sc/ttf/BlenderProMedium-Regular.ttf"
DICT = ROOT + "/../sc-ohseearr/models/sc-rec-latin/dict.txt"
INI_EN = None            # --pack: global.ini des Spielers (Sprachpaket, englisch)
INI_DE = LOCAL + "/localization/sc-deutsch/global.ini"
EVAL = LOCAL + "/ocr-eval"
BG_DIR = LOCAL + "/ocr-train/bg"
BG_SETS = {"2503": LOCAL + "/stock_scan_debug/qm-inventory-debug-1793452503",
           "8932": LOCAL + "/stock_scan_debug/qm-inventory-debug-1793448932"}

EMB_HSCALE = (0.90, 0.97)
EMB_STROKE = (0.012, 0.032)
SS = 4                 # Supersampling: ungehintet, Flächen-AA beim Herunterrechnen
CAP_PER_SIZE = 0.6     # Versalhöhe / Fontgröße der Blender Pro Medium (gemessen an "H")
TRI_UP, TRI_DOWN = "\u25b2", "\u25bc"

# Farben (RGB). Weiß aus den echten Crops (hellste 30 % der Tinte: 1080p ~214/209/203, 1600p ~227/223/219,
# kleine Schrift erreicht die Vollfarbe seltener); Grün aus inventory 4 (verbesserter Wert mit ▲);
# Rot ist geschätzt (kein Beispiel mit ▼ in den Daten).
WHITE = (229, 224, 219)
GREEN = (53, 223, 139)
RED = (226, 74, 66)

# --- Mix v2 (--mix v2): andere Fonts, Terminal (Raffinerie) in Gro\u00dfbuchstaben, Lager-Tags, farbige Werte
FONT_DIR = LOCAL + "/fonts-sc/ttf"
BG_REF_DIR = LOCAL + "/ocr-train/bg-ref"
REF_DIRS = [LOCAL + "/screenshots/refinery flow", LOCAL + "/screenshots/refinery flow 2", LOCAL + "/screenshots/refinery flow 3"]
REF_SKIP = ("22-41-13-D25", "22-41-18-130")                        # schr\u00e4g aufgenommen
REF_SCREEN = (816, 168, 3036, 1428)                                  # Bildschirm des Terminals (x0, y0, x1, y1) bei 3840\u00d71600
BLENDER = {"medium": "BlenderProMedium-Regular", "book": "BlenderProBook-Regular", "bold": "BlenderProBold-Bold",
           "heavy": "BlenderProHeavy-Regular", "thin": "BlenderProThin-Regular"}
CAPS_ONLY = {"Furore-Regular", "BlenderProHeavy-Regular"}   # Kleinbuchstaben sind dort Versalien: Label in Großbuchstaben
OTHER_FONTS = ["Aldrich-Regular", "AudimatMono-Regular", "AudimatMono-Bold", "BarlowCondensed-Regular",
               "BarlowCondensedSemiBold-Regular", "Capsuula-Regular", "Electrolize-Regular", "Furore-Regular",
               "Jura-Medium", "Michroma-Regular", "OpenSans-Regular", "Orbitron-Light", "Orbitron-Medium",
               "Outfit-Regular", "Outfit-Bold", "Quantico-Regular", "RalewayMedium-Regular", "TitilliumWeb-Regular",
               "TitilliumWebSemiBold-Regular"]
# Raffinerie-Terminal (RGB, gemessen in refinery flow*): Text wei\u00df/grau, Akzente orange, Ausbeute gelbgr\u00fcn/rot
TERM_WHITE = (234, 228, 232)
TERM_GREY = (152, 150, 152)
TERM_ORANGE = (222, 126, 60)
TERM_YELLOW = (173, 174, 82)
TERM_RED = (229, 91, 57)
TERM_BAR = (100, 92, 104)          # graue Kopfleiste ("// MATERIAL SPECIALIZATIONS")
TERM_RED_BAR = (150, 62, 52)       # rote Kopfleiste ("// REFINERY SYSTEM")
AMBER = (235, 175, 55)
# Lager-Tooltip (screenshots/inventory): Tags unten mit farbigem Grund, Kapazit\u00e4t gedimmt
TAG_COLOURS = [(71, 52, 102), (25, 95, 98), (84, 100, 65)]
DIM_CAP = (91, 103, 109)

CHAR_MAP = {"\u2019": "'", "\u2018": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-", "\u2014": "-",
            "\u2026": "...", "\u00a0": " ", "\t": " ", "\u03bc": "\u00b5"}


# ---------------------------------------------------------------- Texte

def load_charset():
    chars = [l.rstrip("\r\n") for l in open(DICT, encoding="utf-8")]
    return set(chars) | {" "}


def parse_ini(path):
    out = {}
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            eq = line.find("=")
            if eq <= 0:
                continue
            key = line[:eq].strip()
            if key.lower().endswith(",p"):
                key = key[:-2]
            out[key] = line[eq + 1:].rstrip("\r\n")
    return out


def clean(s, charset):
    """Spieltext -> Label im Zeichensatz des Modells, None wenn nicht abbildbar."""
    s = re.sub(r"<[^>]*>", "", s)
    for a, b in CHAR_MAP.items():
        s = s.replace(a, b)
    s = re.sub(r" +", " ", s).strip()
    if not s or "PLACEHOLDER" in s.upper() or "MISSING" in s:
        return None
    if any(c not in charset for c in s):
        return None
    return s


def corpus_from(ini, charset):
    names, paras = set(), set()
    for k, v in ini.items():
        kl = k.lower()
        if kl.startswith("item_name"):
            c = clean(v.replace("\\n", " "), charset)
            if c and 2 <= len(c) <= 60:
                names.add(c)
        elif kl.startswith("item_desc"):
            for p in v.split("\\n"):
                c = clean(p, charset)
                if c and len(c) >= 2:
                    paras.add(c)
    return sorted(names), sorted(paras)


def wrap(text, width):
    """Zeilenumbruch nach Zeichen wie der Tooltip; Wörter mit Bindestrich dürfen nach dem "-" brechen."""
    lines, cur, words, i = [], "", text.split(" "), 0
    while i < len(words):
        w = words[i]
        cand = w if not cur else cur + " " + w
        if len(cand) <= width:
            cur, i = cand, i + 1
            continue
        room = width - (len(cur) + 1 if cur else 0)
        cut = max((j for j, ch in enumerate(w[:-1]) if ch == "-" and j + 1 <= room), default=-1)
        if cut >= 0:
            head = w[:cut + 1]
            lines.append(head if not cur else cur + " " + head)
            cur, words[i] = "", w[cut + 1:]
        elif cur:
            lines.append(cur)
            cur = ""
        else:
            cur, i = w, i + 1      # überlanges Wort
    if cur:
        lines.append(cur)
    return lines


STAT_LABELS = ["Fire Rate", "Impact Force", "Recoil Kick", "Recoil Smoothness", "Recoil Handling", "Damage Mitigation",
               "Min Temp", "Max Temp", "Integrity", "Coolant Rating", "Power Pips", "Quantum Speed",
               "Max. Shield Strength", "Volume", "Temp. Rating", "Rate Of Fire", "Effective Range", "Magazine Size",
               "Carrying Capacity", "Quantum Fuel Burn", "Max. Assist Distance", "Damage Reduction",
               "Radiation Scrub Rate", "Power Draw", "Heat Generation", "EM Signature", "IR Signature"]
PCT_LABELS = {"Impact Force", "Recoil Kick", "Recoil Smoothness", "Recoil Handling", "Damage Mitigation"}


def stat_value(label, rng):
    """(Wert, darf Dreieck haben)"""
    r = rng.random
    def f2(lo, hi):
        return "%.2f" % rng.uniform(lo, hi)
    def sgn():
        return rng.choice("+-")
    if label in PCT_LABELS:
        v = "0.00" if r() < 0.3 else f2(0, 60)
        return f"{sgn()}{v} %", True
    if label == "Fire Rate":
        return (f"{f2(30, 1500)} RPM", True) if r() < 0.7 else (f"{rng.randint(30, 1500)} rpm", False)
    if label == "Rate Of Fire":
        if r() < 0.25:
            return f"{rng.randint(30, 900)} rpm / {rng.randint(300, 1500)} rpm", False
        return f"{rng.randint(30, 1500)} rpm", False
    if label in ("Min Temp", "Max Temp"):
        return (f"{sgn()}{f2(0, 300)}", False) if r() < 0.6 else (f"{rng.randint(-250, 300)} °C", False)
    if label == "Temp. Rating":
        return f"{rng.randint(-250, 0)} / {rng.randint(10, 300)} °C", False
    if label in ("Integrity", "Max. Shield Strength", "Coolant Rating", "Power Pips", "Power Draw",
                 "Heat Generation", "EM Signature", "IR Signature"):
        hi = rng.choice([30, 500, 5000, 100000])
        return (f2(0, hi) if r() < 0.8 else str(rng.randint(0, hi))), False
    if label == "Quantum Speed":
        return f"{f2(50, 400)} Mm/s", False
    if label in ("Volume", "Carrying Capacity"):
        x = r()
        if x < 0.4:
            v = str(rng.choice([1, 2, 5, 10, 25]) * 10 ** rng.randint(1, 5))
        elif x < 0.75:
            v = "%.1fK" % rng.uniform(1, 500)
        else:
            v = f"{rng.randint(1, 900)}{rng.choice(['k', 'K'])}"
        return f"{v} µSCU", False
    if label == "Effective Range":
        return f"{rng.randint(5, 3000)} m", False
    if label == "Magazine Size":
        return str(rng.randint(1, 300)), False
    if label == "Quantum Fuel Burn":
        return f"{f2(1, 200)} per Km", False
    if label == "Max. Assist Distance":
        return f"{f2(100, 3000)} M", False
    if label == "Damage Reduction":
        return f"{rng.randint(0, 90)}%", False
    if label == "Radiation Scrub Rate":
        return f"{rng.randint(1, 300)} REM/s", False
    return f2(0, 1000), False


STAT_LABELS_V2 = STAT_LABELS + ["Radiation Capacity", "Radiation Dissipation", "Radiation Protection", "Aim Time",
                                 "Damage Mitigation", "Min Temp", "Max Temp", "Spread", "Ammo Capacity", "Shield HP",
                                 "Regen Rate", "Cooling Rate", "Resistance", "Drive Speed", "Spool Time"]


def stat_value_v2(label, rng):
    """Wie stat_value, dazu die Formate gecrafteter Ausrüstung (inventory 4, 15-53-26): 0.30, -61.00 °C, 26400.00 mRem"""
    r = rng.random
    def f2(lo, hi):
        return "%.2f" % rng.uniform(lo, hi)
    if label == "Damage Mitigation" and r() < 0.5:
        return rng.choice(["0.%02d" % rng.randint(0, 99), f2(0, 3)]), False
    if label in ("Min Temp", "Max Temp") and r() < 0.5:
        return f"{rng.choice('+-')}{f2(0, 300)} °C", False
    if label == "Radiation Capacity":
        return f"{f2(0, 90000)} mRem", False
    if label == "Radiation Dissipation":
        return f"{f2(0, 900)} mRem/s", False
    if label == "Radiation Protection":
        return f"{rng.randint(0, 90000)} REM", False
    if label == "Radiation Scrub Rate" and r() < 0.5:
        return f"{'%.1f' % rng.uniform(0, 500)} REM/s", False
    if label in ("Aim Time", "Spread", "Resistance"):
        return f"{rng.choice('+-')}{rng.randint(0, 60)}%", False
    if label in ("Ammo Capacity", "Shield HP", "Regen Rate", "Cooling Rate", "Drive Speed", "Spool Time"):
        unit = {"Regen Rate": " /s", "Cooling Rate": " /s", "Drive Speed": " m/s", "Spool Time": " s"}.get(label, "")
        return (f2(0, 5000) if r() < 0.6 else str(rng.randint(0, 5000))) + unit, False
    return stat_value(label, rng)


UI_WORDS = ["QUALITY", "QTY", "YIELD", "REFINE", "COST", "MATERIAL", "SETUP", "COMPLETED", "PROCESSING", "DETAILS",
            "STATION PROFILE", "USER DETAILS", "CURRENT CAPACITY", "FREE SPACE", "INERT", "REFINABLE", "PROCESSING TIME",
            "// FUNDS", "// USER", "LOOTING VIEW", "MOVE ALL", "CLEAR FILTERS", "PERSONAL / ALL", "LOCAL / LOCAL",
            "EQUIPMENT", "CAPACITY:", "SCU", "WORK ORDER", "// RAW MATERIALS", "// IN MANIFEST", "// TO REFINE",
            "MATERIALS SELECTED", "MATERIALS YIELDED (CSCU)", "REFINEMENT CENTER", "// MODULE-FD57", "TOUCH TO START",
            "STORAGE ACCESS", "SETUP WORK ORDER", "// MATERIAL SELECTION", "// MATERIAL SPECIALIZATIONS"]


def term_number(rng):
    x = rng.random()
    if x < 0.2:
        return str(rng.randint(0, 999))
    if x < 0.35:
        return f"{rng.randint(-99, 99):+d}%" if rng.random() < 0.5 else f"{rng.randint(0, 100)}{rng.choice(['%', ' %'])}"
    if x < 0.5:
        return f"{rng.randint(1, 99999):,} {rng.choice(['SCU', 'CSCU', 'cSCU', 'aUEC', 'UEC'])}"
    if x < 0.6:
        return f"{rng.randint(1, 9999999):,} aUEC"
    if x < 0.7:
        return f"{rng.randint(0, 23)}h {rng.randint(0, 59)}m" if rng.random() < 0.5 else f"{rng.randint(0, 59)}m {rng.randint(0, 59)}s"
    if x < 0.8:
        return f"{rng.randint(1, 9999)} CSCU {rng.choice(['REFINABLE', 'INERT', 'FREE SPACE'])}"
    if x < 0.9:
        return "%.2f" % rng.uniform(0, 999)
    return f"{rng.randint(0, 99999)}{rng.choice(['%', ' SCU', 'K', 'M/5G', 'K/167K'])}"


AMP_TEMPLATES = ["Manufacturer: {a}", "Hersteller: {a}", "Core Compatibility: {a}", "Kern-Kompatibilität: {a}",
                 "{a}", "{a}'s {w}", "{a} {w}", "Item Type: {a}"]
AMP_PAIRS = ["Klaus & Werner", "Tyler Design & Tech", "Medium & Heavy", "Light & Medium", "Light & Heavy",
             "Kruger & Co", "Hurston & Sons", "Sakura & Sun", "Behring & Co", "R&D", "Q&A", "Search & Rescue",
             "Mining & Salvage", "Food & Drink", "Arms & Armor"]


class Texts:
    def __init__(self, charset, v2=False):
        self.charset = charset
        self.v2 = v2
        self.rand_chars = sorted(c for c in charset if c not in (" ", "\u03bc"))
        self.ascii = [c for c in self.rand_chars if ord(c) < 128]
        en = parse_ini(INI_EN)
        de = parse_ini(INI_DE)
        self.en_names, self.en_paras = corpus_from(en, charset)
        self.de_names, self.de_paras = corpus_from(de, charset)
        amp = set()
        for ini in (en, de):
            for v in ini.values():
                for p in v.split("\\n"):
                    if "&" in p:
                        c = clean(p, charset)
                        if c:
                            amp.add(c)
        self.amp = sorted(amp)
        words = set()
        for p in self.en_paras[:4000] + self.de_paras[:4000]:
            for w in p.split(" "):
                w = w.strip(".,;:()\"'")
                if 3 <= len(w) <= 12 and w[0].isupper() and w.isalpha():
                    words.add(w)
        self.cap_words = sorted(words)
        if v2:
            comm, ui = set(), set()
            for k, v in en.items():
                kl = k.lower()
                if kl.startswith("items_commodities_") and "desc" not in kl:
                    c = clean(v, charset)
                    if c and len(c) <= 30 and "[" not in c:
                        comm.add(c)
                elif kl.startswith("refinery_ui"):
                    for p in v.split("\\n"):
                        c = clean(p, charset)
                        if c:
                            ui.add(c)
            self.commodities = sorted(comm)
            self.ref_ui = sorted(ui)
            self.prefixed = [n for n in self.en_names if re.match(r"^[A-Z][a-z]{1,3}/\d/[A-Z] ", n)]
            self.prefixes = sorted({n.split(" ", 1)[0].split("/")[0] for n in self.prefixed})

    def upper(self, s):
        u = s.upper()
        return u if clean(u, self.charset) == u else s

    def term_line(self, rng):
        """Raffinerie-Terminal / Lager-UI: meist Großbuchstaben"""
        x = rng.random()
        if x < 0.3:
            t = rng.choice(self.commodities)
            if rng.random() < 0.3 and "(" not in t:
                t += rng.choice([" (Ore)", " (Raw)"])
        elif x < 0.5:
            t = rng.choice(wrap(rng.choice(self.ref_ui), rng.randint(25, 50)))
        elif x < 0.75:
            return term_number(rng)
        elif x < 0.9:
            t = rng.choice(UI_WORDS)
            if t == "WORK ORDER":
                t += f" {rng.randint(0, 9)}"
        else:
            t = " ".join(rng.choice(self.cap_words) for _ in range(rng.randint(1, 3)))
        return self.upper(t) if rng.random() < 0.88 else t

    def tag_line(self, rng):
        """Lager-Tooltip unten: Material / Menge / Volumen auf farbigem Grund"""
        x = rng.random()
        if x < 0.4:
            return rng.choice(self.commodities)
        if x < 0.7:
            return str(rng.randint(1, 999))
        return f"{rng.choice(['%.3f' % rng.uniform(0, 5), '%.2f' % rng.uniform(0, 99), str(rng.randint(1, 500))])} {rng.choice(['SCU', 'cSCU', 'mSCU', 'µSCU'])}"

    def prefixed_name(self, rng):
        if rng.random() < 0.6:
            return rng.choice(self.prefixed)
        return f"{rng.choice(self.prefixes)}/{rng.randint(0, 4)}/{rng.choice('ABCD')} {rng.choice(self.cap_words)}" + \
            (f" {rng.choice(self.cap_words)}" if rng.random() < 0.4 else "")

    def sample_v2(self, rng, force=None):
        """Mix v2: & 5 %, Zufall 25 % wie v1; Terminal 13 %, Werte 15 %, Präfix-Namen 3 %, Tags/Kapazität 2 %,
        de 10 %, en Namen 9 %, en Beschreibungen 18 %"""
        x = rng.random()
        kind = force or ("amp" if x < 0.05 else "rand" if x < 0.30 else "term" if x < 0.43 else "stat" if x < 0.58 else
                         "prefixed" if x < 0.61 else "tag" if x < 0.63 else "de_name" if x < 0.67 else
                         "de_desc" if x < 0.73 else "name" if x < 0.82 else "desc")
        if kind == "amp":
            return {"kind": kind, "text": self.amp_line(rng)}
        if kind == "rand":
            return {"kind": kind, "text": self.random_line(rng)}
        if kind == "term":
            return {"kind": kind, "text": self.term_line(rng)}
        if kind == "prefixed":
            return {"kind": kind, "text": self.prefixed_name(rng)}
        if kind == "tag":
            if rng.random() < 0.3:
                return {"kind": "dimcap", "text": f"Capacity: {'%.2f' % rng.uniform(0, 99)}{rng.choice(['mSCU', 'SCU', 'cSCU', 'µSCU'])}"}
            return {"kind": kind, "text": self.tag_line(rng)}
        if kind == "de_name":
            return {"kind": kind, "text": rng.choice(self.de_names)}
        if kind == "de_desc":
            return {"kind": kind, "text": self.para_line(self.de_paras, rng)}
        if kind == "name":
            return {"kind": kind, "text": rng.choice(self.en_names)}
        if kind == "desc":
            return {"kind": kind, "text": self.para_line(self.en_paras, rng)}
        label = rng.choice(STAT_LABELS_V2)
        value, tri_ok = stat_value_v2(label, rng)
        tri, colour, vcolour = None, None, None
        y = rng.random()
        if y < 0.15:                                 # ganze Zeile farbig (wie inventory 4, F11)
            good = rng.random() < 0.5
            colour = GREEN if good else rng.choice([RED, AMBER])
            if tri_ok and rng.random() < 0.6:
                tri = TRI_UP if good else TRI_DOWN
        elif y < 0.40:                               # nur der Wert farbig
            vcolour = rng.choice([GREEN, RED, AMBER, TERM_YELLOW, TERM_ORANGE])
        return {"kind": "stat", "label": label + ":", "value": value, "tri": tri, "colour": colour,
                "vcolour": vcolour, "column": rng.random() < 0.7}

    def para_line(self, paras, rng):
        p = rng.choice(paras)
        width = rng.randint(35, 55)
        return rng.choice(wrap(p, width))

    def amp_line(self, rng):
        x = rng.random()
        if x < 0.4 and self.amp:
            p = rng.choice(self.amp)
            lines = [l for l in wrap(p, rng.randint(35, 55)) if "&" in l]
            if lines:
                return rng.choice(lines)
        if x < 0.7:
            a = rng.choice(AMP_PAIRS)
        else:
            sep = "&" if rng.random() < 0.12 else " & "
            a = rng.choice(self.cap_words) + sep + rng.choice(self.cap_words)
        return rng.choice(AMP_TEMPLATES).format(a=a, w=rng.choice(self.cap_words).lower())

    def random_line(self, rng):
        n = rng.randint(3, 40)
        uni = rng.random() < 0.6
        out, wl = [], 0
        while len(out) < n:
            if wl > 0 and rng.random() < 0.18 and len(out) < n - 1:
                out.append(" ")
                wl = 0
                continue
            out.append(rng.choice(self.rand_chars if uni else self.ascii))
            wl += 1
        return re.sub(r" +", " ", "".join(out)).strip()

    def sample(self, rng):
        """-> dict(kind, text) oder für Wertezeilen dict(kind='stat', label, value, tri, colour, column)"""
        x = rng.random()
        if x < 0.05:
            return {"kind": "amp", "text": self.amp_line(rng)}
        if x < 0.30:
            return {"kind": "rand", "text": self.random_line(rng)}
        if x < 0.35:
            return {"kind": "de_name", "text": rng.choice(self.de_names)}
        if x < 0.45:
            return {"kind": "de_desc", "text": self.para_line(self.de_paras, rng)}
        if x < 0.58:
            return {"kind": "name", "text": rng.choice(self.en_names)}
        if x < 0.85:
            return {"kind": "desc", "text": self.para_line(self.en_paras, rng)}
        label = rng.choice(STAT_LABELS)
        value, tri_ok = stat_value(label, rng)
        tri, colour = None, None
        if tri_ok and rng.random() < 0.55:
            good = rng.random() < 0.5
            tri = TRI_UP if good else TRI_DOWN
            if rng.random() < 0.15:
                tri = TRI_DOWN if good else TRI_UP
            colour = GREEN if good else RED
        return {"kind": "stat", "label": label + ":", "value": value, "tri": tri, "colour": colour,
                "column": rng.random() < 0.7}


# ---------------------------------------------------------------- Hintergründe

def build_bg_bank(per_set=90):
    """Tooltip-Flächen aus echten Frames (Sets 2503, 8932), Text herausgerechnet (Inpainting) -> BG_DIR/*.jpg"""
    os.makedirs(BG_DIR, exist_ok=True)
    frames = {}
    for r in csv.DictReader(open(EVAL + "/index.tsv", encoding="utf-8"), delimiter="\t", quoting=csv.QUOTE_NONE):
        if r["set"] in BG_SETS:
            frames.setdefault((r["set"], r["frame"]), []).append(
                (float(r["x0"]), float(r["y0"]), float(r["w"]), float(r["h"])))
    for st in BG_SETS:
        keys = sorted((k for k in frames if k[0] == st), key=lambda k: int(re.sub(r"\D", "", k[1]) or 0))
        step = max(1, len(keys) // per_set)
        for key in keys[::step][:per_set]:
            path = f"{BG_SETS[st]}/{key[1]}.jpg"
            img = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                continue
            H, W = img.shape[:2]
            k = H / 1080 if W / H < 2 else H / 1180
            boxes = frames[key]
            x0 = min(b[0] for b in boxes) - 16 * k
            y0 = min(b[1] for b in boxes) - 8 * k
            x1 = max(b[0] + b[2] for b in boxes) + 16 * k
            y1 = max(b[1] + b[3] for b in boxes) + 12 * k
            x0, y0, x1, y1 = max(0, int(x0)), max(0, int(y0)), min(W, int(x1)), min(H, int(y1))
            if x1 - x0 < 100 or y1 - y0 < 60:
                continue
            panel = img[y0:y1, x0:x1].copy()
            mask = np.zeros(panel.shape[:2], np.uint8)
            for bx, by, bw, bh in boxes:
                cv2.rectangle(mask, (int(bx - x0) - 2, int(by - y0) - 2), (int(bx + bw - x0) + 2, int(by + bh - y0) + 2), 255, -1)
            # Reste ohne Box (nicht zugeordnete Zeilen, ▲▼): kleine helle Strukturen mitmaskieren
            g = cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY)
            th = cv2.morphologyEx(g, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(15 * k), int(15 * k))))
            mask |= cv2.dilate((th > 70).astype(np.uint8) * 255, np.ones((3, 3), np.uint8))
            out = cv2.inpaint(panel, mask, 5, cv2.INPAINT_TELEA)
            cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tofile(f"{BG_DIR}/{st}_{key[1]}.jpg")
    return sorted(glob.glob(BG_DIR + "/*.jpg"))


# ---------------------------------------------------------------- Rendern

class Renderer:
    def __init__(self, texts, bg_files):
        self.texts = texts
        self.bg_small = [f for f in bg_files if os.path.basename(f).startswith("2503")]
        self.bg_large = [f for f in bg_files if os.path.basename(f).startswith("8932")]
        self.fonts = {}
        self.adv = {}
        if texts.v2:
            from fontTools.ttLib import TTFont
            self.bg_ref = sorted(glob.glob(BG_REF_DIR + "/*.jpg"))
            self.cmap, self.cap_ratio = {}, {}
            for name in list(BLENDER.values()) + OTHER_FONTS:
                self.cmap[name] = set(TTFont(f"{FONT_DIR}/{name}.ttf").getBestCmap())
                b = ImageFont.truetype(f"{FONT_DIR}/{name}.ttf", 200).getbbox("H")
                self.cap_ratio[name] = (b[3] - b[1]) / 200

    def covers(self, name, text):
        cm = self.cmap[name]
        return all(ord(c) in cm or c in (TRI_UP, TRI_DOWN) for c in text)

    def font(self, px):
        f = self.fonts.get(px)
        if f is None:
            f = self.fonts[px] = ImageFont.truetype(FONT, px)
        return f

    def advance(self, px, ch):
        key = (px, ch)
        a = self.adv.get(key)
        if a is None:
            a = self.adv[key] = self.font(px).getlength(ch)
        return a

    def font_n(self, name, px):
        key = (name, px)
        f = self.fonts.get(key)
        if f is None:
            f = self.fonts[key] = ImageFont.truetype(f"{FONT_DIR}/{name}.ttf", px)
        return f

    def advance_n(self, name, px, ch):
        if name is None:
            return self.advance(px, ch)
        key = (name, px, ch)
        a = self.adv.get(key)
        if a is None:
            a = self.adv[key] = self.font_n(name, px).getlength(ch)
        return a

    def draw_run(self, draw, px, x, base, text, track, cap, stroke=0.0, fname=None):
        """Zeichen einzeln (Laufweite), Dreiecke selbst gezeichnet. Gibt das Ende in SS-Pixeln zurück."""
        f = self.font(px) if fname is None else self.font_n(fname, px)
        for ch in text:
            if ch in (TRI_UP, TRI_DOWN):
                w, h = 1.05 * cap, 0.6 * cap
                cy = base - cap + 0.45 * cap
                if ch == TRI_UP:
                    pts = [(x, cy + h / 2), (x + w, cy + h / 2), (x + w / 2, cy - h / 2)]
                else:
                    pts = [(x, cy - h / 2), (x + w, cy - h / 2), (x + w / 2, cy + h / 2)]
                draw.polygon(pts, fill=255)
                if stroke > 0:
                    draw.line(pts + pts[:1], fill=255, width=max(1, round(2 * stroke)))
                x += w + track
            else:
                draw.text((round(x), round(base)), ch, font=f, fill=255, anchor="ls", stroke_width=stroke, stroke_fill=255)
                x += self.advance_n(fname, px, ch) + track
        return x

    def background(self, rng, w, h, large):
        files = self.bg_large if large and self.bg_large else self.bg_small
        img = cv2.imread(rng.choice(files), cv2.IMREAD_COLOR)
        H, W = img.shape[:2]
        if W < w or H < h:
            s = max(w / W, h / H) * 1.05
            img = cv2.resize(img, (math.ceil(W * s), math.ceil(H * s)), interpolation=cv2.INTER_LINEAR)
            H, W = img.shape[:2]
        x = rng.randint(0, W - w)
        y = rng.randint(0, H - h)
        p = img[y:y + h, x:x + w].astype(np.float32)
        if rng.random() < 0.5:
            p = p[:, ::-1]
        if rng.random() < 0.3:
            p = p * rng.uniform(0.75, 1.3) + rng.uniform(-10, 10)
        return np.clip(p, 0, 255)

    def render(self, rng, nrng):
        spec = self.texts.sample(rng)
        # Versalhöhe: 1080p-Aufnahmen (~9.3 px), 3840×1600 (~12.9 px), dazu breit gestreut für 7..44 px hohe Crops
        x = rng.random()
        if x < 0.4:
            cap = rng.gauss(9.3, 0.4)
        elif x < 0.75:
            cap = rng.gauss(12.9, 0.5)
        else:
            cap = rng.uniform(4.3, 27.5)
        cap = max(4.0, cap)
        px = max(6, round(cap / CAP_PER_SIZE * SS))        # Fontgröße in SS-Pixeln
        cap_ss = px * CAP_PER_SIZE
        hscale = rng.uniform(EMB_HSCALE[0], EMB_HSCALE[1])  # das Spiel läuft ~10 % schmaler als Pillow
        stroke = rng.uniform(EMB_STROKE[0], EMB_STROKE[1]) * cap_ss   # und etwas fetter
        track = rng.uniform(0.0, 0.035) * cap_ss
        space = self.advance(px, " ")

        # Zeilentext und Label
        if spec["kind"] == "stat":
            label = f"{spec['label']} {spec['value']}" + (f" {spec['tri']}" if spec["tri"] else "")
            colour = spec["colour"] or WHITE
        else:
            label = spec["text"]
            colour = WHITE
        if rng.random() < 0.07:
            colour = tuple(c * rng.uniform(0.5, 0.85) for c in colour)   # abgedunkelte Zeilen
        colour = np.minimum(255, np.array(colour[::-1], np.float32) * rng.uniform(0.96, 1.04))   # BGR

        pitch = rng.uniform(1.5, 1.65) * cap_ss
        est_w = int(sum(self.advance(px, c) + track for c in label) + 12 * cap_ss + 2 * space)
        pad = int(2.5 * cap_ss)
        W = est_w + 2 * pad
        H = int(4 * pitch + 2 * cap_ss)
        base = int(H / 2 + cap_ss / 2)
        x0 = pad + rng.uniform(0, 2 * SS)

        main = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(main)
        if spec["kind"] == "stat":
            xe = self.draw_run(d, px, x0, base, spec["label"], track, cap_ss, stroke)
            gap = space if not spec["column"] else space + rng.uniform(0.2, 7) * cap_ss
            val = spec["value"]
            xe = self.draw_run(d, px, xe + gap, base, val, track, cap_ss, stroke)
            if spec["tri"]:
                self.draw_run(d, px, xe + rng.uniform(0.45, 0.8) * cap_ss, base, spec["tri"], track, cap_ss, stroke)
        else:
            self.draw_run(d, px, x0, base, label, track, cap_ss, stroke)

        # Nachbarzeilen darüber/darunter (Unterlängen ragen in echte Crops)
        nb = Image.new("L", (W, H), 0)
        dn = ImageDraw.Draw(nb)
        for sgn in (-1, 1):
            if rng.random() < 0.55:
                t = self.texts.sample(rng)
                t = t["text"] if "text" in t else f"{t['label']} {t['value']}"
                n = rng.randint(min(3, len(t)), len(t)) if rng.random() < 0.3 else len(t)
                self.draw_run(dn, px, x0, base + sgn * pitch, t[:n], track, cap_ss, stroke)

        def down(im):
            a = np.asarray(im, np.float32)
            return cv2.resize(a, (max(1, round(W * hscale / SS)), H // SS), interpolation=cv2.INTER_AREA) / 255.0
        am = down(main)
        an = down(nb)
        h, w = am.shape

        bg = self.background(rng, w, h, cap > 11.5)
        nb_col = np.array(WHITE[::-1], np.float32) * rng.uniform(0.85, 1.02)
        opacity = rng.uniform(0.94, 1.0)
        img = bg * (1 - an[..., None] * opacity) + nb_col * an[..., None] * opacity
        img = img * (1 - am[..., None] * opacity) + colour * am[..., None] * opacity

        if rng.random() < 0.25:
            img = cv2.GaussianBlur(img, (0, 0), rng.uniform(0.3, 0.75))
        if rng.random() < 0.3:
            img = img + nrng.normal(0, rng.uniform(1.5, 5), img.shape)
        img = np.clip(img + 0.5, 0, 255).astype(np.uint8)
        if rng.random() < 0.9:
            img = cv2.imdecode(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, rng.randint(50, 95)])[1], cv2.IMREAD_COLOR)

        # Box wie der Detektor: um die Tinte der Zeile, Ränder relativ zur Versalhöhe (gemessen an echten Crops)
        cap_px = cap_ss / SS
        cols = np.where(am.max(0) > 0.25)[0]
        if len(cols) == 0:
            return None
        base_px = base / SS
        has_desc = any(c in "gjpqy(),;[]{}|Qµ" for c in label)
        mt = min(0.4, max(0.0, rng.gauss(0.27, 0.08)))
        mb = min(0.5, max(0.15, rng.gauss(0.40, 0.07))) + (rng.uniform(0, 0.1) if has_desc else 0)
        ml = min(0.45, max(0.0, rng.gauss(0.17, 0.08)))
        mr = min(0.6, max(0.05, rng.gauss(0.32, 0.1)))
        bx0 = math.floor(cols[0] - ml * cap_px)
        bx1 = math.ceil(cols[-1] + 1 + mr * cap_px)
        by0 = math.floor(base_px - cap_px - mt * cap_px)
        by1 = math.ceil(base_px + mb * cap_px)
        crop = img[max(0, by0):min(h, by1), max(0, bx0):min(w, bx1)]
        return crop, label


    def pick_font(self, rng, kind, text):
        """Terminal: Blender Pro Book (Breite der Raffinerie-Wörter passt), Bold/Medium; sonst meist Medium."""
        x = rng.random()
        if kind == "term":
            name = BLENDER["book"] if x < 0.45 else BLENDER["bold"] if x < 0.65 else BLENDER["medium"] if x < 0.85 else None
        else:
            name = BLENDER["medium"] if x < 0.68 else BLENDER["book"] if x < 0.78 else BLENDER["bold"] if x < 0.84 else \
                BLENDER["heavy"] if x < 0.85 else BLENDER["thin"] if x < 0.86 else None
        if name is None:
            name = rng.choice(OTHER_FONTS)
        return name if self.covers(name, text) else BLENDER["medium"]

    def bg_ref_patch(self, rng, w, h):
        img = cv2.imread(rng.choice(self.bg_ref), cv2.IMREAD_COLOR)
        H, W = img.shape[:2]
        if W < w or H < h:
            s = max(w / W, h / H) * 1.05
            img = cv2.resize(img, (math.ceil(W * s), math.ceil(H * s)), interpolation=cv2.INTER_LINEAR)
            H, W = img.shape[:2]
        x, y = rng.randint(0, W - w), rng.randint(0, H - h)
        p = img[y:y + h, x:x + w].astype(np.float32)
        if rng.random() < 0.3:
            p = p * rng.uniform(0.75, 1.3) + rng.uniform(-8, 8)
        return np.clip(p, 0, 255)

    def render_v2(self, rng, nrng, force=None):
        spec = self.texts.sample_v2(rng, force)
        kind = spec["kind"]
        if kind == "stat":
            label = f"{spec['label']} {spec['value']}" + (f" {spec['tri']}" if spec["tri"] else "")
        else:
            label = spec["text"]
        fname = self.pick_font(rng, kind, label)
        if fname in CAPS_ONLY:
            u = self.texts.upper(label)
            if u != label.upper() or not self.covers(fname, u):
                fname = BLENDER["medium"]
            else:
                label = u
                if kind == "stat":
                    spec = dict(spec, label=spec["label"].upper(), value=spec["value"].upper())
                elif "text" in spec:
                    spec = dict(spec, text=u)
        blender = fname in BLENDER.values()
        x = rng.random()
        if kind == "term":
            cap = rng.gauss(9.3, 0.5) if x < 0.3 else rng.gauss(13, 1.8) if x < 0.7 else rng.uniform(4.3, 27.5)
        else:
            cap = rng.gauss(9.3, 0.4) if x < 0.4 else rng.gauss(12.9, 0.5) if x < 0.75 else rng.uniform(4.3, 27.5)
        cap = max(4.0, cap)
        ratio = self.cap_ratio[fname]
        px = max(6, round(cap / ratio * SS))
        cap_ss = px * ratio
        if kind == "term" and fname == BLENDER["book"]:
            hscale = rng.uniform(0.95, 1.03)                     # Raffinerie: Book ohne Stauchung (Breitenfit)
            stroke = rng.uniform(0.01, 0.04) * cap_ss
        elif blender:
            hscale = rng.uniform(EMB_HSCALE[0], EMB_HSCALE[1])
            stroke = rng.uniform(EMB_STROKE[0], EMB_STROKE[1]) * cap_ss
        else:
            hscale = rng.uniform(0.92, 1.04)
            stroke = rng.uniform(0.0, 0.02) * cap_ss
        track = rng.uniform(0.0, 0.035) * cap_ss
        space = self.advance_n(fname, px, " ")

        # Farben und Untergrund je Art
        scheme = "tooltip"
        vcolour = None
        if kind == "term":
            scheme = "term"
            y = rng.random()
            colour = TERM_WHITE if y < 0.55 else TERM_GREY if y < 0.75 else TERM_ORANGE if y < 0.83 else \
                TERM_YELLOW if y < 0.9 else TERM_RED if y < 0.95 else tuple(c * 0.6 for c in TERM_WHITE)
        elif kind == "stat":
            colour = spec["colour"] or WHITE
            vcolour = spec["vcolour"]
        elif kind == "dimcap":
            colour = DIM_CAP
        else:
            colour = WHITE
        split = kind == "term" and " " in label and rng.random() < 0.12
        if split:                                    # zweifarbig wie "STATION PROFILE": erstes Wort orange
            colour, vcolour = TERM_ORANGE, TERM_WHITE
        if kind != "dimcap" and rng.random() < 0.07:
            colour = tuple(c * rng.uniform(0.5, 0.85) for c in colour)
        colour = np.minimum(255, np.array(colour[::-1], np.float32) * rng.uniform(0.96, 1.04))
        vcol = colour if vcolour is None else np.minimum(255, np.array(vcolour[::-1], np.float32) * rng.uniform(0.96, 1.04))

        pitch = rng.uniform(1.5, 1.65) * cap_ss
        est_w = int(sum(self.advance_n(fname, px, c) + track for c in label) + 12 * cap_ss + 2 * space)
        pad = int(2.5 * cap_ss)
        W = est_w + 2 * pad
        H = int(4 * pitch + 2 * cap_ss)
        base = int(H / 2 + cap_ss / 2)
        x0 = pad + rng.uniform(0, 2 * SS)

        main = Image.new("L", (W, H), 0)
        val = Image.new("L", (W, H), 0)
        d, dv = ImageDraw.Draw(main), ImageDraw.Draw(val)
        if kind == "stat":
            xe = self.draw_run(d, px, x0, base, spec["label"], track, cap_ss, stroke, fname)
            gap = space if not spec["column"] else space + rng.uniform(0.2, 7) * cap_ss
            xe = self.draw_run(dv, px, xe + gap, base, spec["value"], track, cap_ss, stroke, fname)
            if spec["tri"]:
                self.draw_run(dv, px, xe + rng.uniform(0.45, 0.8) * cap_ss, base, spec["tri"], track, cap_ss, stroke, fname)
            text_end = None
        elif split:
            head, tail = label.split(" ", 1)
            xe = self.draw_run(d, px, x0, base, head, track, cap_ss, stroke, fname)
            text_end = self.draw_run(dv, px, xe + space + track, base, tail, track, cap_ss, stroke, fname)
        else:
            text_end = self.draw_run(d, px, x0, base, label, track, cap_ss, stroke, fname)

        # Nachbarzeilen (nur wenn der Font ihre Zeichen hat); nicht bei Tags
        nb = Image.new("L", (W, H), 0)
        dn = ImageDraw.Draw(nb)
        for sgn in (-1, 1):
            if kind not in ("tag",) and rng.random() < 0.5:
                t = self.texts.sample_v2(rng, "term" if kind == "term" else None)
                t = t["text"] if "text" in t else f"{t['label']} {t['value']}"
                n = rng.randint(min(3, len(t)), len(t)) if rng.random() < 0.3 else len(t)
                t = t.upper() if fname in CAPS_ONLY else t
                if self.covers(fname, t[:n]):
                    self.draw_run(dn, px, x0, base + sgn * pitch, t[:n], track, cap_ss, stroke, fname)

        def down(im):
            a = np.asarray(im, np.float32)
            return cv2.resize(a, (max(1, round(W * hscale / SS)), H // SS), interpolation=cv2.INTER_AREA) / 255.0
        am, av, an = down(main), down(val), down(nb)
        h, w = am.shape
        cap_px = cap_ss / SS
        base_px = base / SS

        if scheme == "term":
            bg = self.bg_ref_patch(rng, w, h)
            y = rng.random()
            if y < 0.22:                                            # Kopfleiste hinter der Zeile
                bar = TERM_BAR if y < 0.16 else TERM_RED_BAR
                t0 = int(base_px - cap_px - rng.uniform(0.3, 0.7) * cap_px)
                t1 = int(base_px + rng.uniform(0.3, 0.7) * cap_px)
                barc = np.array(bar[::-1], np.float32) * rng.uniform(0.85, 1.15)
                bg[max(0, t0):t1] = bg[max(0, t0):t1] * 0.15 + barc * 0.85
            elif y < 0.3:
                bg = bg * 0 + np.array((30, 34, 38), np.float32) * rng.uniform(0.7, 1.3) + nrng.normal(0, 2, bg.shape)
        else:
            bg = self.background(rng, w, h, cap > 11.5)
            if kind == "tag" and text_end is not None:              # farbiger Tag-Grund um den Text
                tc = np.array(rng.choice(TAG_COLOURS)[::-1], np.float32) * rng.uniform(0.85, 1.2)
                l0 = int(x0 * hscale / SS - rng.uniform(0.3, 0.8) * cap_px)
                l1 = int(text_end * hscale / SS + rng.uniform(0.3, 0.8) * cap_px)
                t0 = int(base_px - cap_px - rng.uniform(0.35, 0.6) * cap_px)
                t1 = int(base_px + rng.uniform(0.35, 0.6) * cap_px)
                bg[max(0, t0):t1, max(0, l0):l1] = bg[max(0, t0):t1, max(0, l0):l1] * 0.15 + tc * 0.85
        nb_col = (np.array(TERM_WHITE[::-1], np.float32) if scheme == "term" else np.array(WHITE[::-1], np.float32)) * rng.uniform(0.6, 1.02)
        opacity = rng.uniform(0.94, 1.0)
        img = bg * (1 - an[..., None] * opacity) + nb_col * an[..., None] * opacity
        img = img * (1 - am[..., None] * opacity) + colour * am[..., None] * opacity
        img = img * (1 - av[..., None] * opacity) + vcol * av[..., None] * opacity

        if rng.random() < 0.25:
            img = cv2.GaussianBlur(img, (0, 0), rng.uniform(0.3, 0.75))
        if rng.random() < 0.3:
            img = img + nrng.normal(0, rng.uniform(1.5, 5), img.shape)
        img = np.clip(img + 0.5, 0, 255).astype(np.uint8)
        if rng.random() < 0.9:
            img = cv2.imdecode(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, rng.randint(50, 95)])[1], cv2.IMREAD_COLOR)

        cols = np.where(np.maximum(am, av).max(0) > 0.25)[0]
        if len(cols) == 0:
            return None
        has_desc = any(c in "gjpqy(),;[]{}|Qµ" for c in label)
        mt = min(0.4, max(0.0, rng.gauss(0.27, 0.08)))
        mb = min(0.5, max(0.15, rng.gauss(0.40, 0.07))) + (rng.uniform(0, 0.1) if has_desc else 0)
        ml = min(0.45, max(0.0, rng.gauss(0.17, 0.08)))
        mr = min(0.6, max(0.05, rng.gauss(0.32, 0.1)))
        bx0 = math.floor(cols[0] - ml * cap_px)
        bx1 = math.ceil(cols[-1] + 1 + mr * cap_px)
        by0 = math.floor(base_px - cap_px - mt * cap_px)
        by1 = math.ceil(base_px + mb * cap_px)
        crop = img[max(0, by0):min(h, by1), max(0, bx0):min(w, bx1)]
        return crop, label, kind, fname


def build_ref_bank(tile=(640, 320)):
    """Untergründe des Raffinerie-Terminals: Bildschirmfläche, helle (Text) und dunkle (Text auf Leisten)
    Strukturen herausgerechnet, in Kacheln -> BG_REF_DIR/*.jpg"""
    os.makedirs(BG_REF_DIR, exist_ok=True)
    files = sorted(f for d in REF_DIRS for f in glob.glob(d + "/*.jpg") if not any(s in f for s in REF_SKIP))
    for f in files:
        img = cv2.imdecode(np.fromfile(f, np.uint8), cv2.IMREAD_COLOR)
        if img is None or img.shape[:2] != (1600, 3840):
            continue
        x0, y0, x1, y1 = REF_SCREEN
        scr = img[y0:y1, x0:x1].copy()
        g = cv2.cvtColor(scr, cv2.COLOR_BGR2GRAY)
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))
        mask = (cv2.morphologyEx(g, cv2.MORPH_TOPHAT, k) > 30) | (cv2.morphologyEx(g, cv2.MORPH_BLACKHAT, k) > 40)
        mask = cv2.dilate(mask.astype(np.uint8) * 255, np.ones((5, 5), np.uint8))
        small = cv2.resize(scr, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
        msmall = cv2.resize(mask, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_NEAREST)
        out = cv2.resize(cv2.inpaint(small, msmall, 3, cv2.INPAINT_TELEA), (scr.shape[1], scr.shape[0]), interpolation=cv2.INTER_LINEAR)
        out = np.where(mask[..., None] > 0, out, scr)
        name = os.path.basename(f)[11:-4]
        tw, th = tile
        for ty in range(0, out.shape[0] - th + 1, th):
            for tx in range(0, out.shape[1] - tw + 1, tw):
                cv2.imencode(".jpg", out[ty:ty + th, tx:tx + tw], [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tofile(
                    f"{BG_REF_DIR}/{name}_{ty}_{tx}.jpg")
    return sorted(glob.glob(BG_REF_DIR + "/*.jpg"))


_R = None
_SEED = 0


def _init(texts, bg_files, seed):
    global _R, _SEED
    cv2.setNumThreads(1)
    _R = Renderer(texts, bg_files)
    _SEED = seed


def _work(i):
    rng = random.Random(_SEED * 1_000_003 + i)
    nrng = np.random.default_rng([_SEED, i])
    while True:
        r = _R.render_v2(rng, nrng) if _R.texts.v2 else _R.render(rng, nrng)
        if r is not None and r[0].size and r[1]:
            break
    meta = "\t".join(r[2:])
    return i, cv2.imencode(".png", r[0], [cv2.IMWRITE_PNG_COMPRESSION, 9])[1].tobytes(), r[1], meta


def generate(n, out, seed, workers, v2=False):
    t0 = time.time()
    charset = load_charset()
    texts = Texts(charset, v2)
    print(f"Texte: en {len(texts.en_names)} Namen / {len(texts.en_paras)} Absätze, de {len(texts.de_names)} / "
          f"{len(texts.de_paras)}, & {len(texts.amp)} ({time.time() - t0:.1f} s)", flush=True)
    bg_files = sorted(glob.glob(BG_DIR + "/*.jpg")) or build_bg_bank()
    if v2 and not glob.glob(BG_REF_DIR + "/*.jpg"):
        print(f"Raffinerie-Untergründe: {len(build_ref_bank())} ({time.time() - t0:.1f} s)", flush=True)
    print(f"Hintergründe: {len(bg_files)} ({time.time() - t0:.1f} s)", flush=True)
    os.makedirs(out, exist_ok=True)
    meta_f = open(f"{out}/meta.tsv", "w", encoding="utf-8", newline="") if v2 else None
    with open(f"{out}/labels.tsv", "w", encoding="utf-8", newline="") as lab, \
            mp.Pool(workers, _init, (texts, bg_files, seed)) as pool:
        for i, png, label, meta in pool.imap(_work, range(n), chunksize=200):
            sub = f"{i // 10000:02d}"
            if i % 10000 == 0:
                os.makedirs(f"{out}/{sub}", exist_ok=True)
                print(f"  {i} ({time.time() - t0:.0f} s)", flush=True)
            fn = f"{sub}/{i:06d}.png"
            with open(f"{out}/{fn}", "wb") as f:
                f.write(png)
            lab.write(f"{fn}\t{label}\n")
            if meta_f:
                meta_f.write(f"{fn}\t{meta}\n")
    if meta_f:
        meta_f.close()
    print(f"{n} Zeilen in {time.time() - t0:.0f} s", flush=True)


# ---------------------------------------------------------------- Vergleichsbild

def compare(sheet, synth_dir, k=30, seed=0):
    rng = random.Random(seed)
    lf = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 13)
    syn = [l.rstrip("\n").split("\t", 1) for l in open(f"{synth_dir}/labels.tsv", encoding="utf-8")]
    real = list(csv.DictReader(open(EVAL + "/labels.tsv", encoding="utf-8"), delimiter="\t", quoting=csv.QUOTE_NONE))
    syn = rng.sample(syn, k)
    real = rng.sample(real, k)
    colw = 760

    def cell(path, text):
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        h, w = img.shape[:2]
        nw = max(1, math.ceil(48 * w / h))
        img = cv2.resize(img, (nw, 48), interpolation=cv2.INTER_LINEAR)[:, :colw]
        c = Image.new("RGB", (colw, 68), (255, 255, 255))
        c.paste(Image.fromarray(img[..., ::-1]), (0, 0))
        ImageDraw.Draw(c).text((2, 50), f"{text}   [{h}px]", fill=(0, 110, 0), font=lf)
        return c
    rows = []
    for (sf, sl), r in zip(syn, real):
        row = Image.new("RGB", (2 * colw + 20, 68), (255, 255, 255))
        row.paste(cell(f"{synth_dir}/{sf}", sl), (0, 0))
        row.paste(cell(f"{EVAL}/{r['file']}", r["label"]), (colw + 20, 0))
        rows.append(row)
    head = Image.new("RGB", (2 * colw + 20, 24), (255, 255, 255))
    hf = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 16)
    ImageDraw.Draw(head).text((2, 3), "synthetisch", fill=(0, 0, 0), font=hf)
    ImageDraw.Draw(head).text((colw + 22, 3), "echt (ocr-eval)", fill=(0, 0, 0), font=hf)
    out = Image.new("RGB", (2 * colw + 20, 24 + 68 * len(rows)), (255, 255, 255))
    out.paste(head, (0, 0))
    for i, r in enumerate(rows):
        out.paste(r, (0, 24 + 68 * i))
    out.save(sheet)
    print("Vergleich:", sheet)


# Echte Zeilen aus Raffinerie-/Lager-Screenshots (Bereich grob von Hand, Box automatisch um die Tinte)
REAL_V2 = [
    ("refinery flow/ScreenShot-2026-10-07_22-41-33-C28", (835, 205, 1500, 250), "CRU-L1 AMBITIOUS DREAM STATION"),
    ("refinery flow/ScreenShot-2026-10-07_22-41-33-C28", (888, 400, 985, 424), "Iron (Ore)"),
    ("refinery flow/ScreenShot-2026-10-07_22-41-33-C28", (1146, 400, 1192, 424), "+2%"),
    ("refinery flow/ScreenShot-2026-10-07_22-41-33-C28", (1146, 435, 1192, 459), "-6%"),
    ("refinery flow/ScreenShot-2026-10-07_22-41-33-C28", (836, 305, 1010, 330), "STATION PROFILE"),
    ("refinery flow/ScreenShot-2026-10-07_22-41-33-C28", (838, 330, 1110, 354), "// MATERIAL SPECIALIZATIONS"),
    ("refinery flow 3/ScreenShot-2026-10-08_22-31-08-BB4", (1615, 305, 1745, 348), "SETUP"),
    ("refinery flow 3/ScreenShot-2026-10-08_22-31-08-BB4", (1252, 355, 1400, 381), "WORK ORDER 0"),
    ("refinery flow 3/ScreenShot-2026-10-08_22-31-08-BB4", (1345, 458, 1405, 495), "114"),
    ("refinery flow 3/ScreenShot-2026-10-08_22-31-08-BB4", (1258, 572, 1410, 598), "Dinyx Solventation"),
    ("refinery flow 3/ScreenShot-2026-10-08_22-31-08-BB4", (1338, 636, 1648, 662), "LOW SPEED // HIGH COST // HIGH YIELD"),
    ("refinery flow 3/ScreenShot-2026-10-08_22-31-08-BB4", (1286, 720, 1470, 752), "TITANIUM (ORE)"),
    ("refinery flow 3/ScreenShot-2026-10-08_22-31-08-BB4", (1474, 722, 1516, 750), "516"),
    ("refinery flow 3/ScreenShot-2026-10-08_22-31-08-BB4", (2060, 304, 2292, 346), "COMPLETED"),
    ("refinery flow 3/ScreenShot-2026-10-08_22-31-08-BB4", (1840, 535, 1942, 565), "AGRICIUM"),
    ("inventory/ScreenShot-2026-10-18_14-51-54-34F", (2010, 416, 2090, 445), "Sadaryx"),
    ("inventory/ScreenShot-2026-10-18_14-51-54-34F", (2010, 440, 2200, 471), "Volume: 1000 µSCU"),
    ("inventory/ScreenShot-2026-10-18_14-51-54-34F", (1992, 562, 2175, 588), "Capacity: 1.00mSCU"),
    ("inventory/ScreenShot-2026-10-18_14-51-54-34F", (2003, 588, 2090, 616), "Sadaryx (Tag)"),
    ("inventory/ScreenShot-2026-10-18_14-51-54-34F", (2112, 588, 2165, 616), "510 (Tag)"),
    ("inventory/ScreenShot-2026-10-18_14-51-54-34F", (2358, 588, 2460, 616), "0.001 SCU (Tag)"),
    ("inventory 4/ScreenShot-2026-10-22_15-53-26-8DE", (2012, 808, 2255, 834), "Damage Mitigation: 0.30"),
    ("inventory 4/ScreenShot-2026-10-22_15-53-26-8DE", (2012, 834, 2295, 860), "Min Temp: -61.00 °C"),
    ("inventory 4/ScreenShot-2026-10-22_15-53-26-8DE", (2012, 886, 2350, 912), "Radiation Capacity: 26400.00 mRem"),
]


def real_crop(path, box):
    """Box wie der Detektor: Tinte (heller oder dunkler als der Grund) plus Rand relativ zur Höhe"""
    img = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)
    x0, y0, x1, y1 = box
    g = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    t, _ = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    m = g > t
    ys = np.where(m.mean(1) > 0.02)[0]
    xs = np.where(m.sum(0) > 0)[0]
    if len(ys) == 0:
        return img[y0:y1, x0:x1]
    cap = ys[-1] - ys[0] + 1
    a, b = y0 + ys[0] - int(0.27 * cap), y0 + ys[-1] + 1 + int(0.3 * cap)
    c, d = x0 + xs[0] - int(0.17 * cap), x0 + xs[-1] + 1 + int(0.3 * cap)
    return img[max(0, a):b, max(0, c):d]


def compare2(sheet, seed=7):
    rng = random.Random(seed)
    nrng = np.random.default_rng(seed)
    texts = Texts(load_charset(), True)
    if not glob.glob(BG_REF_DIR + "/*.jpg"):
        build_ref_bank()
    r = Renderer(texts, sorted(glob.glob(BG_DIR + "/*.jpg")))
    groups = {"term": [], "tag": [], "prefixed": [], "stat": [], "other font": []}
    want = {"term": 10, "tag": 4, "prefixed": 4, "stat": 6, "other font": 8}
    while any(len(groups[k]) < want[k] for k in groups):
        kind = rng.choice(["term", "tag", "prefixed", "stat", "desc", "name"])
        out = r.render_v2(rng, nrng, kind)
        if out is None:
            continue
        crop, label, k, fname = out
        g = "other font" if fname not in BLENDER.values() and k in ("desc", "name") else k if k in groups else \
            "tag" if k == "dimcap" else None
        if g and len(groups[g]) < want[g]:
            groups[g].append((crop, f"{g}: {label}   [{fname}, {crop.shape[0]}px]"))
    syn = [x for k in groups for x in groups[k]]
    real = [(real_crop(f"{LOCAL}/screenshots/{p}.jpg", b), f"{t}   [{p.split('/')[0]}]") for p, b, t in REAL_V2]
    lf = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 13)
    colw = 620

    def cell(img, text):
        h, w = img.shape[:2]
        img = cv2.resize(img, (max(1, math.ceil(48 * w / h)), 48), interpolation=cv2.INTER_LINEAR)[:, :colw]
        c = Image.new("RGB", (colw, 68), (255, 255, 255))
        c.paste(Image.fromarray(img[..., ::-1]), (0, 0))
        ImageDraw.Draw(c).text((2, 50), text, fill=(0, 110, 0), font=lf)
        return c
    n = max(len(syn), len(real))
    out = Image.new("RGB", (2 * colw + 20, 24 + 68 * n), (255, 255, 255))
    hf = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 16)
    ImageDraw.Draw(out).text((2, 3), "synthetisch (v2)", fill=(0, 0, 0), font=hf)
    ImageDraw.Draw(out).text((colw + 22, 3), "echt (Raffinerie / Lager / gecraftet)", fill=(0, 0, 0), font=hf)
    for i, (img, t) in enumerate(syn):
        out.paste(cell(img, t), (0, 24 + 68 * i))
    for i, (img, t) in enumerate(real):
        out.paste(cell(img, t), (colw + 20, 24 + 68 * i))
    out.save(sheet)
    print("Vergleich:", sheet)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", help="global.ini des Spielers (englisch), Pflicht außer bei --compare")
    ap.add_argument("--n", type=int, default=1000)
    ap.add_argument("--out", default=LOCAL + "/ocr-train/synth")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    ap.add_argument("--compare", help="nur Vergleichsbild aus --out schreiben")
    ap.add_argument("--rebuild-bg", action="store_true")
    ap.add_argument("--mix", choices=["v1", "v2"], default="v1", help="v2: andere Fonts, Terminal, Tags, farbige Werte")
    ap.add_argument("--compare2", help="Vergleichsbild der v2-Arten gegen echte Raffinerie-/Lager-Crops")
    a = ap.parse_args()
    global INI_EN
    INI_EN = a.pack
    if a.compare:
        compare(a.compare, a.out)
        return
    if not a.pack:
        ap.error("--pack ist nötig")
    if a.compare2:
        compare2(a.compare2)
        return
    if a.rebuild_bg:
        for f in glob.glob(BG_DIR + "/*.jpg"):
            os.remove(f)
    generate(a.n, a.out, a.seed, a.workers, a.mix == "v2")


if __name__ == "__main__":
    main()
