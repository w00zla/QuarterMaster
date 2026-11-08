// Downloads the OCR models (PaddleOCR PP-OCRv6 "tiny", PaddlePaddle's own ONNX from Hugging Face,
// Apache-2.0; multi-language, one dictionary of 6904 characters; `ocr::Model::Tiny`) into
// src-tauri/resources/ocr/, checked against pinned SHA-256 hashes: its dictionary is the list
// `PostProcess.character_dict` of the recognizer's inference.yml, written one character per line
// (PP-OCRv6 "small" from RapidOCR read the warehouse until 2026-10-31). The app's models come from
// ../sc-ohseearr since 2026-11-05 (the detector there is this one); the recognizer and its dictionary here are
// the input of cut-rec.py (the Latin dictionary in ../sc-ohseearr/models/sc-rec-latin/, in git there; the
// app's recognizer is our fine-tune, companion/ocrtrain/).
// On Windows also DirectML.dll 1.15.4 (Microsoft's redistributable, MIT; ONNX Runtime's GPU
// acceleration needs it next to the exe, Windows' own is too old; the setup bundles it): out of the
// NuGet package Microsoft.AI.DirectML (200 MB) only that one file, by HTTP ranges, checked against
// its pinned SHA-256. The files stay out of git; run this once per checkout (and after a change):
// pnpm --filter sc-quartermaster-companion ocr:models
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const HF = "https://huggingface.co/PaddlePaddle";
const TINY_DET = `${HF}/PP-OCRv6_tiny_det_onnx/resolve/2ba1506c0380b8f0b03dd142459aac66d4421f6c`;
const TINY_REC = `${HF}/PP-OCRv6_tiny_rec_onnx/resolve/2612ab37152ae0a677521bae4e1e3d4fb4cf7c30`;

/** The `character_dict` list of a PaddleX recognizer's inference.yml, one character per line. */
function dictOfYml(bytes) {
  const lines = bytes.toString("utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "character_dict:") + 1;
  if (start === 0) throw new Error("inference.yml: no character_dict");
  const chars = [];
  for (let i = start; i < lines.length && lines[i].startsWith("  - "); i++) {
    const v = lines[i].slice(4);
    // A plain scalar or a single-quoted one ('' = ')
    chars.push(v.startsWith("'") ? v.slice(1, -1).replaceAll("''", "'") : v);
  }
  if (chars.some((c) => [...c].length !== 1)) throw new Error("inference.yml: an entry is no single character");
  return Buffer.from(chars.join("\n") + "\n", "utf8");
}

// sha256: of the download; written: of the file written from it, when converted
const MODELS = [
  { file: "det-tiny.onnx", url: `${TINY_DET}/inference.onnx`,
    sha256: "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8" },
  { file: "rec-tiny.onnx", url: `${TINY_REC}/inference.onnx`,
    sha256: "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6" },
  { file: "rec_dict-tiny.txt", url: `${TINY_REC}/inference.yml`,
    sha256: "66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1", convert: dictOfYml,
    written: "c5cbe34ef40c29c4df07ed012bf96569cb69a2d2a01a07027e9f13cb832bd9cd" },
];

const dir = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/resources/ocr");
mkdirSync(dir, { recursive: true });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const m of MODELS) {
  const path = join(dir, m.file);
  if (existsSync(path) && sha(readFileSync(path)) === (m.written ?? m.sha256)) {
    console.log(`${m.file}: up to date`);
    continue;
  }
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`${m.url}: HTTP ${res.status}`);
  const downloaded = Buffer.from(await res.arrayBuffer());
  if (sha(downloaded) !== m.sha256) throw new Error(`${m.file}: SHA-256 ${sha(downloaded)}, expected ${m.sha256}`);
  const bytes = m.convert ? m.convert(downloaded) : downloaded;
  if (m.written && sha(bytes) !== m.written) throw new Error(`${m.file}: SHA-256 ${sha(bytes)} written, expected ${m.written}`);
  writeFileSync(path, bytes);
  console.log(`${m.file}: ${bytes.length} bytes`);
}

/** The file `name` of the ZIP at `url` (a NuGet package), fetched by HTTP ranges: the end record, the
 * central directory, then the entry's local header and data. */
async function fileOfRemoteZip(url, name) {
  const range = async (from, to) => {
    const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
    if (res.status !== 206) throw new Error(`${url}: HTTP ${res.status} for a range`);
    return Buffer.from(await res.arrayBuffer());
  };
  const head = await fetch(url, { method: "HEAD" });
  const size = Number(head.headers.get("content-length"));
  // The end of central directory record: within the last 64 KiB + 22 bytes (its comment)
  const tail = await range(Math.max(0, size - 65558), size - 1);
  const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error(`${url}: no ZIP`);
  const [cdSize, cdOffset] = [tail.readUInt32LE(end + 12), tail.readUInt32LE(end + 16)];
  const cd = await range(cdOffset, cdOffset + cdSize - 1);
  for (let i = 0; i + 46 <= cd.length; ) {
    const [method, compressed, nameLen, extraLen, commentLen, local] =
      [cd.readUInt16LE(i + 10), cd.readUInt32LE(i + 20), cd.readUInt16LE(i + 28), cd.readUInt16LE(i + 30), cd.readUInt16LE(i + 32), cd.readUInt32LE(i + 42)];
    if (cd.toString("utf8", i + 46, i + 46 + nameLen) === name) {
      const header = await range(local, local + 29);
      const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const data = await range(start, start + compressed - 1);
      return method === 8 ? inflateRawSync(data) : data;
    }
    i += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${url}: no ${name}`);
}

if (process.platform === "win32") {
  const file = "DirectML.dll";
  const sha256 = "9c9e6d822561c6c41b90e6994b3e8857cf1d66dbfb1e0c4c799c7c89b4e92da1";
  const path = join(dir, file);
  if (existsSync(path) && sha(readFileSync(path)) === sha256) {
    console.log(`${file}: up to date`);
  } else {
    const bytes = await fileOfRemoteZip("https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg", "bin/x64-win/DirectML.dll");
    if (sha(bytes) !== sha256) throw new Error(`${file}: SHA-256 ${sha(bytes)}, expected ${sha256}`);
    writeFileSync(path, bytes);
    console.log(`${file}: ${bytes.length} bytes`);
  }
}
