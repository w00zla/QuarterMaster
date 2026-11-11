//! The server bundle (`pnpm app:bundle`, docs/singleuser.md "The app bundle"): where it is and what its `bundle.json` says.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Development and tests: a bundle folder instead of the one in the app's resources (`local/app-bundle/`).
pub const BUNDLE_ENV: &str = "QM_APP_BUNDLE";
/// The bundle's folder inside the app's resources (tauri.bundle.conf.json).
pub const RESOURCE_FOLDER: &str = "server";

/// The splash texts of one language, as the web app words them.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct StartTexts {
    pub starting: String,
    #[serde(rename = "languagePack")]
    pub language_pack: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct StartTextsByLang {
    pub de: StartTexts,
    pub en: StartTexts,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Versioned {
    pub version: String,
}

/// What the shell reads of `bundle.json` (the file list is not needed here).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BundleInfo {
    pub app: Versioned,
    pub node: Versioned,
    #[serde(rename = "nodeFlags")]
    pub node_flags: Vec<String>,
    #[serde(rename = "startTexts")]
    pub start_texts: StartTextsByLang,
}

/// The bundle folder: the override if set, else `server/` in the resources.
pub fn bundle_dir(override_dir: Option<String>, resource_dir: &Path) -> PathBuf {
    match override_dir {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => resource_dir.join(RESOURCE_FOLDER),
    }
}

pub fn parse_bundle_info(text: &str) -> Result<BundleInfo, String> {
    let info: BundleInfo = serde_json::from_str(text).map_err(|e| format!("bundle.json: {e}"))?;
    // A flag is one argument for node, never a script or a second option smuggled in with a space
    if let Some(bad) = info.node_flags.iter().find(|f| !f.starts_with("--") || f.contains(char::is_whitespace)) {
        return Err(format!("bundle.json: nodeFlags entry {bad:?} is not a flag"));
    }
    Ok(info)
}

/// Reads `<dir>/bundle.json` and checks that the server is beside it.
pub fn read_bundle(dir: &Path) -> Result<BundleInfo, String> {
    let file = dir.join("bundle.json");
    let text = std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    let info = parse_bundle_info(&text)?;
    if !dir.join("server.mjs").is_file() {
        return Err(format!("{}: server.mjs is missing", dir.display()));
    }
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "app": { "version": "0.1.0" },
      "node": { "version": "26.13.0" },
      "nodeFlags": ["--max-semi-space-size=1", "--max-old-space-size=192"],
      "startTexts": {
        "de": { "starting": "Starte …", "languagePack": "Sprachpaket wird geladen …" },
        "en": { "starting": "Starting …", "languagePack": "Loading language pack …" }
      },
      "files": [{ "path": "server.mjs", "size": 1 }]
    }"#;

    #[test]
    fn reads_what_the_shell_needs() {
        let info = parse_bundle_info(SAMPLE).unwrap();
        assert_eq!(info.app.version, "0.1.0");
        assert_eq!(info.node.version, "26.13.0");
        assert_eq!(info.node_flags, ["--max-semi-space-size=1", "--max-old-space-size=192"]);
        assert_eq!(info.start_texts.de.starting, "Starte …");
        assert_eq!(info.start_texts.en.language_pack, "Loading language pack …");
    }

    #[test]
    fn refuses_a_broken_file_and_flags_that_are_not_flags() {
        assert!(parse_bundle_info("{").is_err());
        assert!(parse_bundle_info(r#"{ "app": { "version": "1" } }"#).is_err());
        for bad in ["evil.mjs", "--inspect --eval=1", "-e"] {
            let text = SAMPLE.replace("--max-semi-space-size=1", bad);
            assert!(parse_bundle_info(&text).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_folder_is_the_override_or_the_resources() {
        let resources = Path::new("res");
        assert_eq!(bundle_dir(None, resources), resources.join("server"));
        assert_eq!(bundle_dir(Some(String::new()), resources), resources.join("server"));
        assert_eq!(bundle_dir(Some("local/app-bundle".into()), resources), PathBuf::from("local/app-bundle"));
    }

    #[test]
    fn a_folder_without_the_server_is_refused() {
        let dir = std::env::temp_dir().join(format!("qm-app-bundle-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_bundle(&dir).is_err(), "no bundle.json");
        std::fs::write(dir.join("bundle.json"), SAMPLE).unwrap();
        assert!(read_bundle(&dir).unwrap_err().contains("server.mjs"));
        std::fs::write(dir.join("server.mjs"), "").unwrap();
        assert_eq!(read_bundle(&dir).unwrap().node.version, "26.13.0");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
