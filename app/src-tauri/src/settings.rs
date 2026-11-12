//! What the shell reads of the server's settings before it starts the server: the one switch `autoUpdate` in
//! `<data folder>/settings.json` (docs/singleuser.md "Settings"). The shell never writes that file.

use std::path::{Path, PathBuf};

/// The data folder as the server resolves it (src/singleuser/paths.ts `dataDir`): `QM_DATA_DIR`, else
/// `%LOCALAPPDATA%\QuarterMaster\singleuser` on Windows, `${XDG_DATA_HOME:-~/.local/share}/quartermaster/singleuser` elsewhere.
pub fn data_dir(env: &dyn Fn(&str) -> Option<String>, windows: bool, home: &Path) -> PathBuf {
    let set = |name: &str| env(name).filter(|v| !v.is_empty());
    if let Some(dir) = set("QM_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if windows {
        let local = set("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Local"));
        return local.join("QuarterMaster").join("singleuser");
    }
    let share = set("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local").join("share"));
    share.join("quartermaster").join("singleuser")
}

/// `autoUpdate` of a settings file's text: true unless the file says `false`. No file, a file that is not JSON, no key or
/// a key that is not a boolean all mean the default, true. `QM_AUTO_UPDATE=0` switches it off whatever the file says.
pub fn auto_update(settings_text: Option<&str>, env_override: Option<&str>) -> bool {
    if env_override == Some("0") {
        return false;
    }
    settings_text
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|json| json.get("autoUpdate").and_then(|v| v.as_bool()))
        .unwrap_or(true)
}

/// The switch for this start: the data folder's settings file and the environment.
pub fn read_auto_update(env: &dyn Fn(&str) -> Option<String>, windows: bool, home: &Path) -> bool {
    let file = data_dir(env, windows, home).join("settings.json");
    let text = std::fs::read_to_string(file).ok();
    auto_update(text.as_deref(), env("QM_AUTO_UPDATE").as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
    }

    #[test]
    fn the_data_folder_is_the_servers() {
        let home = Path::new("home");
        assert_eq!(data_dir(&env_of(&[("QM_DATA_DIR", "x/data")]), true, home), PathBuf::from("x/data"));
        assert_eq!(data_dir(&env_of(&[("LOCALAPPDATA", "L")]), true, home), Path::new("L").join("QuarterMaster").join("singleuser"));
        assert_eq!(data_dir(&env_of(&[]), true, home), home.join("AppData").join("Local").join("QuarterMaster").join("singleuser"));
        assert_eq!(data_dir(&env_of(&[("XDG_DATA_HOME", "X")]), false, home), Path::new("X").join("quartermaster").join("singleuser"));
        assert_eq!(data_dir(&env_of(&[("QM_DATA_DIR", "")]), false, home), home.join(".local").join("share").join("quartermaster").join("singleuser"));
    }

    #[test]
    fn auto_update_defaults_to_true() {
        assert!(auto_update(None, None), "no file");
        assert!(auto_update(Some("not json"), None), "broken file");
        assert!(auto_update(Some("[1]"), None), "not an object");
        assert!(auto_update(Some(r#"{ "gameDir": null }"#), None), "no key");
        assert!(auto_update(Some(r#"{ "autoUpdate": "no" }"#), None), "wrong type");
        assert!(auto_update(Some(r#"{ "autoUpdate": true }"#), None));
        assert!(!auto_update(Some(r#"{ "autoUpdate": false }"#), None));
    }

    #[test]
    fn the_environment_only_switches_off() {
        assert!(!auto_update(Some(r#"{ "autoUpdate": true }"#), Some("0")));
        assert!(!auto_update(None, Some("0")));
        assert!(auto_update(None, Some("1")));
        assert!(!auto_update(Some(r#"{ "autoUpdate": false }"#), Some("1")), "anything but 0 leaves it to the file");
    }

    #[test]
    fn reads_the_file_in_the_data_folder() {
        let dir = std::env::temp_dir().join(format!("qm-app-settings-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir_text = dir.to_string_lossy().to_string();
        let env = move |name: &str| (name == "QM_DATA_DIR").then(|| dir_text.clone());
        assert!(read_auto_update(&env, true, Path::new("home")), "missing file");
        std::fs::write(dir.join("settings.json"), r#"{ "autoUpdate": false }"#).unwrap();
        assert!(!read_auto_update(&env, true, Path::new("home")));
        std::fs::write(dir.join("settings.json"), "{ broken").unwrap();
        assert!(read_auto_update(&env, true, Path::new("home")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
