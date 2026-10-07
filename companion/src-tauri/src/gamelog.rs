//! Blueprint unlocks as logged in `Game.log`.
//!
//! SC logs every HUD notification; a blueprint the player receives shows up as
//!
//! ```text
//! <2026-03-29T11:35:27.679Z> [Notice] <SHUDEvent_OnNotification> Added notification "Received Blueprint: Arclight "Stormfall" Pistol: " [74] to queue. ...
//! ```
//!
//! The same notification is logged again as `UpdateNotificationItem` (Next,
//! StartFade, Remove); only the `Added notification` line is read, so one
//! unlock is one line. The name is the item's display name in the game's
//! language (English unless a community `global.ini` is installed) and may
//! hold quotes itself, so it ends at the `: " [` that closes the notification
//! text. Ship components carry a class/size/grade prefix (`Ind/1/B Guardian`);
//! it stays in the name, the matching against the catalog handles it.
//!
//! The format is SC-internal and may change with a patch: unknown lines are
//! skipped, nothing panics.

use std::path::Path;

use serde::Serialize;

const MARKER: &str = "Added notification \"Received Blueprint: ";
const END: &str = ": \" [";

/// One logged unlock: the line's timestamp (as logged, UTC) and the name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Unlock {
    pub at: String,
    pub name: String,
}

/// The unlock in a log line, if it is one.
pub fn unlock(line: &str) -> Option<Unlock> {
    let start = line.find(MARKER)? + MARKER.len();
    let rest = &line[start..];
    let name = rest[..rest.find(END)?].trim();
    if name.is_empty() {
        return None;
    }
    Some(Unlock { at: line_timestamp(line).unwrap_or_default().to_string(), name: name.to_string() })
}

/// Every unlock in a chunk of log text, in log order.
pub fn unlocks(text: &str) -> Vec<Unlock> {
    text.lines().filter_map(unlock).collect()
}

/// The `<...>` timestamp a log line starts with, if any.
fn line_timestamp(line: &str) -> Option<&str> {
    let inner = line.strip_prefix('<')?;
    Some(&inner[..inner.find('>')?])
}

/// The unlocks in a whole file's bytes. Searches the marker instead of
/// decoding everything: old logs are GBs, and Windows SC writes OS strings in
/// the ANSI code page (not UTF-8), which only the found lines are decoded for.
pub fn unlocks_in_bytes(bytes: &[u8]) -> Vec<Unlock> {
    memchr::memmem::find_iter(bytes, MARKER.as_bytes())
        .filter_map(|pos| {
            let start = memchr::memrchr(b'\n', &bytes[..pos]).map_or(0, |p| p + 1);
            let end = memchr::memchr(b'\n', &bytes[pos..]).map_or(bytes.len(), |p| pos + p);
            unlock(&String::from_utf8_lossy(&bytes[start..end]))
        })
        .collect()
}

/// The unlocks in every `*.log` of a folder (the game's `logbackups`), oldest
/// first, each name once (its first unlock). Unreadable files are skipped and
/// counted. `progress(done, total)` is called after each file.
pub fn scan_folder(dir: &Path, mut progress: impl FnMut(usize, usize)) -> Result<(Vec<Unlock>, usize), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let paths: Vec<_> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("log")) == Some(true))
        .collect();
    let mut all = Vec::new();
    let mut failed = 0;
    for (i, path) in paths.iter().enumerate() {
        match std::fs::read(path) {
            Ok(bytes) => all.extend(unlocks_in_bytes(&bytes)),
            Err(e) => {
                log::warn!("{}: {e}", path.display());
                failed += 1;
            }
        }
        progress(i + 1, paths.len());
    }
    Ok((first_per_name(all), failed))
}

/// Sorted by time (ISO timestamps sort as text), the first unlock per name.
pub fn first_per_name(mut all: Vec<Unlock>) -> Vec<Unlock> {
    all.sort_by(|a, b| a.at.cmp(&b.at));
    let mut seen = std::collections::HashSet::new();
    all.retain(|u| seen.insert(u.name.clone()));
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verbatim from the user's Linux/Wine Game.log (4.x).
    const LOG: &str = r#"<2026-03-26T20:06:07.838Z> [Notice] <SHUDEvent_OnNotification> Added notification "Received Blueprint: Arclight Pistol Battery (30 cap): " [46] to queue. New queue size: 3, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]
<2026-03-26T20:06:07.838Z>    "Received Blueprint: Arclight Pistol Battery (30 cap): " [46]
<2026-03-26T20:06:09.101Z> [Notice] <UpdateNotificationItem> Notification "Received Blueprint: Arclight Pistol Battery (30 cap): " [46], Action: Next [Team_CoreGameplayFeatures][Missions][Comms]
<2026-03-29T11:35:27.679Z> [Notice] <SHUDEvent_OnNotification> Added notification "Received Blueprint: Arclight "Stormfall" Pistol: " [74] to queue. New queue size: 3, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]
<2026-04-03T20:18:49.256Z> [Notice] <SHUDEvent_OnNotification> Added notification "Received Blueprint: Ind/1/B Guardian: " [12] to queue. New queue size: 1, MissionId: [00000000-0000-0000-0000-000000000000], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]
<2026-04-03T20:19:00.000Z> [Notice] <SHUDEvent_OnNotification> Added notification "A Refinery Work Order has been Completed at Levski: " [3] to queue. New queue size: 1
"#;

    #[test]
    fn reads_the_added_notification_lines_only() {
        let found = unlocks(LOG);
        assert_eq!(
            found,
            vec![
                Unlock { at: "2026-03-26T20:06:07.838Z".into(), name: "Arclight Pistol Battery (30 cap)".into() },
                Unlock { at: "2026-03-29T11:35:27.679Z".into(), name: "Arclight \"Stormfall\" Pistol".into() },
                Unlock { at: "2026-04-03T20:18:49.256Z".into(), name: "Ind/1/B Guardian".into() },
            ]
        );
    }

    #[test]
    fn bytes_search_finds_the_same_and_tolerates_non_utf8() {
        let mut bytes = b"<t> FriendlyName='Kopfh".to_vec();
        // ANSI code page `ö`, verbatim shape from a Windows Game.log
        bytes.push(0xF6);
        bytes.extend_from_slice(b"rer'\n");
        bytes.extend_from_slice(LOG.as_bytes());
        assert_eq!(unlocks_in_bytes(&bytes), unlocks(LOG));
        // A marker in the first line and one without a trailing newline
        let edge = "<a> Added notification \"Received Blueprint: X: \" [1]\n<b> Added notification \"Received Blueprint: Y: \" [2]";
        assert_eq!(unlocks_in_bytes(edge.as_bytes()).iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), ["X", "Y"]);
    }

    #[test]
    fn first_unlock_per_name_in_time_order() {
        let u = |at: &str, name: &str| Unlock { at: at.into(), name: name.into() };
        let all = vec![u("2026-05-02", "B"), u("2026-05-01", "A"), u("2026-04-01", "B")];
        assert_eq!(first_per_name(all), vec![u("2026-04-01", "B"), u("2026-05-01", "A")]);
    }

    #[test]
    fn scans_a_folder_of_logs() {
        let dir = std::env::temp_dir().join(format!("qm-companion-scan-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Game Build(1) 01 Jan 26 (10 00 00).log"), LOG).unwrap();
        std::fs::write(dir.join("Game Build(1) 02 Jan 26 (10 00 00).log"), LOG).unwrap();
        std::fs::write(dir.join("notes.txt"), LOG).unwrap();
        let mut calls = Vec::new();
        let (found, failed) = scan_folder(&dir, |done, total| calls.push((done, total))).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(found, unlocks(LOG));
        assert_eq!(failed, 0);
        assert_eq!(calls, vec![(1, 2), (2, 2)]);
        assert!(scan_folder(Path::new("/definitely/not/here"), |_, _| {}).is_err());
    }

    #[test]
    fn never_panics_on_garbage() {
        for input in [
            "\0\0\0",
            "Added notification \"Received Blueprint: ",
            "Added notification \"Received Blueprint: : \" [1]",
            "Added notification \"Received Blueprint: no end",
            "<unclosed Added notification \"Received Blueprint: Grüße \"Ü\": \" [1]",
        ] {
            let _ = unlocks(input);
            let _ = unlocks_in_bytes(input.as_bytes());
        }
        assert_eq!(unlocks("<t> Added notification \"Received Blueprint: Grüße \"Ü\": \" [1]")[0].name, "Grüße \"Ü\"");
    }
}
