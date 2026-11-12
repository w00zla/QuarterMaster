# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Discord bot, user web app, companion desktop app and the singleuser desktop app for Star Citizen players and orgs to manage materials
(stock), ship components, refinery jobs and blueprints. Multi-guild (one Discord server = one org),
German/English. GitHub: `w00zla/quartermaster` (public, MIT; remote over SSH like all sibling repos). The npm packages, the
Docker image, the compose project and the server checkout keep the old name `sc-quartermaster`.

Where things are described (read the matching file before working in an area):

| File | Content |
|---|---|
| `docs/requirements.md` | product requirements, role model, interaction and display rules, localization |
| `docs/catalog-sources.md` | game data sources, the catalog pipeline (extract → snapshot → import), the `catalog` schema, data quirks, the icons (target list for packshot, thumbnails) |
| `docs/stock.md` | stock service, rights, sharing, refinery jobs, what is bookable (ship components, stats), history, crafting check |
| `docs/bot.md` | schemas `app`/`bot`/`web`, the bot's structure, commands, roster, logs channel, board |
| `docs/webapp.md` | user web app: backend, login, sessions, API, realtime, SPA views and building blocks, the desktop shell's contract (commands, events, frameless window, update dialog), security measures |
| `docs/adminapp.md` | admin web UI |
| `docs/companion.md` | companion app (`companion/`): requirements, structure, Game.log, server/config, release, scan session, warehouse and character inventory scans, refinery sync, capture, overlay, OCR adapters (pointers into sc-ohseearr), decisions |
| `docs/singleuser.md` | singleuser variant: the process (entry point, env variables, data folder, port, Host guard), the app bundle for the desktop shell (files, `nodeFlags`, start protocol `QM_STEP`/`QM_READY`/`QM_FATAL`, stdin control, the data folder's lock), the DB part (PGlite in the process, `connectUrl`, settings, `maintain()`, the one-connection rule) the settings, the game folder, the language pack and the pairing file, the data pack (assets, manifest, build, install, the update from GitHub) and the local identity (one fixed user, the open local API) |
| `docs/app.md` | the desktop app (`app/`, the shell of the singleuser variant: Tauri 2): the start, the Node sidecar, the splash and its texts, the shell contract's implementation (capabilities, IPC and the CSP value), app updates and channels, single instance, the environment overrides, building (what is unsigned), the smoke test |
| `docs/releasing.md` | releasing: tags and versions of the two apps and the data packs, `channels.json` (the one feed file, on the `channels` branch), the PR-only `main`, its ruleset and its one bypass (the deploy key with which `release.yml` rewrites the README's downloads block), the workflows in `.github/workflows/` (`ci.yml` for pull requests, the build and release workflows) and the scripts they run, cutting a release, one-time repository setup |
| `docs/ext.md` | third-party data (UEX trading) |
| `docs/deploy.md` | production design (image, compose, DB roles, Caddy) and the step-by-step deploy, backups, updates, rollback, restore |
| `../sc-ohseearr` | OCR engine, models, readers and training (own repo, https://github.com/w00zla/sc-ohseearr; the companion's Rust git dependencies by release tag; PP-OCRv6 runtime, warehouse layout detector, text recognizer) |
| `.claude/open-points.md` | open decisions and follow-ups the user schedules (local, not in git) |

**Status:** catalog pipeline, admin web UI, the bot with all its commands, logs channel and org board, the
stock service, UEX pull and the user web app are built. In production since 2026-10-05 (Docker Compose on a
VPS behind Caddy); live with real users and data since 2026-11-08 (bot and user web app), so the production DB
is not disposable. Backup and restore are tested on production; **the daily backups stay on the server only** (no
remote target yet: `docs/deploy.md` § 6). The companion (Game.log blueprints, warehouse and character inventory scans, scan overlay, refinery sync) is in use. The singleuser variant ("Quartermaster (singleuser)", the desktop app `app/`) is released: app 1.0.0, companion 2.1.0 and the first data pack since 2026-11-12, as GitHub releases with updates through `channels.json` (`docs/releasing.md`).

## Commands

pnpm workspace: the root package (backend, CLIs), `adminapp/` (the admin SPA), `webapp/` (the user web app SPA), `companion/` (the companion app: Tauri 2, Rust + Vue SPA) and `app/` (the desktop app: Tauri 2, Rust and a static splash). Run everything from the root (the cargo commands of both apps use `--manifest-path`); pass CLI arguments directly (`pnpm x --flag`, no `--`, it would reach the CLI as a positional).

```sh
pnpm db:up | db:down | db:psql      # local Postgres 18 via Podman (Linux; creates quartermaster + quartermaster_test)
                                    # Windows: no db:* scripts, the service postgresql-x64-18 (role quartermaster, both DBs); psql in "C:/Program Files/PostgreSQL/18/bin/" (not on PATH); the postgres superuser password is the user's: ask, never store
pnpm db:migrate                     # apply drizzle/ migrations to $DATABASE_URL
pnpm db:generate --name <name>      # generate a migration from src/db/schema/*.ts (drizzle-kit)
pnpm typecheck                      # backend: tsc, no emit
pnpm test                           # all tests, one file at a time (DB test files reset the same DB); DB tests only run when TEST_DATABASE_URL is set
pnpm test:pglite                    # the same suite on PGlite in the process (TEST_DATABASE_URL=pglite:memory from test/pglite.env, one memory DB per test file); docs/singleuser.md
scripts/test-roles.sh [files]       # the same DB tests under the production roles (needs the dev container; docs/deploy.md)
node --env-file-if-exists=.env --test test/plan.test.ts                                   # single file
node --env-file-if-exists=.env --test --test-name-pattern="diffTexts" "test/**/*.test.ts"   # single test

pnpm catalog:extract --p4k "<install>/LIVE/Data.p4k"   # -> local/snapshots/ (does not load .env: pass --p4k); StarBreaker fork ../starbreaker-ps via $STARBREAKER_BIN, else local/starbreaker-ps/ (build: ../sc-packshot/scripts/starbreaker-build.{sh,ps1})
pnpm catalog:import <snapshot.json.gz> [--dry-run] [--force] [--allow-downgrade] [--json]
pnpm loc:import <global.ini> --source <name> --lang <code> [--priority n] [--dry-run] [--force]
pnpm loc:import --remove --source <name> --lang <code>
pnpm packshot:targets [--out <f>]    # the target list for packshot (../sc-packshot renders the icons) from the DB -> local/packshot-targets.json, copied into packshot's targets/ by hand
pnpm thumbs:build [--in <dir>] [--out <dir>] [--force]   # packshot's set main -> local/thumbs/ (AVIFs + thumbs.json; docs/webapp.md "Thumbnails")

pnpm adminapp            # admin API + built UI on 127.0.0.1:3000 (basic auth from .env)
pnpm adminapp:watch      # the same, restarting on source changes
pnpm adminapp:dev        # Vite with hot reload on :5173 (needs the API running); same basic auth
pnpm adminapp:build      # vue-tsc + vite build -> adminapp/dist
pnpm --filter sc-quartermaster-adminapp typecheck   # SPA typecheck only

pnpm webapp | webapp:watch    # user web app backend on 127.0.0.1:3002 (needs DISCORD_CLIENT_SECRET, WEBAPP_ORIGIN)
pnpm webapp:dev               # its SPA on Vite, http://localhost:5174 (proxies /api and /auth; open as localhost, not 127.0.0.1)
pnpm webapp:build             # vue-tsc + vite build -> webapp/dist (served by pnpm webapp)
pnpm singleuser                # singleuser variant: the web app + API on PGlite for one fixed user, 127.0.0.1:28460-28469 (docs/singleuser.md; needs webapp:build; fetches the data pack itself: QM_AUTO_UPDATE=0 switches that off, QM_DATA_FEED=<dir> reads a folder instead of GitHub, QM_GAME_DIR=<game folder> and QM_PAIRING_FILE=<file> override the setting and the pairing file's place)
pnpm singleuser:import <pack.zip | snapshot.json.gz>   # installs a full data pack (or imports a snapshot, development) into the singleuser data folder (QM_DATA_DIR); the server must not run
pnpm app:bundle [--out <dir>]    # the desktop shell's server: ONE folder (default local/app-bundle/, gitignored) with server.mjs (esbuild), PGlite's wasm/data files, drizzle/, web/ and bundle.json; runs with a bare node.exe (docs/singleuser.md "The app bundle"; builds the SPA when stale)
pnpm data:pack --snapshot <f> --thumbs <dir> --n <n> --out <dir> [--previous <dir>]   # builds a data release (4 assets; docs/singleuser.md "The data pack")
pnpm app:fetch-node           # desktop app: the pinned Node as the sidecar -> app/src-tauri/binaries/ (not in git; copies the running Node when its version is the pin, else downloads the official build and checks its sha256)
pnpm app:build                # desktop app, release build for this OS: app:bundle -> app:fetch-node -> tauri build (Windows: the NSIS setup, and the bare exe in app/src-tauri/target/release/ with node.exe and server/ beside it); unsigned for updating without TAURI_SIGNING_PRIVATE_KEY (docs/app.md)
pnpm app:start                # desktop app: tauri dev (set QM_DATA_DIR, or it uses the real data folder)
pnpm app:fast                 # desktop app: test build without installer (profile fast -> app/src-tauri/target/fast/quartermaster.exe)
pnpm app:smoke [--no-build] [--only <scenario>,...]   # builds and starts the built exe on temp folders: start, close, kill, the shell contract, updates against a local feed, single instance (docs/app.md "Tests"; the app's window opens several times)
cargo test --manifest-path app/src-tauri/Cargo.toml   # desktop app: Rust tests (pure); clippy: cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets
pnpm bot                      # Discord bot (needs DISCORD_TOKEN)
pnpm bot:register [--dry-run] # bulk-overwrite slash commands: DISCORD_DEV_GUILD_ID set = that server only, else global
pnpm ext                      # third-party pull (UEX, needs UEX_TOKEN): at start, then every 15 minutes

pnpm companion:directml       # once per checkout on Windows: DirectML.dll (GPU OCR) into companion/src-tauri/resources/ocr (not in git)
pnpm companion:start          # companion: tauri dev (Vite on :1430, UI hot reload, Rust rebuilt when it changed; OCR on the CPU: no DirectML.dll there)
pnpm companion:fast           # test build for the game: profile `fast` -> companion/src-tauri/target/fast/quartermaster-companion.exe (+ DirectML.dll); close the running exe first
pnpm companion:build          # release build for this OS (LTO, minutes): build:windows (NSIS setup and the bare exe) or build:linux (AppImage)
pnpm --filter sc-quartermaster-companion typecheck   # companion SPA typecheck (vue-tsc)
cargo test --release --manifest-path companion/src-tauri/Cargo.toml   # Rust tests (pure: no local data; the readers' screenshot tests are sc-ohseearr's); the JS tests are test/companion-*.test.ts (pnpm test)
cargo run --release --manifest-path companion/src-tauri/Cargo.toml --example inventory_dump -- <out dir> <dir>... [--threads n] [--gpu]   # warehouse read over screenshots/recordings, overlays per frame
cargo run --release --manifest-path companion/src-tauri/Cargo.toml --example components_dump -- <[set=]dir>... [--threads n] [--gpu] [--dataset <out dir>]   # character inventory read; --dataset: the tooltip lines as a line-crop dataset (companion/tools/dataset-export/README.md)
cargo run --release --manifest-path ../sc-ohseearr/Cargo.toml --example ocr_dump -- <image> [max_height] [threads]   # raw OCR of an image (sc-ohseearr's; needs its checkout next to this repo)
tools/releasectl/.venv/Scripts/python.exe -I tools/releasectl/run.py [--dry-run]   # release TUI: version bumps, tags, channels, drafts, data releases for app and companion (tools/releasectl/README.md; own uv venv, never bare python)
companion/scripts/regression-dumps.sh <out dir> [repo root]   # inventory_dump, components_dump and sc-ohseearr's regress-refinery (its checkout next to this repo) over the readers' regression sets (recordings in its data root's regression/<reader>/), normalized: compare with a baseline before and after any OCR/reader change (byte-identical is the bar)
```

VS Code tasks (`.vscode/tasks.json`, commented there) start the dev stacks; production deploy, backups and updates: `docs/deploy.md`. `.env`: see `.env.example`. The DB integration tests **drop and recreate** the `ext`, `web`, `bot`, `app`, `catalog` and `drizzle` schemas in `TEST_DATABASE_URL` — never point it at a real database.

## Runtime conventions

- Backend: no build step. Node ≥ 26 runs `.ts` files directly via type stripping. Relative imports must use the `.ts` extension, and only erasable TypeScript is allowed (`erasableSyntaxOnly`: no enums, namespaces, parameter properties). TypeScript 7 for the backend.
- SPAs (`adminapp/`, `webapp/`, `companion/`): Vue 3 + Vite, own packages with TypeScript 6 (`vue-tsc` needs the JS API that the Go-based TS 7 lacks). They (the companion too) import shared pure code from `src/` (listed in their `tsconfig.json` and Vite `fs.allow`); such files must not import server dependencies. The web app imports the admin's styles and components relatively from `adminapp/src/` (no copies); the companion imports from `src/`, `adminapp/src/` and `webapp/src/` the same way (no copies, no mirrored API types).
- DB sessions run with JIT off (`src/db/client.ts`): JIT compiled short list queries for ~450 ms each.
- `local/` is gitignored and holds the StarBreaker binary of our fork (`local/starbreaker-ps/`, built from `../starbreaker-ps`), snapshots, external `global.ini` files (`local/localization/<source>/`), the extractor's working directory, screenshots. Game data does not go into the repo. Logo copies in the apps: `docs/webapp.md` "UI rules".
- Shell scripts must pass `shellcheck`.
- The checkout is shared by Linux and Windows (NTFS): `.gitattributes` keeps every text file LF in the working tree (`* text=auto eol=lf`: Windows git has `autocrlf`), `core.filemode` is false (NTFS loses the executable bit), `node_modules` and `companion/src-tauri/target` are per platform (`pnpm install --config.confirmModulesPurge=false` after switching). File paths from module URLs only via `fileURLToPath` (`URL.pathname` is `/D:/…` on Windows).
- **Companion:** it talks to the online server (Access Key) or to the Quartermaster app on this PC (pairing file, no key; `QM_PAIRING_FILE` overrides the file's place for both). The refinery read needs the game's texts (the language pack's `global.ini`, else the English table the server delivers, `GET /api/companion/locale`, kept in the app's cache; no game texts compiled in). Companion log: `%LOCALAPPDATA%com.w00zla.quartermaster.companionlogscompanion.log` (Linux: `~/.local/share/…/logs`; 2 MB, 3 old files), every OCR read is logged (`docs/companion.md` "Debug window", "OCR"); debug recordings (the debug window's "Record data") hold every read's frame + JSON. Screenshots, recordings and OCR datasets live in sc-ohseearr's data root (`$SC_OHSEEARR_DATA`, else `../sc-ohseearr/local`).
- Ideas adopted from another bot (fg-sc-org-inventory-bot) are concepts only: that repo has no license, never copy its code.

## Rules that must not break

- **Migrations applied in production are frozen:** never edit, regenerate, reorder or delete them; every schema change is a new migration. drizzle only compares the timestamp of the last applied migration (the stored hash is never checked): an edited migration, or one with an older timestamp than the last applied, is skipped silently. Dev/test DBs may still be reset. Production updates run through `scripts/deploy.sh`.
- Never run migrations as the superuser (grants come from `ALTER DEFAULT PRIVILEGES FOR ROLE qm_owner`); migrations stay free of role names. Never publish a container port without `127.0.0.1` (Docker's port rules bypass ufw/firewalld). Details: `docs/deploy.md` "Design".
- Catalog rows are never deleted (retired instead); guild data references catalog UUIDs and survives retirement.
- `src/stock/service.ts` is the only code that writes `app.stock_batch` and `app.stock_journal`; rights live there (only the owner changes a batch). `app.stock_journal` and `app.history` are append-only (by grants).
- Quantities are `NUMERIC`, passed as strings, validated as text (`parseAmount`), computed with BigInt micro units, never JS floats.
- Rights are never cached: the web app reads the roster per request; the bot checks `requireMember` per interaction.
- The bot answers within Discord's 3 s: modals only as the first answer (`modalSubcommands`), handlers reply via `ctx.reply` only.
- Users without any org are first-class in every feature.

## Architecture in brief

- **Catalog** (`docs/catalog-sources.md`): StarBreaker extracts DataCore records from `Data.p4k` → `normalize.ts` → a versioned snapshot (`src/catalog/snapshot.ts`, the contract) → `catalog:import` writes schema `catalog` in one transaction; `loc:import` adds community `global.ini` texts.
- **Stock** (`docs/stock.md`): every batch belongs to one user, shared into orgs per batch; refinery jobs are personal work orders; `app.history` records every action in the same transaction.
- **Bot** (`docs/bot.md`): discord.js; roster from member roles; logs channel from `app.history`; one board message per org via `LISTEN qm_changes`.
- **User web app** (`docs/webapp.md`): Hono backend (`src/webapp/`) with Discord OAuth behind the `Identity` seam (`identity*.ts`), role `qm_web`; Vue SPA (`webapp/`); realtime via Postgres `NOTIFY` → WebSocket; features and privileges (`src/webapp/features.ts`).
- **Admin web UI** (`docs/adminapp.md`): Hono + Vue, basic auth; control room, read-only user data, catalog browser, imports, UEX, features.
- **Companion** (`docs/companion.md`, `companion/`): Tauri 2 desktop app (Rust + Vue). Reads `Game.log` and, in a scan session, the game window (OCR from sc-ohseearr, git dependencies by release tag; the Rust adapters in `companion/src-tauri/`), and registers blueprints, stock and refinery jobs through the API of the online web app (per-user token `qmt_…`) or of the local singleuser app (pairing file), with the API contract number header; server side: that API, `GET /api/companion/catalog`, `GET /api/companion/locale` and the contract check (`docs/webapp.md` "Companion API"); the server hosts no companion files (GitHub releases). Tests: `test/companion-*.test.ts` (pure frontend logic, root `pnpm test`), Rust tests in `companion/src-tauri`; the API side is covered by `test/webapp*.test.ts`. OCR engine, models, readers and training: `../sc-ohseearr` (own repo; the build fetches it by tag, a checkout next to this one is only needed for its own examples and the regression script).
- **Desktop app** (`docs/app.md`, `app/`): Tauri 2 program for the singleuser variant: runs the server bundle (`pnpm app:bundle`) with the official pinned `node` as a sidecar (start protocol on stdout, `stop` on stdin), shows a splash until the server listens, then the web app at `http://127.0.0.1:<port>` in a frameless window, and implements the shell contract (pickers, window commands, app updates by channel from GitHub releases) for that origin only. Tests: Rust unit tests in `app/src-tauri`, `test/app-fetch-node.test.ts`, the smoke test `app/scripts/smoke.mjs`.
- **ext** (`docs/ext.md`): UEX pull every 15 minutes into schema `ext`.

**Tests** (`test/`): `fixtures.ts` builds synthetic DataCore records (no real game data) and runs them through the real normalizer; the resulting snapshot feeds both the pure tests and the DB integration tests.

<!-- claude-reflect: learned rules (saved from the band; edit freely) -->
## Learned rules
- Companion: OCR results must not change silently (`companion/scripts/regression-dumps.sh` before and after an OCR/reader change, byte-identical is the bar); changes to the engine, models or readers belong in `../sc-ohseearr`. The companion's UI follows the same UI rules as the apps (buttons keep their size, no hint texts, no layout jumps); a text change in German always changes English too.
- No details of the maintainer's own environment in tracked files (the repo is public): no hosts, IPs, domains, user names, tailnet names or home network setup in docs, examples, comments or scripts. Use placeholders (`<user>@<vm>`, `qm.example.com`); the real values live in Claude's memory, not in git.
- Buttons keep their size when their state changes (details: `docs/webapp.md` "UI rules").
- READMEs describe the current state only: no ADR numbers or links, no plans, open points or "not decided yet"; plans live in `.claude/open-points.md`.
<!-- end claude-reflect -->
