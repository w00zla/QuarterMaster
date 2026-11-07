# Companion app

A desktop app (Tauri 2) that works for the user next to the game, through the Quartermaster web app's API with
the user's API token ("Access Key"):

- reads blueprint unlocks from `Game.log` and registers them;
- scans the freight manager's warehouse for material stacks and the character inventory for gear (ship
  components and FPS gear) with their stats and stack counts (OCR of the hovered tile's tooltip on a screen
  capture) and proposes them as stock;
- syncs the refinery jobs of a station with the terminal's work order overview (same OCR; checked against
  screenshots and recordings, the sync untested in game);
- shows what it detects in a scan overlay over the game.

Linux and Windows; the screen capture and so every scan and the overlay are Windows only so far.

Commands, the log file and its lines: `CLAUDE.md` "Commands".

## Requirements

Product requirements (moved here from sc-quartermaster's `docs/requirements.md`, "Refinery" in the bot):

- `/qm-refinery time job` (bot) sets or clears the time left of a running job; the companion sets it through the API
  (`POST /api/refinery/duration`) from the terminal's work order overview.
- The companion app syncs the jobs of a station from the terminal's work order overview: yield and time left of known
  jobs are updated by themselves; new jobs, finished ones (to store) and jobs missing at the terminal (to remove) are
  proposals the user confirms (see "Refinery").

## Structure

- Rust (`src-tauri/src/`): `lib` (commands, setup), `config`, `logwatch`, `gamelog`, `server`, `ocr` (loads the
  OCR), `inventory` (warehouse), `components` (character inventory), `refinery` (the three: the companion's payloads
  and the adapters from sc-ohseearr's readers, `to_legacy`), `ocrwatch` (scan worker), `capture` (the capture loop on
  sc-ohseearr's capture crate), `overlay`. The OCR engine and models, the screen readers, the game's texts (`Locale`)
  and the capture itself are sc-ohseearr's (`../sc-ohseearr`, path dependencies; see "OCR").
- Vue SPA with three pages (`index.html` → `App.vue`, `debug.html` → `DebugApp.vue`, `overlay.html` →
  `OverlayApp.vue`), components in `src/components/`, styles in `src/styles/` (`base.css` with tokens, fonts and
  `ui.css`; `views.css` for forms, fields and table rows), the fonts in `src/assets/fonts/`. Pure logic in
  `src/{match,inventory,components,refinery}.ts`, tested from `test/companion-*.test.ts`.
- The window structure and look follow BindSight (title bar, settings, `Dropdown`, `ConfirmDialog`, the icon set,
  `tableColumns.ts`). The shared UI components (`Icon`, `Tooltip`, `HelpTip`, `Dropdown`, `ColumnHead`,
  `ColumnsButton`/`ColumnsDialog`, `ConfirmDialog`, `Picker`, `ViewToggle`), `tableColumns.ts`, the styles, the
  fonts and the pure helpers `apiTypes.ts` (the web app's API types the companion uses), `materialNames.ts`,
  `quality.ts` and `componentStats.ts` were copied from sc-quartermaster at 92d89c2 on 2026-11-06 and are owned here
  (no sync).

## Game.log and blueprint unlocks

- `logwatch.rs`, `gamelog.rs`: a metadata poll every 2 s (new file = other creation time or shorter:
  NTFS tunneling), a tail that hands out complete lines (lossy UTF-8: Windows SC writes the ANSI code
  page). Read: blueprint unlocks only, the `Added notification "Received Blueprint: <name>: " [n]` line
  (names may hold quotes; the `UpdateNotificationItem` repeats are skipped). The whole current log is
  read at start, then what the game appends. "Scan history" ("Historie scannen") reads every `logbackups/*.log` (GBs: `memmem`
  search, off the main thread; progress per file as the `scan-progress` event, shown as a bar in the head
  between the filter chip and the buttons). The list keeps the first unlock per name, each marked whether it came from an old log
  (`backup`); the panel lists every one, newest first (no kind badge since 2026-10-30: the thumbnail says it): registered and default
  blueprints dimmed with their state (hidden 2026-10-19, back on 2026-10-20), the count and the tab only
  the unregistered ones (new, ambiguous, not in the catalog: obtainable all the same; magazine unlocks were left
  out 2026-10-25, listed again since 2026-10-26); the overlay lists
  every one like the panel (the user sees what is detected), the others dimmed with the blueprint icon
  instead of their state text (too wide for the tile). In the panel's head after the count the filter
  "Unlocks" ("Freischaltungen", like the other panels' filter chips; localStorage `qm.companion.unlocks`,
  on by default, like every scan filter kept across starts): off, the Rust side reads no unlocks
  (`set_unlock_scan`, the list emptied, "Scan history" disabled, the overlay's mode warns); on again, it
  reads the current log from its start. The location lines are read either way. `log_state` also holds the file as last polled (created,
  modified, size, read up to; changes of these alone send no `log-changed`: the game writes all the time).
- The player's location (`gamelog::location`): `<RequestLocationInventory> Player[…] requested inventory
  for Location[<key>]`, the star map key (`catalog.location.key`, case aside; `INVALID_LOCATION_ID`
  ignored). SC logs it at spawn, on arriving at a location (also without a landing) and on every opening of
  the freight manager's Warehouse tab, never for the character inventory; leaving is not logged reliably,
  so it is the last one seen (`log_state.location`; every line of the current log with its time in
  `log_state.locations` for the debug window, cleared with a new log file; a change of key logged as
  "location <key>"). Checked over all 1709 logs of the user on 2026-10-19 (40 of 40 warehouse openings, 0 of 481
  character inventory openings).
- Matching (`match.ts`): names against the catalog's blueprint output names in de and en (community
  translations), ship component prefix (`Ind/1/B Guardian`) stripped and used to narrow by size/grade;
  several candidates = the user picks; default blueprints are never registered. Checked against all 78
  unlocks in a real 2026 log history: all matched.
- No refinery terminal events in `Game.log` (checked): only notifications.

## Server and config

- `server.rs`, `config.rs`: server origin fixed (`https://quartermaster.w00z.net`; missing or empty in
  the file = that; only a `server` entry in the config file changes it, e.g. `http://localhost:5174` for
  dev, read at start). Config as JSON in the app config dir like BindSight
  (`%APPDATA%\com.w00zla.quartermaster.companion\config.json`): Access Key (pasted from the web app's
  Companion dialog), LIVE folder, UI language (`de`, `en` or empty = the system's; `langRef` in `i18n.ts`
  is reactive, the debug window re-reads it on `config-changed`), the overlay's position, display and hotkeys.
  Saving keeps the file's `server` entry as it is: the default is never written, a hand edit while the app
  runs is not overwritten.
- Every API call goes through the Rust `api` command (only `/api/…`, GET/POST; no CORS) with
  `X-QM-Companion` = the Cargo version. With `cache` (only the catalog) a GET's answer is kept with its
  ETag in the app cache dir (`%LOCALAPPDATA%\com.w00zla.quartermaster.companion\api\<path>.json`,
  `server::cached_api`) and sent with `If-None-Match`; a 304 answers the kept body (the ETag hashes the
  content: another server or user never gets a wrong one; a broken file only costs the transfer).
- **Item thumbnails** (2026-10-25; the sizes at `ThumbSize` in `backend.ts`, the server side in sc-quartermaster's
  `docs/webapp.md` "Thumbnails"): only for catalog entries with a hash (`CatalogMaterial.thumb`, `CatalogBlueprint.thumb` of
  its `outputUuid`); without one nothing is asked and the row looks as before. Rust `thumb(size, uuid, hash)`
  (s|m|l, UUID and 8-hex hash checked) answers a `data:image/avif;base64,…` URL (the CSP stays: `img-src`
  has `data:`, not the server) from `%LOCALAPPDATA%\com.w00zla.quartermaster.companion\thumbs\<size>\<uuid>.<hash>.avif`,
  else fetched from the configured origin's public `/thumbs/…` (no token, the API's client and user agent)
  and kept there for good (temp file, renamed when complete: a URL's content never changes). Frontend
  `thumbs.ts`: one promise per image and window for the session (a failure is asked again by the next
  element), `Thumb.vue` a fixed square that stays empty while loading or without an image (nothing moves).
- No reload button (removed 2026-10-19): a restart of the app loads catalog, stock, jobs and blueprints
  afresh.
- Thin lines: every API call that runs longer than 400 ms shows a "Loading…" tag in the scan row (after
  the scan's tag, icon turning; the tooltip names what: catalog per language, stock, blueprints, connection,
  saving; `loadingTexts` in `state.ts`). While connected without the catalog, the location picker and Scan
  are disabled ("Catalog is loading…") and the unlocks list shows that state instead of
  "Not in catalog". The HTTP client has no total timeout (the catalog is ~2.5 MB per language): 10 s to
  connect, 30 s without data at most (`server::client`); the update download keeps its 30 min. A 426 makes the app show only the update panel (`UpdatePanel.vue`:
  installed and required version, the download for its platform): Rust `download_update` fetches it with
  the token (only URLs below the configured origin's `/downloads/`, `<dest>.part` renamed when complete,
  the file left as downloaded: no permission changes) to a path picked in a save dialog, progress as the
  `download-progress` event. Plain http only for localhost.
- Installed app (Windows NSIS setup, per user, no admin): it updates itself instead (like BindSight, but
  from the own server). `app_info.updater` says which build runs: the bundler stamps the exe it packs into
  the setup (`bundle_type()` = NSIS), the bare exe of the standalone zip stays unstamped and keeps the
  download above. The panel's "Install update" calls Rust `install_update`: `tauri-plugin-updater` (Windows
  only, registered under `cfg(windows)`) reads the feed `<origin>/downloads/companion/latest.json` and the
  setup with the token (`Authorization` header), checks the setup against the updater key
  (`plugins.updater.pubkey` in `tauri.windows.conf.json`), runs it passive (progress window, no questions)
  and ends the app; the setup starts the new version. Progress as `download-progress` like the download.
  `dangerousInsecureTransportProtocol` is on because `server::origin` already allows plain http for
  localhost only. Updates come only with the 426 (the manifest's version is required), there is no own check.

## Release

- Bump the version in `src-tauri/Cargo.toml` (bundle names and the header use it), build per platform:
  Windows `pnpm companion:build` (`build:windows`) with the updater's private key **as content** in
  `TAURI_SIGNING_PRIVATE_KEY` (plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if it has one; the `_PATH` variant is not
  read by the CLI, see BindSight) gives the setup (with `DirectML.dll` next to the exe, from `pnpm directml`)
  `target/release/bundle/nsis/Quartermaster Companion_<v>_x64-setup.exe` and its `.sig`, and
  `target/release/quartermaster-companion.exe`; Linux the AppImage.
- Windows: `scripts/publish-win-companion.ps1 <user@host> [-DeployPath …]` copies the setup, its `.sig` and the exe
  zipped with `DirectML.dll` (`…_x64-standalone.zip`) into `COMPANION_DIR` (default `local/companion`), writes
  `companion.json` (version, windows, linux kept, windowsSetup) and pushes. Linux: copy the AppImage there, add it to
  `companion.json`, then `scripts/push-companion.sh <user@host>`.
- The push is one implementation, `scripts/push-companion.mjs` (Node and scp, on Windows its OpenSSH scp; the ps1
  calls it, the .sh is its Linux entry point): the files the manifest names into `<DEPLOY_PATH>/local/companion/` on
  the VM (default `/opt/sc-quartermaster`), the manifest last (it raises the required version; copied first, it
  would send outdated apps to downloads that are not there yet). The server side: sc-quartermaster's `docs/deploy.md`
  and `docs/webapp.md` "Companion release".
- The key pair comes from `pnpm tauri signer generate -w <file>` once; the private key never goes into the repo,
  losing it means installed apps take no update until reinstalled with a new key.

## Window, tabs and state

- Clipped texts ("…") show their full text after ~0.45 s of hovering (`ClipTip.vue`, one per window, main
  and debug: any element with `text-overflow: ellipsis` wider than its box, unless it has a title or a
  Tooltip of its own). Buttons whose icon or text changes with a state keep their width (the scan button's
  icon in a fixed 14 px place, the debug recording button as wide as its longer text).
- `App.vue`, `components/TopBar.vue`, `WindowEdges.vue`, `state.ts`: no native frame
  (`decorations: false`), the title bar after BindSight's (drag region, minimize/maximize/close; window
  permissions in `capabilities/default.json`, which lists the windows `main`, `debug`, `overlay`),
  invisible resize edges. The window stays narrow (640 px, also its minimum), 800 px high at start and
  780 px at least (the settings dialog fits; dialogs sit 16 px below the top instead of 10vh, `App.vue`); main and debug window
  open where they were closed (`tauri-plugin-window-state`: place incl. monitor, size, maximized; the
  overlay is excluded, it places itself), created hidden and shown once placed.
- The title bar holds, before the settings button, the user (Discord avatar from `/api/me`, the name in
  its tooltip: a 640 px bar has no room for it; CSP `img-src` allows `cdn.discordapp.com`) and,
  after it, an icon button opening the web app in the browser (Rust `open_webapp`: the configured origin
  only), or the connection's short reason as a chip when down.
- Below it the **scan row** (`ScanBar.vue`, fixed height, decided 2026-10-19): the Scan toggle (off =
  outline with an eye, on = accent with a pulsing dot, locked with a lock icon while the overlay runs it),
  the overlay toggle (Windows; a desktop icon, off = dashed and dimmed, on = accent), one tag that always
  says what the scan does (`scan.ts` `scanState`: "Scan off" / "Preparing…" / "Game not detected" /
  "Game not in focus" (another window in front: the scan is idle) / "Nothing to scan" (every filter off) / "Waiting for a terminal" / "Location missing" (warehouse or
  inventory without a location) / "Warehouse|Inventory|Refinery detected"), the "Loading…" tag; on the
  right "Log not found" (a chip only then, the path in its tooltip: the blueprints and the auto location
  need the log), the auto location toggle and the location picker (see "Inventory panel"; its tooltip the picked
  location's full name, the field clips it, else what it is for; a fixed 240 px: the tags to its left
  change without moving it, the state tag clips when room runs out). Problem chips
  open the settings.
- `state.ts` holds config, connection and log state; every API call goes through its `api()`; connection
  refusals (`noServer`, `noToken`, `invalidServer`, `insecureServer`, `invalidToken`, `network`, 426) mark
  the connection down and are not toasted (`isConnectionError`); a down connection is re-checked every
  30 s, any connection on window focus; a successful check clears the update hint. Toasts are for events
  only.
- A tab bar (icons; each tab and panel title with its table's row count, `tabCounts` in `overlay.ts`; the
  last tab kept in localStorage `qm.companion.tab`; it never switches by itself: the scan row's tag names
  the screen) with the panels
  Gear and Resources (both `InventoryPanel.vue`, prop `part`: `comps`, `stock`), Refinery (`RefineryPanel.vue`) and
  Blueprints (`UnlocksPanel.vue`), like the web app's navigation (order, names "Ausrüstung" (until 2026-10-20 "Komponenten")/"Ressourcen"/
  "Raffinerie"/"Baupläne", icons; decided 2026-10-20, before: one Inventory tab), all four kept mounted
  (`v-show`; a stored "inventory" tab opens Stock); panel heads carry no icon. Every head: title, the count
  (room for "999": the chips after it stay put), the panel's filter chips (no label: "Scanned" / "Not
  scanned" as their tooltip), then the buttons on the right. Stock, Components and Refinery fill the window
  and scroll only their rows (head and column titles stay).
- Settings dialog (`SettingsDialog.vue`): Access Key, language, game folder, the "Bildschirm-Scan" group
  ("Screen Scan": "App-Ansicht automatisch wechseln" (the automatic tab switch), then "GPU-Beschleunigung
  aktivieren" (since 2026-10-31 a plain row below it, off by default; before, a highlighted card on top) with a state tag "Aktiv" / "CPU" / "Nicht verfügbar" / "Fehler" and a dim
  note below (pays off only when the scan reads slowly on a weaker CPU, takes VRAM), switches; the
  GPU greyed out and off when the OCR cannot run on the GPU, see "OCR"), the "Scan overlay" group
  (Windows only, see below: the position as six icon-only buttons on a drawn 16:9 monitor, each with its
  place as tooltip; "Darstellung" ("Display": "Thumbnails" (default) or "Kompakt", a dropdown, config
  `overlayDisplay`, applied once saved); the hotkeys "Hotkey Overlay an/aus" and "Hotkey Overlay-Ansicht wechseln"; the UI says "Ansicht" for tab and overlay view alike, since 2026-10-30), in the head's right end
  a small "Debug" button for the debug window (secondary for the user; what it does as tooltip; the dialog
  closes once the window is open; `ConfirmDialog`'s `head` slot). Labels left, controls right like
  BindSight's settings.
- Refinery panel cards (`RefineryPanel.vue`), three lines: the icon-only job badge (live colour), the
  station and the actions (registering blue, storing a crate on green, removing outlined); the state tag
  (new blue, finished green, not at the terminal yellow), an icon-only link badge (accent: registered as a
  job, dimmed: not yet), the time left and the end, the total yield in SCU at the right; the materials
  as compact rows in the columns of one head above the cards (material, quality, amount; see
  "Tables"), each with the S thumbnail (18 px) in front of the name (no display toggle). German "Eintragen" for registering everywhere.
- **Tables** (Components, Resources, the refinery's materials, Blueprints; 2026-10-20): like the web app's
  (`useTableColumns` in `tableColumns.ts` + `ColumnHead.vue`, ui.css `.table`/`.row`/`.cols-head`, the table
  measured with `observe`: the columns always fit, growing takes the free room and then narrows the
  columns to the right, the fixed action columns stay in view), compact (`.table.compact` in `App.vue`:
  4 px padding for head and rows, so the titles sit in the middle, 8 px gap, 12 px text). One column
  takes the room left (the location, the material, the blueprint: no grip); widths and hidden columns in
  localStorage `qm.companion.{comps,stock,refinery,unlocks}.columns`. A first try with an "Excel" mode
  (only the dragged column changes, sideways scroll) was dropped the same day: the actions scrolled out. The icon button in the
  panel head left of the filter chips (since 2026-10-25, before in the head of the action column; `ColumnsButton.vue`, its tooltip "Spalten wählen",
  texts via `columnsTexts()`) opens `ColumnsDialog.vue`:
  a switch per hideable column (all but the name and the actions), applied and kept right away. The
  location in the mono face (like the overlay's). Lists in dialogs scroll inside them (max. 40–50 vh) and
  show the table's shown columns in its order.
- **Display per table** (Gear, Resources, Blueprints; 2026-10-25): `ViewToggle.vue` (tooltip "Thumbnails
  anzeigen" / "Kompakt anzeigen") left of the column chooser, kept with the
  table's columns (`useTableColumns` `view`, default compact). Compact: today's rows plus the S thumbnail
  (18 px, the 24 px rows keep their height) in front of the name. No kind or blueprint badges since 2026-10-30 (the thumbnail says it; only the refinery jobs keep theirs).
  Thumbnails: a column first with the M thumbnail (48 px), rows 48 px high, 13 px text. Blueprints show the
  crafted item's (the picked, registered or first match; none when not in the catalog).

## Scan

- **One scan** for the warehouse, the character inventory and the refinery terminal (decided
  2026-10-19; before: one session per terminal kind, started in its panel). `ocrwatch.rs`, Rust
  `get_scan`/`set_scan` (`on` plus the scope `warehouse`/`inventory`/`refinery`), `scan.ts`: switched in
  the scan row or by showing the overlay (which switches it off again only if it started it); off at every
  start; the capture runs only while it is on. Starting clears the inventory's sightings and loads catalog
  and stored stock. The **scope** follows the filters: warehouse = Materials or Items, inventory =
  Ship comp. or FPS gear, refinery = Jobs; a screen out of scope is neither looked for nor read (all off: "Nothing to
  scan"); a filter change applies to the next frame.
- **Which screen** (`Screen` in `ocrwatch.rs`, sent as `scan-screen`: `none`, `warehouse`, `inventory`,
  `refinery`): without one the worker probes every 2 s (`PROBE_MS`): the refinery's big titles first
  (the refinery reader's `probe`, 30–110 ms; skipped without the game's texts, see "OCR"), then the cheap
  page number read (~30 ms, the gear reader's `probe_with(.., false)`: every place the page can have, a
  kept scale not trusted; only "n/m" with m ≤ 99) for the character inventory, else the grid read for the
  warehouse, and a frame with neither is tried as the inventory too. The decision stands until the reader
  found nothing 3 reads in a row (`SCREEN_MISSES`, the refinery's `LEAVE_AFTER`: a switch takes the player
  seconds), a minute without frames, the scan's stop or the screen's filter going off.
- The readers are sc-ohseearr's (`Readers` in `ocrwatch.rs`: `WarehouseReader`, `GearInventoryReader`,
  `RefineryReader`, ADR 0010 there: `probe`/`read` on a `Frame` with its id, cursor and `Locale`); each keeps
  what it learned across frames (the warehouse's last strong layout, reset when its screen is left; the
  character inventory's UI scale); their output goes through `to_legacy` into the companion's payloads.
- The refinery screen reads a live frame once the view came to rest after it moved and every 2 s
  (sc-ohseearr's `Gate`: a 96×40 grey thumbnail sampled from the frame; checking every changed frame took
  ~5 % CPU in the verse).
  Warehouse and inventory read every delivered frame (1/s, the character inventory up to 2/s, paced by the read time) without the gate: the world behind the
  translucent inventory screen never comes to rest (the gate delayed reads by 3–6 s in the first test).
- The worker reads the newest frame when it falls behind. The `Ocr` is loaded by the first read
  (well under a second) and dropped within 5 s of the stop (memory back; the memory arena stays on:
  off made reads 30 % slower), the readers (the warehouse's layout detector with them) and the game's
  texts too. "Preparing…" while the sync loads the catalog and the player's language
  pack (`refinerySync.ts` `loadCatalog`: the companion's only catalog fetch, `/api/companion/catalog` de and
  en (since 2026-11-01; before: the web app's `/api/catalog`), once connected, again when the game folder
  changes; kept in memory and on disk (ETag), the unlocks panel uses its responses). It has only what the
  companion reads (`CompanionCatalogResponse` in `apiTypes.ts`, sc-quartermaster's `docs/webapp.md`): materials uuid, kind (the unit follows
  from it), name, nameKey, type, typeLabel, component, label, size, gradeLetter, stats (every
  `CatalogStat` field), thumb; locations uuid, key, label, short, nameKey, refinery; blueprints uuid,
  label, name, size, gradeLetter, isDefault, retired, outputUuid, thumb. Per language ~2.45 MB instead of
  ~2.95 MB raw, on the line ~340 KB: the server gzips it, reqwest asks for gzip and unpacks it (feature
  `gzip`; the disk cache keeps the unpacked text). The ~3760 components with their stats are most of it. `StarCitizen.exe` running comes from `capture.rs` (`game-seen` / `get_game_seen`).
  `QM_OCR_FRAMES=<dir>` feeds every image in a folder once (tests without capture; the scan must still
  be switched on in the UI).
- Warehouse and inventory reads go out as `inventory-read` (`grid` for the warehouse, `components` for the
  character inventory, never both); the refinery's as `refinery-visit` and `refinery-overview` (below).

## Warehouse scan (freight manager)

The freight elevator terminal's tab Warehouse (sc-ohseearr's warehouse reader, `inventory.rs` adapts it,
pure part `inventory.ts`, store `inventorySync.ts`): materials and items. 4 columns of tiles, scrolled without pages, every tile with a
count badge top right ("X1", "X14") and an info icon top left, a material tile with its quality bottom left
("572Q", the dim Q read as 0, a letter or ".0"). The icons look alike, so the name comes from the tooltip of
the hovered tile, which opens at the cursor (title; materials also "Capacity: …", the chip "<name>"
"<quality>" and the SCU; items the title only). The gems (Feynmaline, Hadanite, …) are items in the catalog:
their amount is the badge's count, the tooltip's "0.001 SCU" is per piece.

### The read

- sc-ohseearr's `WarehouseReader` (`../sc-ohseearr/usecases/warehouse`: its README is the use case card, the module
  docs the read; `inventory.rs` adapts its output to `Grid`, the field mapping in its module docs). In short: the
  reader's own layout detector (`sc-warehouse-layout`, NanoDet-Plus, its card `models/sc-warehouse-layout/MODEL.md`
  there) finds the badges, quality texts and the tooltip's lines, a grid is fitted to them per frame, and only the
  tooltip's lines, the hovered tile's quality and badge are recognized (~25 ms per read on the CPU).
- What the app relies on: the reader keeps the last strong layout as its prior (`reset` when the warehouse screen is
  left, a new reader when the scan stops) and reads every tile's badge after `set_diagnostics(true)` (the debug window
  open: the costly part); the **hovered tile** is the one under the mouse cursor, which the capture passes with every
  frame (`Frame.cursor`; screenshots without a cursor fall back to the tooltip's hints).
- **Retraining the layout detector**: its COCO set exists (exported from recordings up to 1.3.1 by the former
  `warehouse_coco.py`); an export of the current recording format into `inventory_dump` is not built yet. Run
  sc-ohseearr's layout pipeline on the recipe (`training/README.md` there), then `scripts/regression-dumps.sh` here
  against the read before.

### Sightings and proposals (frontend)

- A **sighting** = tooltip + hovered tile: material via `findMaterial` over resources *and* items plus the
  language pack; quality = chip, else tile; amount = SCU from the tooltip for SCU materials, else the
  badge's count. Keyed by its **content in its column** (material or name, quality, amount, column: a tile
  hovered again after a scroll is the same sighting; equal stacks in one column collapse, a known limit);
  an uncertain count merges with a certain read of the same stack, a certain read replaces it.
- It counts once **two reads in a row of the same hovered tile agree**: the tile by its place in the frame,
  within half a pitch (the per-frame fit shifts its row index when a partly visible top row is fitted). An
  OCR glitch in one read books nothing, and the previous tile's tooltip the game still shows right after a
  move (one read so far) disagrees with the next read.
- A ship component hovered here stays a sighting "Component: scan the inventory" (no proposal); unresolved
  names, missing qualities and amounts stay sightings without a proposal, listed in the debug window; so
  does a stack confirmed with two counts, one a digit short of the other ("X1"/"X10", same column,
  material and quality: "Count read differently").
- **One proposal per stack**, nothing summed up, with what the user's stored stock at that location already
  holds of that material and quality.

## Gear scan (character inventory)

Ship components and FPS gear (weapons, attachments, armor, gadgets; since 2026-10-22), read in the character
inventory's "Storage Access" screen, because only its tooltip shows an item's stats. The read is sc-ohseearr's
`GearInventoryReader` (`../sc-ohseearr/usecases/gear-inventory`, its README and module docs: the storage pane, the
UI scale `k` from the page number's place, the tooltip at its fixed place right of the character, the stack count,
the hovered tile from the game's lit frame around it, the row in the scrolled content); `components.rs` adapts its
output to `ComponentRead`, the pure part is `components.ts`. The reader keeps the UI scale until the scan stops; the
tooltip and the page number go through the OCR only while the cursor is on a lit tile (~57 ms per read on the CPU,
3 threads).

- Frontend: the title ("Mil/3/A Blizzard", "CQ7 Rifle") against the catalog's gear names in de/en plus the
  language pack, the prefix narrowing size and grade (`findComponents`; among same-name variants the
  craftable one; the catalog lists only the plain part of a variant group, see sc-quartermaster's `docs/stock.md`); without an
  exact match with the OCR's look-alikes folded (l/I and 1, O and 0: "Sion Compensatorl"). Ship component
  or FPS gear by the item's catalog type (`FPS_TYPES` in `components.ts`), which picks the filter that lets it through. Stat lines ("Coolant
  Rating:  60.00", the value in a column of its own; a dropped colon is tolerated) against each stat's
  names (`CatalogStat.name` per language, `nameKey` in the pack); the absolute value converted to the stored
  gain with `CatalogStat.base` (`statFromTooltip`; a negative base like armor's minimum temperature divides
  the same way), where `CatalogStat.tooltip` says the tooltip shows the change in percent (impact force
  "+6.11 %", recoil kick "-28.44 %", recoil smoothness and handling negated: "+28.44 %" = stored -28.4) that
  change itself: an unmodified item reads as ±0; "no stats" only
  when the tooltip had no stat lines (weapons, event items); a value below the base beyond rounding, above
  the blueprint's bound (mirrored for a stat whose improvement is a drop, e.g. quantum fuel burn, since
  2026-10-22), unparsable or without a known base = "Stats not readable" (no proposal, listed in
  the debug window with the reason, like unknown or ambiguous titles).
- A sighting's identity is **page + content row + units + content** (a tile hovered again after a scroll is
  the same sighting, equal components on other tiles stay apart). A tooltip counts only once the cursor
  stayed on its tile for a read or had rested ≥ 200 ms when the frame was grabbed (`SETTLED_MS`, the
  capture waits for that: sc-ohseearr's `REST`), then two agreeing reads in a row (2 reads per tile since
  2026-10-27, ≥ 3 before). The stack count is
  not part of the identity: a count that changes on the same tile (two agreeing reads) updates the
  sighting. One proposal per sighting (its pieces, quality 0, the stats if any).
- `cargo run --release --example components_dump -- <dir>…` prints page, the tile under the stored cursor, title and
  lines per image (a recording's frames with their cursor; sc-ohseearr's `read_components`, the stateless read,
  through the app's adapter). The reader's screenshot tests are sc-ohseearr's.

## Inventory panel, locations, registering

- The location sits in the scan row (`ScanBar.vue`, it belongs to every warehouse and inventory read):
  the auto location toggle (an `icon-btn` with `locate`, 20 px; off = dashed and dimmed, on = accent with
  a faint backdrop; on by default, kept in localStorage `qm.companion.inventory.autoLocation`; its tooltip
  says what it does, or while on what Game.log named: the location, "not selectable" with the key, or
  nothing logged yet) and the location picker (`Picker`, kept in localStorage
  `qm.companion.inventory.location`). With the toggle on the pick follows Game.log's last location when it
  is turned on, when the log names another place and once the catalog is loaded; a key that is no
  selectable location clears the pick (nothing is booked at the place before: reads without a location
  are dropped); a pick by hand holds until the log names another place.
- One panel per part: Resources (the warehouse's stacks) and Gear (the character inventory's). Head:
  title with count, the part's kind filter, toggle chips Materials / Harvestables ("Sammelobjekte", until 2026-10-20 "Items") (Resources) or "Ship comp." ("Schiffs-Komp.") / "FPS gear" ("FPS-Ausrüstung", since 2026-10-22) (Gear; on =
  the kind's badge colour with a check, off = dashed and dimmed with an x; what the scan detects from then
  on, all may be off; localStorage `qm.companion.inventory.kinds` as `{on, known}`: a kind added later
  starts on; the plain list before FPS gear is read as known = the three of then), the "Benutzerfilter" button
  ("User filters", below), "Register all" (the panel's rows only).
- **User filters** (2026-10-31; `userFilters.ts`, `FiltersButton.vue`, `FiltersDialog.vue`): terms that are not
  scanned, each for one kind or all ("Alle" / the four kinds), with `*` (any text) and `?` (one character),
  matched against the whole name, case aside: the catalog's names in de and en and the tooltip's title. One icon
  button (a funnel, tooltip "Benutzerfilter") after the kind filter in the Gear and Resources heads, both open the
  same dialog; lit (accent) while some filter applies. The dialog: the wildcards as a small quiet line (asked for,
  2026-10-31), below it a term, its kind, "Add", the list below
  with a remove button each; in its head "Filter aktiv" / "Filter aus" for all of them (not kept: on at every start; greyed out
  without filters). The list kept in localStorage `qm.companion.inventory.filters`. A filtered item still becomes
  a sighting (the scan, its two agreeing reads, its key as before) but no proposal, so neither the panel, the
  count, the overlay nor "Register all" shows it and the overlay does not flash for it; the debug window's
  detections list it as "Filtered" with the term. The filter is applied to the list each time (`proposals` in
  `inventorySync.ts`): a filter removed or switched off brings the sightings back as proposals at once.
  Then one compact row per proposal. What the stored stock at the location already holds stays listed,
  dimmed, without Register / Discard (2026-10-20; `inStockOf` in `inventory.ts` and `components.ts`,
  `inStock` on the listed proposals): stacks per material and quality as long as the stored amount covers
  them, gear counted in pieces per item and stats (ship components do not stack in the game, attachments
  do: 5 tiles hovered, 4 stored, one new; a stack of 3 with 2 stored is new); the ones registered here count first (and always), then the earliest seen. The count, the tab and
  "Register all" only take the rest; the overlay shows them dimmed too. Stock is loaded at the scan's start and after every
  registration. Stock (no kind badge since 2026-10-30):
  name, quality (its level before the number like the web app's, "★★★ 734", 2026-10-31; the overlay the number only), amount. Gear: name, type, size, grade (from the catalog in the
  UI language; items show none of these: every bookable item is of the type "Misc.", checked 2026-10-20),
  the stats ("Coolant Rating +12.5 % · Integrity ±0.0 %"; without any gain, or when the tooltip showed none,
  a dimmed "Standard"/"Default" since 0.2.1, before a "–"), the pieces (the overlay shows them only above 1). Both: location last, Register /
  Discard (fixed 26 px each). Columns: see "Tables" (no
  sorting: the newest first).
- **Every location collects its own** sightings (`inventorySync.ts`: an `InventoryScan` and a
  `ComponentScan` per location, keys and ids prefixed with the location): a read belongs to the location
  picked at that moment (changeable while scanning: the player walks from one warehouse to the next); the
  panel lists every location's proposals, each is registered at its own location; the overlay shows the
  current location's only. Starting a session clears the sightings of the one before.
- Registering (one or all) asks in a dialog with a switch per org to share right away (`guildIds`, the
  choice kept for the session); adds only via `/api/stock/add`. Rows at several locations ("Register
  all"): first a switch per location (all on when it opens), only the rows of the ones on are registered.

## Debug window

- `debug.html` + `DebugApp.vue`, opened from the settings (Rust `open_debug_window`, async, with the main
  window's WebView2 browser arguments: another set hangs WebView2; no JS close handler: `destroy` would
  need a permission); closing the main window ends the app, the debug window with it.
- Three tabs (`DebugApp.vue`, all stay mounted, the OCR scan opens first, General is the last on the right; the shared table, panel and key/value styles sit unscoped
  there), the layout after the concept artifact https://claude.ai/artifact/WrWSMUa9T48WVDZCt4WLJL:
  - **General** (`DebugGeneral.vue`, 2026-10-31; "General" in both languages, as the user named it): the app (version,
    platform, setup or standalone exe, server origin, user, connection), its folders (config file, log, cache, game
    folder; each opens in the file manager: Rust `open_folder` with `config`/`log`/`cache`/`game`, never a path from
    the page), the catalog (when loaded, resources / items (ship components and FPS gear among them, by the catalog's `kind`) / locations / blueprints per language, the copy kept on disk with
    size, date and ETag) and the language pack (the `global.ini` the game reads, found or not, `user.cfg`'s language,
    size, date, how many of the texts asked for it had; the ones it lacked, loc key and the catalog's English name,
    in a collapsed panel below, asked from the main window only while it is open: `pack-missing-request` →
    `pack-missing`). The app's side is Rust `debug_info` (re-read on
    `config-changed` and when the catalog was loaded again); connection, user and catalog come from the main window
    (`debugReport.ts`: `general-report` on every change, `general-report-request` on open; `catalogLoad` in
    `refinerySync.ts`). The kept copy is `/api/companion/catalog`'s (Rust `debug_info`). No catalog version: `/api/catalog` has none (decided 2026-10-31: no server change for it).
  - **OCR scan** (`DebugScan.vue`), two views and "Record data" in its row. "Last read": first the frame (a
    JPEG data URL, 1280 px wide, CSP `img-src data:`, in a box of the frame's aspect that stays while what
    follows changes; its height can be dragged, the image then fits in centred) with SVG overlays (OCR boxes, read cells, tiles, hovered tile, tooltip, or the
    character inventory's tooltip lines and the cursor's tile) and a legend of the overlays this screen
    draws; then a row of key figures (time, duration, "OCR" (the models that ran and their time), "GPU" (yes, or no and why: off in the settings, DirectML.dll missing, failed with the error), how long the cursor had rested at the grab, frame, screen, then tiles / page / station and work
    orders, OCR boxes); per screen the grid and tooltip with a table of every tile (hovered one marked,
    uncertain values "?"), the cursor and tooltip with every tooltip line marked as title, stat (its label
    one of the catalog's stat names: the sightings report carries them), field ("Label: value") or text
    (`parseField`), or every work order with its
    rows; the read cells and OCR boxes (scores below 0.6 in warn colour). Every table is collapsible
    (the last two start collapsed; open or closed is kept across reads). No header of its own: the tabs
    sit at the top, the window's title names it.
    "Detections" ("Erkennungen"): the main window's sightings of both scans in one table (event
    `inventory-sightings` on every change, `inventory-sightings-request` on open, with the locations' short
    names: the window has no catalog; own kind filter; columns source (FE = warehouse, INV = character
    inventory), name, quality, amount or stats, location, page and cell, state (Proposal / Registered /
    Discarded, Filtered with the user filter's term, or Problem with the reason), time).
  - **Game.log** (`DebugGamelog.vue`): the file (path, created, modified, size, read up to: `log_state`'s
    `file`, re-read every 2 s besides `log-changed`), every blueprint unlock (current log and old logs,
    registered and default ones included; time, logged name, matched catalog labels, state with a filter
    per state, source Game.log / logbackups), then the location (the last logged key, what it resolves to
    and whether it is selectable, the auto location, the pick, every location line of the current log,
    newest first). The matching comes from the main window (`debugReport.ts`: event `gamelog-report` on
    every change, `gamelog-report-request` on open; the unlocks panel hands over its rows before hiding
    registered and default ones). "Export" writes `qm-gamelog-debug-<unix s>.json` into a folder the user
    picks (Rust `export_log_debug`: version, platform, game folder, the log state and that report).
- While it is open (`set_debug`) every read goes with its frame to the **debug writer** thread
  (`spawn_debug_writer`), which encodes it, keeps the last 3 reads in RAM and emits it as
  `inventory-debug` (the window listens to that; the scan gets its `inventory-read` right away, without
  the frame): on the worker, encoding and writing stretched the reads' interval from 1.05 to 1.8 s. The
  hand-over is a queue of 2 reads (`DEBUG_QUEUE`, `try_send`): a read that finds it full is left out of
  the view and a recording (logged, debug): an unbounded queue, with the writer emitting the scan's event too, fell
  behind at ~3.6 reads a second (24 s and ~1.5 GB of waiting frames within three minutes, the proposals waiting with
  it). Encoding takes ~220 ms per 3840×1600 frame (the preview scaled with the OCR's SIMD resize). The refinery's reads go to the writer only (with a
  `refinery` part: overview, terminal or nothing).
- "Record data" asks for a folder and writes a session folder `qm-inventory-debug-<unix s>`: the 3 kept
  reads, then every read while it runs (frame as JPEG quality 90, ~0.6 MB, + JSON with grid, components
  part, refinery part, the cursor and boxes, and `capture` for remote diagnosis since 2026-10-20: `grabMs`,
  grabs without a new image `skippedTimeout`/`skippedPointer`/`skippedOutside`, frames not read `dropped`
  (the OCR busy) and `gated` (probe throttle, the refinery's rest gate), `waitMs` from grab to read, the
  counts since the read before, `restMs` the cursor's rest at the grab; and `ocr` since 2026-10-30 (the
  recordings of 1.2.0 lacked it): the models that ran, `gpu`, the setting and the GPU's `status`, their
  `ms`; `info.json` with the count), until stopped or the window
  closes. The folders replay through `inventory_dump` and `components_dump` (both pass the stored cursor;
  recordings before 2026-10-19 have none).

## OCR

- **sc-ohseearr** (the sibling checkout `../sc-ohseearr`, path dependencies, so it must sit next to this repo wherever
  the companion is built): `sc-ohseearr-core` (ONNX Runtime, prebuilt and linked statically), the model packages
  `paddle-det-tiny` (PP-OCRv6 tiny's detector), `sc-rec-latin` (our recognizer: tiny's cut to Latin and fine-tuned on
  the game's font) and `sc-warehouse-layout`, compiled in (the Windows release is a bare exe), `sc-ohseearr-sc` (the
  reader interface, the game's texts), the use cases `-warehouse`, `-gear-inventory`, `-refinery` and
  `sc-ohseearr-capture-win`. How they work, what was tried, the measurements and the model history: its README, the
  use case READMEs, the model cards (`models/*/MODEL.md`), `training/README.md` and `docs/adr/` (0006/0007/0010 the
  readers). Changes to the engine, models or readers belong there.
- `ocr.rs` only loads the `Ocr` (`ocr::load(threads, gpu)`: ONNX Runtime's intra-op threads, 3 in the scan
  (`OCR_THREADS`, the game runs too)); `ocrwatch` loads it on the first read (well under a second, logged "OCR Tiny
  loaded in … on the GPU|CPU") and drops it within 5 s of the stop. The debug data name the models "tiny"
  (`OcrInfo.models`, empty when they did not run) and the log's read phases "tiny: …"; the warehouse reader's layout
  detector counts in the detector's timings. `inventory.rs`, `components.rs` and `refinery.rs` keep the companion's
  serde payloads (frontend, events, recordings) and map the readers' neutral output onto them (`to_legacy`; fields
  like `Field::raw`/`ambiguous` and the names' loc keys are not used beyond that yet).
- **Regression check** for any change of sc-ohseearr or the adapters: `scripts/regression-dumps.sh <out> [repo root]`
  runs `inventory_dump`, `components_dump` (this repo) and sc-ohseearr's `ocr_dump` over a fixed selection of
  recordings and screenshots (740 warehouse frames, 444 character inventory frames, 62 images of the refinery and the
  freight elevator terminal), compared byte for byte (`*.norm.txt`, `overlays.sha256`) against the build before.
- **The recognizer's training data from here**: `components_dump --dataset` exports the real tooltip lines from debug
  recordings as line crops, `tools/dataset-export/ocr-eval-label.ts` labels them (its README); the game's font (Blender Pro, taken from `Data.p4k`) is used
  for local training only and never goes into git or a build.
- **On the GPU** (Windows; setting "GPU-Beschleunigung aktivieren", config `gpu`, off by default since 2026-10-31: on a
  fast CPU the reads are hardly faster and it holds VRAM next to the game): ONNX Runtime's DirectML execution provider
  (`sc-ohseearr-core` feature `directml` on Windows only). It needs the redistributable `DirectML.dll` 1.15.4 (18.5 MB,
  Microsoft, MIT) next to the exe: Windows' own (`System32`, 1.0 on Windows 10) refuses the session. `pnpm directml`
  (`scripts/fetch-directml.mjs`) fetches it into `src-tauri/resources/ocr/` (only that file of the 200 MB NuGet package,
  by HTTP ranges, SHA-256 pinned); `build:windows` and `build:fast:windows` put it next to the exe
  (`tauri.setup.conf.json`: `$INSTDIR\DirectML.dll`), `publish-win-companion.ps1` into the standalone zip; not in
  `tauri dev`. `ocrwatch::Gpu`: ready (the DLL next to the exe), missing, or failed (any OCR error on the GPU: the
  models load anew on the CPU from the next frame, for the rest of the run); the settings grey the switch out (off)
  unless ready (`gpu_status`, event `ocr-gpu`). Not measured: what the GPU load costs the running game's frame time.
- **The game's texts** (sc-ohseearr's `Locale`, its ADR 0007: no game text compiled in): `user.cfg`'s
  `g_language` picks `data/Localization/<language>/global.ini` (a language pack, also one replacing the English
  texts like StarStrings; keys case-insensitive, a pack's `key,P=` suffix dropped), and the game's own English
  texts come from **`global-english.ini` in the app's local data folder** (Windows
  `%LOCALAPPDATA%\com.w00zla.quartermaster.companion\global-english.ini`): the game keeps them inside
  `Data.p4k`, sc-ohseearr's `scripts/extract-global-ini.{ps1,sh}` extracts them per game build. How players get
  that file without placing it by hand is open (see "Open"). `ocrwatch` keeps a `LocaleSource` (re-read when
  `user.cfg`, the pack or the English table change, checked every 10 s; dropped when the scan stops) and
  passes the locale into every reader's frame: the refinery reader anchors on loc keys (below), the others
  only resolve names to loc keys (not used yet). With neither a pack nor the English table the refinery is
  not read: its probe counts as no terminal, a visit in progress counts misses until it ends; logged once
  per change ("refinery not readable: …", warning; "refinery readable again", info). No UI shows it.
  Rust `game_names(keys)` returns pack texts for loc keys (sc-ohseearr's `LocTable` over the pack).

## Refinery

- Read: sc-ohseearr's `RefineryReader` (`../sc-ohseearr/usecases/refinery`, its README; `refinery.rs` adapts its output
  to `Overview`/`Read`). It reads only the terminal's **work order overview** (the station from the title, every
  work order panel with its rows: processing orders with quality, yield and time remaining, completed ones with
  quality and yield; a panel cut by the edge is left out), anchored on 9 loc keys whose texts come from the frame's
  `Locale`: the pack's wording, then the English table's, so the English table belongs next to a pack too. Without
  either table it is not read (see "OCR"). The reader's `probe` is the cheap check for the screen (the big titles:
  30–110 ms).
- The refinery screen is a **visit** (`refinery-visit` `{atMs, active}`), each overview as
  `refinery-overview`; 3 reads in a row without the terminal or 60 s without frames end it. The panel's
  filter "Jobs" (one chip in the head after the count, the live colour; localStorage `qm.companion.refinery.jobs`, on by
  default) decides whether the scan reads the terminal at all.
- Sync (`refinery.ts`, store `refinerySync.ts`, `RefineryPanel.vue`; the requirements: "Requirements"): names via
  `findMaterial` (`materialNames.ts`, also takes a name without its accents: the OCR read "HEPHAESTÁNITE") over the catalog's de/en names plus the pack texts; the station by its title against refinery
  locations; unresolved rows are skipped. An order counts once read the same twice in a row (time left
  ignored); a running order whose rows are only part of a registered job's or of another new order's at
  that station is no order of its own (right after accepting, "Work Order Accepted" hides rows for a few
  reads; the fuller order replaces the short one); it matches a running job at that station by the set of (material, quality) (several: the
  closest end). Matched processing orders update the job **by themselves** (yield per row via
  `/api/stock/adjust`, time left via `/api/refinery/duration` when off by over 120 s; a toast says so).
  Proposals, nothing booked without a click: unmatched processing order = new job, matched completed order =
  store it (`/api/refinery/done` with the terminal's yields), completed order without a job (never
  registered) = store its materials as stock (`/api/stock/add` per row at the station, unshared; a retry
  after a failed row adds only the rest), at the visit's end every job of a read station
  no order matched = missing (Remove after a confirm, or Keep). Dismissed proposals stay away for the app
  session. A stored completed order (materials, qualities and yields at its station: `completedKey`) is
  remembered for 30 days (localStorage `qm.companion.refinery.stored`): the terminal shows it until it is
  collected in the game, and it must not be proposed again (also not as one without a job once its job is
  stored).

## Screen capture (Windows)

`capture.rs`, the loop on sc-ohseearr's `sc-ohseearr-capture-win` (`WindowCapture`: the window, in front or not,
`is_running`, `grab_window` with the skips counted into the next frame's info; `Rest`; how it captures, DXGI Desktop
Duplication of the game's monitor cut to the window's client area with the cursor's position, and its limits (HDR,
rotated monitors untested): that crate's README). `capture.rs` keeps the interval, the worker's pull, the events and
its own `CaptureInfo` with `dropped`/`gated`/`waitMs`; `foreground_game`/`client_rect` for the overlay wrap the crate.

- While a scan runs and the foreground window belongs to `StarCitizen.exe` (not minimized): one frame per second.
- The game not in front (any other window, the companion's own too): no frames, the scan idle (`GameFront`, event
  `game-front`: the worker leaves its screen within a second, the scan row shows "Spiel nicht im Fokus"; with the
  companion in front and the game window still up the game still counts as seen). The capture is of the monitor:
  frames taken while the companion was in front read its own tables as a warehouse grid (2026-10-20).
- While the warehouse or the character inventory is in view the worker pulls the frames (`FastCapture`, since
  2026-10-27): the next one is grabbed once a read is done and the mouse cursor rested 200 ms (polled every 15 ms), so
  every read sees a fresh frame and none is grabbed while the cursor moves or the OCR works (a fixed interval handed
  slow machines frames up to a second old).
- Frames go as BGRA (converted to RGB only for frames that are read). Frames without a new desktop image are skipped
  (the next try a full interval later); skips and grabs over 150 ms are logged (debug) and go with the read
  (`capture` in the debug view's events and recordings); any error drops the duplication, reopened next time.

## Scan overlay (Windows)

`overlay.rs`; main window side `overlay.ts`; page `overlay.html` + `OverlayApp.vue`. Built 2026-10-18, used in
game since.

- A frameless, transparent, click-through, non-focusable window holding the mode's panel as a
  compact fixed-size read-only tile (300×130 logical px, 340×190 in the display "Thumbnails": wider by the rows' S thumbnails; both narrower since 2026-10-30 without the kind badges, lower since 2026-10-31), slightly see-through; layout "C" of the concept
  https://claude.ai/artifact/1CK7QBiMpLcj7n4efMeybn with the rail on the right, 2026-10-20): a narrow rail
  on the right with the four modes top down, each its icon above its count, exactly as wide as "999"
  (`3ch`, tabular digits; the shown one highlighted; a warning instead of the count when its filters are
  all off or the log is missing); next to it a 22 px line (a line below it) with the picked location after its icon in every
  mode (mono face, clipped at its end; "No location picked" in warn colour), then the newest rows at 20 px
  without lines between (a text tag only where the row has one: refinery states, new/ambiguous unlocks), 5 fit; more than that: the last one
  fades out. No hint texts: without rows only the location line.
- **Display** (settings "Darstellung", 2026-10-25; `overlayLayout.ts`, the height in `overlay.rs` follows the
  config with the next tick): "Kompakt" is the look above. "Thumbnails" (default) shows the newest row as a
  60 px top row (the M thumbnail at 44 px when the item has one, the name at 14 px above its tag and
  details at 12 px, the amount right) and 5 rows below it, each with the S thumbnail (16 px) after its tag.
  The refinery has no single newest item: rows only (8, with the first material's thumbnail).
  `OverlayRow.thumb` carries uuid and hash from the panels; the overlay page loads the images itself
  (`thumb` is allowed in every window: the app has no command allowlist).
- **Flash** (2026-10-31, always on, no setting): every
  detection (`detections.ts`): an inventory read that adds or changes a sighting (stock or gear), a refinery read with a
  new proposal or a job update, a new unlock to register that Game.log adds while the app runs (where the
  view switches too); each counts
  `OverlayView.flash` up; the page draws the location line afresh and it lights up in the accent colour
  (45 %) for 0.7 s.
- A thread puts it every 250 ms at the configured place (`overlayPosition`: top-left (default), top-center,
  top-right, bottom-left, bottom-center, bottom-right, six buttons in the settings laid out where they are;
  24 px margin, scaled with the game monitor's DPI) of the game window's client area as `HWND_TOPMOST`,
  only while `StarCitizen.exe` is the foreground window (`capture::foreground_game`; the companion in front
  hides it). SC must run borderless/windowed.
- `WDA_EXCLUDEFROMCAPTURE` keeps it out of the desktop duplication, set **before** the click-through makes
  it layered (a layered window refuses it with error 8; a failure is logged: the OCR would read it).
- On/off is not stored (off at every start); switched in the scan row or by hotkey (the settings hold
  only position, display and hotkeys). Showing it switches the scan on (locked in the scan row while it is shown), hiding it switches
  the scan off only if it started it. The mode is the main window's tab, one and the same (since
  2026-10-20; before, the overlay had its own and the two drifted apart). By itself: the screen the scan
  sees (warehouse: Stock, character inventory: Components, terminal: Refinery; nothing in view: it stays) and a blueprint
  unlock Game.log adds while the app runs that is still to register (new or ambiguous, once matched:
  Blueprints; the log's unlocks at its first state and the old logs' do not switch); both can be turned
  off in the settings ("App-Ansicht automatisch wechseln", config `autoTab`, on by default). By hand: a click on a
  tab, the mode hotkey stepping through the four. Also with the overlay off. A component row shows its name and stats only, a stack its name, quality and amount.
- Each panel writes its rows into `overlayRows`; `overlay.ts` sends the view as texts (`overlay-view`, on
  every change and on `overlay-request`).
- Hotkeys (`hotkeyOverlay`/`hotkeyMode`, accelerators with the browser's physical key code, default
  `Alt+Shift+KeyQ` for on/off (until 2026-10-20 `Ctrl+Shift+KeyQ`; a stored config keeps its own) and none for the mode; recorded in `HotkeyInput.vue`, a modifier or an F key
  required; cleared with Backspace/Delete while recording or the × inside the field) are **polled** (`GetAsyncKeyState` every 30 ms, exactly these modifiers; character keys by scan
  code, mapped with the current layout): `RegisterHotKey` never fired while SC was in front (its raw input
  keeps application hotkeys away). The keys reach the game too. A press emits `overlay-hotkey`
  `toggle`/`mode`; `set_config` refuses invalid ones (`hotkeyInvalid`, `hotkeySame`) and keeps the old.

## WebView2

Runs with `--disable-gpu` (`additionalBrowserArgs` in `tauri.conf.json` and for every further window): its
GPU process should not compete with the game; not measured yet.

## Decisions (user) and why

- **Freight manager only** for materials and items (the storage access terminal was built first and
  dropped: SCU materials are visible only in the freight manager). Components are not booked from it.
- **Components in the character inventory, strictly apart** (2026-10-18): only that tooltip shows stats
  (absolute values). The stock keeps gains, so the server delivers each stat's base value from the item's
  `raw_record` (`CatalogStat.base`; chosen over storing absolute values or scanning without stats).
- **One scan for every screen** (2026-10-19; before: one inventory scan, and a refinery session of its
  own): the worker tells warehouse, inventory and refinery terminal apart; the filters set its scope; the
  overlay runs it in every tab; Scan and location in one row above the tabs.
- **Every ship item of a component type is bookable**, crafted or not; of a group of same-named variants
  only the plain part (2026-10-19).
- **Tooltip-driven**: the user shows every entry's tooltip briefly. Icon matching (DINOv2 ViT-S/14
  embeddings) was tried and dropped: the freight manager's icons look alike, the amount is only in the
  tooltip.
- **OCR** (the readers live in sc-ohseearr now; there the details): one model for every screen, PP-OCRv6 tiny
  (2026-10-31, after small and a tiny/small split: the scans took 4–8 s on slower CPUs); the warehouse read around
  the cursor with the last layout as prior and **a layout detector of our own** (NanoDet-Plus-m, Apache-2.0, over
  Ultralytics YOLO, whose AGPL-3.0 covers the weights it trains: the companion is distributed), chosen over
  fine-tuning tiny's detector on one player's texts and over a pixel-based tile finder (the terminal's glare washes
  the hovered frame out). Tried and dropped for the gear tooltip (do not re-try): a layout detector of its own (its
  boxes cut letters; as a hybrid with tiny's boxes hardly faster, 5.7 MB more app).
- **Manual scanning** (switched on by hand or with the overlay); **one proposal per stack or component**, nothing summed up; registering asks with
  a switch per org.
- Identity history: per tile first, which double-counted after a scroll; then per column (equal components
  in a column collapsed, a wide tile counted twice); now the tile in the scrolled content (character
  inventory). The warehouse keeps the column identity.
- Wrong hover assignment once made a tile vanish and hit the neighbour: the capture's cursor decides,
  every cell stays a tile.

## Open

- 16:9 / 1080p never verified (no screenshots; the fit is position-independent in principle, the character
  inventory's constants are shares of the height).
- The refinery read with v6 and its manual scan; the refinery sync is untested in game (language packs,
  16:9, sideways scrolled orders, HDR, rotated monitors, angled views).
- Faster warehouse counting: a stack could count after one read when the chip's quality matches the tile's
  own and the count is certain (proposed 2026-10-19, not decided).
- "[CS2] StrikeForce Missile" stays unknown (the catalog says "StrikeForce II Missile"); which tooltips show
  stats at all; Quantum Fuel Burn (a lower value is the improvement, the bounds run 0…+20 %).
- `--disable-gpu` and the RAM with the OCR running are not measured in game.
- How players get the English `global-english.ini` (the game's own texts, needed for the refinery without a
  language pack) without placing it by hand: not decided (the server per build, a download, a p4k reader).
  The readers on sc-ohseearr (2026-11-06) are verified offline only (identical dumps), not yet in game.
- Not built: the Linux screen capture (xdg portal), the AppImage's updater, CI, tray/autostart; the API
  token is a full-user token (not scoped). Shelved: a native GUI instead of Tauri (Slint with its software
  renderer), only if WebView2 turns out too heavy.
