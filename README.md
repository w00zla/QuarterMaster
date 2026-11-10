<p align="center"><img src="assets/banner.jpg" alt="Quartermaster" width="800"></p>

<h1 align="center">Quartermaster</h1>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-54adf7" alt="Windows | Linux">
  <img src="https://img.shields.io/badge/node-26%2B-54adf7?logo=node.js" alt="Node 26+">
  <img src="https://img.shields.io/badge/Tauri%202-Rust%20%2B%20Vue%203-54adf7" alt="Tauri 2: Rust + Vue 3">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-54adf7" alt="License: MIT"></a>
</p>

<p align="center">
  Materials, ship components, FPS gear, refinery jobs and blueprints of Star Citizen players and orgs, kept in one
  place: a Discord bot, a web app and a companion desktop app that reads what the game shows.
</p>

- **Stock:** materials with quality, ship components and FPS gear with their stats; every batch belongs to one
  player and is shared into orgs batch by batch.
- **Refinery jobs and blueprints:** your work orders and your blueprint collection, with a crafting check against
  your stock.
- **Discord bot:** slash commands, an org board that updates itself and a logs channel. One Discord server is one
  org; German and English.
- **Web app:** the same data in the browser, signed in with Discord.
- **Companion:** registers blueprints, stock and refinery jobs from the game without typing (below).

The bot and the web app run as one hosted service; how it is deployed is described in [docs/deploy.md](docs/deploy.md).

## Companion

<p align="center"><img src="assets/companion-banner.jpg" alt="Quartermaster Companion" width="800"></p>

The companion (`companion/`, Tauri 2: Rust + Vue) reads what the game shows and turns it into stock, blueprint and
refinery entries:

- **Blueprints** from the game's `Game.log`: every unlock as it happens, and the history from old logs.
- **Scans** while you play (Windows): the freight manager's warehouse (materials with quality and amount), the
  character inventory (ship components and FPS gear with their stats) and the refinery terminal (work orders), read
  with OCR from the game window. Each read becomes a proposal you confirm in the app.
- **Overlay**: what the scan sees, drawn click-through over the game.

It needs Windows 10/11 for the scans and the overlay (Linux builds read `Game.log` only), an API token from the web
app's Companion dialog, and for the refinery scan a language pack or the game's English texts as `global-english.ini`
in the app's data folder. How it works: [docs/companion.md](docs/companion.md).

## Build

Requirements: Node 26+, pnpm, PostgreSQL 18 (bot and web app); Rust and the [Tauri 2
prerequisites](https://tauri.app/start/prerequisites/) (companion). The companion's OCR comes from
[sc-ohseearr](https://github.com/w00zla/sc-ohseearr): clone it next to this repository.

```sh
pnpm install
pnpm typecheck && pnpm test   # backend checks (DB tests need TEST_DATABASE_URL)
pnpm webapp:dev               # web app SPA on Vite (needs the backend: pnpm webapp)
pnpm companion:directml       # once on Windows: DirectML.dll for the GPU OCR
pnpm companion:start          # companion in development (tauri dev)
pnpm companion:build          # companion release build for this OS
```

`.env.example` lists the settings. `CLAUDE.md` has all commands, the conventions and a table of what is described
where; the details are in [docs/](docs).

## Related projects

- [sc-ohseearr](https://github.com/w00zla/sc-ohseearr): OCR engine, models and screen readers for Star Citizen
- [sc-packshot](https://github.com/w00zla/sc-packshot): renders the item pictures
- [starbreaker-ps](https://github.com/w00zla/starbreaker-ps): the StarBreaker fork that reads the game data

## Credits

- [StarBreaker](https://github.com/diogotr7/StarBreaker) by diogotr7, used (through our fork) to read the game data.
- [UEX](https://uexcorp.space) for prices.

## Game data and fan content

Quartermaster and its companion are an unofficial Star Citizen fan project, not endorsed by or affiliated with the
Cloud Imperium group of companies. Game content and materials are copyright Cloud Imperium Rights LLC and Cloud
Imperium Rights Ltd. Star Citizen® is a registered trademark of Cloud Imperium Rights LLC.

## License

[MIT](LICENSE). Bundled third-party parts keep their own licenses.
