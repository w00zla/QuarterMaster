<p align="center"><img src="docs/logo.jpg" alt="Quartermaster Companion" width="800"></p>

# Quartermaster Companion

A desktop companion for Star Citizen and the [Quartermaster](https://github.com/w00zla/sc-quartermaster) web app: it
reads what the game shows and turns it into stock, blueprint and refinery entries, without typing.

- **Blueprints** from the game's `Game.log`: every unlock as it happens, and the history from old logs.
- **Scans** while you play (Windows): the freight manager's warehouse (materials with quality and amount), the
  character inventory (ship components and FPS gear with their stats) and the refinery terminal (work orders), read
  with OCR from the game window. Each read becomes a proposal you confirm in the app.
- **Overlay**: what the scan sees, drawn click-through over the game.
- German and English; follows the game's language pack.

The OCR, the screen readers and the capture come from [sc-ohseearr](../sc-ohseearr) (a separate repository for OCR of
Star Citizen screens).

## Requirements

- Windows 10/11 for the scans and the overlay (DXGI capture); Linux builds read `Game.log` only.
- A Quartermaster account and an API token from its web app (Companion dialog).
- For the refinery scan: a language pack, or the game's English texts as `global-english.ini` in the app's data folder.

## Build

Next to this checkout you need `../sc-ohseearr`. Then:

```sh
pnpm install
pnpm ocr:models          # once: DirectML.dll for the GPU OCR (Windows) and the original OCR models
pnpm companion:start     # develop (tauri dev)
pnpm companion:build     # release build for this OS
```

Tests: `pnpm typecheck`, `pnpm test`, `cargo test --release --manifest-path src-tauri/Cargo.toml`.
Everything about how it works: [docs/companion.md](docs/companion.md).

## License

Not decided yet; all rights reserved until then. Bundled third-party parts keep their licenses (fonts in
`src/shared/ui/adminapp/assets/fonts` under the OFL; DirectML.dll is Microsoft's redistributable, MIT).
