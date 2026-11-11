//! Quartermaster Companion: follows SC's `Game.log` for blueprint unlocks and
//! books them, once the user confirms, through the Quartermaster API: the online web app's
//! with the user's API token, or the Quartermaster app's on this PC (`pairing.rs`, `target`).
//! Structure after BindSight (`config.rs`, `logwatch.rs`).
//! Reads the warehouse (`inventory.rs`), the character inventory (`components.rs`) and the refinery
//! terminal (`refinery.rs`) from frames during a scan session the user starts (`ocr.rs`, `ocrwatch.rs`)
//! with sc-ohseearr's readers, in the player's game language (sc-ohseearr's `Locale`); the frames come
//! from the screen capture (`capture.rs` on sc-ohseearr's capture crate, Windows only so far).
//! The scan overlay (`overlay.rs`, Windows only) shows the main window's detections over the game.

#[cfg(windows)]
mod capture;
pub mod components;
mod config;
mod gamelog;
pub mod inventory;
mod logwatch;
pub mod ocr;
mod ocrwatch;
#[cfg(windows)]
mod overlay;
mod pairing;
pub mod refinery;
mod server;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

use config::Config;
use gamelog::{LocationLine, Unlock};

/// Event to the frontend: the log state (file found, unlocks, location lines) changed; it
/// fetches `log_state` again (not for the file's size and times alone: the game writes all the time).
const LOG_CHANGED: &str = "log-changed";
// Full scan progress: { done, total } (log files)
const SCAN_PROGRESS: &str = "scan-progress";
// The scan session changed: its mode name
const SCAN_CHANGED: &str = "scan-changed";
// The config was saved (the main window re-reads it and the connection, the debug window the language)
const CONFIG_CHANGED: &str = "config-changed";
/// The companion's releases (the update panel's button); fixed here, never a URL from the page
const RELEASES_URL: &str = "https://github.com/w00zla/quartermaster/releases";
/// The debug window's label (capabilities/default.json lists it)
const DEBUG_WINDOW: &str = "debug";
/// The settings window's label (capabilities/default.json lists it) and its fixed inner width (logical px)
const SETTINGS_WINDOW: &str = "settings";
const SETTINGS_WIDTH: f64 = 560.0;
/// The main window's WebView2 arguments (tauri.conf.json `additionalBrowserArgs`), for every further window
#[cfg(windows)]
pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu";

struct AppData {
    config: Config,
    /// The local app's pairing file as last read (`target`, at every connection attempt in the local mode); kept
    /// while the app does not run (its game folder stays the one in use), dropped when the connection is set online
    paired: Option<pairing::Pairing>,
    /// Whether `Game.log` exists at the configured place
    log_found: bool,
    /// Every unlock seen since the app started (live log and scanned
    /// backups), the first per name, oldest first
    unlocks: Vec<Unlock>,
    /// Every location line of the current `Game.log` (`gamelog::location`), oldest first
    locations: Vec<LocationLine>,
    /// The current `Game.log` as last polled, `None` while not found
    file: Option<LogFile>,
    /// Blueprint unlocks are read (the blueprints panel's "Unlocks" filter; on at start, the frontend
    /// sends its stored choice); the location lines are read either way
    unlocks_on: bool,
    /// Read the current log again from its start (unlocks switched on)
    reread: bool,
}

impl AppData {
    /// The game folder in use (`Config::game_dir_with`: the paired app's in the local mode, else the config's).
    fn game_dir(&self) -> String {
        self.config.game_dir_with(self.paired.as_ref().and_then(|p| p.game_dir.as_deref()))
    }
}

type State<'a> = tauri::State<'a, Mutex<AppData>>;

/// Where the API calls go now. Online: the configured server with the token. Local: the origin the app's pairing
/// file names, read at every call (the port can change between the app's starts); no file, or not a valid one, is
/// `noLocalApp` (the app is not running).
fn target(app: &AppHandle) -> Result<server::Target, String> {
    let state = app.state::<Mutex<AppData>>();
    let config = state.lock().unwrap().config.clone();
    if config.connection != config::LOCAL {
        if config.server.is_empty() {
            return Err("noServer".into());
        }
        return Ok(server::Target { origin: server::origin(&config.server)?, token: Some(config.token) });
    }
    let pairing = pairing::read(&pairing::file()).ok_or("noLocalApp")?;
    let origin = pairing.origin.clone();
    let mut data = state.lock().unwrap();
    if data.paired.as_ref() != Some(&pairing) {
        log::info!("local app at {origin}, game folder {}", pairing.game_dir.as_deref().unwrap_or("not set there"));
        data.paired = Some(pairing);
    }
    Ok(server::Target { origin, token: None })
}

/// The followed file on disk (the debug window shows it).
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct LogFile {
    created_ms: Option<u64>,
    modified_ms: Option<u64>,
    size: u64,
    /// How far it is read (bytes)
    read_to: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogState {
    path: String,
    found: bool,
    unlocks: Vec<Unlock>,
    /// The last location key the current `Game.log` named
    location: Option<String>,
    locations: Vec<LocationLine>,
    file: Option<LogFile>,
}

fn log_state_of(data: &AppData) -> LogState {
    LogState {
        path: config::game_log(&data.game_dir()).display().to_string(),
        found: data.log_found,
        unlocks: data.unlocks.clone(),
        location: data.locations.last().map(|l| l.key.clone()),
        locations: data.locations.clone(),
        file: data.file,
    }
}

/// Adds unlocks to the list (first per name); whether the list changed.
fn merge_unlocks(data: &mut AppData, found: Vec<Unlock>) -> bool {
    if found.is_empty() {
        return false;
    }
    let before = data.unlocks.clone();
    let mut all = std::mem::take(&mut data.unlocks);
    all.extend(found);
    data.unlocks = gamelog::first_per_name(all);
    data.unlocks != before
}

/// Follows `Game.log` from its start: the whole current file at the first
/// poll (unlocks and the location earlier in this game session count too), then
/// what the game appends; a new file (game restart) or another folder starts
/// over (the location lines with it).
fn spawn_game_log_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut path = PathBuf::new();
        let mut last = None;
        let mut tail = logwatch::Tail::default();
        loop {
            let state = app.state::<Mutex<AppData>>();
            let now_path = config::game_log(&state.lock().unwrap().game_dir());
            let stamp = logwatch::stamp(&now_path);
            let mut moved = false;
            let reread = std::mem::take(&mut state.lock().unwrap().reread);
            if reread || now_path != path || logwatch::is_new_file(last, stamp) {
                tail.reset();
                path = now_path;
                moved = !std::mem::take(&mut state.lock().unwrap().locations).is_empty();
            }
            last = stamp;
            let text = match stamp {
                Some(_) => tail.read(&path).unwrap_or_else(|e| {
                    log::debug!("{}: {e}", path.display());
                    String::new()
                }),
                None => String::new(),
            };
            let lines = gamelog::location_lines(&text);
            let changed = {
                let mut data = state.lock().unwrap();
                let found = if data.unlocks_on { gamelog::unlocks(&text) } else { Vec::new() };
                let flipped = data.log_found != stamp.is_some();
                data.log_found = stamp.is_some();
                data.file = stamp.map(|s| LogFile {
                    created_ms: s.created.map(ocrwatch::unix_ms),
                    modified_ms: s.modified.map(ocrwatch::unix_ms),
                    size: s.len,
                    read_to: tail.pos(),
                });
                if !found.is_empty() {
                    log::info!("{} blueprint unlock(s) in {}", found.len(), path.display());
                }
                if let Some(last) = lines.last().filter(|l| data.locations.last().map(|d| &d.key) != Some(&l.key)) {
                    log::info!("location {}", last.key);
                }
                moved |= !lines.is_empty();
                data.locations.extend(lines);
                merge_unlocks(&mut data, found) || flipped || moved
            };
            if changed {
                let _ = app.emit(LOG_CHANGED, ());
            }
            std::thread::sleep(logwatch::POLL);
        }
    });
}

// --- commands ------------------------------------------------------------------

#[tauri::command]
fn get_config(state: State) -> Config {
    state.lock().unwrap().config.clone()
}

/// Saves the connection, token, game folder, language and the overlay's position, display and hotkeys; the server
/// stays as loaded (only the config file changes it). Invalid hotkeys refuse the save (the ones before stay).
/// Every window hears about it (`config-changed`).
#[tauri::command]
fn set_config(app: AppHandle, state: State, mut config: Config) -> Result<Config, String> {
    let before = state.lock().unwrap().config.clone();
    config.server = before.server.clone();
    config.token = config.token.trim().to_string();
    config.game_dir = config.game_dir.trim().to_string();
    if config.connection != config::LOCAL {
        config.connection = config::ONLINE.into();
    }
    if !matches!(config.language.as_str(), "de" | "en") {
        config.language = String::new();
    }
    if !config::OVERLAY_POSITIONS.contains(&config.overlay_position.as_str()) {
        config.overlay_position = Config::default().overlay_position;
    }
    if !config::OVERLAY_DISPLAYS.contains(&config.overlay_display.as_str()) {
        config.overlay_display = Config::default().overlay_display;
    }
    #[cfg(windows)]
    overlay::set_hotkeys(&app, &config.hotkey_overlay, &config.hotkey_mode)?;
    config::save(&app, &config)?;
    {
        let mut data = state.lock().unwrap();
        if config.connection != config::LOCAL {
            data.paired = None;
        }
        data.config = config.clone();
    }
    let _ = app.emit(CONFIG_CHANGED, ());
    Ok(config)
}

#[tauri::command]
fn log_state(state: State) -> LogState {
    log_state_of(&state.lock().unwrap())
}

/// Switches reading the blueprint unlocks from `Game.log` on or off: off drops the list, on reads the
/// current log again from its start (what came while off counts too).
#[tauri::command]
fn set_unlock_scan(app: AppHandle, state: State, on: bool) {
    let mut data = state.lock().unwrap();
    if data.unlocks_on == on {
        return;
    }
    data.unlocks_on = on;
    if on {
        data.reread = true;
    } else {
        data.unlocks.clear();
    }
    drop(data);
    log::info!("unlock scan {}", if on { "on" } else { "off" });
    let _ = app.emit(LOG_CHANGED, ());
}

/// Writes the Game.log export `qm-gamelog-debug-<unix s>.json` into `dir`: this build, the log state and
/// what the main window made of it (`report`: blueprint matches, locations); the file's path.
#[tauri::command]
fn export_log_debug(state: State, dir: String, report: serde_json::Value) -> Result<String, String> {
    let (logged, game_dir) = {
        let data = state.lock().unwrap();
        (log_state_of(&data), data.game_dir())
    };
    let now = ocrwatch::unix_ms(std::time::SystemTime::now());
    let export = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": if cfg!(windows) { "windows" } else { "linux" },
        "exportedAtMs": now,
        "gameDir": game_dir,
        "log": logged,
        "report": report,
    });
    let path = std::path::Path::new(&dir).join(format!("qm-gamelog-debug-{}.json", now / 1000));
    std::fs::write(&path, serde_json::to_string_pretty(&export).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", path.display()))?;
    log::info!("Game.log debug export to {}", path.display());
    Ok(path.display().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    /// Unlocks in the old logs (first per name)
    found: usize,
    /// Logs that could not be read
    failed: usize,
}

#[derive(Serialize, Clone)]
struct ScanProgress {
    done: usize,
    total: usize,
}

/// Reads every old log in `logbackups` once (GBs: off the main thread) and
/// adds their unlocks to the list; reports progress at most every 50 ms.
#[tauri::command]
async fn scan_backups(app: AppHandle) -> Result<ScanResult, String> {
    let dir = config::log_backups(&app.state::<Mutex<AppData>>().lock().unwrap().game_dir());
    let emitter = app.clone();
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let (found, failed) = tauri::async_runtime::spawn_blocking(move || {
        gamelog::scan_folder(&dir, |done, total| {
            if done == total || last.elapsed() >= std::time::Duration::from_millis(50) {
                last = std::time::Instant::now();
                let _ = emitter.emit(SCAN_PROGRESS, ScanProgress { done, total });
            }
        })
    })
    .await
        .map_err(|e| e.to_string())??;
    let count = found.len();
    let changed = merge_unlocks(&mut app.state::<Mutex<AppData>>().lock().unwrap(), found);
    if changed {
        let _ = app.emit(LOG_CHANGED, ());
    }
    Ok(ScanResult { found: count, failed })
}

/// One API call to the server in use (`target`) with the frontend's API contract number (`COMPANION_API` in
/// `src/webapp/api-types.ts`, the one place it lives); `cache`: a GET whose answer is kept in the app's cache dir
/// and revalidated by its ETag (`server::cached_api`).
#[tauri::command]
async fn api(
    app: AppHandle,
    http: tauri::State<'_, reqwest::Client>,
    api_number: u32,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    cache: Option<bool>,
) -> Result<server::ApiResponse, String> {
    let target = target(&app)?;
    if cache == Some(true) && method == "GET" {
        return server::cached_api(&http, &target, api_number, &path, &api_cache_dir(&app)?).await;
    }
    server::api(&http, &target, api_number, &method, &path, body, None).await
}

/// Where API answers are kept (the catalog per language, the game's English texts).
fn api_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("api"))
}

/// Brings the game's English texts kept on disk up to date with the server in use (`server::cached_text`: the
/// readers' English table, `ocrwatch`); the answer like `api`'s, without a body when the table is there.
#[tauri::command]
async fn refresh_locale(app: AppHandle, http: tauri::State<'_, reqwest::Client>, api_number: u32) -> Result<server::ApiResponse, String> {
    let target = target(&app)?;
    server::cached_text(&http, &target, api_number, &api_cache_dir(&app)?).await
}

/// The local app as its pairing file last said (`target`): its origin and game folder; None online or before the
/// file was read.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Paired {
    origin: String,
    game_dir: Option<String>,
}

#[tauri::command]
fn paired(state: State) -> Option<Paired> {
    state.lock().unwrap().paired.as_ref().map(|p| Paired { origin: p.origin.clone(), game_dir: p.game_dir.clone() })
}

/// An item thumbnail (`size` s|m|l, catalog UUID, content hash) as a `data:` URL: from the app's cache dir
/// (`thumbs/`), else fetched from the server in use and kept there (`server::thumb`).
#[tauri::command]
async fn thumb(app: AppHandle, http: tauri::State<'_, reqwest::Client>, size: String, uuid: String, hash: String) -> Result<String, String> {
    let origin = target(&app)?.origin;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("thumbs");
    server::thumb(&http, &origin, &size, &uuid, &hash, &dir).await
}

#[derive(Serialize)]
struct AppInfo {
    version: &'static str,
    platform: &'static str,
    /// The installed app (NSIS setup), not the bare exe
    setup: bool,
}

/// Whether the screen scan's OCR can run on the GPU (the settings grey their switch out otherwise).
#[tauri::command]
fn gpu_status(gpu: tauri::State<ocrwatch::Gpu>) -> ocrwatch::GpuState {
    gpu.state()
}

/// This build's version, platform and kind.
#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo { version: env!("CARGO_PKG_VERSION"), platform: if cfg!(windows) { "windows" } else { "linux" }, setup: installed() }
}

/// Whether this is the installed app: the bundler stamps the exe it packs into the setup, the bare
/// exe stays unstamped.
fn installed() -> bool {
    #[cfg(windows)]
    return matches!(tauri::utils::platform::bundle_type(), Some(tauri::utils::config::BundleType::Nsis));
    #[cfg(not(windows))]
    false
}

/// The texts of these loc keys (lower case) in the player's language pack (`global.ini` picked by
/// `user.cfg`); keys it lacks, or all without a pack, are left out.
#[tauri::command]
fn game_names(app: AppHandle, keys: Vec<String>) -> std::collections::HashMap<String, String> {
    let game_dir = app.state::<Mutex<AppData>>().lock().unwrap().game_dir();
    let Ok(pack) = sc_ohseearr_sc::LocTable::load(&sc_ohseearr_sc::locale::pack_path(std::path::Path::new(&game_dir))) else { return Default::default() };
    keys.into_iter()
        .filter_map(|k| {
            let k = k.to_ascii_lowercase();
            pack.get(&k).map(|v| (k, v.to_string()))
        })
        .collect()
}

/// Whether the scan runs.
#[tauri::command]
fn get_scan(detect: tauri::State<ocrwatch::Detect>) -> bool {
    detect.load(std::sync::atomic::Ordering::Relaxed)
}

/// Switches the scan on or off, with the screens it reads (a change of them while it runs applies to
/// the next frame); the capture runs only while it is on. Every window hears about it (`scan-changed`).
#[tauri::command]
fn set_scan(app: AppHandle, detect: tauri::State<ocrwatch::Detect>, scan: tauri::State<ocrwatch::Scan>, on: bool, warehouse: bool, inventory: bool, refinery: bool) {
    let scope = ocrwatch::Scope { warehouse, inventory, refinery };
    scan.set(scope);
    let was = detect.swap(on, std::sync::atomic::Ordering::Relaxed);
    if was != on {
        log::info!("scan {}", if on { "on" } else { "off" });
        let _ = app.emit(SCAN_CHANGED, on);
    }
    log::debug!("scan scope {scope:?}");
}

/// Opens the settings window (settings.html), or brings it to the front. Fixed width, not resizable; it starts
/// hidden, and the page reports its content height (`fit_settings_window`), which sets the height before the
/// window shows (what the page holds depends on the platform). Async and with the main window's browser
/// arguments like the debug window.
#[tauri::command]
async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(SETTINGS_WINDOW) {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let builder = tauri::WebviewWindowBuilder::new(&app, SETTINGS_WINDOW, tauri::WebviewUrl::App("settings.html".into()))
        .title("Quartermaster Companion – Settings")
        .inner_size(SETTINGS_WIDTH, 600.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .visible(false);
    #[cfg(windows)]
    let builder = builder.additional_browser_args(BROWSER_ARGS);
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Sizes the settings window to its content (`height`, logical px; the page measures it once it is filled), centers
/// it and shows it.
#[tauri::command]
fn fit_settings_window(app: AppHandle, height: f64) -> Result<(), String> {
    let window = app.get_webview_window(SETTINGS_WINDOW).ok_or("no settings window")?;
    window.set_size(tauri::LogicalSize::new(SETTINGS_WIDTH, height)).map_err(|e| e.to_string())?;
    window.center().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())
}

/// Opens the debug window (debug.html), or brings it to the front; closing it turns the debug flag
/// off. Async: the window is built off the main thread (a sync command runs on it, and building a
/// window waits for it). The webview gets the main window's browser arguments: WebView2 shares one
/// browser process per app, a second webview with other arguments does not come up.
#[tauri::command]
async fn open_debug_window(app: AppHandle, debug: tauri::State<'_, ocrwatch::Debug>, store: tauri::State<'_, ocrwatch::DebugStore>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(DEBUG_WINDOW) {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let builder = tauri::WebviewWindowBuilder::new(&app, DEBUG_WINDOW, tauri::WebviewUrl::App("debug.html".into()))
        .title("Quartermaster Companion – Debug")
        .inner_size(960.0, 760.0)
        .min_inner_size(640.0, 400.0)
        .visible(false);
    #[cfg(windows)]
    let builder = builder.additional_browser_args(BROWSER_ARGS);
    // Shown once the window state plugin placed it, like the main window
    let window = builder.build().map_err(|e| e.to_string())?;
    let _ = window.show();
    let (debug, store) = (debug.inner().clone(), store.inner().clone());
    window.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            debug.0.store(false, std::sync::atomic::Ordering::Relaxed);
            store.0.lock().unwrap().clear();
            log::info!("inventory debug window closed");
        }
    });
    Ok(())
}

/// Turns the inventory debug mode on or off (frames with the events, the last reads kept); off drops
/// the kept reads. The debug window sets it when it opens; its destruction clears it.
#[tauri::command]
fn set_debug(debug: tauri::State<ocrwatch::Debug>, store: tauri::State<ocrwatch::DebugStore>, on: bool) {
    debug.0.store(on, std::sync::atomic::Ordering::Relaxed);
    if !on {
        store.0.lock().unwrap().clear();
    }
    log::info!("inventory debug {}", if on { "on" } else { "off" });
}

/// Starts recording the inventory reads (frames as PNG, reads as JSON, an info file) into a new
/// folder below `dir`: the kept reads first, then every read while it runs; the folder's path.
#[tauri::command]
fn start_debug_recording(app: AppHandle, store: tauri::State<ocrwatch::DebugStore>, dir: String) -> Result<String, String> {
    let game_dir = app.state::<Mutex<AppData>>().lock().unwrap().game_dir();
    let folder = store.start_recording(std::path::Path::new(&dir), &game_dir)?;
    log::info!("inventory debug recording to {}", folder.display());
    Ok(folder.display().to_string())
}

/// Ends the recording (closing the debug window ends it too).
#[tauri::command]
fn stop_debug_recording(app: AppHandle, store: tauri::State<ocrwatch::DebugStore>) {
    let game_dir = app.state::<Mutex<AppData>>().lock().unwrap().game_dir();
    if let Some(folder) = store.stop_recording(&game_dir) {
        log::info!("inventory debug recording stopped: {}", folder.display());
    }
}

/// Whether the game window is in front, so the scan reads (changes come as `game-front`).
#[tauri::command]
fn get_game_front(front: tauri::State<ocrwatch::GameFront>) -> bool {
    front.0.load(std::sync::atomic::Ordering::Relaxed)
}

/// Whether the screen capture sees Star Citizen running (changes come as `game-seen`).
#[tauri::command]
fn get_game_seen(seen: tauri::State<ocrwatch::GameSeen>) -> bool {
    seen.0.load(std::sync::atomic::Ordering::Relaxed)
}

/// Switches the scan overlay on (its window, shown while the game is in front) or off (Windows only).
/// Async: building a window must not run on the main thread (see the debug window).
#[tauri::command]
async fn set_overlay(app: AppHandle, on: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let overlay = app.state::<overlay::Overlay>().inner().clone();
        let display = app.state::<Mutex<AppData>>().lock().unwrap().config.overlay_display.clone();
        overlay::set(&app, &overlay, on, &display)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, on);
        Err("unsupported".into())
    }
}

/// A file on disk as the debug window shows it; `size` None = not there.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileInfo {
    path: String,
    size: Option<u64>,
    modified_ms: Option<u64>,
}

fn file_info(path: &std::path::Path) -> FileInfo {
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file());
    FileInfo {
        path: path.display().to_string(),
        size: meta.as_ref().map(|m| m.len()),
        modified_ms: meta.and_then(|m| m.modified().ok()).map(ocrwatch::unix_ms),
    }
}

/// The catalog of one language as kept on disk (`server::cached_api`; `/api/companion/catalog`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeptCatalog {
    lang: &'static str,
    file: FileInfo,
    etag: Option<String>,
}

/// The debug window's General tab, the app's side: the server in use, the app's folders, the player's language
/// pack (`user.cfg`'s language, None = not set: the game's English) and the catalog kept on disk.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugInfo {
    /// The origin in use (the local app's as last paired), else the configured text (invalid) or nothing (no
    /// local app seen)
    server: String,
    config_file: String,
    log_dir: String,
    cache_dir: String,
    game_dir: String,
    language: Option<String>,
    pack: FileInfo,
    catalog: Vec<KeptCatalog>,
}

#[tauri::command]
fn debug_info(app: AppHandle) -> DebugInfo {
    let (config, game_dir, paired) = {
        let state = app.state::<Mutex<AppData>>();
        let data = state.lock().unwrap();
        (data.config.clone(), data.game_dir(), data.paired.as_ref().map(|p| p.origin.clone()))
    };
    let shown = |dir: tauri::Result<PathBuf>| dir.map(|d| d.display().to_string()).unwrap_or_default();
    let cache = app.path().app_cache_dir().ok();
    let server = if config.connection == config::LOCAL { paired.unwrap_or_default() } else { server::origin(&config.server).unwrap_or(config.server.clone()) };
    let game_dir = std::path::Path::new(&game_dir);
    let catalog = ["de", "en"]
        .into_iter()
        .filter_map(|lang| {
            let (file, etag) = server::kept_etag(&cache.as_ref()?.join("api"), &format!("/api/companion/catalog?lang={lang}"));
            Some(KeptCatalog { lang, file: file_info(&file), etag })
        })
        .collect();
    DebugInfo {
        server,
        config_file: shown(app.path().app_config_dir().map(|d| d.join("config.json"))),
        log_dir: shown(app.path().app_log_dir()),
        cache_dir: cache.as_ref().map(|d| d.display().to_string()).unwrap_or_default(),
        game_dir: game_dir.display().to_string(),
        language: sc_ohseearr_sc::locale::language(game_dir),
        pack: file_info(&sc_ohseearr_sc::locale::pack_path(game_dir)),
        catalog,
    }
}

/// Opens one of the app's folders in the file manager (the debug window): `config`, `log`, `cache` or
/// the game folder (`game`); only these, never a path from the page.
#[tauri::command]
fn open_folder(app: AppHandle, which: String) -> Result<(), String> {
    let dir = match which.as_str() {
        "config" => app.path().app_config_dir(),
        "log" => app.path().app_log_dir(),
        "cache" => app.path().app_cache_dir(),
        "game" => Ok(PathBuf::from(app.state::<Mutex<AppData>>().lock().unwrap().game_dir())),
        _ => return Err("unknown folder".into()),
    }
    .map_err(|e| e.to_string())?;
    if !dir.is_dir() {
        return Err(format!("{}: not found", dir.display()));
    }
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

/// Opens the web app of the server in use in the browser (the local app's paired origin in the local mode).
#[tauri::command]
fn open_webapp(app: AppHandle) -> Result<(), String> {
    let origin = target(&app)?.origin;
    tauri_plugin_opener::open_url(format!("{origin}/"), None::<&str>).map_err(|e| e.to_string())
}

/// Opens the companion's releases page in the browser (the update panel: the app installs nothing itself).
#[tauri::command]
fn open_releases() -> Result<(), String> {
    tauri_plugin_opener::open_url(RELEASES_URL, None::<&str>).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMABUF renderer triggers "Error 71 (Protocol error)" on many
    // Wayland/Nvidia setups (see BindSight). Respect an explicit override.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let builder = tauri::Builder::default()
        .plugin(
            // Stdout for `tauri dev`, plus a rotating file in the app log dir;
            // dependencies only when they warn
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(Target::new(TargetKind::Stdout))
                .target(Target::new(TargetKind::LogDir { file_name: Some("companion".into()) }))
                .level(log::LevelFilter::Warn)
                .level_for("companion_lib", log::LevelFilter::Debug)
                .max_file_size(2_000_000)
                .rotation_strategy(RotationStrategy::KeepSome(3))
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // The main and the debug window open where they were closed (place incl. monitor, size,
        // maximized); the overlay places itself, the settings window sizes itself to its content and centers
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_denylist(&["overlay", "settings"])
                .build(),
        );
    builder
        .setup(|app| {
            std::panic::set_hook(Box::new(|info| log::error!("panic: {info}")));
            let config = config::load(app.handle());
            log::info!("Companion {} started, connection {}, game folder {}", env!("CARGO_PKG_VERSION"), config.connection, config.game_dir);
            app.manage(Mutex::new(AppData { config, paired: None, log_found: false, unlocks: Vec::new(), locations: Vec::new(), file: None, unlocks_on: true, reread: false }));
            app.manage(server::client());
            spawn_game_log_watch(app.handle().clone());
            // The frame channel for the screen capture (Windows so far); QM_OCR_FRAMES feeds test images.
            // No scan session at start: the user starts one (the capture only runs during a session while
            // the game is in front)
            let detect = ocrwatch::Detect::new(std::sync::atomic::AtomicBool::new(false));
            let scan = ocrwatch::Scan::default();
            let debug = ocrwatch::Debug::default();
            let store = ocrwatch::DebugStore::default();
            let fast = ocrwatch::FastCapture::default();
            let front = ocrwatch::GameFront::default();
            let gpu = ocrwatch::Gpu::new();
            let frames = ocrwatch::spawn(app.handle().clone(), detect.clone(), scan.clone(), debug.clone(), store.clone(), fast.clone(), front.clone(), gpu.clone());
            let seen = ocrwatch::GameSeen::default();
            #[cfg(windows)]
            capture::spawn(app.handle().clone(), frames.clone(), detect.clone(), seen.clone(), fast, front.clone());
            app.manage(Mutex::new(frames));
            app.manage(detect);
            app.manage(scan);
            app.manage(debug);
            app.manage(store);
            app.manage(seen);
            app.manage(front);
            app.manage(gpu);
            // The scan overlay: off at every start; its hotkeys from the config (invalid ones only logged)
            #[cfg(windows)]
            {
                let overlay = overlay::Overlay::default();
                let handle = app.handle().clone();
                overlay::spawn(app.handle().clone(), overlay.clone(), move || {
                    let state = handle.state::<Mutex<AppData>>();
                    let data = state.lock().unwrap();
                    (data.config.overlay_position.clone(), data.config.overlay_display.clone())
                });
                app.manage(overlay);
                app.manage(overlay::Hotkeys::default());
                let c = app.state::<Mutex<AppData>>().lock().unwrap().config.clone();
                if let Err(e) = overlay::set_hotkeys(app.handle(), &c.hotkey_overlay, &c.hotkey_mode) {
                    log::warn!("overlay hotkeys not set: {e}");
                }
                overlay::spawn_hotkeys(app.handle().clone());
            }
            // Closing the main window ends the app, the debug window included (else it would keep
            // the process alive). It starts hidden and shows only now, after the window state plugin
            // moved it to its saved place (else it pops up at the default place first)
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let handle = app.handle().clone();
                main.on_window_event(move |e| {
                    if let tauri::WindowEvent::Destroyed = e {
                        handle.exit(0);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            log_state,
            export_log_debug,
            set_unlock_scan,
            scan_backups,
            api,
            refresh_locale,
            paired,
            thumb,
            app_info,
            gpu_status,
            open_webapp,
            open_releases,
            debug_info,
            open_folder,
            get_scan,
            set_scan,
            set_debug,
            start_debug_recording,
            stop_debug_recording,
            open_debug_window,
            open_settings_window,
            fit_settings_window,
            get_game_seen,
            get_game_front,
            game_names,
            set_overlay,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
