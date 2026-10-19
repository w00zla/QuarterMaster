//! Quartermaster Companion: follows SC's `Game.log` for blueprint unlocks and
//! books them, once the user confirms, through the Quartermaster web app's API
//! with the user's API token. Structure after BindSight (`config.rs`, `logwatch.rs`).
//! Reads the inventory terminals (`inventory.rs`) and the refinery terminal (`refinery.rs`) from
//! frames during a scan session the user starts (`ocr.rs`, `ocrwatch.rs`), in the player's game
//! language (`locale.rs`); the frames come from the screen capture (`capture.rs`, Windows only so far).
//! The scan overlay (`overlay.rs`, Windows only) shows the main window's detections over the game.

#[cfg(windows)]
mod capture;
pub mod components;
mod config;
mod gamelog;
pub mod inventory;
pub mod locale;
mod logwatch;
pub mod ocr;
mod ocrwatch;
#[cfg(windows)]
mod overlay;
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
// Update download progress: { done, total } (bytes; total null when unknown)
const DOWNLOAD_PROGRESS: &str = "download-progress";
// The scan session changed: its mode name
const SCAN_CHANGED: &str = "scan-changed";
// The config was saved (the debug window re-reads the language)
const CONFIG_CHANGED: &str = "config-changed";
/// The debug window's label (capabilities/default.json lists it)
const DEBUG_WINDOW: &str = "debug";
/// The main window's WebView2 arguments (tauri.conf.json `additionalBrowserArgs`), for every further window
#[cfg(windows)]
pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu";

struct AppData {
    config: Config,
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

type State<'a> = tauri::State<'a, Mutex<AppData>>;

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
        path: data.config.game_log().display().to_string(),
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
            let now_path = state.lock().unwrap().config.game_log();
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

/// Saves token, game folder, language and the overlay's position and hotkeys; the server stays as
/// loaded (only the config file changes it). Invalid hotkeys refuse the save (the ones before stay).
/// Every window hears about it (`config-changed`).
#[tauri::command]
fn set_config(app: AppHandle, state: State, mut config: Config) -> Result<Config, String> {
    let before = state.lock().unwrap().config.clone();
    config.server = before.server.clone();
    config.token = config.token.trim().to_string();
    config.game_dir = config.game_dir.trim().to_string();
    if !matches!(config.language.as_str(), "de" | "en") {
        config.language = String::new();
    }
    if !config::OVERLAY_POSITIONS.contains(&config.overlay_position.as_str()) {
        config.overlay_position = Config::default().overlay_position;
    }
    #[cfg(windows)]
    overlay::set_hotkeys(&app, &config.hotkey_overlay, &config.hotkey_mode)?;
    config::save(&app, &config)?;
    state.lock().unwrap().config = config.clone();
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
        (log_state_of(&data), data.config.game_dir.clone())
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
    let dir = app.state::<Mutex<AppData>>().lock().unwrap().config.log_backups();
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

/// One web app API call with the configured server and token; `cache`: a GET whose answer is kept in the
/// app's cache dir and revalidated by its ETag (`server::cached_api`).
#[tauri::command]
async fn api(
    app: AppHandle,
    http: tauri::State<'_, reqwest::Client>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    cache: Option<bool>,
) -> Result<server::ApiResponse, String> {
    let config = app.state::<Mutex<AppData>>().lock().unwrap().config.clone();
    if config.server.is_empty() {
        return Err("noServer".into());
    }
    let origin = server::origin(&config.server)?;
    if cache == Some(true) && method == "GET" {
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("api");
        return server::cached_api(&http, &origin, &config.token, &path, &dir).await;
    }
    server::api(&http, &origin, &config.token, &method, &path, body, None).await
}

#[derive(Serialize)]
struct AppInfo {
    version: &'static str,
    platform: &'static str,
}

/// This build's version and platform (for the update hint: which download fits).
#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo { version: env!("CARGO_PKG_VERSION"), platform: if cfg!(windows) { "windows" } else { "linux" } }
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    done: u64,
    total: Option<u64>,
}

/// Downloads an update of the configured server (with the token) to `dest`,
/// reporting progress at most every 100 ms.
#[tauri::command]
async fn download_update(app: AppHandle, http: tauri::State<'_, reqwest::Client>, url: String, dest: String) -> Result<(), String> {
    let config = app.state::<Mutex<AppData>>().lock().unwrap().config.clone();
    let origin = server::origin(&config.server)?;
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
    server::download(&http, &origin, &config.token, &url, std::path::Path::new(&dest), |done, total| {
        if Some(done) == total || last.elapsed() >= std::time::Duration::from_millis(100) {
            last = std::time::Instant::now();
            let _ = app.emit(DOWNLOAD_PROGRESS, DownloadProgress { done, total });
        }
    })
    .await
}

/// The texts of these loc keys (lower case) in the player's language pack (`global.ini` picked by
/// `user.cfg`); keys it lacks, or all without a pack, are left out.
#[tauri::command]
fn game_names(app: AppHandle, keys: Vec<String>) -> std::collections::HashMap<String, String> {
    let game_dir = app.state::<Mutex<AppData>>().lock().unwrap().config.game_dir.clone();
    let keys = keys.into_iter().map(|k| k.to_ascii_lowercase()).collect();
    locale::read_values(&locale::ini_path(std::path::Path::new(&game_dir)), &keys)
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
    let game_dir = app.state::<Mutex<AppData>>().lock().unwrap().config.game_dir.clone();
    let folder = store.start_recording(std::path::Path::new(&dir), &game_dir)?;
    log::info!("inventory debug recording to {}", folder.display());
    Ok(folder.display().to_string())
}

/// Ends the recording (closing the debug window ends it too).
#[tauri::command]
fn stop_debug_recording(app: AppHandle, store: tauri::State<ocrwatch::DebugStore>) {
    let game_dir = app.state::<Mutex<AppData>>().lock().unwrap().config.game_dir.clone();
    if let Some(folder) = store.stop_recording(&game_dir) {
        log::info!("inventory debug recording stopped: {}", folder.display());
    }
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
        overlay::set(&app, &overlay, on)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, on);
        Err("unsupported".into())
    }
}

/// Opens the configured server's web app in the browser.
#[tauri::command]
fn open_webapp(app: AppHandle) -> Result<(), String> {
    let server = app.state::<Mutex<AppData>>().lock().unwrap().config.server.clone();
    let origin = server::origin(&server)?;
    tauri_plugin_opener::open_url(format!("{origin}/"), None::<&str>).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMABUF renderer triggers "Error 71 (Protocol error)" on many
    // Wayland/Nvidia setups (see BindSight). Respect an explicit override.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(
            // Stdout for `tauri dev`, plus a rotating file in the app log dir;
            // dependencies only when they warn
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(Target::new(TargetKind::Stdout))
                .target(Target::new(TargetKind::LogDir { file_name: Some("companion".into()) }))
                .level(log::LevelFilter::Warn)
                .level_for("companion_lib", log::LevelFilter::Debug)
                .level_for(tauri_plugin_log::WEBVIEW_TARGET, log::LevelFilter::Debug)
                .max_file_size(2_000_000)
                .rotation_strategy(RotationStrategy::KeepSome(3))
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // The main and the debug window open where they were closed (place incl. monitor, size,
        // maximized); the overlay places itself
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_denylist(&["overlay"])
                .build(),
        )
        .setup(|app| {
            std::panic::set_hook(Box::new(|info| log::error!("panic: {info}")));
            let config = config::load(app.handle());
            log::info!("Companion {} started, game folder {}", env!("CARGO_PKG_VERSION"), config.game_dir);
            app.manage(Mutex::new(AppData { config, log_found: false, unlocks: Vec::new(), locations: Vec::new(), file: None, unlocks_on: true, reread: false }));
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
            let frames = ocrwatch::spawn(app.handle().clone(), detect.clone(), scan.clone(), debug.clone(), store.clone(), fast.clone());
            let seen = ocrwatch::GameSeen::default();
            #[cfg(windows)]
            capture::spawn(app.handle().clone(), frames.clone(), detect.clone(), seen.clone(), fast);
            app.manage(Mutex::new(frames));
            app.manage(detect);
            app.manage(scan);
            app.manage(debug);
            app.manage(store);
            app.manage(seen);
            // The scan overlay: off at every start; its hotkeys from the config (invalid ones only logged)
            #[cfg(windows)]
            {
                let overlay = overlay::Overlay::default();
                let handle = app.handle().clone();
                overlay::spawn(app.handle().clone(), overlay.clone(), move || {
                    handle.state::<Mutex<AppData>>().lock().unwrap().config.overlay_position.clone()
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
            app_info,
            download_update,
            open_webapp,
            get_scan,
            set_scan,
            set_debug,
            start_debug_recording,
            stop_debug_recording,
            open_debug_window,
            get_game_seen,
            game_names,
            set_overlay,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
