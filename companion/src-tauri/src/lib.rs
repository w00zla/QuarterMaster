//! Quartermaster Companion: follows SC's `Game.log` for blueprint unlocks and
//! books them, once the user confirms, through the Quartermaster web app's API
//! with the user's API token. Structure after BindSight (`config.rs`, `logwatch.rs`).
//! Reads the inventory terminals (`inventory.rs`) and the refinery terminal (`refinery.rs`) from
//! frames during a scan session the user starts (`ocr.rs`, `ocrwatch.rs`), in the player's game
//! language (`locale.rs`); the frames come from the screen capture (`capture.rs`, Windows only so far).

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
pub mod refinery;
mod server;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

use config::Config;
use gamelog::Unlock;

/// Event to the frontend: the log state (file found, unlocks) changed; it
/// fetches `log_state` again.
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
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu";

struct AppData {
    config: Config,
    /// Whether `Game.log` exists at the configured place
    log_found: bool,
    /// Every unlock seen since the app started (live log and scanned
    /// backups), the first per name, oldest first
    unlocks: Vec<Unlock>,
}

type State<'a> = tauri::State<'a, Mutex<AppData>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogState {
    path: String,
    found: bool,
    unlocks: Vec<Unlock>,
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
/// poll (unlocks earlier in this game session count too), then what the game
/// appends; a new file (game restart) or another folder starts over.
fn spawn_game_log_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut path = PathBuf::new();
        let mut last = None;
        let mut tail = logwatch::Tail::default();
        loop {
            let state = app.state::<Mutex<AppData>>();
            let now_path = state.lock().unwrap().config.game_log();
            let stamp = logwatch::stamp(&now_path);
            if now_path != path || logwatch::is_new_file(last, stamp) {
                tail.reset();
                path = now_path;
            }
            last = stamp;
            let text = match stamp {
                Some(_) => tail.read(&path).unwrap_or_else(|e| {
                    log::debug!("{}: {e}", path.display());
                    String::new()
                }),
                None => String::new(),
            };
            let found = gamelog::unlocks(&text);
            let changed = {
                let mut data = state.lock().unwrap();
                let flipped = data.log_found != stamp.is_some();
                data.log_found = stamp.is_some();
                if !found.is_empty() {
                    log::info!("{} blueprint unlock(s) in {}", found.len(), path.display());
                }
                merge_unlocks(&mut data, found) || flipped
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

/// Saves token, game folder and language; the server stays as loaded (only the config file changes
/// it). Every window hears about it (`config-changed`).
#[tauri::command]
fn set_config(app: AppHandle, state: State, mut config: Config) -> Result<Config, String> {
    config.server = state.lock().unwrap().config.server.clone();
    config.token = config.token.trim().to_string();
    config.game_dir = config.game_dir.trim().to_string();
    if !matches!(config.language.as_str(), "de" | "en") {
        config.language = String::new();
    }
    config::save(&app, &config)?;
    state.lock().unwrap().config = config.clone();
    let _ = app.emit(CONFIG_CHANGED, ());
    Ok(config)
}

#[tauri::command]
fn log_state(state: State) -> LogState {
    let data = state.lock().unwrap();
    LogState { path: data.config.game_log().display().to_string(), found: data.log_found, unlocks: data.unlocks.clone() }
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

/// One web app API call with the configured server and token.
#[tauri::command]
async fn api(
    app: AppHandle,
    http: tauri::State<'_, reqwest::Client>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<server::ApiResponse, String> {
    let config = app.state::<Mutex<AppData>>().lock().unwrap().config.clone();
    if config.server.is_empty() {
        return Err("noServer".into());
    }
    server::api(&http, &server::origin(&config.server)?, &config.token, &method, &path, body).await
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

/// The running scan session: "off", "inventory", "components" or "refinery".
#[tauri::command]
fn get_scan(detect: tauri::State<ocrwatch::Detect>, scan: tauri::State<ocrwatch::Scan>) -> &'static str {
    if detect.load(std::sync::atomic::Ordering::Relaxed) { scan.get() } else { ocrwatch::ScanMode::Off }.name()
}

/// Starts a scan session ("inventory", "components", "refinery") or stops it ("off"); the capture runs only during
/// one. Every window hears about it (`scan-changed`).
#[tauri::command]
fn set_scan(app: AppHandle, detect: tauri::State<ocrwatch::Detect>, scan: tauri::State<ocrwatch::Scan>, mode: String) -> Result<(), String> {
    let mode = ocrwatch::ScanMode::parse(&mode).ok_or("invalid")?;
    scan.set(mode);
    detect.store(mode != ocrwatch::ScanMode::Off, std::sync::atomic::Ordering::Relaxed);
    log::info!("scan {}", mode.name());
    let _ = app.emit(SCAN_CHANGED, mode.name());
    Ok(())
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
        .min_inner_size(640.0, 400.0);
    #[cfg(windows)]
    let builder = builder.additional_browser_args(BROWSER_ARGS);
    let window = builder.build().map_err(|e| e.to_string())?;
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
        .setup(|app| {
            std::panic::set_hook(Box::new(|info| log::error!("panic: {info}")));
            let config = config::load(app.handle());
            log::info!("Companion {} started, game folder {}", env!("CARGO_PKG_VERSION"), config.game_dir);
            app.manage(Mutex::new(AppData { config, log_found: false, unlocks: Vec::new() }));
            app.manage(server::client());
            spawn_game_log_watch(app.handle().clone());
            // The frame channel for the screen capture (Windows so far); QM_OCR_FRAMES feeds test images.
            // No scan session at start: the user starts one (the capture only runs during a session while
            // the game is in front)
            let detect = ocrwatch::Detect::new(std::sync::atomic::AtomicBool::new(false));
            let scan = ocrwatch::Scan::default();
            let debug = ocrwatch::Debug::default();
            let store = ocrwatch::DebugStore::default();
            let frames = ocrwatch::spawn(app.handle().clone(), detect.clone(), scan.clone(), debug.clone(), store.clone());
            let seen = ocrwatch::GameSeen::default();
            #[cfg(windows)]
            capture::spawn(app.handle().clone(), frames.clone(), detect.clone(), seen.clone());
            app.manage(Mutex::new(frames));
            app.manage(detect);
            app.manage(scan);
            app.manage(debug);
            app.manage(store);
            app.manage(seen);
            // Closing the main window ends the app, the debug window included (else it would keep
            // the process alive)
            if let Some(main) = app.get_webview_window("main") {
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
