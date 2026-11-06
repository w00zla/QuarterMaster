# Deployment

Production runs on a VM with Docker Compose: `db` (Postgres 18), `bot`, `ext` (UEX pull), `webapp` (user web app), `admin` (admin web UI). Caddy on the VM host terminates TLS. Files: `Dockerfile`, `compose.yaml`, `scripts/push-deploy.sh` (local), `scripts/push-thumbs.sh` (local), `scripts/deploy.sh` (VM), `scripts/backup.sh`, `deploy/db-roles.sh`, `deploy/quartermaster-backup.{service,timer}`, `docs/Caddyfile.example`. Background and design decisions: "Design" below.

Paths below assume the checkout in `/opt/sc-quartermaster` and the user `w00zla` on the VM (sudo, member of the `docker` group); adjust as needed.

There is no git server: the VM's checkout is a plain repo that you push into over SSH from your machine (`receive.denyCurrentBranch updateInstead` updates its working tree on push). The VM never pulls. Only committed files arrive (this file and the Caddyfile example are in `docs/`); `.claude/`, `local/` and `.env` are gitignored and stay local.

## Design

- `Dockerfile` (multi-stage): one image for every process, the compose service's `command` picks it. Build stage with all dependencies builds both SPAs; the runtime stage has the backend's production dependencies only (`--filter sc-quartermaster`), `src/`, `drizzle/`, `adminapp/dist`, `webapp/dist`, runs as `node`. `package.json` must be in the image (`"type": "module"`). `.dockerignore` keeps `.env`, `local/` and `node_modules` out.
- `compose.yaml`: `db` (Postgres 18, no published port), `bot` (no port; `WEBAPP_ORIGIN` optional for its web app links; `local/thumbs/` mounted read-only for which item thumbnails exist, Discord fetches them from `THUMBS_URL`, default `WEBAPP_ORIGIN` + `/thumbs`), `ext` (the third-party pull every 15 minutes, no port), `admin` (published on `127.0.0.1:3001` only, `local/thumbs/` mounted read-only for the thumbnails' coverage and images), `webapp` (as `qm_web`, published on `127.0.0.1:3000` only, `WEBAPP_TRUST_PROXY=1`, the companion release and the item thumbnails mounted read-only from `local/companion/` and `local/thumbs/` of the checkout), `migrate` (profile `tools`, one-off). App containers run read-only, without capabilities, `no-new-privileges`; logs rotate (json-file with `max-size`: the default never rotates). Each service gets only its own variables; `DATABASE_URL` is built from the role passwords (URL-safe characters only).
- **DB roles** (`deploy/db-roles.sh`, idempotent): superuser `postgres` only for init, roles and dumps; `qm_owner` owns the database and everything the migrations create and is used by `migrate` only; `qm_app` (bot, admin, ext) has DML only, no DDL, `app.stock_journal` and `app.history` only `SELECT`/`INSERT` (append-only enforced by the DB), no access to schema `drizzle`, in schema `web` only column-level `SELECT` on `web.session` (`user_id`, Discord username/global name, `created_at`, `last_seen_at`, `expires_at`) and `web.api_token` (`user_id`, Discord username/global name, `created_at`, `last_used_at`) for the admin's user overview, never the token hashes (bot/admin must not forge web sessions; regranted after the `REVOKE ALL` on every run). `qm_web` (user web app) reads `catalog`, `app` and `ext`, writes `app_user`, `stock_batch`, `stock_journal` and `history` (`INSERT` only), `user_blueprint` and `feature_entry` (privilege features; the key check is the code's), but `app.org`/`app.member` and `app.user_privilege` are read-only (no role IDs, no roster changes, no self-granted privileges), no access to schema `bot`, full DML in `web`; its grants are explicit, reapplied on every run (default privileges cover `qm_app` only). Grants for new tables come from `ALTER DEFAULT PRIVILEGES FOR ROLE qm_owner`, which only covers objects qm_owner creates: never run migrations as the superuser. The script runs on a fresh volume (mounted into `/docker-entrypoint-initdb.d/`) and in `deploy.sh` after every migration, fed via stdin (a single-file bind mount keeps the old inode after a push updated the checkout). Migrations stay free of role names: dev and test DBs run as superuser without these roles. A dump restores into a fresh volume (the init creates the roles first). `scripts/test-roles.sh` runs the DB tests under these roles.
- Caddy on the VM host terminates TLS: the user web app on 443 (`quartermaster.w00z.net` → `127.0.0.1:3000`, Caddy adds only HSTS: the app sets its own headers), the admin UI on its own port (`:8443` → `127.0.0.1:3001`), example in `docs/Caddyfile.example`.
- The scripts assume Docker Compose. podman-compose only serves for local tests and behaves differently: it does not wait for `service_healthy`, `run migrate` needs `--profile tools`, `up --wait` waits for every container of the project, and `up -d` does not recreate containers after the image changed.

## 1. VM prerequisites

- Docker Engine with the compose plugin (`docker compose`, not the old `docker-compose`), git, rsync, Caddy (host package, not a container).
- `w00zla` is in the `docker` group (`sudo usermod -aG docker w00zla`, then log in again). The group is root-equivalent, which adds nothing for a user with sudo anyway.
- DNS: the domain points to the VM.
- Firewall on the VM and port forwards on the router: inbound **80, 443** (ACME challenge, the user web app) and **8443** (admin UI). Nothing else, in particular not 3000, 3001 or 5432.
- **Docker's published ports bypass ufw/firewalld.** `compose.yaml` only publishes `127.0.0.1:3000` (web app) and `127.0.0.1:3001` (admin); never add a port without `127.0.0.1:`.
- SELinux host (RHEL/Fedora): the bind mounts in `compose.yaml` need `:z` (`…/10-roles.sh:ro,z`, `./local/companion:/companion:ro,z`, `./local/thumbs:/thumbs:ro,z`). Debian/Ubuntu: nothing to do.

## 2. Checkout and `.env`

On the VM, as `w00zla` (SSH key login from your machine):

```sh
sudo mkdir /opt/sc-quartermaster
sudo chown w00zla:w00zla /opt/sc-quartermaster
git init -b main /opt/sc-quartermaster
git -C /opt/sc-quartermaster config receive.denyCurrentBranch updateInstead
```

`-b main` matters: with a different `init.defaultBranch`, `HEAD` points to an unborn branch and the push of `main` never reaches the working tree.

From your machine, the first push without deploying (`.env` does not exist yet):

```sh
git push w00zla@<vm>:/opt/sc-quartermaster main
```

On the VM:

```sh
cd /opt/sc-quartermaster
cp .env.example .env && chmod 600 .env
mkdir -p local/companion     # the companion release (§ 8); created by Docker as root otherwise
mkdir -p local/thumbs        # the item thumbnails (§ 8, `push-thumbs.sh`)
```

Set in `.env`:

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | superuser `postgres`; **only applied when the volume is created** |
| `QM_OWNER_PASSWORD`, `QM_APP_PASSWORD`, `QM_WEB_PASSWORD` | DB roles (`qm_web`: the user web app); go into URLs: **URL-safe characters only** |
| `DISCORD_TOKEN`, `DISCORD_APP_ID` | the production application (not the dev one) |
| `DISCORD_DEV_GUILD_ID` | **empty**: commands are registered globally |
| `DISCORD_CLIENT_SECRET` | the production application's OAuth2 client secret (not the bot token) |
| `WEBAPP_ORIGIN` | `https://quartermaster.w00z.net` (no trailing slash; the companion app's fixed server) |
| `ADMINAPP_USER`, `ADMINAPP_PASSWORD` | basic auth of the admin UI; long random password (it is reachable from the internet) |
| `UEX_TOKEN` | bearer token of an app on https://uexcorp.space/api/apps (service `ext`) |

```sh
openssl rand -hex 32     # one per password
```

`DATABASE_URL`, `ADMINAPP_HOST`, `ADMINAPP_PORT`, `WEBAPP_HOST`, `WEBAPP_PORT`, `WEBAPP_TRUST_PROXY`, `COMPANION_DIR` are ignored (compose sets them). Delete `TEST_DATABASE_URL`: the tests drop schemas in that database.

## 3. Discord developer portal (production application)

- Bot → Privileged Gateway Intents: **Server Members** on. Nothing else.
- Bot → **Requires OAuth2 Code Grant: off.** When on, the bot only joins once the invite's code is exchanged, and the invite redirects to the web app's `/auth/callback`, which refuses it (no login state): the authorize page goes through, the web app opens, but no bot on the server. The URL generator asking for a redirect URI with only `bot` + `applications.commands` ticked is the sign that this switch is on.
- OAuth2 → Redirects: `https://quartermaster.w00z.net/auth/callback` (= `WEBAPP_ORIGIN` + `/auth/callback`, exactly). Client secret from the same page into `.env`.
- Invite: `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=52224` (no `redirect_uri`, no `response_type`). From the URL generator: scopes `bot` and `applications.commands` only (any other scope turns the invite into a code grant with the same redirect problem), permissions View Channels, Send Messages, Embed Links, Attach Files (= `52224`; nothing ticked = `permissions=0`).

## 4. First deploy

From your machine (or `scripts/deploy.sh` directly on the VM):

```sh
scripts/push-deploy.sh w00zla@<vm>               # creates the DB + roles, migrates, starts everything
```

On the VM:

```sh
docker compose run --rm bot node src/bot/register.ts    # registers the slash commands globally
docker compose logs bot                                 # optional check: "Logged in as …" (a wrong token only shows as a restart loop)
```

Then:
- Catalog: extract the snapshot locally (`pnpm catalog:extract`, StarBreaker does not run on the VM) and upload it in the admin UI (Imports, dry run first). Same for external `global.ini` files.
- On the Discord server: invite the bot, run `/qm-setup` (roles, language, logs channel), then try `/qm-res add` once: it is the first real write as `qm_app`.
- Global commands can take a moment to show up; restart the Discord client if they do not.

## 5. Caddy

- Copy the site blocks from `docs/Caddyfile.example` (in the checkout on the VM) into `/etc/caddy/Caddyfile`, set the domain: one for the web app (443 → `127.0.0.1:3000`), one for the admin UI (8443 → `127.0.0.1:3001`). The web app sets its own security headers (CSP etc.); its block only adds HSTS.
- `remote_ip` allowlist (basic auth has no rate limit or lockout), what Caddy sees as client IP:
  - From outside: the client's public IP. With a dynamic IP (daily reconnect) an allowlist locks you out after the next change; use it with fixed IPs only, otherwise a VPN (WireGuard on the Fritzbox) is the clean way.
  - From the LAN via the public DNS name: the Fritzbox reflects the connection (NAT loopback) and rewrites the source to its **public WAN IP**; it cannot be switched off. Its "DNS rebind protection" exceptions do not change that.
  - To be seen with the LAN IP: the domain must resolve to the VM's LAN IP inside the LAN, e.g. an `/etc/hosts` entry on the client (in use) or a local DNS (Pi-hole etc.). Give the VM a fixed DHCP lease in the Fritzbox; on a laptop, the entry breaks access from outside the LAN (comment it out or use the VPN).
  - Requests from `66.102.x.x` (`google-proxy-…`) are Google fetching the URL (link previews, translation), not a person.
- The web app's block serves `/thumbs/*` itself from `local/thumbs/` of the checkout (`handle_path` with `file_server`, immutable cache), the rest goes to the app: no Node for the images, and they work before the web app is deployed. The `caddy` user must be able to read the directory (`o+rX`, `o+x` on the directories above). The path in the block is the checkout's.
- The log directory (`/var/log/caddy/`) must exist and be writable by the `caddy` user.
- `caddy validate --config /etc/caddy/Caddyfile`, then `systemctl reload caddy`.
- Check: `curl -I https://<domain>:8443` → `401`; in the browser the UI loads; look once at the console for CSP errors.
- Check the thumbnails (after `push-thumbs.sh`): `curl -I https://<domain>/thumbs/l/<uuid>.<hash>.avif` (a pair from `local/thumbs/thumbs.json`) → `200`, `content-type: image/avif`, the immutable `cache-control`; `403` = the `caddy` user cannot read the directory.
- Check the web app: `curl -I https://<domain>` → `200` with `content-security-policy` and `strict-transport-security`; `curl https://<domain>/api/me` → `401`; log in with Discord once (a wrong redirect URL or secret ends on `/?login=failed`, the reason is in `docker compose logs webapp`).

## 6. Backups

> **⚠️ Local only for now (open TODO).** The daily dumps stay on the VM (`backups/`): they cover Docker mishaps (a deleted volume, a broken migration), but losing the VM or its host loses the data. A remote target is still to be prepared (NAS via SSH/rsync, a mounted share as a plain path, or an external Storage Box on SSH port 23); never on the same hardware as the VM, ideally with a copy outside the house.

`scripts/backup.sh [target]` dumps into `backups/`, copies to the target if one is given (anything rsync accepts, e.g. `backup@host:quartermaster/`) and then deletes local dumps older than `KEEP_DAYS` (14). Nothing is deleted on the target.

```sh
sudo cp deploy/quartermaster-backup.{service,timer} /etc/systemd/system/
# in the .service: User=w00zla, WorkingDirectory, ExecStart (local only: no target; later e.g. qm-backup:, see below)
sudo systemctl daemon-reload
sudo systemctl enable --now quartermaster-backup.timer
```

- Remote target: the timer runs unattended, so it needs an SSH key **without passphrase**. Use a **separate key** for it, not your normal one (otherwise a passphrase-less key on `w00zla` opens a full shell on the backup host):
  ```sh
  ssh-keygen -t ed25519 -N '' -f ~/.ssh/qm-backup -C qm-backup
  ```
  `~/.ssh/config` of `w00zla` (`backup.sh` runs plain rsync, the alias picks the key):
  ```
  Host qm-backup
    HostName backup.example.com
    User backup
    IdentityFile ~/.ssh/qm-backup
    IdentitiesOnly yes
  ```
  On the backup host, restrict the key in `authorized_keys` to rsync into one directory (`rrsync` ships with rsync ≥ 3.2.4, older versions have it under `/usr/share/doc/rsync/scripts/`; `-wo`: write only, the key cannot read old dumps back; check that your version knows the option):
  ```
  command="rrsync -wo /srv/backup/quartermaster",restrict ssh-ed25519 AAAA… qm-backup
  ```
  With `rrsync`, target paths are relative to that directory: target `qm-backup:` (untested, check with the manual run below).
- The host key must already be known: connect once by hand (`ssh qm-backup`; with `rrsync` the login itself is refused, but the host key is stored), otherwise the first timer run waits for the host key prompt.
- Test: `sudo systemctl start quartermaster-backup.service && journalctl -u quartermaster-backup -n 20`, and check the file in `backups/` (and at the target).
- `scripts/deploy.sh` also dumps before every update (local only, `backups/`).
- Do not deploy around 04:00: the dump names have second resolution.

## 7. Updates

> **⚠️ Existing production setup: add `UEX_TOKEN`, `QM_WEB_PASSWORD` (`openssl rand -hex 32`), `DISCORD_CLIENT_SECRET` and `WEBAPP_ORIGIN` (§ 2) to the VM's `.env`, `mkdir -p local/companion`, the OAuth2 redirect (§ 3), the web app's Caddy block (§ 5) and rename `WEB_USER`/`WEB_PASSWORD` to `ADMINAPP_USER`/`ADMINAPP_PASSWORD` (`sed -i -E 's/^WEB_(USER|PASSWORD|HOST|PORT)=/ADMINAPP_\1=/' .env`) BEFORE the next `scripts/deploy.sh`.** Without it every `docker compose` call fails on the `:?` check in `compose.yaml` (also `logs`, `run … register.ts`). `deploy.sh` then aborts at its first `docker compose` call, before backup, build and migration: the running containers and the DB stay unchanged (with `push-deploy.sh` the checkout is already updated). Set the variable and run `deploy.sh` again. The `db` container is recreated once because its environment changed (a short DB restart).

From your machine, on `main` with everything committed:

```sh
scripts/push-deploy.sh w00zla@<vm>
ssh w00zla@<vm> 'cd /opt/sc-quartermaster && docker compose run --rm bot node src/bot/register.ts'   # only when commands changed
```

`push-deploy.sh` refuses changed or untracked files (only commits are pushed: a never added file, e.g. a new migration, would silently be missing on the VM) and any branch but `main`. Then it pushes `main` into the VM's checkout and runs `scripts/deploy.sh` there with live output (`DEPLOY_PATH` for another checkout path).

- The push is refused when the VM's checkout has local changes: never edit files there (`.env` and `backups/` are ignored and never touched).
- A dropped SSH connection kills `deploy.sh`. Run it again (on the VM or with `push-deploy.sh`, the push is then a no-op): a migration rolls back as a whole, bot/admin/ext/webapp stay stopped until then.

`deploy.sh`: dump → tag the running image `:previous` → `build --pull`, `pull db` → stop bot/admin/ext/webapp → `migrate` → DB roles → start. If the migration fails, the DB is unchanged (one transaction) and the previous image is started again.

- **Migrations applied in production are frozen**: never edit or regenerate them, only add new ones (`CLAUDE.md`).
- Never run migrations as `postgres`: only `migrate` (role `qm_owner`). Otherwise new tables have no grants and the app gets "permission denied".

## 8. Companion app release

Copy the builds (`…_x64-standalone.zip`, the AppImage, the Windows setup with its `.sig` next to it) and `companion.json` (`{"version":"x.y.z","windows":"<zip>","linux":"<AppImage>","windowsSetup":"<setup.exe>"}`) into `local/companion/` of the VM's checkout; the web app picks a new manifest up within seconds, no restart. Its version is the one it requires: older apps get the update panel, the installed one installs the setup itself. No manifest = no downloads and no version check; a setup without its `.sig` = the manifest is ignored. Building the setup and the release scripts live in the companion repo (`../sc-qm-companion`, `docs/companion.md` "Release").

The upload runs from `../sc-qm-companion` against its own `local/companion/` (the release files and `companion.json`): `scripts/publish-win-companion.ps1 w00zla@<vm>` (Windows: collects the build into that folder, then uploads) or `scripts/push-companion.sh w00zla@<vm>` (just the upload; `DEPLOY_PATH`/`-DeployPath` for another checkout path on the VM). It copies the files the manifest names, then the manifest. The manifest goes last: copied first, it would already send outdated apps to downloads that are not there yet. By hand (from the companion repo):

```sh
scp local/companion/<zip> local/companion/<AppImage> local/companion/<setup.exe> local/companion/<setup.exe>.sig w00zla@<vm>:/opt/sc-quartermaster/local/companion/
scp local/companion/companion.json w00zla@<vm>:/opt/sc-quartermaster/local/companion/
```

### Item thumbnails

After `pnpm thumbs:build` (`local/thumbs/`: `s/`, `m/`, `l/`, `thumbs.json`), from the local checkout:

```sh
scripts/push-thumbs.sh w00zla@<vm>
```

One tar stream over ssh into the VM's `local/thumbs/` (into the existing directory: the container's bind mount
stays valid), then `thumbs.json` under a temporary name and renamed, then every image the manifest no longer
names is deleted. ~23 MB for the full set; the web app and the bot pick the manifest up within seconds. The file names
carry a content hash, so clients keep what did not change. On an existing VM, `mkdir -p local/thumbs` before
the next `deploy.sh`: Docker would create it as root, and the push could not write into it.

## 9. Rollback

Code only (no migration in between):

```sh
docker tag sc-quartermaster:previous sc-quartermaster:latest
docker compose up -d
```

`:previous` is only the image before the **last** deploy. After a deploy that ran migrations, the old code may not match the new schema: restore the dump from before the deploy (§ 10) and then roll back the image.

## 10. Restore

Into a fresh volume (tested; the init creates the roles first, the dump carries owners and grants):

```sh
docker compose stop bot admin ext webapp
docker compose rm -sf db
docker volume rm sc-quartermaster_pgdata               # DELETES THE DATABASE
docker compose up -d --wait db                         # fresh volume: runs deploy/db-roles.sh
docker compose exec -T db pg_restore -U postgres -d quartermaster --exit-on-error < backups/<dump>
docker compose exec -T db bash -s < deploy/db-roles.sh
docker compose run --rm migrate                        # no-op unless the code is newer than the dump
docker compose up -d
```

Make the restore **at least once on purpose**, e.g. into a test VM, before you need it.

## 11. Operations

- Logs: `docker compose logs -f bot` (or `webapp`, …; rotated, 5 × 10 MB per container).
- Admin outside Caddy: none needed; for debugging `curl -u … http://127.0.0.1:3001/api/meta` on the VM.
- Old images: every build leaves untagged layers behind. Clean up now and then with `docker image prune`.
- **`docker compose down -v` deletes the database volume.** `down` without `-v` is harmless.
- Passwords: `QM_OWNER_PASSWORD`/`QM_APP_PASSWORD`/`QM_WEB_PASSWORD` change in `.env` and apply with the next `scripts/deploy.sh`. `POSTGRES_PASSWORD` only applies to a new volume; for an existing one: `docker compose exec db psql -U postgres -c "ALTER ROLE postgres PASSWORD '…'"`.
- Postgres major upgrade (18 → 19): not via the image tag. Dump, new volume with the new major, restore (§ 10).
