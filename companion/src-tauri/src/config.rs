//! Persistent app config (JSON in the app config dir, like BindSight's —
//! `%APPDATA%\com.w00zla.quartermaster.companion\config.json` on Windows,
//! `~/.config/com.w00zla.quartermaster.companion/config.json` on Linux): the
//! connection (the online server or the Quartermaster app on this PC), the
//! Quartermaster server, the user's API token, the SC channel folder whose
//! `Game.log` is followed (in the local mode the app's folder comes first, `pairing.rs`), the UI language, the automatic tab switch, the OCR on the GPU, the overlays' transparency, the scan overlay's position, display and hotkeys, the signature overlay's position, and the updates (the switch and the chosen channel). The server defaults to the production
//! one; the settings can set another (e.g. a server of one's own), and only then the file holds a `server` entry.

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
    /// Which server the app talks to: "online" (`server` with `token`) or "local" (the Quartermaster app on
    /// this PC, found through its pairing file: no token).
    #[serde(default = "default_connection")]
    pub connection: String,
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
    /// The overlay's hotkeys as accelerators ("Alt+Shift+KeyQ", the on/off default); empty = none (the mode's and
    /// the scan mode's default).
    #[serde(default = "default_hotkey_overlay")]
    pub hotkey_overlay: String,
    #[serde(default)]
    pub hotkey_mode: String,
    /// Switches the scan between the terminals and the radar signature
    #[serde(default)]
    pub hotkey_scan_mode: String,
    /// How see-through both overlays are, in percent (0 = opaque; at most `MAX_TRANSPARENCY`).
    #[serde(default = "default_overlay_transparency")]
    pub overlay_transparency: u32,
    /// Where the signature overlay sits next to the radar signature: "below", "above", "left" or "right".
    #[serde(default = "default_signature_position")]
    pub signature_position: String,
    /// The scan overlay stays shown while the signature scan runs (off: the signature overlay alone).
    #[serde(default = "default_true")]
    pub scan_overlay_in_signature: bool,
    /// The main window's tab (= the overlay's mode) switches by itself: with the screen the scan sees
    /// and with a new blueprint unlock (the frontend's `overlay.ts`).
    #[serde(default = "default_true")]
    pub auto_tab: bool,
    /// The screen scan's OCR on the GPU where it can (`ocrwatch::Gpu`), else on the CPU. Off by default:
    /// on fast CPUs it reads hardly faster and holds VRAM next to the game.
    #[serde(default)]
    pub gpu: bool,
    /// Updates by themselves: with this on, a check at start installs a newer version at once (update.rs).
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// The update channel the user chose in the update dialog; empty = none (the build's own channel, else stable). Only
    /// `update_set_channel` changes it (`set_config` keeps the stored one).
    #[serde(default)]
    pub update_channel: String,
}

pub const ONLINE: &str = "online";
pub const LOCAL: &str = "local";

fn default_connection() -> String {
    ONLINE.into()
}

pub const OVERLAY_POSITIONS: [&str; 6] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

pub const OVERLAY_DISPLAYS: [&str; 2] = ["thumbs", "compact"];

pub const SIGNATURE_POSITIONS: [&str; 4] = ["below", "above", "left", "right"];

/// The settings' slider ends at this (more and the tiles are hard to read over the game)
pub const MAX_TRANSPARENCY: u32 = 80;

/// The overlay's look before the setting existed (82 % opaque)
fn default_overlay_transparency() -> u32 {
    18
}

fn default_signature_position() -> String {
    "below".into()
}

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
            connection: default_connection(),
            server: default_server(),
            token: String::new(),
            game_dir: default_game_dir(),
            language: String::new(),
            overlay_position: default_overlay_position(),
            overlay_display: default_overlay_display(),
            hotkey_overlay: default_hotkey_overlay(),
            hotkey_mode: String::new(),
            hotkey_scan_mode: String::new(),
            overlay_transparency: default_overlay_transparency(),
            signature_position: default_signature_position(),
            scan_overlay_in_signature: true,
            auto_tab: true,
            gpu: false,
            auto_update: true,
            update_channel: String::new(),
        }
    }
}

impl Config {
    /// The game folder in use: in the local mode the paired app's (`paired`: its pairing file's `gameDir`, None
    /// while unknown or not set there), else and online this config's own.
    pub fn game_dir_with(&self, paired: Option<&str>) -> String {
        match paired {
            Some(dir) if self.connection == LOCAL => dir.to_string(),
            _ => self.game_dir.clone(),
        }
    }
}

pub fn game_log(game_dir: &str) -> PathBuf {
    PathBuf::from(game_dir).join("Game.log")
}

pub fn log_backups(game_dir: &str) -> PathBuf {
    PathBuf::from(game_dir).join("logbackups")
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

/// Writes the config; the production server is never written (it stays a default: a later change of it in the app
/// reaches everyone who did not set a server of their own).
pub fn save(app: &AppHandle, config: &Config) -> Result<(), String> {
    let path = config_path(app).ok_or("no config dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(&path, to_file(config)?).map_err(|e| format!("{}: {e}", path.display()))
}

/// The file's content: everything of `config`, the `server` entry only when it is not the production server.
fn to_file(config: &Config) -> Result<String, String> {
    let mut value = serde_json::to_value(config).map_err(|e| e.to_string())?;
    let map = value.as_object_mut().ok_or("config is no object")?;
    if config.server == DEFAULT_SERVER {
        map.remove("server");
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
        // Updates: on, no channel chosen
        assert!(c.auto_update);
        assert_eq!(c.update_channel, "");
        assert!(!parse(r#"{"autoUpdate":false}"#).unwrap().auto_update);
        assert_eq!(parse(r#"{"updateChannel":"beta"}"#).unwrap().update_channel, "beta");
        assert_eq!(c.overlay_display, "thumbs");
        // Files written before the local mode existed: online
        assert_eq!(c.connection, ONLINE);
        assert_eq!(parse(r#"{"connection":"local"}"#).unwrap().connection, LOCAL);
        // Missing before the signature scan existed: below, the old look, no hotkey
        assert_eq!(c.signature_position, "below");
        assert_eq!(c.overlay_transparency, 18);
        assert_eq!(c.hotkey_scan_mode, "");
        assert!(c.scan_overlay_in_signature);
    }

    #[test]
    fn the_paired_game_folder_only_in_the_local_mode() {
        let online = Config { game_dir: "D:/SC/LIVE".into(), ..Config::default() };
        let local = Config { connection: LOCAL.into(), ..online.clone() };
        assert_eq!(online.game_dir_with(Some("F:/Games/LIVE")), "D:/SC/LIVE");
        assert_eq!(local.game_dir_with(Some("F:/Games/LIVE")), "F:/Games/LIVE");
        // Not set in the app (or the app not seen yet): the companion's own setting
        assert_eq!(local.game_dir_with(None), "D:/SC/LIVE");
    }

    #[test]
    fn saving_writes_only_a_server_of_ones_own() {
        let c = Config { token: "qmt_x".into(), game_dir: "D:/SC/LIVE".into(), language: "de".into(), ..Config::default() };
        // The production server: not written (the default stays a default)
        let saved: serde_json::Value = serde_json::from_str(&to_file(&c).unwrap()).unwrap();
        assert_eq!(saved.get("server"), None);
        assert_eq!(parse(&saved.to_string()).unwrap(), c);
        // Another one (set in the settings): written and read back
        let own = Config { server: "http://localhost:5174".into(), ..c.clone() };
        let saved = parse(&to_file(&own).unwrap()).unwrap();
        assert_eq!(saved.server, "http://localhost:5174");
        assert_eq!(saved.token, "qmt_x");
        assert_eq!(saved.game_dir, "D:/SC/LIVE");
    }

    #[test]
    fn paths_below_the_game_dir() {
        let c = Config { game_dir: "/games/sc/LIVE".into(), ..Config::default() };
        let dir = c.game_dir_with(None);
        assert_eq!(game_log(&dir), PathBuf::from("/games/sc/LIVE/Game.log"));
        assert_eq!(log_backups(&dir), PathBuf::from("/games/sc/LIVE/logbackups"));
    }
}
