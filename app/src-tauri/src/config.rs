//! The shell's own configuration: one file, `config.json` in the app's config folder, holding the update channel the user
//! chose (`{ "updateChannel": "beta" }`). The server's settings (`<data folder>/settings.json`) are not the shell's.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Tests and development: the config file's path instead of the one in the profile.
pub const CONFIG_ENV: &str = "QM_APP_CONFIG";

pub fn config_file(app: &AppHandle) -> PathBuf {
    match std::env::var(CONFIG_ENV) {
        Ok(file) if !file.is_empty() => PathBuf::from(file),
        _ => app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from(".")).join("config.json"),
    }
}

/// The chosen channel; empty when none was chosen (no file, a broken file, no key).
pub fn load_channel(file: &Path) -> String {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("updateChannel").and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_default()
}

/// Writes the file through a temp file and a rename, creating its folder.
pub fn save_channel(file: &Path, channel: &str) -> Result<(), String> {
    let failed = |e: std::io::Error| format!("{}: {e}", file.display());
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
    }
    let temp = file.with_extension("json.tmp");
    let text = format!("{}\n", serde_json::to_string_pretty(&serde_json::json!({ "updateChannel": channel })).map_err(|e| e.to_string())?);
    std::fs::write(&temp, text).map_err(failed)?;
    std::fs::rename(&temp, file).map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_channel_survives_a_save_and_a_broken_file_is_no_choice() {
        let dir = std::env::temp_dir().join(format!("qm-app-config-test-{}", std::process::id()));
        let file = dir.join("nested").join("config.json");
        assert_eq!(load_channel(&file), "", "no file");
        save_channel(&file, "beta").unwrap();
        assert_eq!(load_channel(&file), "beta");
        save_channel(&file, "stable").unwrap();
        assert_eq!(load_channel(&file), "stable");
        std::fs::write(&file, "{ broken").unwrap();
        assert_eq!(load_channel(&file), "");
        std::fs::write(&file, r#"{ "updateChannel": 3 }"#).unwrap();
        assert_eq!(load_channel(&file), "");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
