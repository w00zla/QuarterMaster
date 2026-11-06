# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Discord bot and user web app (plus the server side of the companion desktop app) for Star Citizen players and orgs to manage materials
(stock), ship components, refinery jobs and blueprints. Multi-guild (one Discord server = one org),
German/English. GitHub: `w00zla/QuarterMaster` (private; remote over SSH like all sibling repos, the folder keeps its
name `sc-quartermaster`).

Where things are described (read the matching file before working in an area):

| File | Content |
|---|---|
| `docs/requirements.md` | product requirements, role model, interaction and display rules, localization |
| `docs/catalog-sources.md` | game data sources, the catalog pipeline (extract → snapshot → import), the `catalog` schema, data quirks, the icons (target list for packshot, thumbnails) |
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
deployed, **daily backups stay on the VM only** (since 2026-10-20, no remote target yet: `docs/deploy.md` § 6).

## Commands

pnpm workspace: the root package (backend, CLIs), `adminapp/` (the admin SPA) and `webapp/` (the user web app SPA). Run everything from the root; pass CLI arguments directly (`pnpm x --flag`, no `--`, it would reach the CLI as a positional).

```sh
pnpm db:up | db:down | db:psql      # local Postgres 18 via Podman (Linux; creates quartermaster + quartermaster_test)
                                    # Windows: no db:* scripts, the service postgresql-x64-18 (role quartermaster, both DBs); psql in "C:/Program Files/PostgreSQL/18/bin/" (not on PATH); the postgres superuser password is the user's: ask, never store
pnpm db:migrate                     # apply drizzle/ migrations to $DATABASE_URL
pnpm db:generate --name <name>      # generate a migration from src/db/schema/*.ts (drizzle-kit)
pnpm typecheck                      # backend: tsc, no emit
pnpm test                           # all tests, one file at a time (DB test files reset the same DB); DB tests only run when TEST_DATABASE_URL is set
scripts/test-roles.sh [files]       # the same DB tests under the production roles (needs the dev container; docs/deploy.md)
node --env-file-if-exists=.env --test test/plan.test.ts                                   # single file
node --env-file-if-exists=.env --test --test-name-pattern="diffTexts" "test/**/*.test.ts"   # single test

pnpm catalog:extract --p4k "<install>/LIVE/Data.p4k"   # -> local/snapshots/ (does not load .env: pass --p4k); StarBreaker fork ../starbreaker-ps via $STARBREAKER_BIN, else local/starbreaker-ps/ (build: ../sc-packshot/scripts/starbreaker-build.{sh,ps1})
pnpm catalog:import <snapshot.json.gz> --label 4.10.2 [--dry-run] [--force] [--allow-downgrade] [--json]
pnpm loc:import <global.ini> --source <name> --lang <code> [--priority n] [--dry-run] [--force]
pnpm loc:import --remove --source <name> --lang <code>
pnpm packshot:targets [--out <f>]    # the target list for packshot (../sc-packshot renders the icons) from the DB
pnpm thumbs:build [--in <dir>] [--out <dir>] [--force]   # packshot's set live -> local/thumbs/ (AVIFs + thumbs.json; docs/webapp.md "Thumbnails")

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
```

VS Code tasks (`.vscode/tasks.json`, commented there) start the dev stacks; production deploy, backups and updates: `docs/deploy.md`. `.env`: see `.env.example`. The DB integration tests **drop and recreate** the `ext`, `web`, `bot`, `app`, `catalog` and `drizzle` schemas in `TEST_DATABASE_URL` — never point it at a real database.

## Runtime conventions

- Backend: no build step. Node ≥ 22.18 runs `.ts` files directly via type stripping. Relative imports must use the `.ts` extension, and only erasable TypeScript is allowed (`erasableSyntaxOnly`: no enums, namespaces, parameter properties). TypeScript 7 for the backend.
- SPAs (`adminapp/`, `webapp/`): Vue 3 + Vite, own packages with TypeScript 6 (`vue-tsc` needs the JS API that the Go-based TS 7 lacks). They import shared pure code from `src/` (listed in their `tsconfig.json` and Vite `fs.allow`); such files must not import server dependencies. The web app imports the admin's styles and components relatively from `adminapp/src/` (no copies) (the companion keeps its own copies in `../sc-qm-companion/src/shared`).
- DB sessions run with JIT off (`src/db/client.ts`): JIT compiled short list queries for ~450 ms each.
- `local/` is gitignored and holds the StarBreaker binary of our fork (`local/starbreaker-ps/`, built from `../starbreaker-ps`), snapshots, external `global.ini` files (`local/localization/<source>/`), the extractor's working directory, screenshots. Game data does not go into the repo. Logo copies in the apps: `docs/webapp.md` "UI rules".
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

- **Catalog** (`docs/catalog-sources.md`): StarBreaker extracts DataCore records from `Data.p4k` → `normalize.ts` → a versioned snapshot (`src/catalog/snapshot.ts`, the contract) → `catalog:import` writes schema `catalog` in one transaction; `loc:import` adds community `global.ini` texts.
- **Stock** (`docs/stock.md`): every batch belongs to one user, shared into orgs per batch; refinery jobs are personal work orders; `app.history` records every action in the same transaction.
- **Bot** (`docs/bot.md`): discord.js; roster from member roles; logs channel from `app.history`; one board message per org via `LISTEN qm_changes`.
- **User web app** (`docs/webapp.md`): Hono backend (`src/webapp/`) with Discord OAuth, role `qm_web`; Vue SPA (`webapp/`); realtime via Postgres `NOTIFY` → WebSocket; features and privileges (`src/webapp/features.ts`).
- **Admin web UI** (`docs/adminapp.md`): Hono + Vue, basic auth; control room, read-only user data, catalog browser, imports, UEX, features.
- **Companion / OCR** (own repos `../sc-qm-companion` Tauri desktop app, `../sc-ohseearr` OCR): they register blueprints, stock and refinery jobs through the web app's API (per-user token, version header); here only that API, `GET /api/companion/catalog` and the release files (`docs/webapp.md` "Companion release"). Their tests live there; the API side is covered by `test/webapp*.test.ts`.
- **ext** (`docs/ext.md`): UEX pull every 15 minutes into schema `ext`.

**Tests** (`test/`): `fixtures.ts` builds synthetic DataCore records (no real game data) and runs them through the real normalizer; the resulting snapshot feeds both the pure tests and the DB integration tests.

<!-- claude-reflect: learned rules (saved from the band; edit freely) -->
## Learned rules
- No details of the maintainer's own environment in tracked files (the repo will go public): no hosts, IPs, domains, user names, tailnet names or home network setup in docs, examples, comments or scripts. Use placeholders (`<user>@<vm>`, `qm.example.com`); the real values live in Claude's memory, not in git.
- Buttons keep their size when their state changes (details: `docs/webapp.md` "UI rules").
<!-- end claude-reflect -->
