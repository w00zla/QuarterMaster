//! Quartermaster's desktop shell (docs/app.md): starts the singleuser server as a Node sidecar from the bundle in the
//! app's resources, shows the loading steps on the splash, then the web app at the origin the server reports, and
//! provides the shell contract the web app calls (docs/webapp.md "The desktop shell (the contract)"): the pickers, the
//! frameless window's commands and the app updates.

mod bundle;
mod config;
mod protocol;
mod settings;
mod sidecar;
mod texts;
mod update;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri_runtime::ResizeDirection;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, Url, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

use bundle::BundleInfo;
use protocol::{Line, Step, STEPS};
use sidecar::{Sidecar, STOP_WAIT};
use texts::Lang;
use update::{UpdateState, Updater};

const MAIN_WINDOW: &str = "main";
/// The event the splash listens to; its payload is the `Splash`.
const SPLASH_EVENT: &str = "splash-changed";
/// The update check at start never holds the start longer than this.
const START_CHECK_LIMIT: Duration = Duration::from_secs(5);

/// What the splash shows: the version, the row of segments, one line of text; or a message with the quit button.
#[derive(Debug, Clone, Serialize)]
struct Splash {
    version: String,
    steps: u8,
    step: u8,
    text: String,
    error: Option<String>,
    quit: String,
}

struct Shell {
    lang: Lang,
    splash: Mutex<Splash>,
    /// The splash's address, to come back to it when the server ends.
    splash_url: Mutex<Option<Url>>,
    /// The origin the server reported: the only one beside the splash the window may show.
    origin: Arc<Mutex<Option<String>>>,
    sidecar: Sidecar,
    quitting: AtomicBool,
}

fn set_splash(app: &AppHandle, change: impl FnOnce(&mut Splash)) {
    let shell = app.state::<Shell>();
    let splash = {
        let mut splash = shell.splash.lock().unwrap();
        change(&mut splash);
        splash.clone()
    };
    let _ = app.emit(SPLASH_EVENT, splash);
}

/// The message with the quit button; the window comes back to the splash if it already showed the web app.
fn show_fatal(app: &AppHandle, text: &str) {
    log::error!("fatal: {text}");
    set_splash(app, |s| s.error = Some(text.to_string()));
    let shell = app.state::<Shell>();
    if shell.origin.lock().unwrap().take().is_some() {
        let url = shell.splash_url.lock().unwrap().clone();
        if let (Some(url), Some(window)) = (url, app.get_webview_window(MAIN_WINDOW)) {
            let _ = window.navigate(url);
        }
    }
}

/// Stops the server cleanly (`stop` on its stdin, up to 10 s, then killed) and returns when it is gone.
pub(crate) fn stop_server(app: &AppHandle) {
    app.state::<Shell>().sidecar.stop(STOP_WAIT);
}

/// The app ends: the window disappears at once, the server is stopped, then the process exits.
fn quit_app(app: &AppHandle) {
    if app.state::<Shell>().quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        stop_server(&app);
        app.exit(0);
    });
}

/// The window shows the splash (the app's own page) and the server's origin, nothing else.
fn navigation_allowed(url: &Url, dev: Option<&Url>, server: Option<&str>) -> bool {
    let same = |other: &Url| url.scheme() == other.scheme() && url.host_str() == other.host_str() && url.port_or_known_default() == other.port_or_known_default();
    let splash = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    splash || dev.is_some_and(same) || server.and_then(|origin| Url::parse(origin).ok()).is_some_and(|origin| same(&origin))
}

fn step_text(info: &BundleInfo, lang: Lang, step: Option<Step>) -> String {
    let texts = match lang {
        Lang::De => &info.start_texts.de,
        Lang::En => &info.start_texts.en,
    };
    match step {
        Some(Step::LanguagePack) => texts.language_pack.clone(),
        _ => texts.starting.clone(),
    }
}

fn home_dir(app: &AppHandle) -> PathBuf {
    app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// The start: the bundle, the update at start (when "Updates automatisch" is on), then the server.
async fn start(app: AppHandle) {
    let shell = app.state::<Shell>();
    let lang = shell.lang;
    let resources = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    let dir = bundle::bundle_dir(std::env::var(bundle::BUNDLE_ENV).ok(), &resources);
    let info = match bundle::read_bundle(&dir) {
        Ok(info) => info,
        Err(e) => {
            log::error!("bundle: {e}");
            return show_fatal(&app, lang.fatal(""));
        }
    };
    log::info!("bundle: {} (app {}, node {})", dir.display(), info.app.version, info.node.version);
    set_splash(&app, |s| s.text = step_text(&info, lang, None));

    let env = |name: &str| std::env::var(name).ok();
    if settings::read_auto_update(&env, cfg!(windows), &home_dir(&app)) {
        match tokio::time::timeout(START_CHECK_LIMIT, update::check(&app, false)).await {
            Ok(true) => {
                set_splash(&app, |s| s.text = lang.installing_update().to_string());
                // Returns only when it failed: the app then starts as it is
                update::install(&app).await;
                set_splash(&app, |s| s.text = step_text(&info, lang, None));
            }
            Ok(false) => {}
            Err(_) => {
                log::warn!("update check at start: no answer within {} s", START_CHECK_LIMIT.as_secs());
                update::abandon(&app);
            }
        }
    } else {
        log::info!("automatic update: off");
    }
    if shell.quitting.load(Ordering::SeqCst) {
        return;
    }
    start_server(&app, &dir, &info);
}

fn start_server(app: &AppHandle, dir: &Path, info: &BundleInfo) {
    let shell = app.state::<Shell>();
    let lang = shell.lang;
    let node = sidecar::node_path(&std::env::current_exe().unwrap_or_default());
    let inherited: Vec<String> = std::env::vars_os().filter_map(|(name, _)| name.into_string().ok()).collect();
    let spec = sidecar::spec(&node, dir, info, &inherited);
    // Set by a QM_FATAL line: the end of stdout that follows must not replace its message
    let failed = Arc::new(AtomicBool::new(false));

    let on_line = {
        let (app, info, failed) = (app.clone(), info.clone(), failed.clone());
        move |line: Line| match line {
            Line::Step(step) => set_splash(&app, |s| {
                s.step = step.number();
                s.text = step_text(&info, lang, Some(step));
            }),
            Line::Ready(origin) => {
                let Ok(url) = Url::parse(&origin) else { return };
                *app.state::<Shell>().origin.lock().unwrap() = Some(origin);
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = window.navigate(url);
                }
            }
            Line::Fatal(code) => {
                failed.store(true, Ordering::SeqCst);
                show_fatal(&app, lang.fatal(&code));
            }
            Line::Log => {}
        }
    };
    let on_end = {
        let app = app.clone();
        move |asked: bool| {
            if asked || failed.load(Ordering::SeqCst) {
                return;
            }
            // The server ended by itself: before it listened that is a failed start, afterwards a stopped server
            let listened = app.state::<Shell>().origin.lock().unwrap().is_some();
            show_fatal(&app, if listened { lang.stopped() } else { lang.fatal("") });
        }
    };
    if let Err(e) = shell.sidecar.start(&spec, on_line, on_end) {
        log::error!("server: {e}");
        show_fatal(app, lang.fatal(""));
    }
}

// --- the splash's commands ---

#[tauri::command]
fn splash_state(shell: State<Shell>) -> Splash {
    shell.splash.lock().unwrap().clone()
}

#[tauri::command]
fn quit(app: AppHandle) {
    quit_app(&app);
}

// --- the shell contract (webapp/src/shellLogic.ts) ---

#[tauri::command]
async fn pick_folder(window: WebviewWindow) -> Option<String> {
    let folder = window.dialog().file().set_parent(&window).blocking_pick_folder()?;
    folder.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn pick_file(window: WebviewWindow, extensions: Vec<String>) -> Option<String> {
    let mut dialog = window.dialog().file().set_parent(&window);
    let extensions: Vec<&str> = extensions.iter().map(|e| e.trim_start_matches('.')).filter(|e| !e.is_empty()).collect();
    if !extensions.is_empty() {
        let name = extensions.iter().map(|e| format!("*.{e}")).collect::<Vec<_>>().join(", ");
        dialog = dialog.add_filter(name, &extensions);
    }
    dialog.blocking_pick_file()?.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: WebviewWindow) -> Result<(), String> {
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if maximized { window.unmaximize() } else { window.maximize() }.map_err(|e| e.to_string())
}

/// A close request, as from the system: the server is stopped first (`on_window_event`).
#[tauri::command]
fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_is_maximized(window: WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_start_resize(window: tauri::Window, direction: ResizeDirection) -> Result<(), String> {
    window.start_resize_dragging(direction).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_state(updater: State<Updater>) -> UpdateState {
    updater.state()
}

#[tauri::command]
fn update_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        update::check(&app, false).await;
    });
}

#[tauri::command]
fn update_install(app: AppHandle) {
    tauri::async_runtime::spawn(async move { update::install(&app).await });
}

#[tauri::command]
fn update_set_channel(app: AppHandle, id: String) -> Result<(), String> {
    update::choose_channel(&app, &id)?;
    tauri::async_runtime::spawn(async move {
        update::check(&app, true).await;
    });
    Ok(())
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    // One app per data folder. The default folder: a second start brings the running window to the front and ends.
    // With QM_DATA_DIR (development, tests) several may run; the server's lock then guards each folder.
    if std::env::var_os("QM_DATA_DIR").is_none_or(|dir| dir.is_empty()) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| focus_main(app)));
    }
    builder
        .plugin(
            // The shell's lines and everything the server prints: stdout (tauri dev) and a file in the app's log folder,
            // 2 MB with three old files kept
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(Target::new(TargetKind::Stdout))
                .target(Target::new(TargetKind::LogDir { file_name: Some("quartermaster".into()) }))
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .rotation_strategy(RotationStrategy::KeepSome(3))
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        // The updater's plugin side; the checks go through update.rs
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // A panic ends the app (release builds abort; the server then stops by itself: its stdin closes), but the
            // reason reaches the log first
            std::panic::set_hook(Box::new(|info| log::error!("panic: {info}")));
            let handle = app.handle().clone();
            let lang = Lang::system();
            let version = env!("CARGO_PKG_VERSION");
            log::info!("Quartermaster {version}, language {lang:?}, updater {}", if update::updater_available() { "available" } else { "not available (not an installed build)" });

            let feed = update::Feed::from_env(std::env::var(update::FEED_ENV).ok().as_deref());
            if let Err(e) = &feed {
                log::error!("{e}");
            }
            app.manage(Updater::new(version, config::load_channel(&config::config_file(&handle)), feed, lang));
            let origin = Arc::new(Mutex::new(None::<String>));
            app.manage(Shell {
                lang,
                splash: Mutex::new(Splash { version: version.into(), steps: STEPS, step: 0, text: String::new(), error: None, quit: lang.quit().into() }),
                splash_url: Mutex::new(None),
                origin: origin.clone(),
                sidecar: Sidecar::default(),
                quitting: AtomicBool::new(false),
            });

            let window_config = app.config().app.windows.first().ok_or("tauri.conf.json: no window")?.clone();
            let dev = if tauri::is_dev() { app.config().build.dev_url.clone() } else { None };
            let window = WebviewWindowBuilder::from_config(&handle, &window_config)?
                .on_navigation(move |url| {
                    let allowed = navigation_allowed(url, dev.as_ref(), origin.lock().unwrap().as_deref());
                    if !allowed {
                        log::warn!("navigation refused: {url}");
                    }
                    allowed
                })
                .build()?;
            *app.state::<Shell>().splash_url.lock().unwrap() = window.url().ok();

            tauri::async_runtime::spawn(start(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                quit_app(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            splash_state,
            quit,
            pick_folder,
            pick_file,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_is_maximized,
            window_start_resize,
            update_state,
            update_check,
            update_install,
            update_set_channel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            // The last line of defence: whatever ended the app, no server stays behind
            if let RunEvent::Exit = event {
                stop_server(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn the_window_shows_the_splash_and_the_server_only() {
        let server = Some("http://127.0.0.1:28460");
        for ok in ["tauri://localhost", "tauri://localhost/index.html", "http://tauri.localhost/", "https://tauri.localhost/index.html", "http://127.0.0.1:28460/", "http://127.0.0.1:28460/stock?x=1#y"] {
            assert!(navigation_allowed(&url(ok), None, server), "{ok}");
        }
        for no in [
            "http://127.0.0.1:28461/",
            "http://127.0.0.1/",
            "https://127.0.0.1:28460/",
            "http://localhost:28460/",
            "https://example.com/",
            "http://tauri.localhost.example.com/",
            "tauri://example.com/",
            "file:///C:/x.html",
            "about:blank",
        ] {
            assert!(!navigation_allowed(&url(no), None, server), "{no}");
        }
        // Before the server reported its origin only the splash is allowed
        assert!(!navigation_allowed(&url("http://127.0.0.1:28460/"), None, None));
        // tauri dev serves the splash from its own address
        let dev = url("http://localhost:1430");
        assert!(navigation_allowed(&url("http://localhost:1430/index.html"), Some(&dev), None));
        assert!(!navigation_allowed(&url("http://localhost:1431/"), Some(&dev), None));
    }

    #[test]
    fn the_step_texts_come_from_the_bundle() {
        let info = bundle::parse_bundle_info(
            r#"{ "app": { "version": "0.1.0" }, "node": { "version": "26.13.0" }, "nodeFlags": [],
                 "startTexts": { "de": { "starting": "Starte …", "languagePack": "Sprachpaket wird geladen …" },
                                 "en": { "starting": "Starting …", "languagePack": "Loading language pack …" } } }"#,
        )
        .unwrap();
        assert_eq!(step_text(&info, Lang::De, None), "Starte …");
        assert_eq!(step_text(&info, Lang::De, Some(Step::Database)), "Starte …");
        assert_eq!(step_text(&info, Lang::De, Some(Step::LanguagePack)), "Sprachpaket wird geladen …");
        assert_eq!(step_text(&info, Lang::En, Some(Step::Migrations)), "Starting …");
        assert_eq!(step_text(&info, Lang::En, Some(Step::LanguagePack)), "Loading language pack …");
        assert_eq!(step_text(&info, Lang::En, Some(Step::Listen)), "Starting …");
    }
}
