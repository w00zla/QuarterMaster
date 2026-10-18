// Downloads the OCR models (PaddleOCR PP-OCRv6 "small" as ONNX, Apache-2.0, converted by RapidOCR,
// its default since RapidOCR 3.9; multi-language, one dictionary of 18708 characters) into
// src-tauri/resources/ocr/, checked against pinned SHA-256 hashes (the models' from RapidOCR's
// default_models.yaml). The models stay out of git; run this once per checkout (and after a model
// change): pnpm --filter sc-quartermaster-companion ocr:models
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0";
const MODELS = [
  { file: "det.onnx", url: `${BASE}/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx`,
    sha256: "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f" },
  { file: "rec.onnx", url: `${BASE}/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx`,
    sha256: "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884" },
  { file: "rec_dict.txt", url: `${BASE}/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt`,
    sha256: "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d" },
];

const dir = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/resources/ocr");
mkdirSync(dir, { recursive: true });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const m of MODELS) {
  const path = join(dir, m.file);
  if (existsSync(path) && sha(readFileSync(path)) === m.sha256) {
    console.log(`${m.file}: up to date`);
    continue;
  }
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`${m.url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (sha(bytes) !== m.sha256) throw new Error(`${m.file}: SHA-256 ${sha(bytes)}, expected ${m.sha256}`);
  writeFileSync(path, bytes);
  console.log(`${m.file}: ${bytes.length} bytes`);
}
