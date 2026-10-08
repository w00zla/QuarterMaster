//! Quartermaster Companion: follows SC's `Game.log` for blueprint unlocks and
//! books them, once the user confirms, through the Quartermaster web app's API
//! with the user's API token. Structure after BindSight (`config.rs`, `logwatch.rs`).
//! Reads the refinery terminal from frames (`ocr.rs`, `refinery.rs`, `ocrwatch.rs`);
//! the frames come from the screen capture (`capture.rs`, Windows only so far).

#[cfg(windows)]
mod capture;
mod config;
mod gamelog;
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

/// Saves token and game folder; the server stays as loaded (only the config file changes it).
#[tauri::command]
fn set_config(app: AppHandle, state: State, mut config: Config) -> Result<Config, String> {
    config.server = state.lock().unwrap().config.server.clone();
    config.token = config.token.trim().to_string();
    config.game_dir = config.game_dir.trim().to_string();
    config::save(&app, &config)?;
    state.lock().unwrap().config = config.clone();
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

/// Whether the refinery detection is on.
#[tauri::command]
fn get_detect(detect: tauri::State<ocrwatch::Detect>) -> bool {
    detect.load(std::sync::atomic::Ordering::Relaxed)
}

/// Turns the refinery detection on or off.
#[tauri::command]
fn set_detect(detect: tauri::State<ocrwatch::Detect>, on: bool) {
    detect.store(on, std::sync::atomic::Ordering::Relaxed);
    log::info!("refinery detection {}", if on { "on" } else { "off" });
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
            // The frame channel for the screen capture (Windows so far); QM_OCR_FRAMES feeds test images
            // Detection is on at every start (the capture only runs while the game is in front)
            let detect = ocrwatch::Detect::new(std::sync::atomic::AtomicBool::new(true));
            let frames = ocrwatch::spawn(app.handle().clone(), detect.clone());
            let seen = ocrwatch::GameSeen::default();
            #[cfg(windows)]
            capture::spawn(app.handle().clone(), frames.clone(), detect.clone(), seen.clone());
            app.manage(Mutex::new(frames));
            app.manage(detect);
            app.manage(seen);
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
            get_detect,
            set_detect,
            get_game_seen,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
