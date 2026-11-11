# The desktop app (the shell)

`app/` is the desktop program of the singleuser variant: a Tauri 2 program of its own (no OCR, not the companion) that starts
the singleuser server as a Node sidecar, shows the loading steps on a splash, then shows the web app in its window, and gives
the web app the native functions of the shell contract. The server it runs is described in `docs/singleuser.md` ("The app
bundle", "The start protocol", "Stdin control", "One process per data folder"); the contract the web app calls in
`docs/webapp.md` ("The desktop shell (the contract)").

| Path | What |
|---|---|
| `app/src-tauri/` | the Rust program (`quartermaster`): `lib.rs` (the start, the window, the commands), `protocol.rs` (the start protocol's lines), `bundle.rs` (`bundle.json`), `sidecar.rs` (the server process), `settings.rs` (`autoUpdate`), `update.rs` (app updates), `config.rs` (the chosen channel), `texts.rs` (the shell's own texts) |
| `app/src-tauri/capabilities/` | `splash.json` (the app's own page), `webapp.json` (the web app's origin in the main window) and `settings.json` (the settings window) |
| `app/src-tauri/tauri.conf.json` | the window, the splash's CSP, the updater's public key; `tauri.windows.conf.json` (NSIS), `tauri.bundle.conf.json` (the sidecar and the server bundle, passed by the build script), `tauri.updater.conf.json` (updater artifacts, passed when the signing key is there), `tauri.testfeed.conf.json` (the updater's http switch, only for the smoke test's build) |
| `app/splash/` | the splash: one `index.html` with inline CSS and JS and the fonts (copies of `adminapp/src/assets/fonts/`); no framework, no build step |
| `app/scripts/` | `fetch-node.mjs` (the sidecar binary), `build.mjs` (the build), `smoke.mjs` (the smoke test) |

The app's icon files are in `app/src-tauri/icons/` (the chest; the companion has its own, the same chest seen through a helmet visor, in `companion/src-tauri/icons/`).
Identifier `com.w00zla.quartermaster`, product name and window title "Quartermaster", executable `quartermaster`.

## The start

1. **Single instance** (below): a second start ends before anything else happens.
2. The window opens with the splash (frameless, 1440 × 900, at least 1280 × 720: the web app's bar stays one row from 1280 px).
3. The server bundle is found: `QM_APP_BUNDLE` if set, else `server/` in the app's resources. `bundle.json` gives the Node flags and the
   splash texts. A missing or broken bundle is "Start failed.".
4. **The update at start**, only when "Updates automatisch" is on (`autoUpdate` in `<data folder>/settings.json`, default true; a
   missing or unreadable file is true; `QM_AUTO_UPDATE=0` is off): one check of the app's update feed, at most 5 s. An update that is
   found is downloaded and installed at once, the splash says "Update wird installiert …" / "Installing update …", and the app
   restarts into the new version. No answer in 5 s, no update, or an update that cannot be installed (the error is logged and stays
   the updater's state): the start goes on. With the switch off nothing is asked.
5. The server is started; its protocol lines move the splash; at `QM_READY <origin>` the window goes to that origin.

**No other network request is made by the shell:** the update feed (at start with the switch on, or on a click in the update dialog)
is the only one. The server's own requests (the data update, UEX with a key) are the server's (`docs/singleuser.md`).

## The sidecar

The server runs as `node <nodeFlags> <bundle>/server.mjs` with the bundle folder as its working directory, stdin, stdout and stderr
piped, no console window. `node` is the official Node of the pinned version (`NODE_VERSION` in `src/singleuser/app-bundle.ts`, also in
`bundle.json`), shipped beside the app's executable as Tauri's `externalBin`.

**Environment** (`sidecar::spec`): the child inherits the shell's environment with these changes:

| Variable | Value |
|---|---|
| `QM_MIGRATIONS_DIR` | `<bundle>/drizzle` |
| `QM_DIST_DIR` | `<bundle>/web` |
| `QM_STDIN_CONTROL` | `1` |
| `QM_CSP_CONNECT` | `http://ipc.localhost` on Windows, `ipc:` elsewhere ("IPC and the Content-Security-Policy") |
| `QM_DATA_DIR`, `QM_PORT`, `QM_PAIRING_FILE`, `QM_GAME_DIR`, `QM_AUTO_UPDATE`, `QM_DATA_FEED` | handed on when set in the shell's own environment (development, tests) |
| every other `QM_*` variable, `NODE_OPTIONS` | removed |

**Output:** stdout is read line by line (`protocol::parse_line`). `QM_STEP <step>` lights a segment and sets the text, `QM_READY <origin>`
sends the window there, `QM_FATAL <code>` shows the failure. `QM_READY` is taken only with an origin of the form
`http://127.0.0.1:<port>`; anything else counts as a failed start. Every line of stdout and stderr goes to the log file.

**Stop:** closing the main window (the web app's close button, Alt+F4, the taskbar) or the splash's quit button hides the window (and destroys the settings window), writes
`stop` to the server's stdin, waits up to 10 s for the process to end, kills it if it has not, and exits. The same stop runs before
an update's installer starts and when the app's event loop ends for any other reason. **No server stays behind when the shell dies
without stopping it** (killed, a panic: release builds abort): the server reads the end of its stdin as `stop` and shuts down
cleanly, lock and pairing file removed. Only when the server is killed too do the lock and the pairing file stay; the next start takes
the stale lock over.

**The server ends by itself:** before `QM_READY` it is a failed start; afterwards the window comes back to the splash with "Der Server
wurde unerwartet beendet." / "The server stopped unexpectedly." and the quit button.

## The splash

The look of the web app's start tile (`StartTile.vue`): the base `#0a1d29`, the tile `#0f2c3e`, the reserved icon slot, the wordmark
QUARTER in `#ffffff` and MASTER in the accent `#54adf7` (Bai Jamjuree 700), the app version in Share Tech Mono, a row of four segments and
one line of text, all centred, under a slim bar (44 px) with the three window buttons (minimize, maximize or restore, close; the look of `WindowButtons.vue`)
and the drag region on the rest, so a hanging start can be closed. It is the app's own page and gets its whole state from the shell (command
`splash_state`, event `splash-changed`): the page holds no text and no logic of its own; the window buttons call the contract's window
commands (`window_minimize`, `window_toggle_maximize`, `window_close`, `window_is_maximized`).

| Step | Segments | Text (`bundle.json` `startTexts`, German when the system language is German, else English) |
|---|---|---|
| before the server runs | 0 | `starting` ("Starte …" / "Starting …"); during an update at start "Update wird installiert …" / "Installing update …" |
| `QM_STEP database` | 1 | `starting` |
| `QM_STEP migrations` | 2 | `starting` |
| `QM_STEP languagePack` | 3 | `languagePack` ("Sprachpaket wird geladen …" / "Loading language pack …") |
| `QM_STEP listen` | 4 | `starting` |

A failure replaces the segments and the line by one sentence and the button "Beenden" / "Quit":

| `QM_FATAL` code | German | English |
|---|---|---|
| `portsBusy` | Kein freier Anschluss. | No free port. |
| `locked` | Quartermaster läuft bereits. | Quartermaster is already running. |
| `database` | Datenbank lässt sich nicht öffnen. | The database cannot be opened. |
| anything else, no bundle, the server ended before it listened | Start fehlgeschlagen. | Start failed. |

The version shown is the shell's own (`Cargo.toml`), which a test keeps equal to the root `package.json`'s (the version the server
bundle carries).

## The window and the contract

The main window is frameless (`decorations: false`); the web app draws the chrome and calls the shell. It shows two things only: the
splash and the origin the server reported. Any other navigation is refused (`navigation_allowed`, which the settings window obeys too).

| Command | Implementation |
|---|---|
| `pick_folder`, `pick_file { extensions }` | the system's dialogs (tauri-plugin-dialog), modal to the window; the path, or `null` when cancelled; `extensions` become one filter, `[]` is any file |
| `open_external { url }` | the URL in the system's default browser (the `open` crate, ShellExecute on Windows), started detached. The one rule (`external_url`): the text starts with `https://` and a host, parses as an absolute URL with scheme `https`, a host, no user name or password, no whitespace or control character; anything else is rejected with a text and nothing is started. The opened URL is the parsed one (normalized). No opener or shell plugin exists, so the page cannot open anything else |
| `window_minimize`, `window_toggle_maximize`, `window_is_maximized` | the window's own functions |
| `window_close` | a close request to the window: the stop above |
| `window_start_resize { direction }` | the system's resize drag from that edge or corner; a direction that is none of the eight is rejected |
| `open_settings` | "The settings window" (main window only) |
| `settings_window_fit { width, height }`, `window_focus_main` | "The settings window" (settings window only) |
| `update_state`, `update_check`, `update_install`, `update_set_channel { id }` | "Updates and channels" |
| event `update-changed` | emitted with the `UpdateState` at every change |

**Who may call what.** The app's commands are declared in `build.rs` (an app manifest), so each has a permission and nothing is
callable by default. Three capabilities grant them:

- `splash.json`, the app's own page: `splash_state`, `quit`, listening to events, dragging the window and the four window commands of its buttons.
- `webapp.json`, the main window and pages at `http://127.0.0.1:*` only (`remote.urls`, `local: false`): the contract's twelve commands
  and `open_settings`, listening and unlistening to events, and the two window functions Tauri's `data-tauri-drag-region` calls
  (`start_dragging`, `internal_toggle_maximize`: the double click on the title bar).
- `settings.json`, the settings window (label `settings`, the same origins): `pick_folder`, `pick_file`, `open_external`, `window_close`,
  `window_is_maximized`, `update_state`, `settings_window_fit`, `window_focus_main`, listening and unlistening to events and
  `start_dragging`. Nothing else: no minimize, maximize, resize, `open_settings`, update install or channel.

### The settings window

`open_settings` (from the main window) opens a second window, label `settings`, at `<origin>/settings?window=settings` (the web app's
settings-only mode: a title bar and the settings panel, `docs/webapp.md` "The side bar and the settings window"), or un-minimizes,
shows and focuses it when it exists. It is frameless, **not resizable** (no maximize or minimize either), owned by the main window (it
stays above it), centered, and created hidden: it is shown by `settings_window_fit { width, height }`, which the page sends once after
its first render with the height it measured (`settings_size`: at most 95 % of the window's screen; a width or height that is no size
is refused; the command refuses any other window's label). A page that never sends it is shown as it is after 5 s. The dialogs the panel
opens fit the fixed width (560 px) and the minimum height (400 px) the page asks for. `window_focus_main` brings the main window to the
front (the settings window's "App Update" button asks the main window for the dialog over a `BroadcastChannel`, which needs no
command).

Closing the settings window (its close button, Alt+F4) just closes it. Closing the main window is the app's end as before; the
settings window is destroyed with it (no close request, so it cannot count as an end of its own), and when the server ends by itself
while the app runs it is destroyed too (the main window goes back to the splash). With no server (no origin yet) `open_settings`
answers "the server is not running".

No plugin command is granted beyond these (the dialog and updater plugins are used from Rust only). `withGlobalTauri` injects
`window.__TAURI__` into every page the window shows; with the navigation limited to the server's origin, the commands are reachable from
the web app and from nowhere else.

### IPC and the Content-Security-Policy

Tauri's `invoke` first sends a `fetch` to its custom protocol (`http://ipc.localhost/<command>` on Windows, `ipc://localhost/…`
elsewhere) and falls back to the webview's `postMessage` channel when that fails. The web app's CSP is strict
(`connect-src 'self' ws://127.0.0.1:<port>`), so the shell sets `QM_CSP_CONNECT` to that one origin and the header becomes
`connect-src 'self' ws://127.0.0.1:<port> http://ipc.localhost`. Observed on Windows (WebView2) with the built app:

- with the value: every command and the event work, nothing is reported in the console;
- without it: the commands and the event still work through the fallback, but every page load reports two CSP violations and
  Tauri's warning "IPC custom protocol failed" before it switches.

Nothing else of the server's CSP or Host guard is changed. Events from the shell reach the page without a request. The `ipc:` value
for Linux follows Tauri's scheme there and was not run.

## Updates and channels

The model is BindSight's, read from this repository's `channels.json` (the `app` product) and GitHub releases:

- `https://raw.githubusercontent.com/w00zla/quartermaster/main/channels.json`:
  `{ "app": { "stable": "app-v1.0.0", "channels": [{ "id": "beta", "tag": "app-v1.1.0-beta.1" }] }, … }` (the whole file, the
  companion's and the data entry, and who writes it: `docs/releasing.md`; nothing released is `"stable": null, "channels": []`)
- `https://github.com/w00zla/quartermaster/releases/download/<tag>/latest.json` (Tauri's updater format) of the channel's tag, and the
  installer that file names.

Tags are `app-vX.Y.Z` (stable) and `app-vX.Y.Z-<channel>.<n>`. A channel id is lower case letters, digits and `-`, starting with a letter,
at most 32 characters, never `stable`. A stable tag with a pre-release part, a channel whose tag does not carry its own id, another
product's tag: dropped. **A missing `channels.json` (404), no `app` entry or no tag for the channel is "no update"**: state `current`, no
error. The release notes are the `notes` of `latest.json`; GitHub's API is not asked.

**The channel in effect** (`resolve`): the chosen one while `channels.json` lists it, else the running build's own channel if listed (a
build of `1.1.0-beta.1` follows `beta`), else `stable`: a channel that vanished sends its users back to stable. The choice is stored
in the shell's own config, `config.json` in the app's config folder (`{ "updateChannel": "beta" }`). Only a newer version is offered,
except right after `update_set_channel`: then any other version is, so leaving a channel for a lower stable works.

**The state** (`UpdateState`): `idle` until something was asked; `checking`; `current` or `available` (with `available`, `notes`);
`downloading` with `progress` (one event per percent; null while the size is unknown); `installing`; `error` with the text. `channels`
is `stable` and the channel in effect until a check has read the list, then the list. A command during a running check, download or
install changes nothing (`update_set_channel` is rejected then).

**Install:** the updater plugin downloads the installer, checks its signature against the public key in `tauri.conf.json`, and installs:
on Windows the server is stopped, the NSIS installer runs and restarts the app; the AppImage is replaced, the server stopped and the app
restarted. A failed download or signature leaves the app running with state `error`. While the app runs nothing is installed without a
click; the start is the only moment an update installs by itself ("The start", 4).

**An installation that cannot update itself** (the bare executable from `target/`, a distribution's package: the bundler did not stamp
it as NSIS or AppImage) only compares versions: a newer one is state `error` with "Version X ist verfügbar. Diese Installation kann sich
nicht selbst aktualisieren." / "Version X is available. This installation cannot update itself."

**The signing key.** One updater key pair serves both apps; the public key in `tauri.conf.json` is the one the companion's updater had.
The private key is the maintainer's and is in no repository. A build without `TAURI_SIGNING_PRIVATE_KEY` in its environment is
**unsigned for updating**: the installer is built and installs normally, the app in it checks and installs signed updates, but the build
makes no `.sig` and so cannot be published as an update (a `latest.json` needs the signature). With the key set, `pnpm app:build` adds
`tauri.updater.conf.json` (`createUpdaterArtifacts`). The installer and the executables carry no Authenticode signature either.

The updater plugin refuses an http endpoint in a release build unless `dangerousInsecureTransportProtocol` is on. `tauri.conf.json` has it
off (a release talks to GitHub over https only); `tauri.testfeed.conf.json` turns it on and `build.mjs` passes that file only with
`QM_TEST_FEED=1` in the environment, which `pnpm app:smoke` sets for its own build (the local http feed). The shell itself takes only
GitHub's https addresses or `QM_APP_FEED` of the form `http://127.0.0.1:<port>` (`Feed::from_env`), and whatever the feed delivers must
carry a valid signature to be installed. The endpoint comes from `update.rs` per check, never from the plugin's configuration (which
holds the public key only).

## Single instance

One app per data folder. With the default data folder a second start brings the running window to the front (un-minimized, focused) and
ends (tauri-plugin-single-instance). With `QM_DATA_DIR` set (development, tests) several apps may run side by side; the server's lock
then guards each folder, and a second app on the same folder shows "Quartermaster läuft bereits." with the quit button while the first
is not touched.

## Environment overrides

For development and tests; a normal installation sets none.

| Variable | Meaning |
|---|---|
| `QM_APP_BUNDLE` | the server bundle's folder instead of the one in the resources (e.g. `local/app-bundle`) |
| `QM_APP_FEED` | `http://127.0.0.1:<port>[/path]` serving `channels.json` and `<tag>/latest.json` instead of GitHub; any other value disables update checks with an error |
| `QM_APP_CONFIG` | the shell's config file instead of `config.json` in the app's config folder |
| `QM_DATA_DIR`, `QM_PORT`, `QM_PAIRING_FILE`, `QM_GAME_DIR`, `QM_AUTO_UPDATE`, `QM_DATA_FEED` | the server's (`docs/singleuser.md`), handed on; `QM_DATA_DIR` and `QM_AUTO_UPDATE` are also read by the shell (the settings file's place, the switch) and `QM_DATA_DIR` lifts the single instance |

**The app's own files** (Windows; Linux under `~/.config` and `~/.local/share`): the log
`%LOCALAPPDATA%\com.w00zla.quartermaster\logs\quartermaster.log` (the shell's lines and everything the server prints; 2 MB, three old
files kept), the config `%APPDATA%\com.w00zla.quartermaster\config.json`, the webview's profile
`%LOCALAPPDATA%\com.w00zla.quartermaster\EBWebView`. The server's data folder is not the shell's (`docs/singleuser.md`).

## Building

```sh
pnpm app:fetch-node   # the pinned Node -> app/src-tauri/binaries/node-<target triple>[.exe] (not in git)
pnpm app:build        # app:bundle -> app:fetch-node -> tauri build: the NSIS setup (Windows) or the AppImage (Linux)
pnpm app:start        # the same preparation, then tauri dev (set QM_DATA_DIR: it uses the real data folder otherwise)
pnpm app:fast         # a test build without installer: profile `fast` -> app/src-tauri/target/fast/quartermaster.exe
# (the same three as the companion: companion:start, companion:build, companion:fast)
```

`fetch-node.mjs`: when the Node running the script has exactly the pinned version, its executable is copied; otherwise the official
build is downloaded from `nodejs.org/dist/v<version>/` (`win-<arch>/node.exe`, or the Linux tarball, of which only `bin/node` is taken)
and used only when its sha256 is the one in that release's `SHASUMS256.txt`. A file that is already there with the right version is kept.

The build's output on Windows: `app/src-tauri/target/release/quartermaster.exe` with `node.exe` and `server/` beside it (runs from
there, as an installation that cannot update itself: only the executable inside the installer is stamped as installed), and
`target/release/bundle/nsis/Quartermaster_<version>_x64-setup.exe` (per-user install). The sidecar and the server bundle are named in
`tauri.bundle.conf.json`, which only the build script passes: `cargo test` and `cargo clippy` need neither. Linux (AppImage) is
configured and was not built.

**Sizes** (Windows x64, version 0.1.0, Node 26.13.0): the installer 32.4 MiB; installed `quartermaster.exe` 9.6 MiB, `node.exe` 95.5 MiB,
`server/` 21.0 MiB (92 files), about 126 MiB in all.

**Memory** (Windows 10, the release build, measured once): the sum over the app process, the WebView2 processes it owns (browser, GPU,
renderer, the network and storage utilities, the crash handler), the node sidecar and node's hidden console host (`conhost.exe`).
"Private" is the private working set, the part no other process shares.

| When | Working set | Private | of it node | of it WebView2 (6 processes) | of it the shell |
|---|---|---|---|---|---|
| 15 s after a first start (empty data folder) | 498 MB | 229 MB | 170 / 137 MB | 294 / 81 MB | 23 / 5 MB |
| 60 s after the first data install from a folder feed (18 s; the SPA loaded the catalog) | 549 MB | 260 MB | 196 / 162 MB | 319 / 87 MB | 23 / 5 MB |

## Tests

```sh
cargo test --manifest-path app/src-tauri/Cargo.toml     # the protocol parser, bundle.json, channels and feed, settings, the sidecar's command line and environment, texts, navigation
cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets
node --test test/app-fetch-node.test.ts                 # the Node fetcher: file names, checksum lookup, a download refused on a mismatch (no network)
pnpm app:smoke [--no-build] [--exe <file>] [--only <scenario>,…]
```

`app/scripts/smoke.mjs` builds everything and starts the built executable (not the installer) on temp folders, with local feeds only,
hard time limits everywhere, and no screenshot; every process it started is killed at the end. It drives the page through WebView2's
debugging port (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`). Scenarios:

| Scenario | What it asserts |
|---|---|
| `lifecycle` | pairing file, `GET /api/capabilities` and `/`, exactly one `node` child, no update request with `QM_AUTO_UPDATE=0`; after a close request to the window both processes are gone within 15 s and the pairing file and `server.lock` are removed |
| `hardKill` | the app killed: the server ends by itself; app and server killed: the lock stays and the next start takes it over |
| `contract` | from the web app's page: the IPC without a CSP report and exactly one extra `connect-src` source, the window commands, `update_state`, the `update-changed` events of a check, an update found, downloaded and refused for its signature, a channel chosen and stored, a vanished channel back to stable, the commands that must be refused (`open_external` with http, file, `javascript:`, data, relative, credentials and empty URLs; an accepted URL is never sent, it would start the owner's browser); `window_close` from a minimized window ends everything |
| `settingsWindow` | `open_settings` from the main page opens the settings page (read through the debugging port; fresh data folder, so the main window shows the start tile): the panel renders, the window gets its fixed width (560 px) and no scroll bar, the permissions per window (the main window may not size it; the settings window may not open another, minimize, maximize, install updates or call the splash's commands), closing it leaves the app running, and closing the main window takes a reopened one along (both processes gone, lock removed) |
| `locked` | a second app on the same data folder: the splash's failure sentence and quit button (read from the page), the first app untouched, quit by the button |
| `singleInstance` | the default data folder (moved under the temp folder through `LOCALAPPDATA`): a second start ends with 0, the first keeps running |
| `startUpdate` | the switch on: the start asks the feed, downloads the update, refuses it and starts; a feed that never answers holds the start for the limit only; `autoUpdate: false` in `settings.json` asks nothing |

The bare executable in `target/` is not stamped as installed, so there the updater scenarios assert the "cannot update itself" answer. To
run them through the updater plugin (download, progress, the signature check), point `--exe` at the executable taken out of the installer
(`7z x <setup.exe> -o<temp folder>`; nothing is installed). The pickers are not driven (they open system dialogs), and nothing in these
tests can say how the window looks or feels.
