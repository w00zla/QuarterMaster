# releasectl

The TUI for Quartermaster's releases: version bumps, tags, channels, publishing,
release notes and the data releases. One repository, two apps (the singleuser
desktop app `app/` and the `companion/`), each with its own version, tags and
update channels, plus data releases that are built locally. The tool is
adapted from BindSight's `releasectl`.

## The model

- **`main` is protected**: pull requests only, squash merge as the only merge
  method, required status checks, no bypass for anyone. **The tool never pushes
  to `main`**: a live version goes through a pull request that the tool opens,
  shows (state and checks) and merges on your explicit yes. The tool contains no
  code path that pushes the default branch (one function builds every push and
  refuses `main`; a test checks the commands of every run).
- **Live versions `x.y.z`** are tagged on the **squash commit** the merge leaves
  on `main`, after the merge. Every release step starts from `origin/main`; the
  local `main` is never touched (pull it yourself when you want it current).
- **A channel is a branch** `channel/<id>` cut from `origin/main`. Its versions
  are `x.y.z-<id>.<n>`, committed and tagged on that branch and pushed there
  directly (channel branches are not under the ruleset). The branch is shared: a
  channel may carry versions of the app, of the companion, or of both (each app
  is bumped on it separately).
- **Tags** per app: `app-vX.Y.Z` / `app-vX.Y.Z-<channel>.<n>` and
  `companion-vX.Y.Z` / `companion-vX.Y.Z-<channel>.<n>`. Tags are not under the
  ruleset: the tool pushes them directly, and a tag starts the build workflow.
  Data releases: `data-<game label>-<n>`.
- **`channels.json`** (the feed: `app`, `companion`: `stable` plus `channels`;
  `data`: `stable`) lives on the branch **`channels`** (file at its root), which
  only CI writes. releasectl reads it from `origin/channels:channels.json` for
  its views; a missing branch or file means "nothing released yet", not an error.
  It never writes the feed: Remove starts the `channels.yml` workflow.
- **The version an app carries** is bumped in every file that holds it:

  | App | Files |
  |---|---|
  | app | `app/src-tauri/Cargo.toml` (what the app reports), `app/src-tauri/Cargo.lock`, root `package.json` (the server bundle's version, kept equal by a Rust test), `app/package.json` |
  | companion | `companion/src-tauri/Cargo.toml`, `companion/src-tauri/Cargo.lock`, `companion/package.json` |

  `tauri.conf.json` carries no version (Tauri takes Cargo's). If the files of
  an app do not agree on the current version, the bump refuses. All files of an
  app are committed together.

## Setup and start

Needs `uv`, `git` and a logged-in `gh` that may **push branches and tags, create
and merge pull requests and run workflows** on the repository; for data
releases also `pnpm` (with the repository's dependencies installed). The tool
lives in its own venv; nothing outside `tools/releasectl/` is touched.

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

- **Live and data**: the checked-out branch, the local main vs origin (the tool
  works on `origin/main`, so a local main that is behind is normal), one line
  per app (latest release, newest tag, commits on `origin/main` since, the
  `stable` tag of the feed; the app the actions work on is marked `>`), the data
  release (`data.stable` and the newest data tag), **unfinished** release work
  (see Bump live) and problems (GitHub not reachable, broken `channels.json`).
  Buttons: **Switch app**, **Bump live**, **Data release**.
- **Channels of the app / companion**: one row per channel for the app
  that is switched on: branch (local / origin, ahead / behind `origin/main`),
  *Testers get* (the tag the feed lists, with its release state), *Newest* (the
  app's newest tag on the channel, with its state), warnings. Buttons New, Bump
  channel, Sync, Finalize, Remove act on the selected row and the switched-on
  app (Sync and New only touch the shared branch).
- **Drafts**: every unpublished release of all kinds (app, companion,
  data), with what it is for. Buttons Notes and Publish.
- **Log** tab: every command run and its output. **Build** tab: the CI run
  of a pushed app tag (`build-app.yml` / `build-companion.yml`) or of a started
  workflow (`channels.yml`), one row per job, steps of running or failed jobs
  below.

Every action shows the exact commands and waits for a yes. Pushes, pull request
and workflow calls and GitHub release changes ask separately (sensitive) and
start on Cancel. The tool never force-pushes, rewrites history or deletes tags
or releases, never merges automatically (`gh pr merge` is always called with
`--squash --delete-branch`, never `--auto` or `--admin`, and only after your
yes), never switches branches on a dirty tree (tracked changes; untracked files
do not count) and returns to the branch it started on.

## Actions

| Key | Action | What it does |
|---|---|---|
| `a` | Switch app | Toggles the app (app / companion) that Channels, Bump and Remove work on. Shown in the window's subtitle and the Channels title. |
| `n` | New | Fetches, creates `channel/<id>` from `origin/main`, offers the push. The id must be unused by both apps. |
| `b` | Bump channel | Next version of the selected channel for the switched-on app (`x.y.z-<id>.<n>`) on its branch: pull, version in the app's files, commit, tag, push of the branch and the tag, optional build watch. Direct, no pull request. |
| `l` | Bump live | A new live version of the switched-on app through a pull request, or the continuation of unfinished work. See below. |
| `e` | Notes | Opens the selected draft's release notes in the editor, then saves them to GitHub. |
| `p` | Publish | Publishes the selected draft. A channel version becomes a pre-release (CI then moves the channel in the feed); a live version a full release (not forced to GitHub's "latest": the updaters read tags); a data release a full release that never becomes "latest". |
| `s` | Sync | Fetches and merges `origin/main` into the selected channel branch, then offers the push of the channel. A conflict aborts the merge and lists the files. |
| `f` | Finalize | Brings the selected channel to `main` through one pull request, with the live bump(s). See below. |
| `x` | Remove | Starts the `channels.yml` workflow that removes the channel from the switched-on app's list in the feed; offers to delete the merged branch unless the other app still lists the channel. |
| `t` | Data release | See below. |
| `w` | Watch build | Follows the CI run of a pushed app tag in the Build tab (offered after every push, too). |
| `g` | Fetch | `git fetch` of branches and tags. |
| `r` | Refresh | Re-reads git and GitHub. |
| `q` | Quit | |

### Bump live: a pull request, a gate, the tag

1. Version (proposal: next minor above the latest release). Then one fetch
   (offered), then **one sensitive confirmation** that shows every command:
   - `git checkout --no-track -b release/<app>-v<version> origin/main`
   - the version files written (all files of the app together), `git add`,
     `git commit`
   - `git push -u origin release/<app>-v<version>`
   - `gh pr create --base main --head release/... --title "Bump <app> version to
     <version>" --body ...`

   The tool then returns to the branch it started on. A failure before the push
   undoes the local branch; after the push it says what to do by hand.
2. **The gate**: the pull request's state and checks (`gh pr view --json`: how
   many passed, are pending, failed, the merge state) are shown in the log and
   in a pick: *Refresh* (read again, as often as you like), *Merge now (squash)*
   or *Leave it for later*. Merge asks once more, with the exact command
   `gh pr merge release/... --squash --delete-branch` (a warning in the dialog
   when checks are pending or failing; GitHub itself refuses while required
   checks are not satisfied). A no brings the pick back.
3. **The tag**: after the merge the tool fetches, finds the squash commit on
   `origin/main` (the commit that introduced the version in the app's
   `Cargo.toml`), checks that **every file of the app carries exactly that
   version** (and names any other file the commit changed), and after another
   sensitive confirmation creates the annotated tag (`app-vX.Y.Z`, message
   `Quartermaster app X.Y.Z`) **on that commit** and pushes the tag. The tag
   starts the build workflow; the tool offers to watch it.

**Leaving and coming back**: the screen lists *unfinished* work, and Bump live
offers it first (a pick, with "Start a new bump" last):
- an **open pull request** (`release/...` or a channel's): merge it (the gate),
  then the tag;
- a pushed `release/...` branch **without a pull request**: open it, then the
  gate;
- a bump **merged but not tagged** (merged in the browser, or the tag was
  declined): the tag step. Detected from git alone: the live version on
  `origin/main` is above every live tag and has no tag.

(A fresh checkout whose `main` carries an untagged version, e.g. a first
`0.1.0`, shows up as such an untagged bump; tag it or ignore it.)

### Finalize: a channel to main

One pull request does everything (chosen over a channel merge followed by one
bump pull request per app: that costs a CI run each and leaves a `main` that
carries the channel's pre-release version in between; this way the checks run on
exactly what is released).

1. Fetch (offered). For **each app the channel carried** the live version is
   asked (proposal: the channel version's base); Esc cancels the whole finalize
   (skipping would put the channel's pre-release version on `main`). An app the
   channel never touched is not asked: use Bump live afterwards if it needs one.
2. Switch to `channel/<id>` and pull it, then one sensitive confirmation: per
   app the version files, `git add`, `git commit` (the bumps become the **last
   commits of the channel branch**), `git push origin channel/<id>` (with `-u`
   when origin does not have it yet), `gh pr create --base main --head
   channel/<id> --title "Finalize channel <id>: app 0.2.0, companion 2.2.0"`.
   A hint says when the branch is behind `origin/main` (run Sync first if the
   merge is not clean).
3. The same gate (state, checks, refresh, merge by squash on your yes). The
   channel PR is merged **without** `--delete-branch`.
4. Every bumped app's tag goes on the squash commit, each after its own
   confirmation (verified as above), then the branch is offered for deletion.

**What a squash merge does to the channel branch**: it is not an ancestor of
`main` afterwards (its commits live on as one new commit). The channel ends with
the finalize; do not keep working on the branch. The tool therefore recognizes a
merged channel by its merged pull request (the branch tip is the pull request's
head) and offers `git branch -D` locally (the dialog says why `-D`) and
`git push origin --delete channel/<id>`. Afterwards publish the drafts and
Remove the channel (per app).

If the pull request already exists when you press Finalize, it is continued
(gate, tags, deletion offer) instead of started again.

### Remove

The feed is written by CI only, so Remove does not commit anything: after the
usual sensitive confirmation it runs

```
gh workflow run channels.yml -f product=<app|companion> -f channel=<id> -f action=remove
```

and says that **the feed changes when that run is through** (the testers fall
back to stable at their next check). It offers to watch the run in the Build tab
(the run of `workflow_dispatch` created just after the call); refresh with `r`
afterwards. The channel branch deletion is offered as before (only for a merged
branch, and not while the other app still lists the channel).

### Data release

Builds the four assets locally with `pnpm data:pack` and creates the GitHub
release as a **draft**; publishing is a separate step (Publish on the draft).

1. Asks for the snapshot (default: the newest file in `local/snapshots/`) and
   the thumbnails folder (default: `$THUMBS_DIR`, else `local/thumbs`).
2. Reads the game label from the snapshot and proposes `n` (one above the
   highest known `data-<label>-<n>`).
3. Takes the predecessor from `data.stable` in `channels.json` on
   `origin/channels`: its `manifest.json` and `thumbs-update.zip` are downloaded
   with `gh release download` into `local/data-release/<tag>/previous/` and
   handed to `pnpm data:pack --previous`. No `data.stable` means a first release.
4. Runs `pnpm data:pack` into `local/data-release/<tag>/out/` (a confirmation
   shows both commands first).
5. Shows what was built (tag, predecessor, the four assets with sizes, the
   delta: size of `thumbs-update.zip` and the count of new pictures).
6. After a second, separate confirmation, `gh release create <tag> <assets>
   --draft`.

## Dry-run

Every step of every action above is printed instead of run: the branch, the
file writes, the commit, the push, `gh pr create`, the merge, the fetch, the tag
(its commit shown as `<squash commit on origin/main>`, since there is none yet),
the tag push, the workflow call. A dry run reads (fetch results of earlier
runs, `gh` queries) but changes nothing. After a dry-run bump the gate is
skipped: it prints what it would do and goes on as if the merge had happened.

## Typical runs

**Live release of an app**: switch app (`a`), `l` → version → confirm the
branch / pull request → wait for the checks (Refresh) → Merge now → confirm →
tag confirmation → CI draft → `e` notes → `p` publish.

**Channel** (one app or both):

1. `n` → `channel/<id>`, work there.
2. `b` → push → CI draft → `e` → `p`, once per app that is part of the test;
   testers pick the channel in the app's update dialog.
3. More fixes: `b` again. Live fixes they need: `s`.
4. Test validated: `f` (versions, pull request, merge, tags) → `e` → `p` per
   draft.
5. `x` removes the channel per app (a workflow run); its testers fall back to
   stable.

**Data release**: `t` → check the summary → create the draft → select it in
Drafts → `e` → `p`.

## Tests

```sh
tools/releasectl/.venv/Scripts/python.exe -I -m unittest discover -s tools/releasectl/tests -t tools/releasectl
```

The pure logic (`core.py`) has unit tests. The UI tests run against a
throwaway repository with a local bare origin whose pre-receive hook refuses
pushes to `main` (the ruleset); GitHub is replaced (the release list is canned,
`gh` queries are answered from a fake with pull requests and their checks, the
squash merge is made by a helper standing for GitHub, and every `gh` / `pnpm`
command is recorded and faked), so nothing needs a network or the real remote.
Every UI test also asserts that none of the recorded commands pushes `main`.
