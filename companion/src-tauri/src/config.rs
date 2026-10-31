//! Persistent app config (JSON in the app config dir, like BindSight's —
//! `%APPDATA%\com.w00zla.quartermaster.companion\config.json` on Windows,
//! `~/.config/com.w00zla.quartermaster.companion/config.json` on Linux): the
//! Quartermaster server, the user's API token, the SC channel folder whose
//! `Game.log` is followed, the UI language, the automatic tab switch, the OCR on the GPU and the scan overlay's position, display and hotkeys. The server is fixed in the app; only a `server` entry
//! in the file changes it (e.g. a dev server, read at start), the settings UI
//! does not show it and saving never writes or overwrites that entry.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// The standard Windows install; users on other setups (Linux/Wine) pick
/// their own folder.
const DEFAULT_GAME_DIR: &str = r"C:\Program Files\Roberts Space Industries\StarCitizen\LIVE";

fn default_game_dir() -> String {
    DEFAULT_GAME_DIR.to_string()
}

/// The production web app; a `server` in the config file overrides it.
const DEFAULT_SERVER: &str = "https://quartermaster.w00z.net";

fn default_server() -> String {
    DEFAULT_SERVER.to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Where the web app runs (origin); missing or empty = the production server.
    #[serde(default = "default_server")]
    pub server: String,
    /// The user's API token from the web app's profile; empty = not set.
    #[serde(default)]
    pub token: String,
    /// The channel folder holding `Game.log` and `logbackups` (e.g. `…/LIVE`).
    #[serde(default = "default_game_dir")]
    pub game_dir: String,
    /// The UI language: "de", "en", or empty = the system's.
    #[serde(default)]
    pub language: String,
    /// Where in the game window the scan overlay sits: "top-left", "top-center", "top-right",
    /// "bottom-left", "bottom-center" or "bottom-right".
    #[serde(default = "default_overlay_position")]
    pub overlay_position: String,
    /// How the overlay shows its rows: "thumbs" (the latest item as a taller top row with its thumbnail,
    /// the window a bit higher) or "compact" (rows only).
    #[serde(default = "default_overlay_display")]
    pub overlay_display: String,
    /// The overlay's hotkeys as accelerators ("Alt+Shift+KeyQ", the on/off default); empty = none (the mode's default).
    #[serde(default = "default_hotkey_overlay")]
    pub hotkey_overlay: String,
    #[serde(default)]
    pub hotkey_mode: String,
    /// The main window's tab (= the overlay's mode) switches by itself: with the screen the scan sees
    /// and with a new blueprint unlock (the frontend's `overlay.ts`).
    #[serde(default = "default_true")]
    pub auto_tab: bool,
    /// The screen scan's OCR on the GPU where it can (`ocrwatch::Gpu`), else on the CPU. Off by default:
    /// on fast CPUs it reads hardly faster and holds VRAM next to the game.
    #[serde(default)]
    pub gpu: bool,
}

pub const OVERLAY_POSITIONS: [&str; 6] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

pub const OVERLAY_DISPLAYS: [&str; 2] = ["thumbs", "compact"];

fn default_overlay_position() -> String {
    "top-left".into()
}

fn default_overlay_display() -> String {
    "thumbs".into()
}

fn default_hotkey_overlay() -> String {
    "Alt+Shift+KeyQ".into()
}

fn default_true() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: default_server(),
            token: String::new(),
            game_dir: default_game_dir(),
            language: String::new(),
            overlay_position: default_overlay_position(),
            overlay_display: default_overlay_display(),
            hotkey_overlay: default_hotkey_overlay(),
            hotkey_mode: String::new(),
            auto_tab: true,
            gpu: false,
        }
    }
}

impl Config {
    pub fn game_log(&self) -> PathBuf {
        PathBuf::from(&self.game_dir).join("Game.log")
    }

    pub fn log_backups(&self) -> PathBuf {
        PathBuf::from(&self.game_dir).join("logbackups")
    }
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

/// The stored config, defaults for anything missing or unreadable.
pub fn load(app: &AppHandle) -> Config {
    let Some(path) = config_path(app) else { return Config::default() };
    match std::fs::read_to_string(&path) {
        Ok(text) => parse(&text).unwrap_or_else(|e| {
            log::warn!("{}: {e}, using defaults", path.display());
            Config::default()
        }),
        Err(_) => Config::default(),
    }
}

/// A config file's content; an empty server (older files) is the production server.
fn parse(text: &str) -> Result<Config, serde_json::Error> {
    let mut config: Config = serde_json::from_str(text)?;
    if config.server.trim().is_empty() {
        config.server = default_server();
    }
    Ok(config)
}

/// Writes token and game folder; the file's `server` entry stays as it is (the default is never
/// written, an edit of the file while the app runs is kept).
pub fn save(app: &AppHandle, config: &Config) -> Result<(), String> {
    let path = config_path(app).ok_or("no config dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let text = to_file(config, std::fs::read_to_string(&path).ok().as_deref())?;
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
}

/// The file's content: token and game folder of `config`, the `server` entry of the `current` file (if any).
fn to_file(config: &Config, current: Option<&str>) -> Result<String, String> {
    let mut value = serde_json::to_value(config).map_err(|e| e.to_string())?;
    let map = value.as_object_mut().ok_or("config is no object")?;
    map.remove("server");
    let server = current.and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok()).and_then(|v| v.get("server").cloned());
    if let Some(server) = server {
        map.insert("server".into(), server);
    }
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_get_defaults() {
        let c = parse("{}").unwrap();
        assert_eq!(c, Config::default());
        assert_eq!(c.server, DEFAULT_SERVER);
        assert_eq!(parse(r#"{"server":""}"#).unwrap().server, DEFAULT_SERVER);
        let c = parse(r#"{"server":"https://qm.test"}"#).unwrap();
        assert_eq!(c.server, "https://qm.test");
        assert_eq!(c.game_dir, DEFAULT_GAME_DIR);
        // Missing in files written before it existed: on (the GPU off)
        assert!(c.auto_tab);
        assert!(!c.gpu);
        assert_eq!(c.overlay_display, "thumbs");
    }

    #[test]
    fn saving_keeps_the_files_server_entry() {
        let c = Config { token: "qmt_x".into(), game_dir: "D:/SC/LIVE".into(), language: "de".into(), ..Config::default() };
        // No file or no entry: none written (the default stays a default)
        for current in [None, Some("{}"), Some("not json")] {
            let saved: serde_json::Value = serde_json::from_str(&to_file(&c, current).unwrap()).unwrap();
            assert_eq!(saved.get("server"), None);
            assert_eq!(parse(&saved.to_string()).unwrap(), c);
        }
        // An entry (e.g. edited while the app ran): kept, not the loaded server
        let saved = parse(&to_file(&c, Some(r#"{"server":"http://localhost:5174","token":"old"}"#)).unwrap()).unwrap();
        assert_eq!(saved.server, "http://localhost:5174");
        assert_eq!(saved.token, "qmt_x");
        assert_eq!(saved.game_dir, "D:/SC/LIVE");
    }

    #[test]
    fn paths_below_the_game_dir() {
        let c = Config { game_dir: "/games/sc/LIVE".into(), ..Config::default() };
        assert_eq!(c.game_log(), PathBuf::from("/games/sc/LIVE/Game.log"));
        assert_eq!(c.log_backups(), PathBuf::from("/games/sc/LIVE/logbackups"));
    }
}
