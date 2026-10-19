//! Follows SC's `Game.log` (adapted from BindSight's `logwatch.rs`).
//!
//! A metadata poll, not an OS watcher: the game starts a fresh log at every
//! start (the old one is moved to `logbackups`), a watch on the path breaks
//! exactly then, and NTFS hands a file recreated under the same name within
//! 15 s its predecessor's creation time (name tunneling), so the creation
//! time alone cannot be trusted either. A log only grows, so a shorter file is
//! a new one.
//!
//! [`Tail`] reads only what the game appended since the last read and hands
//! out complete lines; a line still being written waits for the next read.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, SystemTime};

/// Poll interval of the watch thread.
pub const POLL: Duration = Duration::from_secs(2);

/// What identifies one `Game.log` file on disk.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FileStamp {
    /// The OS creation time where the file system has one.
    pub created: Option<SystemTime>,
    pub len: u64,
    /// The last write (the debug window shows it; not part of telling files apart)
    pub modified: Option<SystemTime>,
}

/// The file's current stamp, `None` when it does not exist (or is unreadable).
pub fn stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(FileStamp { created: meta.created().ok(), len: meta.len(), modified: meta.modified().ok() })
}

/// Whether the file seen now is another one than the file seen last:
/// appeared, vanished, another creation time, or shorter than before.
pub fn is_new_file(last: Option<FileStamp>, now: Option<FileStamp>) -> bool {
    match (last, now) {
        (None, None) => false,
        (None, Some(_)) | (Some(_), None) => true,
        (Some(a), Some(b)) => a.created != b.created || b.len < a.len,
    }
}

/// The read position in the followed file and the start of a line the game
/// has not finished yet.
#[derive(Debug, Default)]
pub struct Tail {
    pos: u64,
    partial: Vec<u8>,
}

impl Tail {
    /// Forget the file: the next read starts from its beginning.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// How far the file is read (bytes).
    pub fn pos(&self) -> u64 {
        self.pos
    }

    /// The complete lines the file gained since the last read (lossy UTF-8:
    /// Windows SC writes OS strings in the ANSI code page). A file shorter
    /// than the last position was replaced meanwhile: starts over.
    pub fn read(&mut self, path: &Path) -> std::io::Result<String> {
        let mut file = std::fs::File::open(path)?;
        let len = file.metadata()?.len();
        if len < self.pos {
            self.reset();
        }
        if len == self.pos {
            return Ok(String::new());
        }
        file.seek(SeekFrom::Start(self.pos))?;
        let mut bytes = std::mem::take(&mut self.partial);
        let read = file.take(len - self.pos).read_to_end(&mut bytes)?;
        self.pos += read as u64;
        let complete = memchr::memrchr(b'\n', &bytes).map_or(0, |p| p + 1);
        self.partial = bytes.split_off(complete);
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn st(created: u64, len: u64) -> Option<FileStamp> {
        Some(FileStamp { created: Some(SystemTime::UNIX_EPOCH + Duration::from_secs(created)), len, modified: None })
    }

    #[test]
    fn new_file_detection() {
        assert!(!is_new_file(st(1, 100), st(1, 5000)), "growing");
        assert!(is_new_file(st(1, 100_000), st(1, 300)), "shorter, same creation time (NTFS tunneling)");
        assert!(is_new_file(st(1, 100), st(2, 100)), "other creation time");
        assert!(is_new_file(st(1, 100), None), "vanished");
        assert!(is_new_file(None, st(1, 1)), "appeared");
        assert!(!is_new_file(None, None));
        let written = Some(FileStamp { modified: Some(SystemTime::now()), ..st(1, 100).unwrap() });
        assert!(!is_new_file(st(1, 100), written), "only written to");
    }

    #[test]
    fn stamp_of_a_missing_file_is_none() {
        assert_eq!(stamp(Path::new("definitely/not/here/Game.log")), None);
    }

    #[test]
    fn tail_hands_out_complete_lines_once() {
        let path = std::env::temp_dir().join(format!("qm-companion-tail-{}.log", std::process::id()));
        std::fs::write(&path, "<t> first line\n<t> sec").unwrap();
        let mut tail = Tail::default();
        assert_eq!(tail.read(&path).unwrap(), "<t> first line\n");
        // Read up to the end, the unfinished line included
        assert_eq!(tail.pos(), 22);
        // Nothing new: nothing read, nothing doubled
        assert_eq!(tail.read(&path).unwrap(), "");

        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"ond line\n<t> third\n").unwrap();
        drop(f);
        assert_eq!(tail.read(&path).unwrap(), "<t> second line\n<t> third\n");

        // Replaced by a shorter file: starts over
        std::fs::write(&path, "<t> new\n").unwrap();
        assert_eq!(tail.read(&path).unwrap(), "<t> new\n");

        std::fs::remove_file(&path).unwrap();
        assert!(tail.read(&path).is_err());
    }
}
