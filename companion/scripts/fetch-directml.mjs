// Downloads DirectML.dll 1.15.4 (Microsoft's redistributable, MIT) into src-tauri/resources/ocr/: ONNX
// Runtime's GPU acceleration on Windows needs it next to the exe (Windows' own is too old; the setup and the
// fast build bundle it). Out of the NuGet package Microsoft.AI.DirectML (200 MB) only that one file, by HTTP
// ranges, checked against its pinned SHA-256. The file stays out of git; run this once per checkout (and after
// a change): pnpm directml. Windows only (elsewhere it does nothing).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/resources/ocr");
  mkdirSync(dir, { recursive: true });
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
