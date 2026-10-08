//! Persistent app config (JSON in the app config dir, like BindSight's —
//! `%APPDATA%\com.w00zla.quartermaster.companion\config.json` on Windows,
//! `~/.config/com.w00zla.quartermaster.companion/config.json` on Linux): the
//! Quartermaster server, the user's API token and the SC channel folder whose
//! `Game.log` is followed. The server is fixed in the app; only an edit of the
//! file changes it (e.g. a dev server), the settings UI does not show it.

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
}

impl Default for Config {
    fn default() -> Self {
        Self { server: default_server(), token: String::new(), game_dir: default_game_dir() }
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

pub fn save(app: &AppHandle, config: &Config) -> Result<(), String> {
    let path = config_path(app).ok_or("no config dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
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
    }

    #[test]
    fn paths_below_the_game_dir() {
        let c = Config { game_dir: "/games/sc/LIVE".into(), ..Config::default() };
        assert_eq!(c.game_log(), PathBuf::from("/games/sc/LIVE/Game.log"));
        assert_eq!(c.log_backups(), PathBuf::from("/games/sc/LIVE/logbackups"));
    }
}
