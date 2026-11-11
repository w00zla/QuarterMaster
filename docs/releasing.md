# Releasing

How the two desktop apps and the data packs are released. The model is BindSight's (branch per channel, draft release, publishing moves
the channel); the workflows are in `.github/workflows/`, the scripts in `scripts/`. A third tool, `releasectl` (`tools/releasectl/`),
automates the steps below; the steps stay valid by hand.

## What is released

| What | Tag | Version lives in | Built by | Installed by |
|---|---|---|---|---|
| the app (`app/`, singleuser shell) | `app-vX.Y.Z`, `app-vX.Y.Z-<channel>.<n>` | `app/src-tauri/Cargo.toml` | `build-app.yml` | its updater (`docs/app.md` "Updates and channels") |
| the companion (`companion/`) | `companion-vX.Y.Z`, `companion-vX.Y.Z-<channel>.<n>` | `companion/src-tauri/Cargo.toml` | `build-companion.yml` | its updater (`docs/companion.md`) |
| game data | `data-<game label>-<n>` | the snapshot's game label | by hand (`pnpm data:pack`) | the app's data updater (`docs/singleuser.md` "Updating the data") |

**Versions.** `Cargo.toml` is the version. `tauri.conf.json` of both apps has no `version` key, so Tauri takes `Cargo.toml`'s; the workflows
fail when a `version` appears there that differs. `package.json`'s `version` (`app/`, `companion/`) is not read by the build: keep it
equal by hand (the bump is `Cargo.toml`, `Cargo.lock`, `package.json`, one commit). The tag must equal the version, else the build stops
before anything is built. Semver orders what users see: `1.2.0-beta.3` < `1.2.0` (the final replaces the channel version).

**Branches and channels.** `main` is live: plain versions are tagged on `main` only. A channel is a branch `channel/<id>` cut from `main`; its
versions are `X.Y.Z-<id>.<n>`, tagged on that branch. A channel id is lower case letters, digits and `-`, starting with a letter, at most
32 characters, never `stable`. After a validated test the branch is merged into `main` and the plain version is tagged. A channel
disappears for its users when its entry is removed from `channels.json` (by hand; they fall back to stable).

## `channels.json` (repository root, on `main`)

One file for the three feeds, read raw from `https://raw.githubusercontent.com/w00zla/quartermaster/main/channels.json` without a token (so
the repository must be public). The app reads `app` (`app/src-tauri/src/update.rs`), the companion `companion`, the app's data updater
`data` (`src/datapack/feed.ts`); entries the reader does not know are ignored.

```json
{
  "app":       { "stable": "app-v1.0.0", "channels": [{ "id": "beta", "tag": "app-v1.1.0-beta.2" }] },
  "companion": { "stable": "companion-v2.2.0", "channels": [] },
  "data":      { "stable": "data-4.10.2.12913470-1" }
}
```

Nothing released is `"stable": null` and `"channels": []` (the committed state): the readers treat a null or absent stable tag, an absent
product and a 404 alike as "no update" / "no data channel", never as an error. The `stable` tag of `app` and `companion` must be a plain
version (a pre-release tag is dropped by the readers); a channel entry's tag must carry its own id. `release.yml` writes the file, nobody
else should (`scripts/channels-set.mjs <tag>` is the same step by hand).

## What CI does

- **`build-app.yml` / `build-companion.yml`**, on a tag `app-v*` / `companion-v*` (and `workflow_dispatch`: a test build on any branch,
  artifacts for 14 days, no release):
  1. *Tests*: tag against `Cargo.toml`, typecheck, Node tests, Rust tests (app: the root `pnpm typecheck`, `pnpm test:pglite` = the whole
     suite on PGlite in the process, `cargo test` and `cargo clippy -D warnings` of `app/src-tauri`; companion: its SPA typecheck,
     `test/companion-*.test.ts`, `cargo test --release` of `companion/src-tauri`).
  2. *Build* on Linux (AppImage) and Windows (NSIS setup), signed with the secrets `TAURI_SIGNING_PRIVATE_KEY` /
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (one key for both apps; its public half is in both `tauri.conf.json`). App: `pnpm app:build`;
     companion: `pnpm companion:directml` (Windows) and `pnpm companion:build`. The release build keeps the updater's http switch off (below).
  3. *Draft release* for the tag (a tag with `-` is marked pre-release): the installers, their `.sig` files and `latest.json`
     (`scripts/latest-json.mjs`), which names the assets of exactly that release. Release assets: app `Quartermaster_<v>_x64-setup.exe`,
     `Quartermaster_<v>_amd64.AppImage`; companion `Quartermaster-Companion_<v>_…` (the bundler's space becomes `-`). The draft is not
     `latest` (`--latest=false`): neither app uses GitHub's "latest release", only tags.
- **`release.yml`**, when a release is **published** (a draft made public, by hand): by the tag's prefix it writes the tag into
  `channels.json` on `main` (`app`/`companion`: `stable` for a plain version, the channel entry for `-<channel>.<n>`, created on the
  channel's first version; `data`: `stable`; a tag that is not newer than the listed one leaves the file alone), rewrites the README's
  download table (`scripts/readme-downloads.mjs`, the `release_dls` block) and commits both as `github-actions[bot]`. A manual run with a tag
  redoes this for a release already published.

A release is live only when it is published **and** `channels.json` names it: publishing is the single switch.

**The updater's http switch.** The updater plugin refuses an http endpoint in a release build unless `dangerousInsecureTransportProtocol` is
on. `tauri.conf.json` has it off; `tauri.testfeed.conf.json` turns it on for the smoke test's local feed only (`QM_TEST_FEED=1`, set by
`pnpm app:smoke`, never by CI). The endpoint is not configured in the plugin's config: `update.rs` builds it per check (GitHub's https
addresses, or `QM_APP_FEED` = `http://127.0.0.1:<port>`).

## Cutting an app or companion release

1. Branch: `main` for a plain version, `channel/<id>` (cut from `main`) for a channel version.
2. Bump the version (`Cargo.toml`, `Cargo.lock`, `package.json`), commit. Push the branch (and merge the PR for `main`).
3. Tag and push the tag:
   ```sh
   git tag app-v1.1.0-beta.1 && git push origin app-v1.1.0-beta.1      # companion: companion-v…
   ```
4. Watch the run (`gh run list --workflow build-app.yml`, `gh run watch <id> --exit-status`). A failed run leaves no release; fix, delete
   the tag (`git push origin :refs/tags/<tag>`, `git tag -d <tag>`), tag again.
5. Open the draft (GitHub, Releases), check the assets, then **publish**. The `notes` of `latest.json` (what the update dialog shows)
   are empty: CI writes no notes, and the draft's own text is not read by the apps.
6. `release.yml` commits to `main` (`channels.json`, README); pull. From then on the apps of that channel see the update at their next
   check (the app at its start and on a click, the companion as it decides).

A test build without release: Actions, "Build app" / "Build companion", Run workflow on the branch.

## Cutting a data pack

Built on the maintainer's machine (the game data stays local; `docs/catalog-sources.md`, `docs/singleuser.md` "The data pack"):

```sh
pnpm data:pack --snapshot <snapshot.json.gz> --thumbs <thumbs dir> --n <n> --out <out dir> [--previous <previous out dir>]
```

`<out dir>` then holds the four assets: `manifest.json`, `quartermaster-data-<label>-<n>.zip` (the full pack), `catalog.json.gz`,
`thumbs-update.zip`; the command prints the tag. Publish them as a release with that tag (checks first: the printed sizes and hashes, the
tag is `data-<label>-<n>` with the snapshot's label):

```sh
gh release create data-<label>-<n> <out>/manifest.json <out>/quartermaster-data-<label>-<n>.zip <out>/catalog.json.gz <out>/thumbs-update.zip \
  --title "Game data <label> (<n>)" --notes "" --latest=false
```

Creating the release publishes it, which runs `release.yml`: `data.stable` in `channels.json` becomes the tag and the apps pick it up at
their next data check. Keep `<out dir>` for the next pack's `--previous`. The data feed has no channels: only `data.stable`.

## Once, before the first release

- **Secrets** (repository settings, Actions): `TAURI_SIGNING_PRIVATE_KEY` (the minisign private key as one line, or its file's content),
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty if the key has none). The key pair is the one whose public key is in both `tauri.conf.json`.
- **Visibility:** the apps read `raw.githubusercontent.com` and the release assets without a token, so the repository must be public.
- **Actions permissions:** workflow permissions "Read and write" (the workflows ask `contents: write` themselves), and Actions allowed to
  create releases.
- **The ruleset on `main`** (pull requests only) must let `github-actions[bot]` push to `main` (bypass list), or `release.yml`'s commit is
  refused. Nothing else pushes to `main` directly.
- The first channel tag's run shows whether the NSIS bundler takes a pre-release version (`X.Y.Z-<channel>.<n>`).

## Not built

No Authenticode signing (installers and executables are unsigned; the updater's signature is a different thing), no macOS build, no
`.deb`/`.rpm`/standalone zip (BindSight has them; here the AppImage and the NSIS setup are what the updaters install), no release notes
automation, no automatic removal of channels.
