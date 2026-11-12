# Releasing

How the two desktop apps and the data packs are released, and how `main` is protected. The model is BindSight's (branch per channel, draft
release, publishing moves the channel) with one change: `main` takes pull requests only, so the feed file does not live there but on a
branch of its own that only CI writes. The workflows are in `.github/workflows/`, the scripts in `scripts/`. A third tool, `releasectl`
(`tools/releasectl/`), automates the steps below; the steps stay valid by hand.

## `main`: pull requests only

A ruleset on `main` (below, "Once, before the first release") allows nothing but pull requests: squash merge as the only merge method, no
deletion, no force push, the three jobs of `ci.yml` as required status checks, **no bypass for anyone**, the GitHub Actions bot included.
So nothing in CI commits to `main`: the feed file is on the `channels` branch (below), the README is edited by hand, and a version bump is
a pull request like any change.

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

**Branches and channels.** `main` is live: a plain version is bumped by a pull request to `main` and tagged on its squash merge commit. A
channel is a branch `channel/<id>` cut from `main`; its versions are `X.Y.Z-<id>.<n>`, committed on that branch (the ruleset covers `main`
only) and tagged there. A channel id is lower case letters, digits and `-`, starting with a letter, at most 32 characters, never `stable`.
After a validated test the channel is brought to `main` by a pull request, and the plain version is tagged on the merge commit. A channel
disappears for its users when its entry is removed from `channels.json` (`channels.yml`, below; they fall back to stable).

## `channels.json` (the feed, on the `channels` branch)

One file for the three feeds, at the root of the branch `channels`, read raw from
`https://raw.githubusercontent.com/w00zla/quartermaster/channels/channels.json` without a token (so the repository must be public). The
branch holds nothing else, and only CI writes it, as `github-actions[bot]`: `release.yml` (a release is published) and `channels.yml` (a
channel is removed). It is not on `main` because `main` takes no direct pushes. `release.yml` creates the branch, as an orphan with the file
as its only content, when it does not exist yet. The app reads `app` (`app/src-tauri/src/update.rs`), the companion `companion`
(`companion/src-tauri/src/update.rs`), the app's data updater `data` (`src/datapack/feed.ts`); entries the reader does not know are
ignored. The readers use this address from their first release on: no released app ever knew another one, which is why the file could
still move.

```json
{
  "app":       { "stable": "app-v1.0.0", "channels": [{ "id": "beta", "tag": "app-v1.1.0-beta.2" }] },
  "companion": { "stable": "companion-v2.2.0", "channels": [] },
  "data":      { "stable": "data-4.10.2.12913470-1" }
}
```

Nothing released is `"stable": null` and `"channels": []` (`test/release-feed/channels.json` is that file, the tests' fixture): the readers
treat a null or absent stable tag, an absent product, a missing file and a missing branch (404) alike as "no update" / "no data channel",
never as an error. The `stable` tag of `app` and `companion` must be a plain version (a pre-release tag is dropped by the readers); a
channel entry's tag must carry its own id. Nobody edits the file by hand: `scripts/channels-set.mjs <tag>` and
`scripts/channels-remove.mjs <product> <channel>` are the steps CI runs (running them on a local copy of the file is fine).

## What CI does

- **`ci.yml`**, on every pull request to `main` (and by hand, on any branch): three jobs, **the required checks of the ruleset**:

  | Job name (the check) | Runs |
  |---|---|
  | `Node tests` | root `pnpm typecheck`, the companion SPA's typecheck, `pnpm test:pglite` (the whole node suite on PGlite in the process: no Postgres, no game data; it includes `test/release-scripts.test.ts` and `test/companion-*.test.ts`) |
  | `App Rust tests` | `cargo test` and `cargo clippy --all-targets -- -D warnings` in `app/src-tauri` |
  | `Companion Rust tests` | `cargo test --release` in `companion/src-tauri` (the heavy one: the OCR stack) |

  A required check that never reports blocks the merge, so there is no workflow-level `paths:` filter: every job always starts, asks
  `scripts/ci-scope.mjs` (from the pull request's changed files, read with `gh api`) whether the pull request touches anything it covers,
  and otherwise skips its heavy steps and ends green (the log says why). `Node tests` is skipped only when every changed file is under
  `docs/`, `assets/` or `tools/`, is a `.md` file, or is a build, release or channels workflow; `App Rust tests` runs for `app/**`, the root
  `package.json` (the app's Rust reads its version) or `ci.yml`; `Companion Rust tests` for `companion/**` or `ci.yml`. A manual run runs
  everything. The test steps repeat those of the "Tests" jobs of the two build workflows (which run on a tag and also check the version):
  they are copied, not shared through a reusable workflow, and must be kept in step.
- **`build-app.yml` / `build-companion.yml`**, on a tag `app-v*` / `companion-v*` (and `workflow_dispatch`: a test build on any branch,
  artifacts for 14 days, no release):
  1. *Tests*: tag against `Cargo.toml`, typecheck, Node tests, Rust tests (app: the root `pnpm typecheck`, `pnpm test:pglite`, `cargo test`
     and `cargo clippy -D warnings` of `app/src-tauri`; companion: its SPA typecheck, `test/companion-*.test.ts`, `cargo test --release` of
     `companion/src-tauri`).
  2. *Build* on Linux (AppImage) and Windows (NSIS setup), signed with the secrets `TAURI_SIGNING_PRIVATE_KEY` /
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the production key pair, for both apps; its public half is in both `tauri.conf.json`, and the workflows set `QM_UPDATER_KEY=prod` so the build keeps it). App: `pnpm app:build`;
     companion: `pnpm companion:directml` (Windows) and `pnpm companion:build`. The release build keeps the updater's http switch off (below).
  3. *Draft release* for the tag (a tag with `-` is marked pre-release): the installers, their `.sig` files and `latest.json`
     (`scripts/latest-json.mjs`), which names the assets of exactly that release. Release assets: app `Quartermaster_<v>_x64-setup.exe`,
     `Quartermaster_<v>_amd64.AppImage`; companion `Quartermaster-Companion_<v>_…` (the bundler's space becomes `-`), and for Windows also `Quartermaster-Companion_<v>_x64-standalone.zip` (the bare executable with `DirectML.dll`; it does not update itself). The draft is not
     `latest` (`--latest=false`): neither app uses GitHub's "latest release", only tags.
- **`release.yml`**, when a release is **published** (a draft made public, by hand): by the tag's prefix it writes the tag into
  `channels.json` on the `channels` branch (`app`/`companion`: `stable` for a plain version, the channel entry for `-<channel>.<n>`,
  created on the channel's first version; `data`: `stable`; a tag that is not newer than the listed one leaves the file alone) and commits
  it there as `github-actions[bot]`; the branch is created when missing. It does not touch `main`. A manual run with a tag redoes this for
  a release already published.
- **`channels.yml`**, started by hand only (`workflow_dispatch`), so that "only CI writes the feed" also holds for removals. Inputs:
  `product` (`app` | `companion`), `channel` (the channel id), `action` (`remove`). It removes that channel's entry from `channels.json` on
  the `channels` branch and commits. The release tool calls it: `gh workflow run channels.yml -f product=app -f channel=beta -f action=remove`.
  `release.yml` and `channels.yml` share the concurrency group `channels-json`, so two writers never push at once.

A release is live only when it is published **and** `channels.json` names it: publishing is the single switch.

**The updater's http switch.** The updater plugin refuses an http endpoint in a release build unless `dangerousInsecureTransportProtocol` is
on. `tauri.conf.json` has it off; `tauri.testfeed.conf.json` turns it on for the smoke test's local feed only (`QM_TEST_FEED=1`, set by
`pnpm app:smoke`, never by CI). The endpoint is not configured in the plugin's config: `update.rs` builds it per check (GitHub's https
addresses, or `QM_APP_FEED` = `http://127.0.0.1:<port>`).

## Cutting an app or companion release

1. **A plain version:** a pull request to `main` that bumps the version (`Cargo.toml`, `Cargo.lock`, `package.json`); its checks are
   `ci.yml`'s. After its squash merge, the **merge commit** gets the tag `app-vX.Y.Z` / `companion-vX.Y.Z`. **A channel version:** commit the
   bump on `channel/<id>` (cut from `main`; the ruleset does not cover it) and tag that commit `app-vX.Y.Z-<id>.<n>`. Bringing a channel to
   `main` is a pull request from `channel/<id>`.
2. Push the tag; the tag starts the build:
   ```sh
   git tag app-v1.1.0-beta.1 <commit> && git push origin app-v1.1.0-beta.1      # companion: companion-v…
   ```
3. Watch the run (`gh run list --workflow build-app.yml`, `gh run watch <id> --exit-status`). A failed run leaves no release; fix, delete
   the tag (`git push origin :refs/tags/<tag>`, `git tag -d <tag>`), tag again.
4. Open the draft (GitHub, Releases), check the assets, then **publish**. The `notes` of `latest.json` (what the update dialog shows)
   are empty: CI writes no notes, and the draft's own text is not read by the apps.
5. `release.yml` writes the tag into `channels.json` on the `channels` branch (nothing to pull: `main` is not touched). From then on the
   apps of that channel see the update at their next check (the app at its start and on a click, the companion as it decides).
6. A channel that is done: remove its entry with `channels.yml` (above).

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

Creating the release publishes it, which runs `release.yml`: `data.stable` in `channels.json` (on the `channels` branch) becomes the tag and
the apps pick it up at their next data check. Keep `<out dir>` for the next pack's `--previous`. The data feed has no channels: only
`data.stable`.

## Once, before the first release

- **Secrets** (repository settings, Actions): `TAURI_SIGNING_PRIVATE_KEY` (the minisign private key as one line, or its file's content),
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty if the key has none). It is the **production** pair, whose public key is in both `tauri.conf.json`. Two updater key pairs, each serving both apps: **production** (public key in both `tauri.conf.json`; private key and password only in the repository's Actions secrets and the maintainer's safe; a build keeps this public key only with `QM_UPDATER_KEY=prod`, which the build workflows set) and **development** (public key in `tauri.devkey.conf.json` of each app, added by `scripts/build.mjs` to every other build; private key in the maintainer's environment for local signed builds and the smoke test's feed). A local build therefore never accepts production updates as its own and can never pass as a release; an installed release accepts nothing signed with the development key. Losing the production private key means no installed app can ever be updated again.
- **Visibility:** the apps read `raw.githubusercontent.com` and the release assets without a token, so the repository must be public.
- **Actions permissions** (Settings, Actions, General): workflow permissions "Read and write permissions" (the workflows ask `contents: write`
  themselves, because `release.yml` and `channels.yml` push to `channels` and the build workflows create releases); "Allow GitHub Actions to
  create and approve pull requests" is not needed. **Workflow files must be on `main`:** a `workflow_dispatch` workflow (`channels.yml`, a
  manual `ci.yml` run) is only offered once its file is on the default branch, and `ci.yml` reports no check before it is there. A
  `release` event runs the workflow file as it is on the tagged commit, so a channel cut before this change needs the new `release.yml`
  merged into it before its release is published.
- **The ruleset on `main`** (Settings, Rules, Rulesets, New branch ruleset; name "main: pull requests only"; enforcement Active; target: the
  default branch). The same as sc-ohseearr's:
  - Restrict deletions; block force pushes.
  - Require a pull request before merging, **allowed merge methods: squash only** (required approvals 0: a one-person repository).
  - Require status checks to pass: `Node tests`, `App Rust tests`, `Companion Rust tests` (the job names of `ci.yml`; GitHub offers a name
    only after a run reported it).
  - **Bypass list: empty**, not the repository admin and not the GitHub Actions bot: nothing in CI pushes to `main`.
  - No ruleset on `channels` or `channel/*` that blocks `github-actions[bot]` or direct pushes: `channels` is written by CI only, and
    the channel branches take the release tool's commits.
- **Order:** merge the pull request that brings `ci.yml`, `channels.yml` and the new `release.yml` to `main` first (while `main` can still
  take it, or by the ruleset's own rules once created without the required checks), then add the required checks: a required check that no
  workflow can report blocks every pull request.
- The first channel tag's run shows whether the NSIS bundler takes a pre-release version (`X.Y.Z-<channel>.<n>`).

## Not built

No Authenticode signing (installers and executables are unsigned; the updater's signature is a different thing), no macOS build, no
`.deb`/`.rpm` and no app standalone zip (BindSight has them; here the AppImage and the NSIS setup are what the updaters install; the companion's standalone zip only compares versions), no release notes
automation, no automatic removal of channels (`channels.yml` removes one on request), no generated download table in the README (it
links to the releases page).
