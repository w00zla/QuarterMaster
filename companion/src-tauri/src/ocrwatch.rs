//! Feeds frames to the refinery OCR off the main thread and reports what it reads as the
//! `refinery-screen` event. Platform independent: frames come through a channel from a source —
//! the screen capture (per platform, not built yet) or, for tests, a folder of images
//! (`QM_OCR_FRAMES=<dir>`: every image put there is read once, its modification time as the frame time).
//!
//! The OCR takes ~0.6 s per frame on a fast machine with the game idle, several seconds elsewhere;
//! live frames that queue up meanwhile are dropped but the newest. They also pass a cheap gate first (a 96×40 grey thumbnail): only a frame that is still (the
//! previous one looks the same) and new (differs from the last one read) goes to the OCR, so a terminal
//! is read once per change, not every second, and moving around costs nothing but the thumbnails.

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
use crate::refinery::{read_screen, Screen};

pub const REFINERY_SCREEN: &str = "refinery-screen";
// ONNX Runtime threads: the game runs at the same time
const OCR_THREADS: usize = 2;
const THUMB: (u32, u32) = (96, 40);
// Mean absolute difference of the thumbnails (0–255): below STILL the view did not move, above NEW it changed
const STILL: f32 = 3.0;
const NEW: f32 = 6.0;

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
}

fn thumb(img: &RgbImage) -> GrayImage {
    imageops::grayscale(&imageops::resize(img, THUMB.0, THUMB.1, FilterType::Triangle))
}

fn diff(a: &GrayImage, b: &GrayImage) -> f32 {
    let sum: u64 = a.pixels().zip(b.pixels()).map(|(p, q)| p[0].abs_diff(q[0]) as u64).sum();
    sum as f32 / (THUMB.0 * THUMB.1) as f32
}

impl Gate {
    /// Whether to read this frame: still since the last frame and changed since the last read.
    pub fn pass(&mut self, img: &RgbImage) -> bool {
        let t = thumb(img);
        let still = self.previous.as_ref().is_some_and(|p| diff(p, &t) < STILL);
        let new = self.last_read.as_ref().is_none_or(|l| diff(l, &t) > NEW);
        let pass = still && new;
        if pass {
            self.last_read = Some(t.clone());
        }
        self.previous = Some(t);
        pass
    }
}

/// Whether detection is on (the refinery panel's "Detect" button; off at start). Off: every frame is
/// dropped unread (the screen capture is meant to stop as well).
pub type Detect = Arc<AtomicBool>;

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
        if frame.live && !gate.pass(&frame.image) {
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
        match read_screen(ocr.as_mut().unwrap(), &frame.image) {
            Ok(Some(screen)) => {
                log::info!("refinery {:?} read in {:?}: {} rows", screen.kind, started.elapsed(), screen.rows.len());
                let _ = app.emit(REFINERY_SCREEN, ScreenEvent { at_ms: frame.at_ms, screen });
            }
            Ok(None) => log::debug!("no refinery panel ({:?})", started.elapsed()),
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
        assert!(!gate.pass(&a));
        assert!(gate.pass(&a));
        assert!(!gate.pass(&a));
        // A change: moving (not still), then still and new
        assert!(!gate.pass(&b));
        assert!(gate.pass(&b));
        assert!(!gate.pass(&b));
    }
}
