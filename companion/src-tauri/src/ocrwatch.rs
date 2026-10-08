//! Feeds frames to the refinery OCR off the main thread and reports what it reads as the
//! `refinery-screen` event. Platform independent: frames come through a channel from a source —
//! the screen capture (`capture.rs`, Windows so far) or, for tests, a folder of images
//! (`QM_OCR_FRAMES=<dir>`: every image put there is read once, its modification time as the frame time).
//!
//! The OCR takes ~0.6 s per frame on a fast machine with the game idle, several seconds elsewhere;
//! live frames that queue up meanwhile are dropped but the newest. They also pass a cheap gate first (a 96×40 grey thumbnail): only a frame that is still (the
//! previous one looks the same) and new (differs from the last one read) goes to the OCR, and while a
//! refinery panel is in view one every 2 s anyway (its changes are too small for the thumbnail), so
//! moving around costs nothing but the thumbnails.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use image::imageops::{self, FilterType};
use image::{GrayImage, RgbImage};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::ocr::Ocr;
use crate::refinery::{read_screens, Screen};

pub const REFINERY_SCREEN: &str = "refinery-screen";
// ONNX Runtime threads: the game runs at the same time
const OCR_THREADS: usize = 2;
const THUMB: (u32, u32) = (96, 40);
// Mean absolute difference of the thumbnails (0–255): below STILL the view did not move, above NEW it
// changed. Changes on the terminal are small (quote -> PROCESSING overview: 3.6, a message over the
// panel going away: 0.3), so while a panel is in view it is read again every REREAD_MS anyway.
const STILL: f32 = 3.0;
const NEW: f32 = 1.5;
const REREAD_MS: u64 = 2_000;

pub struct Frame {
    /// When it was taken (Unix ms)
    pub at_ms: u64,
    pub image: RgbImage,
    /// From the screen capture: passes the gate; test frames are always read
    pub live: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScreenEvent {
    at_ms: u64,
    screen: Screen,
}

/// Decides which live frames are worth reading.
#[derive(Default)]
pub struct Gate {
    previous: Option<GrayImage>,
    last_read: Option<GrayImage>,
    last_read_ms: u64,
    /// The last frame read showed a refinery panel
    panel: bool,
}

fn thumb(img: &RgbImage) -> GrayImage {
    imageops::grayscale(&imageops::resize(img, THUMB.0, THUMB.1, FilterType::Triangle))
}

fn diff(a: &GrayImage, b: &GrayImage) -> f32 {
    let sum: u64 = a.pixels().zip(b.pixels()).map(|(p, q)| p[0].abs_diff(q[0]) as u64).sum();
    sum as f32 / (THUMB.0 * THUMB.1) as f32
}

impl Gate {
    /// Whether to read this frame (taken at `at_ms`): still since the last frame, and changed since
    /// the last read or, while a panel is in view, REREAD_MS after it.
    pub fn pass(&mut self, img: &RgbImage, at_ms: u64) -> bool {
        let t = thumb(img);
        let still = self.previous.as_ref().is_some_and(|p| diff(p, &t) < STILL);
        let new = self.last_read.as_ref().is_none_or(|l| diff(l, &t) > NEW);
        let again = self.panel && at_ms.saturating_sub(self.last_read_ms) >= REREAD_MS;
        let pass = still && (new || again);
        if pass {
            self.last_read = Some(t.clone());
            self.last_read_ms = at_ms;
        }
        self.previous = Some(t);
        pass
    }

    /// What the read of the passed frame found.
    pub fn read(&mut self, panel: bool) {
        self.panel = panel;
    }
}

/// Whether detection is on (the refinery panel's button; on at start). Off: every frame is
/// dropped unread (the screen capture is meant to stop as well).
pub type Detect = Arc<AtomicBool>;

/// Whether Star Citizen runs, as the screen capture sees it while detection is on (never true on
/// platforms without a capture); changes go to the frontend as `game-seen`. Its own type, not an alias
/// like `Detect`: Tauri keeps managed state by type, a second `Arc<AtomicBool>` would be ignored.
#[derive(Default, Clone)]
pub struct GameSeen(pub Arc<AtomicBool>);
pub const GAME_SEEN: &str = "game-seen";

/// Starts the OCR worker; frames sent to the returned channel are read in order while `detect` is on.
/// The models load with the first frame read (a few hundred ms, and memory only once the OCR is used).
pub fn spawn(app: AppHandle, detect: Detect) -> Sender<Frame> {
    let (tx, rx) = channel::<Frame>();
    std::thread::spawn(move || worker(app, rx, detect));
    if let Some(dir) = std::env::var_os("QM_OCR_FRAMES") {
        spawn_folder_source(PathBuf::from(dir), tx.clone());
    }
    tx
}

/// The next frame to look at: of the live frames queued while the OCR was busy (slow machines,
/// the game's load) only the newest; test frames are never dropped.
fn next_frame(rx: &Receiver<Frame>) -> Option<Frame> {
    let mut frame = rx.recv().ok()?;
    while frame.live {
        match rx.try_recv() {
            Ok(newer) => frame = newer,
            Err(_) => break,
        }
    }
    Some(frame)
}

fn worker(app: AppHandle, rx: Receiver<Frame>, detect: Detect) {
    let mut ocr: Option<Ocr> = None;
    let mut gate = Gate::default();
    while let Some(frame) = next_frame(&rx) {
        if !detect.load(Ordering::Relaxed) {
            gate = Gate::default();
            continue;
        }
        if frame.live && !gate.pass(&frame.image, frame.at_ms) {
            continue;
        }
        if ocr.is_none() {
            match Ocr::new(OCR_THREADS) {
                Ok(o) => ocr = Some(o),
                Err(e) => {
                    log::error!("OCR models: {e}");
                    continue;
                }
            }
        }
        let started = std::time::Instant::now();
        // One event per panel (the overview's running work orders come as several)
        let result = read_screens(ocr.as_mut().unwrap(), &frame.image);
        gate.read(result.as_ref().is_ok_and(|s| !s.is_empty()));
        match result {
            Ok(screens) if screens.is_empty() => log::debug!("no refinery panel ({:?})", started.elapsed()),
            Ok(screens) => {
                for screen in screens {
                    log::info!("refinery {:?} read in {:?}: {} rows", screen.kind, started.elapsed(), screen.rows.len());
                    let _ = app.emit(REFINERY_SCREEN, ScreenEvent { at_ms: frame.at_ms, screen });
                }
            }
            Err(e) => log::warn!("OCR: {e}"),
        }
    }
}

fn unix_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Test source: reads every image file in `dir` once (by name), checking for new ones every 2 s.
fn spawn_folder_source(dir: PathBuf, tx: Sender<Frame>) {
    log::info!("OCR test frames from {}", dir.display());
    std::thread::spawn(move || {
        let mut seen = std::collections::HashSet::new();
        loop {
            let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
                .map(|entries| entries.flatten().map(|e| e.path()).collect())
                .unwrap_or_default();
            files.retain(|p| {
                let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                matches!(ext.as_str(), "jpg" | "jpeg" | "png") && !seen.contains(p)
            });
            files.sort();
            for path in files {
                seen.insert(path.clone());
                let at_ms = std::fs::metadata(&path).and_then(|m| m.modified()).map_or(unix_ms(SystemTime::now()), unix_ms);
                match image::open(&path) {
                    Ok(img) => {
                        if tx.send(Frame { at_ms, image: img.to_rgb8(), live: false }).is_err() {
                            return;
                        }
                    }
                    Err(e) => log::warn!("{}: {e}", path.display()),
                }
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_reads_a_still_view_once_per_change() {
        let mut gate = Gate::default();
        let a = RgbImage::from_pixel(192, 80, image::Rgb([40, 40, 40]));
        let b = RgbImage::from_pixel(192, 80, image::Rgb([200, 200, 200]));
        // First frame: nothing to compare with yet; then still and new; then still but already read
        assert!(!gate.pass(&a, 0));
        assert!(gate.pass(&a, 1_000));
        gate.read(false);
        assert!(!gate.pass(&a, 2_000));
        assert!(!gate.pass(&a, 10_000));
        // A change: moving (not still), then still and new
        assert!(!gate.pass(&b, 11_000));
        assert!(gate.pass(&b, 12_000));
        gate.read(false);
        assert!(!gate.pass(&b, 13_000));
    }

    #[test]
    fn gate_reads_a_panel_again_every_two_seconds() {
        let mut gate = Gate::default();
        let a = RgbImage::from_pixel(192, 80, image::Rgb([40, 40, 40]));
        assert!(!gate.pass(&a, 0));
        assert!(gate.pass(&a, 1_000));
        gate.read(true);
        // Unchanged (a small change on the terminal looks the same in the thumbnail): again after 2 s
        assert!(!gate.pass(&a, 2_000));
        assert!(gate.pass(&a, 3_000));
        gate.read(false);
        // The panel is gone: once per change again
        assert!(!gate.pass(&a, 6_000));
    }
}
