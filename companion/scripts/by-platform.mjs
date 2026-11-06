// Runs `pnpm <prefix><windows|linux>` for the current OS: node scripts/by-platform.mjs build: -> build:windows / build:linux
import { execSync } from "node:child_process";

const prefix = process.argv[2];
if (!prefix) throw new Error("usage: by-platform.mjs <script prefix>");
execSync(`pnpm ${prefix}${process.platform === "win32" ? "windows" : "linux"}`, { stdio: "inherit" });
