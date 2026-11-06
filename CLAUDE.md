# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Discord bot and user web app (plus the server side of the companion desktop app) for Star Citizen players and orgs to manage materials
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
| `docs/ext.md` | third-party data (UEX refineries, refining methods) |
| `docs/deploy.md` | production design (image, compose, DB roles, Caddy) and the step-by-step deploy, backups, updates, rollback, restore |
| `../sc-qm-companion` | the companion desktop app (own repo since 2026-11-06; its `docs/companion.md`: Game.log, scan session, warehouse and character inventory scans, refinery sync, capture, overlay, release) |
| `../sc-ohseearr` | OCR engine, models and training (own repo; PP-OCRv6 runtime, warehouse layout detector, text recognizer) |
| `.claude/open-points.md` | open decisions and follow-ups the user schedules (local, not in git) |

**Status:** catalog pipeline, admin web UI, the bot with all its commands, logs channel and org board, the
stock service, UEX pull and the user web app are built. In production since 2026-10-05 (Docker Compose on a
VM behind Caddy), not live for users yet: the production DB holds no real data, the user web app is not
deployed, **daily backups stay on the VM only** (since 2026-10-20, no remote target yet: `docs/deploy.md` § 6). The companion app (blueprint unlocks, warehouse/character inventory/refinery scans; Windows capture) lives in `../sc-qm-companion`, the OCR in `../sc-ohseearr`; this repo serves their API (`docs/webapp.md`).

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

pnpm catalog:extract --p4k "<install>/LIVE/Data.p4k"                  # -> local/snapshots/catalog-<channel>-<build>.json.gz (does not load .env: pass --p4k)
pnpm catalog:import <snapshot.json.gz> --label 4.10.2 [--dry-run] [--force] [--allow-downgrade] [--json]
pnpm loc:import <global.ini> --source <name> --lang <code> [--priority n] [--dry-run] [--force]
pnpm loc:import --remove --source <name> --lang <code>
pnpm packshot:targets [--out <f>]     # the target list for packshot from the DB (gear, shop items for the item finder, ore chunks): local/packshot/targets.json
# local/packshot/ is the dev PC's packshot folder, laid out like a bundle: packshot.json, assessment.json, targets.json (offered as a set's target list), runs/, sets/ (each with its targets.json), manifests/, work/ (cache; one packshot process per packshot folder and per work folder: packshot.lock in each, --dry-run too, --report needs none)
pnpm packshot [--render] [--export] [--filter <terms>] [--scope missing|failed|all] [--set <name>] [--name <run>] [--plain|--serve] [--workers n] [--exporters n] [--assess]   # renders the icons (tools/packshot, Rust; cargo builds it on first use): long-lived processes per node: one `starbreaker entity export-batch --stdin` per export slot (our fork, local/starbreaker-qm; without --stdin in its --help one export-batch per export chunk) and one Blender + addon (local/blender) + src/icons/render.py --stdin per render slot (restarted after 200 jobs or 3 GB, export-batch after 40 chunks or 2 GB; a crash fails only the job in flight), several in parallel, terminal dashboard with render preview;
#   every Blender gets --threads 2; on Linux also the RDSEED shim via LD_PRELOAD (tools/packshot/shim/rdseed_shim.rs, built by build.rs with rustc + rust-lld, embedded, written to <work>/rdseed-shim-<hash>.so: Blender's per-node-update std::random_device hit RDSEED and capped the PC at ~13 items/s)
#   no roles: --render (Blender) and --export (Data.p4k + StarBreaker) say what this node can do now, neither = it only starts runs, stores them, watches; the counts change in the TUI (+/-, </>)
#   every run is runs/<date>_<time>_<name>/ (images, run.json, events.jsonl, run.log) on its head node, its images go into the target set sets/<set>/ there (hard links, default live; a new set branches off live); --export needs $SC_DATA_P4K (or --p4k; on Linux .env's F:/ path does not exist) with build_manifest.id next to it, not the DB
#   every set carries its target list (sets/<set>/targets.json: a new set takes its base's, t in view 2 or --targets <file> replaces it, starting a run (Enter) asks for one while the target set has none)
#   TUI views: 1 Run (n head node, s set, a abort), 2 Sets (target set, new set, target list t, adopt into live, delete), 3 Nodes (workers with the assessed items/s, run throughput, runs to fetch h, disk, prerequisites, status per node; details with the items each node holds; the Next run tile; live manifest m, on this node m drops it; assess b, b again aborts); cluster settings in local/packshot/packshot.json (token; optional listen, peers, discovery; "assessment" written by the node), without a token all local;
#   compute assessment on demand only (--assess on this node and exit, or b in view 3, also for another node): a 48-item test set (stratified by type from the target set's list, exported once, here or fetched from an exporting node, kept in work/assess/), n long-lived Blender = 1, 2, 3, 4, 6, 8, … (each warmed by one unmeasured item) until < 5 % gain or RAM/VRAM, sampled every 0.5 s (CPU per core, GPU, VRAM, RAM), then e exports with them alongside (capped by RAM); result + validity keys into assessment.json next to packshot.json (stale: the formula again); while valid its counts are the defaults and the head node sizes each node's chunks by its assessed items/s (at the count it runs now) and prefers the faster nodes
#   the nodes find each other by UDP broadcast on port 47950 (TCP the same); every node can start a run on itself or on another node (its head node: holds the run, hands export chunks to exporting nodes, which hold what they exported, and render chunks to rendering ones, its own items first; a renderer fetches the rest straight from the holder by content hash into its cache (the nodes must reach each other); sends its status to all; every node may abort it)
#   workers read E (export), R (render); PACKSHOT_GRAPHICS=sixel|kitty|iterm2|halfblocks forces one (Konsole: Sixel by default)
#   the head node gives the state: every node needs its packshot build, Blender, add-on and StarBreaker; the exporting nodes' Data.p4k in sync with each other; else no run starts; one run at a time in the cluster
# packshot (tools/packshot, incl. its bundle templates and scripts/packshot-bundle.{ps1,sh}, scripts/starbreaker-build.{sh,ps1}) is English throughout, comments included
# The full run goes on the render PC via the bundle. Fork changes (exporter or Blender addon in ../starbreaker-qm): commit them there, then scripts/starbreaker-build.sh (Linux) or .ps1 (Windows) [--platform all|windows|linux] builds the fork's HEAD (git archive) into local/starbreaker-qm/ (starbreaker.exe; starbreaker for Linux via cargo-zigbuild against glibc 2.31, needs zig + cargo-zigbuild; Windows from Linux via mingw) and writes COMMIT, then rebuild the bundles;
#   the addon in local/blender is a junction (Windows) or symlink (Linux, local/blender/blender-<ver>-linux-x64) to the fork repo (live at once). Addon tests: local/blender/<ver>/5.2/python/bin/python.exe -m unittest discover -s tests -q in ../starbreaker-qm/blender_addon (no system Python);
#   exporter tests with real game data: SC_DATA_P4K=<Data.p4k> cargo test -p starbreaker-3d in ../starbreaker-qm. Render references: the game's tiles in the companion's debug recordings (docs/catalog-sources.md "Review")
pnpm packshot --report [log|run dir]  # evaluates a run's event log (runs/<run>/events.jsonl, default the latest run): items/s, phases p50/p95, chunk overhead and slot use of every node's Blenders, export overhead, CPU/GPU, slowest items
cargo build --release --target x86_64-unknown-linux-musl   # in tools/packshot: the static Linux binary, linked by rust-lld (tools/packshot/.cargo/config.toml; target once via rustup target add x86_64-unknown-linux-musl)
scripts/packshot-bundle.sh [--platform all|windows|linux] [--out <dir>]   # on Linux, both bundles: local/packshot-bundle/windows (packshot.exe cross-built with mingw: rustup target x86_64-pc-windows-gnu + mingw64-gcc; StarBreaker, the official Blender zip checked by SHA256, portable/ with the addon, render.py, targets.json, setup.cmd, run.cmd; Data.p4k + build_manifest.id go next to it)
#   and linux (static packshot, the Linux StarBreaker (glibc: it prints the version it needs), the official Blender tarball checked by SHA256, portable/ with the addon, render.py, targets.json, setup.sh, check.sh, run.sh); the add-on comes from the fork as real files
scripts/packshot-bundle.ps1 [-Platform all|windows|linux] [-Out <dir>]   # on Windows, the same two bundles (the Linux StarBreaker must have been built on Linux)
pnpm thumbs:build [--in <dir>] [--out <dir>] [--force]                # tools/thumbs (Rust, ravif): the PNGs of the set live (local/packshot/sets/live) -> local/thumbs/{s,m,l}/<uuid>.<hash>.avif + thumbs.json (the apps' thumbnails, src/thumbs.ts)

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
node --env-file-if-exists=.env scripts/ocr-eval-label.ts --pack <global.ini>   # sc-ohseearr's recognizer eval labeller: labels for the real line crops from the catalog + the player's global.ini -> local/ocr-eval/labels.tsv; needs the DB and ../sc-qm-companion
# The companion app (build, run, tests, OCR, log) is in ../sc-qm-companion, OCR engine/models/training in ../sc-ohseearr: their commands are there.
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
- SPAs (`adminapp/`, `webapp/`): Vue 3 + Vite, own packages with TypeScript 6 (`vue-tsc` needs the JS API that the Go-based TS 7 lacks). They import shared pure code from `src/` (listed in their `tsconfig.json` and Vite `fs.allow`); such files must not import server dependencies. The web app imports the admin's styles and components relatively from `adminapp/src/` (no copies) (the companion keeps its own copies in `../sc-qm-companion/src/shared`).
- DB sessions run with JIT off (`src/db/client.ts`): JIT compiled short list queries for ~450 ms each.
- `local/` is gitignored and holds the StarBreaker binary of our fork (`local/starbreaker-qm/`, built from the repo `../starbreaker-qm` = github.com/w00zla/starbreaker-qm; `docs/catalog-sources.md` "Icons"), snapshots, external `global.ini` files (`local/localization/<source>/`), the extractor's working directory, screenshots. Game data does not go into the repo. `assets/logo.png` is the app/bot logo (web copies: `adminapp/src/assets/logo-128.png`, `adminapp/public/favicon.png`, `webapp/src/assets/logo-256.png` for the user web app's login page, `webapp/src/assets/logo-{72,144}.png` for its Companion dialog, `webapp/public/favicon.png`; regenerate when it changes).
- Shell scripts must pass `shellcheck`.
- The checkout is shared by Linux and Windows (NTFS): `.gitattributes` keeps every text file LF in the working tree (`* text=auto eol=lf`: Windows git has `autocrlf`), `core.filemode` is false (NTFS loses the executable bit), `node_modules` is per platform (`pnpm install --config.confirmModulesPurge=false` after switching). File paths from module URLs only via `fileURLToPath` (`URL.pathname` is `/D:/…` on Windows).
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
- **User web app** (`docs/webapp.md`): Hono backend (`src/webapp/`) with Discord OAuth (PKCE), hashed session cookies, a strict CSP and same-origin checks, role `qm_web`; Vue SPA (`webapp/`); realtime via Postgres `NOTIFY` → WebSocket messages that only say what changed; the companion authenticates with a per-user API token (`Bearer qmt_…`) and a version header; features (`app.feature`) beyond the roles are used through their privileges (`app.privilege`, `<feature>.<right>`, assigned per user in the admin); their data goes into `app.feature_entry` (feature, user, subject, JSON payload, optional image; which privilege reads and writes is the code's, `src/webapp/features.ts`).
- **Admin web UI** (`docs/adminapp.md`): Hono + Vue, basic auth; a control room (dashboard, status, activity), read-only user data (orgs, users, stock, refinery), catalog browser, imports, UEX, bot status texts, features with their privileges (assigned per user) and the export of their data.
- **Companion** (own repo `../sc-qm-companion`, OCR in `../sc-ohseearr`): Tauri 2 desktop app that reads `Game.log` and the game window and registers blueprints, stock and refinery jobs through the web app's API. Here: the API with its per-user token and version header (`docs/webapp.md`), `GET /api/companion/catalog`, the release files served from `COMPANION_DIR` (`src/webapp/companion.ts`, `docs/deploy.md` § 8) and the web app's Companion dialog.
- **ext** (`docs/ext.md`): UEX pull every 15 minutes into schema `ext` (refinery terminals and yield bonuses, refining methods; terminals, commodities, commodity and item prices, not used yet).

**Tests** (`test/`): `fixtures.ts` builds synthetic DataCore records (no real game data) and runs them through the real normalizer; the resulting snapshot feeds both the pure tests and the DB integration tests. The companion's own tests are in `../sc-qm-companion`; the API side is covered by `test/webapp*.test.ts`.

<!-- claude-reflect: learned rules (saved from the band; edit freely) -->
## Learned rules
- Ensure buttons keep the same size when their state changes; state switches must not alter button dimensions anywhere in the UI.
<!-- end claude-reflect -->
