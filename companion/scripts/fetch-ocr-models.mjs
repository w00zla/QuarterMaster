// Downloads the OCR models (PaddleOCR PP-OCRv5 as ONNX, Apache-2.0, converted by RapidOCR) into
// src-tauri/resources/ocr/, checked against pinned SHA-256 hashes. The models stay out of git; run
// this once per checkout (and after a model change): pnpm --filter sc-quartermaster-companion ocr:models
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0";
const MODELS = [
  { file: "det.onnx", url: `${BASE}/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx`,
    sha256: "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae" },
  { file: "rec.onnx", url: `${BASE}/onnx/PP-OCRv5/rec/latin_PP-OCRv5_rec_mobile.onnx`,
    sha256: "b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a" },
  { file: "rec_dict.txt", url: `${BASE}/paddle/PP-OCRv5/rec/latin_PP-OCRv5_rec_mobile/ppocrv5_latin_dict.txt`,
    sha256: "3c0a8a79b612653c25f765271714f71281e4e955962c153e272b7b8c1d2b13ff" },
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
