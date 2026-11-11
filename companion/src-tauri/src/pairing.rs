//! The pairing file of the local Quartermaster app (the singleuser variant, `docs/singleuser.md` "Pairing with the
//! companion"): where its server listens and which game folder it uses. The app writes it when it listens and
//! removes it on a clean exit; the companion reads it at every connection attempt in the local mode (the port can
//! change between starts). No token: the local API is open. A file naming any origin but `http://127.0.0.1:<port>`
//! is refused, so a planted file cannot send the companion elsewhere.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// What the file says: the local server's origin and its game folder setting (None = not set there).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pairing {
    /// `http://127.0.0.1:<port>`
    pub origin: String,
    pub game_dir: Option<String>,
}

/// The file's place, the server's rule (`src/singleuser/pairing.ts`): `QM_PAIRING_FILE` if set (development, tests),
/// else `%LOCALAPPDATA%\QuarterMaster\pairing.json` on Windows and
/// `${XDG_DATA_HOME:-~/.local/share}/quartermaster/pairing.json` elsewhere. Pure: `env` looks a variable up.
pub fn file_of(env: impl Fn(&str) -> Option<String>, windows: bool, home: &str) -> String {
    let set = |name: &str| env(name).filter(|v| !v.is_empty());
    if let Some(file) = set("QM_PAIRING_FILE") {
        return file;
    }
    if windows {
        let base = set("LOCALAPPDATA").unwrap_or_else(|| format!("{home}\\AppData\\Local"));
        return format!("{base}\\QuarterMaster\\pairing.json");
    }
    let base = set("XDG_DATA_HOME").unwrap_or_else(|| format!("{home}/.local/share"));
    format!("{base}/quartermaster/pairing.json")
}

/// The file's place on this machine.
pub fn file() -> PathBuf {
    let env = |name: &str| std::env::var(name).ok();
    let home = env(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    PathBuf::from(file_of(env, cfg!(windows), &home))
}

/// Whether `origin` is exactly `http://127.0.0.1:<port>` (port 1–65535, written plainly: no path, no slash).
fn local_origin(origin: &str) -> bool {
    let Some(port) = origin.strip_prefix("http://127.0.0.1:") else { return false };
    let plain = !port.is_empty() && port.len() <= 5 && !port.starts_with('0') && port.bytes().all(|b| b.is_ascii_digit());
    plain && port.parse::<u16>().is_ok()
}

/// A pairing file's content (`{ "format": 1, "origin": "http://127.0.0.1:<port>", "gameDir": "<folder>" | null }`);
/// None for anything else.
pub fn parse(text: &str) -> Option<Pairing> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct File {
        format: u32,
        origin: String,
        game_dir: Option<String>,
    }
    let file: File = serde_json::from_str(text).ok()?;
    if file.format != 1 || !local_origin(&file.origin) {
        return None;
    }
    Some(Pairing { origin: file.origin, game_dir: file.game_dir.filter(|d| !d.trim().is_empty()) })
}

/// The pairing at `path`; None when the file is missing, unreadable or not a valid pairing file (the local app is
/// not running, as far as the companion can tell).
pub fn read(path: &Path) -> Option<Pairing> {
    let pairing = parse(&std::fs::read_to_string(path).ok()?);
    if pairing.is_none() {
        log::warn!("{}: not a pairing file of the local app", path.display());
    }
    pairing
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| vars.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
    }

    #[test]
    fn the_files_place_on_both_platforms() {
        // Windows: the profile's local app data, else below the home folder
        assert_eq!(file_of(env(&[("LOCALAPPDATA", r"C:\Users\u\AppData\Local")]), true, r"C:\Users\u"), r"C:\Users\u\AppData\Local\QuarterMaster\pairing.json");
        assert_eq!(file_of(env(&[]), true, r"C:\Users\u"), r"C:\Users\u\AppData\Local\QuarterMaster\pairing.json");
        // Linux: XDG_DATA_HOME, else ~/.local/share; LOCALAPPDATA means nothing there
        assert_eq!(file_of(env(&[("XDG_DATA_HOME", "/data"), ("LOCALAPPDATA", "x")]), false, "/home/u"), "/data/quartermaster/pairing.json");
        assert_eq!(file_of(env(&[("XDG_DATA_HOME", "")]), false, "/home/u"), "/home/u/.local/share/quartermaster/pairing.json");
        // The override wins everywhere
        for windows in [true, false] {
            assert_eq!(file_of(env(&[("QM_PAIRING_FILE", "/tmp/p.json"), ("LOCALAPPDATA", "x"), ("XDG_DATA_HOME", "y")]), windows, "h"), "/tmp/p.json");
        }
    }

    #[test]
    fn a_valid_file() {
        let p = parse(r#"{ "format": 1, "origin": "http://127.0.0.1:28460", "gameDir": "F:/Games/StarCitizen/LIVE" }"#).unwrap();
        assert_eq!(p, Pairing { origin: "http://127.0.0.1:28460".into(), game_dir: Some("F:/Games/StarCitizen/LIVE".into()) });
        // No game folder set in the app
        assert_eq!(parse(r#"{"format":1,"origin":"http://127.0.0.1:1","gameDir":null}"#).unwrap().game_dir, None);
        assert_eq!(parse(r#"{"format":1,"origin":"http://127.0.0.1:65535"}"#).unwrap().game_dir, None);
    }

    #[test]
    fn only_this_machines_origin() {
        for origin in [
            "http://localhost:28460",
            "https://127.0.0.1:28460",
            "http://127.0.0.1",
            "http://127.0.0.1:",
            "http://127.0.0.1:0",
            "http://127.0.0.1:028460",
            "http://127.0.0.1:65536",
            "http://127.0.0.1:28460/",
            "http://127.0.0.1:28460/path",
            "http://127.0.0.1:28460@evil.example",
            "http://127.0.0.1:28460.evil.example",
            "http://127.0.0.1.evil.example:28460",
            "http://evil.example:28460",
            " http://127.0.0.1:28460",
            "",
        ] {
            let text = serde_json::json!({ "format": 1, "origin": origin, "gameDir": null }).to_string();
            assert_eq!(parse(&text), None, "{origin}");
        }
    }

    #[test]
    fn broken_and_missing_files() {
        for text in ["", "not json", "[]", "{}", r#"{"format":2,"origin":"http://127.0.0.1:28460","gameDir":null}"#, r#"{"format":1,"origin":28460}"#, r#"{"format":1,"origin":"http://127.0.0.1:28460","gameDir":5}"#] {
            assert_eq!(parse(text), None, "{text}");
        }
        let dir = std::env::temp_dir().join(format!("qm-companion-pairing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("pairing.json");
        assert_eq!(read(&file), None);
        std::fs::write(&file, "{").unwrap();
        assert_eq!(read(&file), None);
        std::fs::write(&file, r#"{"format":1,"origin":"http://127.0.0.1:28461","gameDir":null}"#).unwrap();
        assert_eq!(read(&file).unwrap().origin, "http://127.0.0.1:28461");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
