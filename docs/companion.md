# Companion app

A desktop app (Tauri 2, structure after BindSight) that works for the user next to the game, through the
user web app's API with the user's API token ("Access Key"):

- reads blueprint unlocks from `Game.log` and registers them;
- scans the freight manager's warehouse for material stacks and the character inventory for ship
  components with their stats (OCR of the hovered tile's tooltip on a screen capture) and proposes them
  as stock;
- syncs the refinery jobs of a station with the terminal's work order overview (same OCR; its scan is
  disabled until re-checked with the current OCR model);
- shows what it detects in a scan overlay over the game.

Linux and Windows; the screen capture and so every scan and the overlay are Windows only so far.

Rust (`companion/src-tauri/src/`): `lib` (commands, setup), `config`, `logwatch`, `gamelog`, `server`,
`ocr`, `inventory` (warehouse read), `components` (character inventory read), `refinery`, `locale`,
`ocrwatch` (scan worker), `capture`, `overlay`. Vue SPA with three pages (`index.html` → `App.vue`,
`debug.html` → `DebugApp.vue`, `overlay.html` → `OverlayApp.vue`) importing the shared styles, `Icon.vue`,
`Tooltip.vue` and the web app's `ConfirmDialog.vue` and `Picker.vue` relatively. Pure logic in
`companion/src/{match,inventory,components,refinery}.ts`, tested from `test/companion-*.test.ts`.

Commands, the log file and its lines: `CLAUDE.md` "Commands".

## Game.log and blueprint unlocks

- `logwatch.rs`, `gamelog.rs`: a metadata poll every 2 s (new file = other creation time or shorter:
  NTFS tunneling), a tail that hands out complete lines (lossy UTF-8: Windows SC writes the ANSI code
  page). Read: blueprint unlocks only, the `Added notification "Received Blueprint: <name>: " [n]` line
  (names may hold quotes; the `UpdateNotificationItem` repeats are skipped). The whole current log is
  read at start, then what the game appends. "Full scan" reads every `logbackups/*.log` (GBs: `memmem`
  search, off the main thread; progress per file as the `scan-progress` event, shown as a bar in place of
  the panel title). The list keeps the first unlock per name.
- Matching (`match.ts`): names against the catalog's blueprint output names in de and en (community
  translations), ship component prefix (`Ind/1/B Guardian`) stripped and used to narrow by size/grade;
  several candidates = the user picks; default blueprints are never registered. Checked against all 78
  unlocks in a real 2026 log history: all matched.
- No refinery terminal events in `Game.log` (checked): only notifications.

## Server, config and releases

- `server.rs`, `config.rs`: server origin fixed (`https://quartermaster.w00z.net`; missing or empty in
  the file = that; only a `server` entry in the config file changes it, e.g. `http://localhost:5174` for
  dev, read at start). Config as JSON in the app config dir like BindSight
  (`%APPDATA%\com.w00zla.quartermaster.companion\config.json`): Access Key (pasted from the web app's
  Companion dialog), LIVE folder, UI language (`de`, `en` or empty = the system's; `langRef` in `i18n.ts`
  is reactive, the debug window re-reads it on `config-changed`), the overlay's position and hotkeys.
  Saving keeps the file's `server` entry as it is: the default is never written, a hand edit while the app
  runs is not overwritten.
- Every API call goes through the Rust `api` command (only `/api/…`, GET/POST; no CORS) with
  `X-QM-Companion` = the Cargo version. A 426 makes the app show only the update panel (`UpdatePanel.vue`:
  installed and required version, the download for its platform): Rust `download_update` fetches it with
  the token (only URLs below the configured origin's `/downloads/`, `<dest>.part` renamed when complete,
  the file left as downloaded: no permission changes) to a path picked in a save dialog, progress as the
  `download-progress` event. Plain http only for localhost.
- Release: bump the version in `companion/src-tauri/Cargo.toml` (bundle names and the header use it),
  build per platform (standalone only: the AppImage, and `target/release/quartermaster-companion.exe`
  zipped as `…_x64-standalone.zip`), copy them and `companion.json` to `COMPANION_DIR` (`docs/deploy.md`
  § 8; the server side is in `docs/webapp.md` "Companion release").

## Window, tabs and state

- `App.vue`, `components/TopBar.vue`, `WindowEdges.vue`, `state.ts`: no native frame
  (`decorations: false`), the title bar after BindSight's (drag region, minimize/maximize/close; window
  permissions in `capabilities/default.json`, which lists the windows `main`, `debug`, `overlay`),
  invisible resize edges. The window stays narrow (640 px, also its minimum); main and debug window open
  where they were closed (`tauri-plugin-window-state`: place incl. monitor, size, maximized; the overlay
  is excluded, it places itself).
- Below the title bar a row of fixed height: on the left the game log state ("Log available" as a
  `.tag ok`, or "Log not found" as a chip with the path in the tooltip) and the scan session's state
  (`scan.ts`/`overlay.ts` `scanState`: "Scan off" / "Preparing…" / "Scanning inventory|refinery" with the
  game seen / "Game not detected"); on the right the user (Discord avatar and name from `/api/me`; CSP
  `img-src` allows `cdn.discordapp.com`) and, after a divider, an icon button opening the web app in the
  browser (Rust `open_webapp`: the configured origin only), or the connection's short reason as a chip
  when down. Problem chips open the settings.
- `state.ts` holds config, connection and log state; every API call goes through its `api()`; connection
  refusals (`noServer`, `noToken`, `invalidServer`, `insecureServer`, `invalidToken`, `network`, 426) mark
  the connection down and are not toasted (`isConnectionError`); a down connection is re-checked every
  30 s, any connection on window focus; a successful check clears the update hint. Toasts are for events
  only.
- A tab bar (icons; each tab and panel title with its table's row count, `tabCounts` in `overlay.ts`; the
  last tab kept in localStorage `qm.companion.tab`, one state with the overlay's mode) with the panels
  Inventory (`InventoryPanel.vue`), Refinery (`RefineryPanel.vue`) and Blueprints (`UnlocksPanel.vue`), all
  three kept mounted (`v-show`); panel heads carry no icon. Inventory and Refinery fill the window and
  scroll only their rows (head, filter and column titles stay).
- Settings dialog (`SettingsDialog.vue`): Access Key, language, game folder, the "Scan overlay" group
  (Windows only, see below), Diagnostics (opens the debug window). Labels left, controls right like
  BindSight's settings.

## Scan session

- `ocrwatch.rs`, Rust `get_scan`/`set_scan` (`off`, `inventory`, `refinery`), `scan.ts`: the user starts a
  scan from a panel's head (Scan / Stop) or by showing the overlay; one session at a time; off at every
  start; the capture runs only during a session. Manual scanning stays (decided 2026-10-18; the former
  automatic refinery detection, the cheap `terminal_in_view` check on every still view, is kept behind
  `AUTO_REFINERY = false`).
- A refinery session reads a live frame once the view came to rest after it moved and every 2 s (`Gate`:
  a 96×40 grey thumbnail sampled from the frame; checking every changed frame took ~5 % CPU in the verse).
  An inventory session reads every delivered frame (1/s) without the gate: the world behind the
  translucent inventory screen never comes to rest (the gate delayed reads by 3–6 s in the first test).
- The worker reads the newest frame when it falls behind. The `Ocr` is loaded by a session's first read
  (well under a second) and dropped as soon as the session stops (memory back; the memory arena stays on:
  off made reads 30 % slower). "Preparing…" while the sync loads the catalog and the player's language
  pack. `StarCitizen.exe` running comes from `capture.rs` (`game-seen` / `get_game_seen`).
  `QM_OCR_FRAMES=<dir>` feeds every image in a folder once (tests without capture; the session must still
  be started in the UI).
- Inventory sessions emit `inventory-read` per read (`grid` for the warehouse, `components` for the
  character inventory, never both). Which screen: `Screen` in `ocrwatch.rs`, unknown at first; the cheap
  page number read (~30 ms, `read_page`; only "n/m" with m ≤ 99) marks the character inventory, else the
  grid read the warehouse, and a frame with neither is tried as the inventory too; the decision stands
  until the reader found nothing 3 reads in a row (`SCREEN_MISSES`: a switch takes the player seconds);
  without a known screen the session probes every 2 s only (`PROBE_MS`).

## Warehouse scan (freight manager)

The freight elevator terminal's tab Warehouse (`inventory.rs`, pure part `inventory.ts`, store
`inventorySync.ts`): materials and items. 4 columns of tiles, scrolled without pages, every tile with a
count badge top right ("X1", "X14") and an info icon top left, a material tile with its quality bottom left
("572Q", the dim Q read as 0, a letter or ".0"). The icons look alike, so the name comes from the tooltip of
the hovered tile, which opens at the cursor (title; materials also "Capacity: …", the chip "<name>"
"<quality>" and the SCU; items the title only). The gems (Feynmaline, Hadanite, …) are items in the catalog:
their amount is the badge's count, the tooltip's "0.001 SCU" is per piece.

### The read (Rust)

- Only the pane right of the screen centre is read, at native height (the elevator pane is ignored; also
  halves the detector's memory).
- The terminal is a screen in the world: the grid's pitch changes with the player's position (260–290 px at
  1600 px height), so the grid is **fitted per frame** from the detected badge boxes and quality texts
  (anchors with weights, the pitch and phase most agree on per axis, the four consecutive columns with the
  most anchors, rows within 0.3–0.84 of the height; at least anchor weight 3). The first strong fit of a
  session (anchor weight ≥ `STRONG_FIT_WEIGHT` on the weaker axis) locks the pitch, weaker fits keep it and
  fit only the phase (reset when the session stops); the row pitch is bounded to 0.85–1.05 of the column
  pitch. Every cell is a tile (unread fields None). The fit can sit up to ~30 px off the tiles.
- Quality band per tile, recognized on its own; not read when the tooltip covers over 20 % of it.
- Badges: only the hovered tile's (every tile's while the debug window is open: the costly part). First the
  nearest detected box of a badge's size around the tile's top right corner (`BADGE_SEARCH`, whatever the
  general model read there: "X 2" came as "xa"), with room on its right (`BADGE_RIGHT_PAD`: the detector
  boxes only the "X" of "X 6" now and then, a digit at the crop's edge reads as "8"), then the tile's badge
  area; upscaled 3×, recognized with the badge's characters only (`Ocr::recognize_images_only`,
  "Xx× 0123456789": the multi-language model read a "6" as "日"); the first read with digits wins, a bare
  "X" = 1 flagged uncertain (so far always a real X1 whose thin 1 got lost). Not read when the tooltip
  covers over 5 % of the area: it opens at the cursor, near the tile's top over its own badge. The
  recordings of 2026-10-19: the hovered tile's count in 115 of 120 and 52 of 55 frames (34 and 69 before).
- Tooltip (`tooltip_from_boxes`): titles are Title Case texts with ≥ 3 letters (the panel's capitals and
  icon texts are none). The tooltip is see-through: a tile's quality behind it shows in the title's row
  ("Janalite 360" over a 360Q neighbour), so the quality is the number right of the name's repeat in the
  chip row, else any number below the title row, never one in it.
- The **hovered tile** is the one under the mouse cursor, which the capture passes with every frame
  (`Frame.cursor`, frame pixels; the duplicated image has no pointer). Screenshots without a cursor fall
  back to the tile with the chip's quality or whose quality the tooltip hides (near the right edge the
  tooltip is shifted left over the tile), else the one under the tooltip's cursor point.

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
  names, missing qualities and amounts stay sightings without a proposal, listed in the debug window.
- **One proposal per stack**, nothing summed up, with what the user's stored stock at that location already
  holds of that material and quality.

## Components scan (character inventory)

Ship components only (`components.rs`, pure part `components.ts`), read in the character inventory's
"Storage Access" screen, because only its tooltip shows a component's stats.

- The storage pane on the right: a grid 4 units wide, a tile 1 unit (coolers, missiles) or 2 (weapons)
  wide, rows mixed like 2+2 or 1+2+1, 6 rows in view, scrolled row by row with a green thumb on its right,
  pages "2/3" below it. The UI is a screen-space overlay around the frame's centre, scaling with the height:
  every position is a share of the height, horizontally from the centre (constants measured on 3840×1600
  only). The left (personal) pane is not read.
- The tooltip opens at a **fixed place** right of the character (not at the cursor); only that area (right of
  the centre, 0.22–0.76 of the height, scaled up to 1800 px height for the small texts) and the page
  number's go through the OCR, ~0.25–0.4 s per read on 3840×1600, and only while the cursor is on a lit tile.
  A tooltip needs ≥ 4 body lines and 3 letters in the title (real ones have 13–17 lines, stray reads of the
  scene 1–3); the Rust side emits the title and the body lines as texts (also into the log).
- The **hovered tile** (`hovered_tile`, pixel checks, no OCR): its row in the page's content = the cursor's
  row plus the pane's scroll, taken from the thumb's place (`scroll_of`: the thumb moves ~61.6 px per 150 px
  row at 1600 px height, snapped to whole rows within 0.15); its units from the light cyan frame the game
  draws around the hovered tile, looked for at the 5 unit edges in the row's middle band (±0.008 of the
  height: tiles leave ~9 px gaps, frames sit up to ~11 px off the edge), the nearest lit edge left and right
  of the cursor (`span_of`). Checked against the recording of 2026-10-18 (195 frames): every tile with a
  tooltip found, the misses only while the cursor moved on.
- Frontend: the title ("Mil/3/A Blizzard") against the catalog's component names in de/en plus the language
  pack, the prefix narrowing size and grade (`findComponents`; among same-name variants the craftable one;
  the catalog lists only the plain part of a variant group, see `docs/stock.md`). Stat lines ("Coolant
  Rating:  60.00", the value in a column of its own; a dropped colon is tolerated) against each stat's
  names (`CatalogStat.name` per language, `nameKey` in the pack); the absolute value converted to the stored
  gain with `CatalogStat.base` (`statFromTooltip`): an unmodified component reads as ±0; "no stats" only
  when the tooltip had no stat lines (weapons, event items); a value below the base beyond rounding, above
  the blueprint's bound, unparsable or without a known base = "Stats not readable" (no proposal, listed in
  the debug window with the reason, like unknown or ambiguous titles).
- A sighting's identity is **page + content row + units + content** (a tile hovered again after a scroll is
  the same sighting, equal components on other tiles stay apart). A tooltip counts only once the cursor
  stayed on its tile for a read, then two agreeing reads in a row (≥ 3 reads per tile). One proposal per
  sighting (one piece, quality 0, the stats if any).
- Screenshot tests over `local/screenshots/inventory 3`; `cargo run --release --example components_dump --
  <dir>…` prints the title and lines per image.

## Inventory panel, locations, registering

- Head: title with count, the location picker (`Picker`, kept in localStorage
  `qm.companion.inventory.location`), Scan / Stop, "Register all". Below: the kind filter, toggle chips
  Materials / Items / Components (on = the kind's badge colour with a check, off = dashed and dimmed; what
  the scan detects from then on; localStorage `qm.companion.inventory.kinds`). Then one compact row per
  proposal: an icon badge for the kind (its name as tooltip), resource (a component with its stats after
  the name, "Coolant Rating +12.5 % · Integrity ±0.0 %"), location, quality, amount, Register / Discard.
- **Every location collects its own** sightings (`inventorySync.ts`: an `InventoryScan` and a
  `ComponentScan` per location, keys and ids prefixed with the location): a read belongs to the location
  picked at that moment (changeable while scanning: the player walks from one warehouse to the next); the
  panel lists every location's proposals, each is registered at its own location; the overlay shows the
  current location's only. Starting a session clears the sightings of the one before.
- Registering (one or all) asks in a dialog with a switch per org to share right away (`guildIds`, the
  choice kept for the session); adds only via `/api/stock/add`.

## Debug window

- `debug.html` + `DebugApp.vue`, opened from the settings (Rust `open_debug_window`, async, with the main
  window's WebView2 browser arguments: another set hangs WebView2; no JS close handler: `destroy` would
  need a permission); closing the main window ends the app, the debug window with it.
- Two tabs: the last read (the frame as a JPEG data URL, 1280 px wide, CSP `img-src data:`, with SVG
  overlays: OCR boxes, read cells, tiles, hovered tile, tooltip, or the character inventory's tooltip lines
  and the cursor's tile; facts; collapsible tooltip lines, cells and OCR boxes) and the main window's
  sightings of both scans in one table (event `inventory-sightings` on every change,
  `inventory-sightings-request` on open; own kind filter; columns source (FE = warehouse, INV = character
  inventory), name, quality, amount or stats, page and cell, state = the reason it is no proposal, or
  Proposal / Registered / Discarded).
- While it is open (`set_debug`) every read goes with its frame to the **debug writer** thread
  (`spawn_debug_writer`), which encodes it, keeps the last 3 reads in RAM and emits the event: on the worker,
  encoding and writing stretched the reads' interval from 1.05 to 1.8 s.
- "Record data" asks for a folder and writes a session folder `qm-inventory-debug-<unix s>`: the 3 kept
  reads, then every read while it runs (frame as JPEG quality 90, ~0.6 MB, + JSON with grid, components part
  and boxes; `info.json` with the count), until stopped or the window closes. The folders replay through
  `inventory_dump` and `components_dump`.

## OCR

- `ocr.rs`: PaddleOCR PP-OCRv6 small (since 2026-10-18; one multi-language detector and recognizer,
  dictionary of 18708 characters; ONNX, Apache-2.0, as converted by RapidOCR, fetched by
  `scripts/fetch-ocr-models.mjs` with pinned SHA-256 and compiled in with `include_bytes!`: the Windows
  release is a bare exe, ~31 MB of models) on ONNX Runtime via `ort` (prebuilt, static); pre/post-processing
  after RapidOCR, boxes axis-aligned, lines recognized in batches of 6 of similar shape (~8 % faster).
  `recognize_images_only` restricts the CTC decoding to given characters (the probability taken among
  them).
- Frames are scaled by **height** (the game's UI scales with it: 16:9 like ultrawide). Read times on
  3840×1600: warehouse ~0.7–1.0 s (more with the debug window: every badge), character inventory
  ~0.25–0.4 s, refinery overview ~0.9 s.
- Labels from `locale.rs`: `user.cfg`'s `g_language` picks `data/Localization/<language>/global.ini` (a
  language pack, also one replacing the English texts like StarStrings; keys case-insensitive, a pack's
  `key,P=` suffix dropped; re-read when `user.cfg` or the file change, checked every 10 s); every label
  matches in English and the pack's wording; Rust `game_names(keys)` returns pack texts for loc keys.

## Refinery

- Read (`refinery.rs`): only the terminal's **work order overview**: the station from the title, then every
  work order panel side by side (found by its table head "MATERIALS YIELDED"; header PROCESSING or
  COMPLETED; columns by the head's words; rows by the names ending at the summary lines or a `// …` section
  label; a row without a quality is dropped; a cell the full pass missed is recognized on its own):
  processing orders with quality, yield (cSCU) and time remaining, completed ones with quality and yield. A
  panel cut by the edge is left out (the terminal scrolls sideways). Full read at 800 px height,
  anchor-first; `terminal_in_view` is the cheap check (320 px height, the big titles: 30–110 ms). Checked
  against the screenshots of 2026-10-07/08 (`local/screenshots/refinery flow`, `… 2`, `… 3`) with the v5
  model; with v6 two of those tests fail, and the panel's Scan button stays disabled until fixed.
- Session: a **visit** (`refinery-visit` `{atMs, active}`), each overview as `refinery-overview`; 60 s
  without frames end the visit.
- Sync (`refinery.ts`, store `refinerySync.ts`, `RefineryPanel.vue`): names via `findMaterial` (shared with
  the bot) over the catalog's de/en names plus the pack texts; the station by its title against refinery
  locations; unresolved rows are skipped. An order counts once read the same twice in a row (time left
  ignored); it matches a running job at that station by the set of (material, quality) (several: the
  closest end). Matched processing orders update the job **by themselves** (yield per row via
  `/api/stock/adjust`, time left via `/api/refinery/duration` when off by over 120 s; a toast says so).
  Proposals, nothing booked without a click: unmatched processing order = new job, matched completed order =
  store it (`/api/refinery/done` with the terminal's yields), at the visit's end every job of a read station
  no order matched = missing (Remove after a confirm, or Keep). Dismissed proposals stay away for the app
  session.

## Screen capture (Windows)

`capture.rs`: while a scan session runs and the foreground window belongs to `StarCitizen.exe` (not
minimized), or the companion itself is in front and the game window seen before is still up, one frame per
second through DXGI Desktop Duplication (`windows` crate, the version Tauri uses): the game's monitor
duplicated on the adapter driving it, cut to the window's client area (physical pixels: the process is
per-monitor DPI aware), with the cursor's position in frame pixels (`GetCursorPos`), into a staging texture
kept while the size stays, sent as BGRA (converted to RGB only for frames that are read). Chosen over
Windows.Graphics.Capture for its border-free capture on Windows 10. Frames without a new desktop image are
skipped; any error drops the duplication, reopened next time. HDR untested (the legacy `DuplicateOutput`
should deliver `B8G8R8A8`; other formats are refused with a warning; `IDXGIOutput5::DuplicateOutput1` with
FP16 and a tone map would be the fix); rotated monitors untested.

## Scan overlay (Windows)

`overlay.rs`; main window side `overlay.ts`; page `overlay.html` + `OverlayApp.vue`. Built 2026-10-18, used in
game since.

- A frameless, transparent, click-through, non-focusable window holding the active tab's panel as a
  fixed-size read-only tile (400×236 logical px, slightly see-through): the mode's name with the row count
  quietly after it, the inventory's location; tags (the inventory's detected kinds as icons, else the
  state); the 6 most recently seen rows (the inventory's kind badges as icons), "+n more"; the rows clipped
  above the tile's bottom padding.
- A thread puts it every 250 ms at the configured place (`overlayPosition`: top-left (default), top-center,
  top-right, bottom-left, bottom-center, bottom-right, six buttons in the settings laid out where they are;
  24 px margin, scaled with the game monitor's DPI) of the game window's client area as `HWND_TOPMOST`,
  only while `StarCitizen.exe` is the foreground window (`capture::foreground_game`; the companion in front
  hides it). SC must run borderless/windowed.
- `WDA_EXCLUDEFROMCAPTURE` keeps it out of the desktop duplication, set **before** the click-through makes
  it layered (a layered window refuses it with error 8; a failure is logged: the OCR would read it).
- On/off is not stored (off at every start); switched in the settings (at once) or by hotkey. The mode is
  the main window's tab: while on, the inventory tab runs the inventory scan (once a location is picked;
  turning it on starts a fresh session, switching back to the tab resumes), refinery and blueprints run none;
  the panels' Scan buttons are locked; hiding it always stops the scan.
- Each panel writes its rows into `overlayRows`; `overlay.ts` sends the view as texts (`overlay-view`, on
  every change and on `overlay-request`).
- Hotkeys (`hotkeyOverlay`/`hotkeyMode`, accelerators with the browser's physical key code, default
  `Ctrl+Shift+KeyQ` for on/off and none for the mode; recorded in `HotkeyInput.vue`, a modifier or an F key
  required) are **polled** (`GetAsyncKeyState` every 30 ms, exactly these modifiers; character keys by scan
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
- **One inventory scan, one panel**: the worker tells the screens apart.
- **Every ship item of a component type is bookable**, crafted or not; of a group of same-named variants
  only the plain part (2026-10-19).
- **Tooltip-driven**: the user shows every entry's tooltip briefly. Icon matching (DINOv2 ViT-S/14
  embeddings) was tried and dropped: the freight manager's icons look alike, the amount is only in the
  tooltip.
- **PP-OCRv6 small** replaced v5 (2026-10-18); the refinery read is secondary.
- **Manual scanning**; **one proposal per stack or component**, nothing summed up; registering asks with
  a switch per org.
- Identity history: per tile first, which double-counted after a scroll; then per column (equal components
  in a column collapsed, a wide tile counted twice); now the tile in the scrolled content (character
  inventory). The warehouse keeps the column identity.
- Wrong hover assignment once made a tile vanish and hit the neighbour: the capture's cursor decides,
  every cell stays a tile.

## Measurements (3840×1600)

- Warehouse grid pitch 260–290 px (rows 0.91–0.98 of that), see the fit.
- Badge texts: "X1" often "X" (taken as 1, uncertain), "X10" as "X1D" (D/O → 0), "X14"/"X51"/"X63" fine
  upscaled 3×.
- Quality texts: "572Q", "5720", "3100Q", "523.0", "371g" all parse; a bare 2-digit number is a cut-off
  text.
- Character inventory: tooltip at x = centre + 0.05…0.35 h, y = 0.26…0.6 h; storage grid units at pitch
  0.098 h from centre + 0.400 h, rows at 0.0938 h from 0.244 h; page "2/3" at centre + 0.56…0.64 h,
  y 0.83…0.85 h; the scrollbar thumb at centre + 0.802 h, its track 0.235…0.815 h.
- Read intervals (log of 2026-10-19): ~1.05–1.2 s without the debug recording.

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
- Not built: the Linux screen capture (xdg portal), updater, CI, tray/autostart, a release script; the API
  token is a full-user token (not scoped). Shelved: a native GUI instead of Tauri (Slint with its software
  renderer), only if WebView2 turns out too heavy.
