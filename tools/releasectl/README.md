# releasectl

The TUI for Quartermaster's releases: version bumps, tags, channels, publishing,
release notes and the data releases. One repository, two apps (the singleuser
desktop app `app/` and the `companion/`), each with its own version, tags and
update channels, plus data releases that are built locally. The tool is
adapted from BindSight's `releasectl`.

## The model

- **`main` is live.** Live versions `x.y.z` are tagged on main only.
- **A channel is a branch** `channel/<id>` cut from main. Its versions are
  `x.y.z-<id>.<n>`. The branch is shared: a channel may carry versions of the
  app, of the companion, or of both (each app is bumped on it separately).
- **Tags** per app: `app-vX.Y.Z` / `app-vX.Y.Z-<channel>.<n>` and
  `companion-vX.Y.Z` / `companion-vX.Y.Z-<channel>.<n>`. Data releases:
  `data-<game label>-<n>`.
- **`channels.json`** on main (`app`, `companion`: `stable` plus `channels`;
  `data`: `stable`) is written by CI when a release is published. releasectl
  reads it for its views and only ever removes a channel from it (Remove).
- **The version an app carries** is bumped in every file that holds it:

  | App | Files |
  |---|---|
  | app | `app/src-tauri/Cargo.toml` (what the app reports), `app/src-tauri/Cargo.lock`, root `package.json` (the server bundle's version, kept equal by a Rust test), `app/package.json` |
  | companion | `companion/src-tauri/Cargo.toml`, `companion/src-tauri/Cargo.lock`, `companion/package.json` |

  `tauri.conf.json` carries no version (Tauri takes Cargo's). If the files of
  an app do not agree on the current version, the bump refuses.

## Setup and start

Needs `uv`, `git` and a logged-in `gh`; for data releases also `pnpm` (with
the repository's dependencies installed). The tool lives in its own venv;
nothing outside `tools/releasectl/` is touched.

```sh
uv venv tools/releasectl/.venv
uv pip install --python tools/releasectl/.venv/Scripts/python.exe -r tools/releasectl/requirements.txt
```

Start it from the repository (or pass `--root`):

```sh
tools/releasectl/.venv/Scripts/python.exe -I tools/releasectl/run.py            # Linux: .venv/bin/python
tools/releasectl/.venv/Scripts/python.exe -I tools/releasectl/run.py --dry-run  # prints every command instead of running it
```

`d` toggles dry-run at any time. Release notes open in `$VISUAL` / `$EDITOR`,
else Notepad on Windows and `nano` elsewhere.

## Screen

- **Live and data**: the checked-out branch, main vs origin, one line per app
  (latest release, newest tag, commits on main since, the `stable` tag of
  `channels.json`; the app the actions work on is marked `>`), the data
  release (`data.stable` and the newest data tag) and problems (GitHub not
  reachable, broken `channels.json`). Buttons: **Switch app**, **Bump
  live**, **Data release**.
- **Channels of the app / companion**: one row per channel for the app
  that is switched on: branch (local / origin, ahead / behind main),
  *Testers get* (the tag `channels.json` lists, with its release state),
  *Newest* (the app's newest tag on the channel, with its state), warnings.
  Buttons New, Bump channel, Sync, Finalize, Remove act on the selected row
  and the switched-on app (Sync and New only touch the shared branch).
- **Drafts**: every unpublished release of all kinds (app, companion,
  data), with what it is for. Buttons Notes and Publish.
- **Log** tab: every command run and its output. **Build** tab: the CI run
  of a pushed app tag (`build-app.yml` / `build-companion.yml`), one row per
  job, steps of running or failed jobs below.

Every action shows the exact commands and waits for a yes. Pushes, GitHub
release changes and commits on main ask separately and start on Cancel. The
tool never force-pushes, rewrites history or deletes tags or releases, never
switches branches on a dirty tree (tracked changes; untracked files do not
count) and returns to the branch it started on.

## Actions

| Key | Action | What it does |
|---|---|---|
| `a` | Switch app | Toggles the app (app / companion) that Channels, Bump and Remove work on. Shown in the window's subtitle and the Channels title. |
| `n` | New | Creates `channel/<id>` from main, offers the push. The id must be unused by both apps. |
| `b` | Bump channel | Next version of the selected channel for the switched-on app (`x.y.z-<id>.<n>`) on its branch: pull, version in the app's files, commit, tag, push, optional build watch. |
| `l` | Bump live | The same on main for a live version (`x.y.z`) of the switched-on app. |
| `e` | Notes | Opens the selected draft's release notes in the editor, then saves them to GitHub. |
| `p` | Publish | Publishes the selected draft. A channel version becomes a pre-release (CI then moves the channel in `channels.json`); a live version a full release (not forced to GitHub's "latest": the updaters read tags); a data release a full release that never becomes "latest". |
| `s` | Sync | Merges main into the selected channel branch. A conflict aborts the merge and lists the files. |
| `f` | Finalize | Merges the selected channel into main, then offers Bump live for the switched-on app and for the other one when the channel carries versions of it. |
| `x` | Remove | Removes the channel from the switched-on app's list in `channels.json` on main; offers to delete the merged branch unless the other app still lists the channel. |
| `t` | Data release | See below. |
| `w` | Watch build | Follows the CI run of a pushed app tag in the Build tab (offered after every push, too). |
| `g` | Fetch | `git fetch` of branches and tags. |
| `r` | Refresh | Re-reads git and GitHub. |
| `q` | Quit | |

### Data release

Builds the four assets locally with `pnpm data:pack` and creates the GitHub
release as a **draft**; publishing is a separate step (Publish on the draft).

1. Asks for the snapshot (default: the newest file in `local/snapshots/`) and
   the thumbnails folder (default: `$THUMBS_DIR`, else `local/thumbs`).
2. Reads the game label from the snapshot and proposes `n` (one above the
   highest known `data-<label>-<n>`).
3. Takes the predecessor from `data.stable` in `channels.json` on origin/main:
   its `manifest.json` and `thumbs-update.zip` are downloaded with
   `gh release download` into `local/data-release/<tag>/previous/` and handed
   to `pnpm data:pack --previous`. No `data.stable` means a first release.
4. Runs `pnpm data:pack` into `local/data-release/<tag>/out/` (a confirmation
   shows both commands first).
5. Shows what was built (tag, predecessor, the four assets with sizes, the
   delta: size of `thumbs-update.zip` and the count of new pictures).
6. After a second, separate confirmation, `gh release create <tag> <assets>
   --draft`.

## Typical runs

**Live release of an app**: switch app (`a`), `l` → push → CI draft →
`e` notes → `p` publish.

**Channel** (one app or both):

1. `n` → `channel/<id>`, work there.
2. `b` → push → CI draft → `e` → `p`, once per app that is part of the test;
   testers pick the channel in the app's update dialog.
3. More fixes: `b` again. Live fixes they need: `s`.
4. Test validated: `f` (merge, then Bump live per app) → `e` → `p`.
5. `x` removes the channel per app; its testers fall back to stable.

**Data release**: `t` → check the summary → create the draft → select it in
Drafts → `e` → `p`.

## Tests

```sh
tools/releasectl/.venv/Scripts/python.exe -I -m unittest discover -s tools/releasectl/tests -t tools/releasectl
```

The pure logic (`core.py`) has unit tests. The UI tests run against a
throwaway repository with a local bare origin; GitHub is replaced (the
release list is canned and every `gh` / `pnpm` command is recorded and
faked), so nothing needs a network or the real remote.
