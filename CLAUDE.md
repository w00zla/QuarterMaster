# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Discord bot, user web app and companion desktop app for Star Citizen players and orgs to manage materials
(stock), ship components, refinery jobs and blueprints. Multi-guild (one Discord server = one org),
German/English.

Where things are described (read the matching file before working in an area):

| File | Content |
|---|---|
| `docs/requirements.md` | product requirements, role model, interaction and display rules, localization |
| `docs/catalog-sources.md` | game data sources, the catalog pipeline (extract → snapshot → import), the `catalog` schema, data quirks, the icon renderer |
| `docs/stock.md` | stock service, rights, sharing, refinery jobs, what is bookable (ship components, stats), history, crafting check |
| `docs/bot.md` | schemas `app`/`bot`/`web`, the bot's structure, commands, roster, logs channel, board |
| `docs/webapp.md` | user web app: backend, login, sessions, API, realtime, SPA views and building blocks, security measures |
| `docs/adminapp.md` | admin web UI |
| `docs/companion.md` | companion app: Game.log, scan session, warehouse and character inventory scans, OCR, refinery sync, capture, overlay, decisions, measurements |
| `docs/ext.md` | third-party data (UEX refineries, refining methods) |
| `docs/deploy.md` | production design (image, compose, DB roles, Caddy) and the step-by-step deploy, backups, updates, rollback, restore |
| `.claude/open-points.md` | open decisions and follow-ups the user schedules (local, not in git) |

**Status:** catalog pipeline, admin web UI, the bot with all its commands, logs channel and org board, the
stock service, UEX pull and the user web app are built. In production since 2026-10-05 (Docker Compose on a
VM behind Caddy), not live for users yet: the production DB holds no real data, the user web app is not
deployed, **daily backups stay on the VM only** (since 2026-10-20, no remote target yet: `docs/deploy.md` § 6). In progress: the companion app
(Windows capture only): blueprint unlocks from `Game.log`; warehouse and character inventory scans and the
scan overlay, used in game since 2026-10-18; since 2026-10-19 one scan for every screen (refinery included);
the refinery read is checked against screenshots and recordings (1080p and 3840×1600), its sync untested in game.

## Commands

pnpm workspace: the root package (backend, CLIs), `adminapp/` (the admin SPA) and `webapp/` (the user web app SPA). Run everything from the root; pass CLI arguments directly (`pnpm x --flag`, no `--`, it would reach the CLI as a positional).

```sh
pnpm db:up | db:down | db:psql      # local Postgres 18 via Podman (scripts/dev-db.sh, Linux); creates quartermaster + quartermaster_test
                                    # Windows: Postgres 18 runs as the service postgresql-x64-18 (role quartermaster/quartermaster, superuser, both DBs), no db:* scripts;
                                    #   psql at "C:\Program Files\PostgreSQL\18\bin\psql.exe" (not on PATH); the postgres superuser password is the user's: ask, never store
pnpm db:migrate                     # apply drizzle/ migrations to $DATABASE_URL
pnpm db:generate --name <name>      # generate a migration from src/db/schema/*.ts (drizzle-kit)
pnpm typecheck                      # backend: tsc, no emit
pnpm test                           # all tests, one file at a time (DB test files reset the same DB); DB tests only run when TEST_DATABASE_URL is set
scripts/test-roles.sh [files]       # the same DB tests under the production roles (migrate as qm_owner, deploy/db-roles.sh, code as qm_app/qm_web via SET ROLE; needs the dev container); password login/pg_hba not covered
node --env-file-if-exists=.env --test test/plan.test.ts                                   # single file
node --env-file-if-exists=.env --test --test-name-pattern="diffTexts" "test/**/*.test.ts"   # single test

pnpm catalog:extract --p4k "<install>/LIVE/Data.p4k"                  # -> local/snapshots/catalog-<channel>-<build>.json.gz
pnpm catalog:import <snapshot.json.gz> --label 4.10.2 [--dry-run] [--force] [--allow-downgrade] [--json]
pnpm loc:import <global.ini> --source <name> --lang <code> [--priority n] [--dry-run] [--force]
pnpm loc:import --remove --source <name> --lang <code>
pnpm icons:render [--sample n] [--filter <s>] [--force] [--dry-run]   # icons for the app's gear items and the ore chunks: StarBreaker fork (local/starbreaker-fy) -> Blender + addon (local/blender) -> local/icons/<uuid>.png; needs $SC_DATA_P4K and the DB
pnpm icons:render --write-targets <f> | --targets <f>                  # the target list from the DB / run without the DB (the bundle)
scripts/icons-bundle.ps1            # packs node, Blender, StarBreaker, the CLI and targets.json into local/icons-bundle/ for another Windows PC (run.cmd there; docs/catalog-sources.md "Icons")
pnpm icons:pack [--in <dir>] [--out <dir>] [--force]                  # the PNGs -> local/thumbs/{s,m,l}/<uuid>.<hash>.avif + thumbs.json (the apps' thumbnails, src/thumbs.ts)

pnpm adminapp            # admin API + built UI on 127.0.0.1:3000 (basic auth from .env)
pnpm adminapp:watch      # the same, restarting on source changes
pnpm adminapp:dev        # Vite with hot reload on :5173 (needs the API running); same basic auth
pnpm adminapp:build      # vue-tsc + vite build -> adminapp/dist
pnpm --filter sc-quartermaster-adminapp typecheck   # SPA typecheck only

pnpm webapp | webapp:watch    # user web app backend on 127.0.0.1:3002 (needs DISCORD_CLIENT_SECRET, WEBAPP_ORIGIN)
pnpm webapp:dev               # its SPA on Vite, http://localhost:5174 (proxies /api and /auth; open as localhost, not 127.0.0.1)
pnpm webapp:build             # vue-tsc + vite build -> webapp/dist (served by pnpm webapp)
pnpm bot                      # Discord bot (needs DISCORD_TOKEN)
pnpm bot:register [--dry-run] # bulk-overwrite slash commands: DISCORD_DEV_GUILD_ID set = that server only, else global
pnpm ext                      # third-party pull (UEX, needs UEX_TOKEN): at start, then every 15 minutes
pnpm companion:start          # companion app: tauri dev (Vite on :1430)
pnpm companion:build          # release build for this OS: build:linux (AppImage) or build:windows (setup + bare exe); in-game tests need it (the OCR is far too slow in debug), the running exe must be closed first
pnpm --filter sc-quartermaster-companion build:linux      # standalone AppImage (no installer, like BindSight)
pnpm --filter sc-quartermaster-companion build:windows    # NSIS setup (DirectML.dll next to the exe, tauri.setup.conf.json) + .sig (self-updating; needs TAURI_SIGNING_PRIVATE_KEY = the key's content) and the bare exe (zip it as …_x64-standalone.zip)
pnpm --filter sc-quartermaster-companion typecheck        # companion SPA typecheck
pnpm --filter sc-quartermaster-companion ocr:models      # once per checkout: OCR models (PP-OCRv6 tiny; on Windows also DirectML.dll for the GPU, bundled by build:windows) into companion/src-tauri/resources/ocr (not in git; every Rust build needs them)
cargo test --release --manifest-path companion/src-tauri/Cargo.toml # its Rust tests (the OCR tests read local/screenshots/… if present)
cargo run --release --manifest-path companion/src-tauri/Cargo.toml --example ocr_dump -- <image> [max_height] [threads]   # what the OCR reads in an image
cargo run --release --manifest-path companion/src-tauri/Cargo.toml --example inventory_dump -- <out dir> <screenshots dir>... [--threads n] [--gpu]   # the warehouse read over screenshot folders or debug recordings (around the cursor once a frame gave a strong layout, as in the app), with its phases (models vs. rest)
cargo run --release --manifest-path companion/src-tauri/Cargo.toml --example components_dump -- <dir>... [--threads n] [--gpu]   # the character inventory's tooltip title and lines per image, with its phases; --gpu needs DirectML.dll copied next to the example exe
# Companion log: %LOCALAPPDATA%\com.w00zla.quartermaster.companion\logs\companion.log (Linux: ~/.local/share/…/logs; 2 MB, 3 old files kept); every OCR read is logged
#   ("scan on/off", "scan screen none|warehouse|inventory|refinery (<why>)", "inventory read in … ms: 4×3 tiles at pitch …, cursor …, tooltip …, hovered …", "components read in … ms: page …, cursor … in tile (row, col, span), tooltip "<title>" with n lines: …", "refinery visit started/ended", "refinery overview read in …", "read phases: rgb …, tiny: det prep+run+post …, rec prep+run+post …, rest …" (debug), "overlay on/off", "OCR GPU: Ready|Missing", "OCR Tiny loaded in … on the GPU|CPU", "OCR GPU failed, on the CPU from now on: …", "screen capture: …"):
#   no read lines during a scan = the capture (game not in front) or the gate, reads without tiles = the layout, a tooltip without a hovered tile = the hover rule.
#   Debug recordings (the debug window's "Record data", e.g. into local/stock_scan_debug/) hold every read's frame + JSON; check a series with a temporary example over the folder (keep it out of git).
```

VS Code task `adminapp: dev` starts `adminapp: backend` (`pnpm adminapp:watch`) and `adminapp: frontend` (`pnpm adminapp:dev`) side by side. `webapp: dev` runs `db: up` (`pnpm db:up`), then `webapp: backend` (`pnpm webapp:watch`), `webapp: frontend` (`pnpm webapp:dev`) and `bot` (`pnpm bot`) side by side. `all: dev` runs `db: up`, then all of them plus `ext` (`pnpm ext`, needs `UEX_TOKEN`) side by side. On Windows `db: up` only checks that the Postgres service runs.

Deployment (`compose.yaml`, run on the VM from the checkout; `.env` there holds the production values incl. `POSTGRES_PASSWORD`, `QM_OWNER_PASSWORD`, `QM_APP_PASSWORD`, `QM_WEB_PASSWORD`):

```sh
scripts/deploy.sh                                       # on the VM, after a push (scripts/push-deploy.sh runs it): pg_dump to backups/ -> tag :previous -> build --pull, pull db -> stop bot/admin/ext/webapp -> migrate (fails: back to :previous) -> DB roles -> up
scripts/push-thumbs.sh <user@host>                      # local: local/thumbs/ into the VM's checkout (tar over ssh, manifest last, stale files deleted)
scripts/backup.sh [rsync target]                        # pg_dump to backups/, copy to the target if given, delete local dumps > KEEP_DAYS (14); daily via deploy/quartermaster-backup.{service,timer}
docker compose run --rm bot node src/bot/register.ts    # after command changes
```

`.env` (from `.env.example`) holds `DATABASE_URL`, `TEST_DATABASE_URL`, `ADMINAPP_USER`, `ADMINAPP_PASSWORD`, `ADMINAPP_HOST`, `ADMINAPP_PORT`, `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_DEV_GUILD_ID`, `DISCORD_CLIENT_SECRET`, `WEBAPP_ORIGIN`, `WEBAPP_HOST`, `WEBAPP_PORT`, `WEBAPP_TRUST_PROXY`, `COMPANION_DIR`, `THUMBS_DIR`, `UEX_TOKEN`. The DB integration tests **drop and recreate** the `ext`, `web`, `bot`, `app`, `catalog` and `drizzle` schemas in `TEST_DATABASE_URL` — never point it at a real database.

## Runtime conventions

- Backend: no build step. Node ≥ 22.18 runs `.ts` files directly via type stripping. Relative imports must use the `.ts` extension, and only erasable TypeScript is allowed (`erasableSyntaxOnly`: no enums, namespaces, parameter properties). TypeScript 7 for the backend.
- SPAs (`adminapp/`, `webapp/`, `companion/`): Vue 3 + Vite, own packages with TypeScript 6 (`vue-tsc` needs the JS API that the Go-based TS 7 lacks). They import shared pure code from `src/` (listed in their `tsconfig.json` and Vite `fs.allow`); such files must not import server dependencies. The web app and the companion import the admin's styles and components relatively from `adminapp/src/` (no copies).
- DB sessions run with JIT off (`src/db/client.ts`): JIT compiled short list queries for ~450 ms each.
- `local/` is gitignored and holds the StarBreaker binary (`local/starbreaker`), snapshots, external `global.ini` files (`local/localization/<source>/`), the extractor's working directory, screenshots and debug recordings. Game data does not go into the repo. `assets/logo.png` is the app/bot logo (web copies: `adminapp/src/assets/logo-128.png`, `adminapp/public/favicon.png`, `webapp/src/assets/logo-256.png` for the user web app's login page, `webapp/src/assets/logo-{72,144}.png` for its Companion dialog, `webapp/public/favicon.png`, `companion/src/assets/logo-{44,88}.png` for the companion's title bar (exact sizes, Lanczos: the webview's own downscaling frays the edge); regenerate when it changes).
- Shell scripts must pass `shellcheck`.
- The checkout is shared by Linux and Windows (NTFS): `.gitattributes` keeps every text file LF in the working tree (`* text=auto eol=lf`: Windows git has `autocrlf`), `core.filemode` is false (NTFS loses the executable bit), `node_modules` and `companion/src-tauri/target` are per platform (`pnpm install --config.confirmModulesPurge=false` after switching, full Rust rebuilds). File paths from module URLs only via `fileURLToPath` (`URL.pathname` is `/D:/…` on Windows).
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

- **Catalog** (`docs/catalog-sources.md`): StarBreaker extracts DataCore records from `Data.p4k`, `normalize.ts` turns them into a versioned snapshot (`src/catalog/snapshot.ts`, the contract; blueprint sources from the contract records via `sources.ts`; where ores are mined from the harvestable providers and the object containers (socpaks) via `mining.ts`/`socpak.ts`), `catalog:import` writes schema `catalog` in one transaction under an advisory lock (dry run = rollback); `loc:import` adds community `global.ini` texts by priority; app texts with the reserved prefix `qm_`.
- **Stock** (`docs/stock.md`): every batch belongs to one user, shared into orgs per batch (`stock_share`); refinery jobs are personal work orders holding refined materials (no ores); ship components are items with quality 0 and optional stat gains; `app.history` records every stock, refinery and blueprint action in the same transaction.
- **Bot** (`docs/bot.md`): discord.js, options search, modals ask, panels show (Components V2, ephemeral); roster from member roles; logs channel from `app.history`; one board message per org kept current via `LISTEN qm_changes`.
- **User web app** (`docs/webapp.md`): Hono backend (`src/webapp/`) with Discord OAuth (PKCE), hashed session cookies, a strict CSP and same-origin checks, role `qm_web`; Vue SPA (`webapp/`); realtime via Postgres `NOTIFY` → WebSocket messages that only say what changed; the companion authenticates with a per-user API token (`Bearer qmt_…`) and a version header.
- **Admin web UI** (`docs/adminapp.md`): Hono + Vue, basic auth; a control room (dashboard, status, activity), read-only user data (orgs, users, stock, refinery), catalog browser, imports, UEX, bot status texts.
- **Companion** (`docs/companion.md`): Tauri 2 (Rust + Vue); `Game.log` unlocks; scan sessions that capture the game window (DXGI, Windows), read tooltips with PP-OCRv6 (ONNX, compiled in) and turn them into proposals the user registers through the web app's API; a click-through overlay over the game.
- **ext** (`docs/ext.md`): UEX pull every 15 minutes into schema `ext` (refinery terminals and yield bonuses, refining methods; terminals, commodities, commodity and item prices, not used yet).

**Tests** (`test/`): `fixtures.ts` builds synthetic DataCore records (no real game data) and runs them through the real normalizer; the resulting snapshot feeds both the pure tests and the DB integration tests. Pure companion logic is tested from `test/companion-*.test.ts`, its Rust side with `cargo test`.
