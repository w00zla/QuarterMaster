<p align="center"><img src="assets/logo.png" alt="Quartermaster" width="96"></p>

# Quartermaster

Quartermaster is a Discord bot, a user web app and an admin web UI for Star Citizen players and orgs to manage materials
(stock), ship components, refinery jobs and blueprints. One Discord server is one org; German and English. The companion desktop app
(`companion/`) is part of this repository; the server side serves its API.

Sibling repositories:

- [sc-ohseearr](https://github.com/w00zla/sc-ohseearr): OCR engine, models, readers and training (the companion builds against a checkout next to this one)
- [sc-packshot](https://github.com/w00zla/sc-packshot): the item icon renderer
- [starbreaker-ps](https://github.com/w00zla/starbreaker-ps): the StarBreaker fork used to read the game data

## Companion

<p align="center"><img src="assets/companion-banner.jpg" alt="Quartermaster Companion" width="800"></p>

The companion (`companion/`, Tauri 2: Rust + Vue) reads what the game shows and turns it into stock, blueprint and
refinery entries, without typing:

- **Blueprints** from the game's `Game.log`: every unlock as it happens, and the history from old logs.
- **Scans** while you play (Windows): the freight manager's warehouse (materials with quality and amount), the
  character inventory (ship components and FPS gear with their stats) and the refinery terminal (work orders), read
  with OCR from the game window. Each read becomes a proposal you confirm in the app.
- **Overlay**: what the scan sees, drawn click-through over the game.

It needs Windows 10/11 for the scans and the overlay (Linux builds read `Game.log` only), an API token from the web
app's Companion dialog, and for the refinery scan a language pack or the game's English texts as `global-english.ini`
in the app's data folder. To build it, clone [sc-ohseearr](https://github.com/w00zla/sc-ohseearr) next to this repository
(path dependencies), then:

```sh
pnpm install
pnpm companion:directml   # once on Windows: DirectML.dll for the GPU OCR
pnpm companion:start      # develop (tauri dev)
pnpm companion:build      # release build for this OS
```

How it works: [docs/companion.md](docs/companion.md).

## Documentation

`CLAUDE.md` lists the commands, conventions and the table of what is described where; the details are in `docs/`
(requirements, catalog sources, stock, bot, web app, admin app, companion, third-party data, deployment).

## Game data and fan content

Quartermaster and its companion are an unofficial Star Citizen fan project, not endorsed by or affiliated with the Cloud Imperium group of
companies. Game content and materials are copyright Cloud Imperium Rights LLC and Cloud Imperium Rights Ltd. Star Citizen®
is a registered trademark of Cloud Imperium Rights LLC.
