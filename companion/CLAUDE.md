# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

The Quartermaster companion: a desktop app (Tauri 2: Rust + Vue 3) for Star Citizen players. It reads the game's
`Game.log` (blueprint unlocks, location) and, during a scan session the user starts, the game window (Windows): the
freight manager's warehouse grid, the character inventory and the refinery terminal; it turns the reads into
proposals the user registers through the Quartermaster web app's API, and draws a click-through overlay over the game.
German/English UI.

Own repository since 2026-11-06 (history imported from `sc-quartermaster/companion`). The goal is an (optionally)
standalone tool that can also work without the web app; that mode is not specified or built yet.

Neighbours (sibling checkouts next to this one):
- `../sc-ohseearr`: OCR engine, model packages, the screen readers (`usecases/warehouse`, `gear-inventory`,
  `refinery`), the language tables (`sc` crate) and the window capture (`capture-win`), as Rust path dependencies.
  **Required to build.** Its `docs/adr/` holds the OCR decisions.
- `../sc-quartermaster`: the web app/bot whose API the companion talks to (token `qmt_…`, version header,
  `/api/companion/catalog`, release files from its `COMPANION_DIR`). Not needed to build: the UI components, styles and
  API types the companion used from there are **copies** in `src/shared/` (no sync; see its README).

| File | Content |
|---|---|
| `docs/companion.md` | everything about the app: Game.log, server/config/releases, window and state, the scan session, warehouse and gear scans, inventory panel, debug window, OCR, refinery, capture, overlay, WebView2, decisions, measurements, open points |
| `src/shared/README.md` | what was copied from sc-quartermaster and when |
| `.claude/open-points.md` | open decisions and follow-ups the user schedules (local, not in git) |

## Commands

```sh
pnpm install                    # standalone project, own lockfile
pnpm ocr:models                 # once per checkout: DirectML.dll (GPU OCR on Windows) and the original Paddle models into src-tauri/resources/ocr (not in git)
pnpm companion:start            # tauri dev (Vite on :1430, UI hot reload, Rust rebuilt when it changed; OCR on the CPU: no DirectML.dll there)
pnpm companion:fast             # test build for the game: profile `fast` -> src-tauri/target/fast/quartermaster-companion.exe (+ DirectML.dll); close the running exe first
pnpm companion:build            # release build for this OS (LTO, minutes): build:windows (NSIS setup + .sig, needs TAURI_SIGNING_PRIVATE_KEY, and the bare exe) or build:linux (AppImage)
pnpm typecheck                  # vue-tsc (src/ incl. src/shared)
pnpm test                       # node tests in test/ (pure frontend logic)
cargo test --release --manifest-path src-tauri/Cargo.toml          # Rust tests (screenshot tests read local/… when present)
cargo run --release --manifest-path src-tauri/Cargo.toml --example inventory_dump -- <out dir> <dir>... [--threads n] [--gpu]   # warehouse read over screenshots/recordings, overlays per frame
cargo run --release --manifest-path src-tauri/Cargo.toml --example components_dump -- <dir>... [--threads n] [--gpu]            # character inventory read
cargo run --release --manifest-path src-tauri/Cargo.toml --example ocr_dump -- <image> [max_height] [threads]                    # raw OCR of an image
scripts/regression-dumps.sh <out dir> [repo root]   # the three dumps over the fixed recordings/screenshots, normalized: compare with a baseline before and after any OCR/reader change (byte-identical is the bar)
scripts/publish-win-companion.ps1 <user@host>       # Windows release: setup + .sig + standalone zip into $COMPANION_DIR (default local/companion), companion.json updated, uploaded to the server's DEPLOY_PATH
```

Companion log: `%LOCALAPPDATA%\com.w00zla.quartermaster.companion\logs\companion.log` (Linux: `~/.local/share/…/logs`;
2 MB, 3 old files kept); every OCR read is logged (`docs/companion.md` "Debug window" and "OCR" explain the lines).
Debug recordings (the debug window's "Record data") hold every read's frame + JSON.

## Runtime conventions

- Rust in `src-tauri/` (the reads are adapters over sc-ohseearr: `inventory.rs`, `components.rs`, `refinery.rs` only map
  its neutral output to the payloads the frontend and the recordings use; `ocrwatch.rs` is the scan worker and screen
  state machine, `capture.rs` the capture loop, `overlay.rs` the overlay window). Vue 3 + Vite + TypeScript 6 in `src/`.
- The refinery read needs the game's texts: the active language pack's `global.ini`, else an English table at
  `<app local data>/global-english.ini` (made with sc-ohseearr's `scripts/extract-global-ini.*`). No game texts are
  compiled in.
- `local/` is gitignored: screenshots and debug recordings (here a junction to `../sc-quartermaster/local`).
- Text files are LF (`.gitattributes`), `core.filemode` false (the checkout may be shared by Windows and Linux);
  `node_modules` and `src-tauri/target` are per platform.

## Rules

- **Language:** identifiers, comments, docs and commit messages English; UI texts German and English with real umlauts,
  a change in one language always changes the other.
- **UI:** buttons, chips, toggles and tabs never change size with their state; no hint texts; no layout jumps.
- **OCR results must not change silently:** run `scripts/regression-dumps.sh` before and after; changes to the engine,
  models or readers belong in `../sc-ohseearr`.
- **Commit after the real test:** features the user checks in the running app or in game are committed after that check.
- The user starts the app and does the in-game checks himself.
