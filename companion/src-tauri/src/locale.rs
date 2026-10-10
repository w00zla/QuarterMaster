//! The player's game language for the refinery OCR: `user.cfg`'s `g_language` picks
//! `data/Localization/<language>/global.ini` in the channel folder. A language pack lives there (a
//! translation, or one replacing the English texts like StarStrings); without one the game uses its
//! built-in texts (in `Data.p4k`, not on disk), which are the English defaults here.
//!
//! The terminal's labels are loc keys, so a pack changes the texts the OCR looks for: every label is
//! matched in English and in the pack's wording. Keys are compared in lower case; a pack may mark
//! its own entries with a suffix (`key,P=value`), which is dropped.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Letters and digits only, upper case (as `refinery.rs` compares texts).
pub fn norm(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_uppercase).collect()
}

/// The `global.ini` the game reads (it may not exist: no pack installed).
pub fn ini_path(game_dir: &Path) -> PathBuf {
    let language = std::fs::read_to_string(game_dir.join("user.cfg"))
        .ok()
        .and_then(|cfg| language_of(&cfg))
        .unwrap_or_else(|| "english".into());
    // On Linux (Wine) the case matters: the game's folder is "data", some installs have "Data"
    let dir = ["data", "Data"].iter().map(|d| game_dir.join(d)).find(|d| d.is_dir()).unwrap_or_else(|| game_dir.join("data"));
    dir.join("Localization").join(language).join("global.ini")
}

/// `g_language` of a `user.cfg` ("g_language = german_(germany)").
fn language_of(cfg: &str) -> Option<String> {
    cfg.lines().find_map(|line| {
        let line = line.split(';').next()?.trim();
        let (key, value) = line.split_once('=')?;
        (key.trim().eq_ignore_ascii_case("g_language") && !value.trim().is_empty()).then(|| value.trim().to_string())
    })
}

/// The values of `keys` (lower case) in a `global.ini`; keys it lacks are left out.
pub fn read_values(path: &Path, keys: &HashSet<String>) -> HashMap<String, String> {
    let Ok(bytes) = std::fs::read(path) else { return HashMap::new() };
    let text = String::from_utf8_lossy(&bytes);
    let mut found = HashMap::new();
    for line in text.lines() {
        let Some((key, value)) = line.trim_start_matches('\u{feff}').split_once('=') else { continue };
        let key = key.split(',').next().unwrap_or(key).trim().to_ascii_lowercase();
        if keys.contains(&key) {
            found.insert(key, value.trim().replace("\\n", " "));
        }
    }
    found
}

/// The terminal's texts the OCR looks for, each normalized (`norm`), English first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Labels {
    /// The table head of a work order ("Materials Yielded (cSCU)", without the parenthesis)
    pub head: Vec<String>,
    pub processing: Vec<String>,
    pub completed: Vec<String>,
    pub time_remaining: Vec<String>,
    /// Columns
    pub quality: Vec<String>,
    pub yield_: Vec<String>,
    pub todo: Vec<String>,
    pub done: Vec<String>,
    /// The terminal's title ("Refinement Center")
    pub center: Vec<String>,
}

const KEYS: [(&str, &str); 9] = [
    ("refinery_ui_jobcard_table_materialsyielded", "Materials Yielded"),
    ("refinery_ui_workordercard_title_processing", "Processing"),
    ("refinery_ui_workordercard_title_completed", "Completed"),
    ("refinery_ui_remainingtime", "Time Remaining"),
    // Not confirmed as the terminal's own key (the column has no refinery key)
    ("ui_quality", "Quality"),
    ("refinery_ui_jobcard_table_yield", "Yield"),
    ("refinery_ui_jobcard_table_todo", "To Do"),
    ("refinery_ui_jobcard_table_done", "Done"),
    ("refinery_ui_refinementcenter", "Refinement Center"),
];

impl Labels {
    /// The English texts plus a pack's (`values`: key -> text).
    pub fn with(values: &HashMap<String, String>) -> Self {
        let label = |i: usize| {
            let (key, english) = KEYS[i];
            // A trailing "(cSCU)" is often a box of its own: left out
            let strip = |t: &str| norm(t.split('(').next().unwrap_or(t));
            let mut all = vec![strip(english)];
            if let Some(v) = values.get(key).map(|v| strip(v)).filter(|v| !v.is_empty() && !all.contains(v)) {
                all.push(v);
            }
            all
        };
        Self {
            head: label(0),
            processing: label(1),
            completed: label(2),
            time_remaining: label(3),
            quality: label(4),
            yield_: label(5),
            todo: label(6),
            done: label(7),
            center: label(8),
        }
    }

    pub fn english() -> Self {
        Self::with(&HashMap::new())
    }
}

/// The labels of the configured game folder, read again when `user.cfg` or the `global.ini` changed
/// (checked at most every CHECK_SECS).
pub struct LabelSource {
    labels: Labels,
    stamp: Option<(PathBuf, Option<SystemTime>, Option<SystemTime>)>,
    checked: Option<std::time::Instant>,
}

const CHECK_SECS: u64 = 10;

impl Default for LabelSource {
    fn default() -> Self {
        Self { labels: Labels::english(), stamp: None, checked: None }
    }
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

impl LabelSource {
    pub fn get(&mut self, game_dir: &Path) -> &Labels {
        if self.checked.is_some_and(|t| t.elapsed().as_secs() < CHECK_SECS) {
            return &self.labels;
        }
        self.checked = Some(std::time::Instant::now());
        let ini = ini_path(game_dir);
        let stamp = (ini.clone(), modified(&game_dir.join("user.cfg")), modified(&ini));
        if self.stamp.as_ref() != Some(&stamp) {
            let keys: HashSet<String> = KEYS.iter().map(|(k, _)| k.to_string()).collect();
            self.labels = Labels::with(&read_values(&ini, &keys));
            log::info!("refinery labels from {} ({})", ini.display(), if stamp.2.is_some() { "language pack" } else { "none, English" });
            self.stamp = Some(stamp);
        }
        &self.labels
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_from_user_cfg() {
        assert_eq!(language_of("r_DisplayInfo = 0\ng_language = german_(germany)\n").as_deref(), Some("german_(germany)"));
        assert_eq!(language_of("G_LANGUAGE=english ; comment").as_deref(), Some("english"));
        assert_eq!(language_of("g_languageAudio = english").as_deref(), None);
        assert_eq!(language_of(""), None);
    }

    #[test]
    fn values_with_pack_suffix_and_any_case() {
        let dir = std::env::temp_dir().join(format!("qm-locale-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ini = dir.join("global.ini");
        std::fs::write(&ini, "\u{feff}refinery_ui_RemainingTime=Verbleibende Zeit\nitems_commodities_raw_silicon,P=Silicon (Raw)\nother=x\n").unwrap();
        let keys: HashSet<String> = ["refinery_ui_remainingtime", "items_commodities_raw_silicon"].iter().map(|s| s.to_string()).collect();
        let v = read_values(&ini, &keys);
        assert_eq!(v.get("refinery_ui_remainingtime").map(String::as_str), Some("Verbleibende Zeit"));
        assert_eq!(v.get("items_commodities_raw_silicon").map(String::as_str), Some("Silicon (Raw)"));
        assert_eq!(v.len(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn labels_in_english_and_the_pack() {
        let pack: HashMap<String, String> = [
            ("refinery_ui_jobcard_table_materialsyielded", "Gewonnene Materialien (cSCU)"),
            ("refinery_ui_jobcard_table_todo", "To-Do"),
            ("refinery_ui_workordercard_title_completed", "Completed"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let l = Labels::with(&pack);
        assert_eq!(l.head, ["MATERIALSYIELDED", "GEWONNENEMATERIALIEN"]);
        assert_eq!(l.todo, ["TODO"]);
        assert_eq!(l.completed, ["COMPLETED"]);
        assert_eq!(l.time_remaining, ["TIMEREMAINING"]);
    }
}
