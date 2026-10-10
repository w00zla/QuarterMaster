//! Feeds frames to the refinery OCR off the main thread. Platform independent: frames come through a
//! channel from a source — the screen capture (`capture.rs`, Windows so far) or, for tests, a folder of
//! images (`QM_OCR_FRAMES=<dir>`: every image put there is read once, its modification time as the frame time).
//!
//! Two modes. Idle: a live frame that passes a cheap gate (a 96×40 grey thumbnail: the view came to rest
//! after it moved) gets the cheap check for a refinery terminal (`terminal_in_view`, its big titles at a
//! low resolution); moving around and standing anywhere cost nothing but the thumbnails (the game's
//! scene changes a little all the time: checking every changed frame took ~5 % CPU). A hit starts a
//! visit (`refinery-visit` true): the terminal is read in full every 2 s (and on every change) and each
//! work order overview goes out as `refinery-overview`. A few reads in a row without the terminal (or a
//! minute without frames) end the visit (`refinery-visit` false). After 5 minutes without any read the
//! OCR is dropped (its memory arena keeps the full reads' peak); the next check loads it again.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use image::{GrayImage, RgbImage};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::locale::LabelSource;
use crate::ocr::Ocr;
use crate::refinery::{read_overview, terminal_in_view, Overview, Read};

pub const REFINERY_OVERVIEW: &str = "refinery-overview";
pub const REFINERY_VISIT: &str = "refinery-visit";
// ONNX Runtime threads: the game runs at the same time
const OCR_THREADS: usize = 2;
const THUMB: (u32, u32) = (96, 40);
// Samples per thumbnail pixel and axis (a box average of the frame's pixels; fewer let small details
// flicker)
const THUMB_SAMPLES: u32 = 16;
// Mean absolute difference of the thumbnails (0–255): below STILL the view did not move, above NEW it
// changed. Changes on the terminal are small (a message over the panel going away: 0.3), so during a
// visit it is read again every REREAD_MS anyway.
const STILL: f32 = 3.0;
const NEW: f32 = 1.5;
const REREAD_MS: u64 = 2_000;
// Full reads in a row without the terminal that end a visit
const LEAVE_AFTER: u32 = 3;
// A visit also ends without any frame for this long (the game not in front)
const VISIT_GAP: Duration = Duration::from_secs(60);
// The OCR is dropped after this long without a read
const UNLOAD_AFTER: Duration = Duration::from_secs(300);

/// A captured image: the capture's BGRA rows (converted only when read) or a test image.
pub enum Pixels {
    Rgb(RgbImage),
    /// Tightly packed rows, 4 bytes per pixel
    Bgra { data: Vec<u8>, width: u32, height: u32 },
}

impl Pixels {
    fn size(&self) -> (u32, u32) {
        match self {
            Pixels::Rgb(img) => img.dimensions(),
            Pixels::Bgra { width, height, .. } => (*width, *height),
        }
    }

    /// Red, green, blue at (x, y).
    fn rgb(&self, x: u32, y: u32) -> [u8; 3] {
        match self {
            Pixels::Rgb(img) => img.get_pixel(x, y).0,
            Pixels::Bgra { data, width, .. } => {
                let i = ((y * width + x) * 4) as usize;
                [data[i + 2], data[i + 1], data[i]]
            }
        }
    }

    /// The grey thumbnail for the gate: each pixel the mean of a grid of samples in its cell (cheap even
    /// on 4K frames, unlike a full resize).
    pub fn thumb(&self) -> GrayImage {
        let (w, h) = self.size();
        GrayImage::from_fn(THUMB.0, THUMB.1, |tx, ty| {
            let mut sum = 0u32;
            for sy in 0..THUMB_SAMPLES {
                for sx in 0..THUMB_SAMPLES {
                    let x = ((tx * THUMB_SAMPLES + sx) * w / (THUMB.0 * THUMB_SAMPLES)).min(w.saturating_sub(1));
                    let y = ((ty * THUMB_SAMPLES + sy) * h / (THUMB.1 * THUMB_SAMPLES)).min(h.saturating_sub(1));
                    let [r, g, b] = self.rgb(x, y);
                    sum += (r as u32 * 77 + g as u32 * 150 + b as u32 * 29) >> 8;
                }
            }
            image::Luma([(sum / (THUMB_SAMPLES * THUMB_SAMPLES)) as u8])
        })
    }

    pub fn into_rgb(self) -> RgbImage {
        match self {
            Pixels::Rgb(img) => img,
            Pixels::Bgra { data, width, height } => {
                let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
                for px in data.as_chunks::<4>().0 {
                    rgb.extend_from_slice(&[px[2], px[1], px[0]]);
                }
                RgbImage::from_raw(width, height, rgb).expect("width × height × 3 bytes")
            }
        }
    }
}

pub struct Frame {
    /// When it was taken (Unix ms)
    pub at_ms: u64,
    pub pixels: Pixels,
    /// From the screen capture: passes the gate; test frames are always read
    pub live: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OverviewEvent {
    at_ms: u64,
    overview: Overview,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VisitEvent {
    at_ms: u64,
    active: bool,
}

/// Decides which live frames are worth reading.
pub struct Gate {
    previous: Option<GrayImage>,
    last_read: Option<GrayImage>,
    last_read_ms: u64,
    /// The view moved since the last read (idle: only a view that came to rest is checked)
    moved: bool,
    /// At a refinery terminal: read again every REREAD_MS
    visit: bool,
}

impl Default for Gate {
    fn default() -> Self {
        // The first still view is checked
        Self { previous: None, last_read: None, last_read_ms: 0, moved: true, visit: false }
    }
}

fn diff(a: &GrayImage, b: &GrayImage) -> f32 {
    let sum: u64 = a.pixels().zip(b.pixels()).map(|(p, q)| p[0].abs_diff(q[0]) as u64).sum();
    sum as f32 / (THUMB.0 * THUMB.1) as f32
}

impl Gate {
    /// Whether to read the frame with this thumbnail (taken at `at_ms`), still since the last frame: idle,
    /// once the view came to rest after it moved; during a visit, when it changed since the last read or
    /// REREAD_MS after it.
    pub fn pass(&mut self, t: GrayImage, at_ms: u64) -> bool {
        let still = self.previous.as_ref().is_some_and(|p| diff(p, &t) < STILL);
        if self.previous.is_some() && !still {
            self.moved = true;
        }
        let pass = still
            && if self.visit {
                let new = self.last_read.as_ref().is_none_or(|l| diff(l, &t) > NEW);
                new || at_ms.saturating_sub(self.last_read_ms) >= REREAD_MS
            } else {
                self.moved
            };
        if pass {
            self.moved = false;
            self.last_read = Some(t.clone());
            self.last_read_ms = at_ms;
        }
        self.previous = Some(t);
        pass
    }

    /// Whether a visit is going on after the read of the passed frame.
    pub fn read(&mut self, visit: bool) {
        self.visit = visit;
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
pub fn spawn(app: AppHandle, detect: Detect) -> Sender<Frame> {
    let (tx, rx) = channel::<Frame>();
    std::thread::spawn(move || Worker::new(app, detect).run(rx));
    if let Some(dir) = std::env::var_os("QM_OCR_FRAMES") {
        spawn_folder_source(PathBuf::from(dir), tx.clone());
    }
    tx
}

/// The next frame (None: none came within `wait`; Err: the channel is closed): of the live frames
/// queued while the OCR was busy (slow machines, the game's load) only the newest; test frames are
/// never dropped.
fn next_frame(rx: &Receiver<Frame>, wait: Duration) -> Result<Option<Frame>, ()> {
    let mut frame = match rx.recv_timeout(wait) {
        Ok(f) => f,
        Err(RecvTimeoutError::Timeout) => return Ok(None),
        Err(RecvTimeoutError::Disconnected) => return Err(()),
    };
    while frame.live {
        match rx.try_recv() {
            Ok(newer) => frame = newer,
            Err(_) => break,
        }
    }
    Ok(Some(frame))
}

struct Visit {
    misses: u32,
    last_frame: Instant,
}

struct Worker {
    app: AppHandle,
    detect: Detect,
    ocr: Option<Ocr>,
    last_used: Instant,
    gate: Gate,
    labels: LabelSource,
    visit: Option<Visit>,
}

fn unix_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl Worker {
    fn new(app: AppHandle, detect: Detect) -> Self {
        Self { app, detect, ocr: None, last_used: Instant::now(), gate: Gate::default(), labels: LabelSource::default(), visit: None }
    }

    fn run(mut self, rx: Receiver<Frame>) {
        loop {
            let Ok(frame) = next_frame(&rx, Duration::from_secs(5)) else { return };
            if self.visit.as_ref().is_some_and(|v| v.last_frame.elapsed() > VISIT_GAP) {
                self.end_visit("no frames");
            }
            if self.ocr.is_some() && self.visit.is_none() && self.last_used.elapsed() > UNLOAD_AFTER {
                self.ocr = None;
                log::info!("OCR unloaded (unused)");
            }
            let Some(frame) = frame else { continue };
            if !self.detect.load(Ordering::Relaxed) {
                self.gate = Gate::default();
                self.end_visit("detection off");
                continue;
            }
            if let Some(v) = &mut self.visit {
                v.last_frame = Instant::now();
            }
            if frame.live && !self.gate.pass(frame.pixels.thumb(), frame.at_ms) {
                continue;
            }
            if let Err(e) = self.look(frame) {
                log::warn!("OCR: {e}");
            }
            self.gate.read(self.visit.is_some());
            self.last_used = Instant::now();
        }
    }

    /// Checks a frame for the terminal (idle) or reads it in full (visit).
    fn look(&mut self, frame: Frame) -> Result<(), String> {
        if self.ocr.is_none() {
            let started = Instant::now();
            self.ocr = Some(Ocr::new(OCR_THREADS).map_err(|e| format!("models: {e}"))?);
            log::info!("OCR loaded in {:?}", started.elapsed());
        }
        let ocr = self.ocr.as_mut().expect("loaded above");
        let image = frame.pixels.into_rgb();
        let game_dir = PathBuf::from(&self.app.state::<Mutex<crate::AppData>>().lock().unwrap().config.game_dir);
        let labels = self.labels.get(&game_dir).clone();
        let started = Instant::now();
        if self.visit.is_none() {
            let found = terminal_in_view(ocr, &image, &labels)?;
            log::debug!("terminal check in {:?}: {found}", started.elapsed());
            if !found {
                return Ok(());
            }
            log::info!("refinery visit started");
            self.visit = Some(Visit { misses: 0, last_frame: Instant::now() });
            let _ = self.app.emit(REFINERY_VISIT, VisitEvent { at_ms: frame.at_ms, active: true });
        }
        let read = read_overview(ocr, &image, &labels)?;
        let visit = self.visit.as_mut().expect("started above");
        match read {
            Read::Overview(overview) => {
                visit.misses = 0;
                let orders: Vec<String> = overview.orders.iter().map(|o| format!("{:?} {} rows", o.status, o.rows.len())).collect();
                log::info!("refinery overview read in {:?}: {}", started.elapsed(), orders.join(", "));
                let _ = self.app.emit(REFINERY_OVERVIEW, OverviewEvent { at_ms: frame.at_ms, overview });
            }
            Read::Terminal => {
                visit.misses = 0;
                log::debug!("refinery terminal without work orders ({:?})", started.elapsed());
            }
            Read::Nothing => {
                visit.misses += 1;
                log::debug!("no refinery terminal ({:?}), {} in a row", started.elapsed(), visit.misses);
                if visit.misses >= LEAVE_AFTER {
                    self.end_visit("left");
                }
            }
        }
        Ok(())
    }

    fn end_visit(&mut self, why: &str) {
        if self.visit.take().is_none() {
            return;
        }
        log::info!("refinery visit ended ({why})");
        let _ = self.app.emit(REFINERY_VISIT, VisitEvent { at_ms: unix_ms(SystemTime::now()), active: false });
    }
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
                        if tx.send(Frame { at_ms, pixels: Pixels::Rgb(img.to_rgb8()), live: false }).is_err() {
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

    fn flat(v: u8) -> GrayImage {
        Pixels::Rgb(RgbImage::from_pixel(192, 80, image::Rgb([v, v, v]))).thumb()
    }

    #[test]
    fn gate_checks_a_view_once_it_came_to_rest() {
        let mut gate = Gate::default();
        let (a, b) = (flat(40), flat(200));
        // First frame: nothing to compare with yet; then still: checked once
        assert!(!gate.pass(a.clone(), 0));
        assert!(gate.pass(a.clone(), 1_000));
        gate.read(false);
        assert!(!gate.pass(a.clone(), 2_000));
        assert!(!gate.pass(a.clone(), 10_000));
        // Small changes while standing (the scene's animations) are no movement: nothing
        assert!(!gate.pass(flat(42), 11_000));
        assert!(!gate.pass(a.clone(), 12_000));
        // Moving (not still), then at rest again: checked once
        assert!(!gate.pass(b.clone(), 13_000));
        assert!(gate.pass(b.clone(), 14_000));
        gate.read(false);
        assert!(!gate.pass(b, 15_000));
    }

    #[test]
    fn gate_reads_again_every_two_seconds_during_a_visit() {
        let mut gate = Gate::default();
        let a = flat(40);
        assert!(!gate.pass(a.clone(), 0));
        assert!(gate.pass(a.clone(), 1_000));
        gate.read(true);
        // Unchanged (a small change on the terminal looks the same in the thumbnail): again after 2 s
        assert!(!gate.pass(a.clone(), 2_000));
        assert!(gate.pass(a.clone(), 3_000));
        gate.read(false);
        // The visit ended: once per change again
        assert!(!gate.pass(a, 6_000));
    }

    #[test]
    fn bgra_and_rgb_give_the_same_picture() {
        // 2×1: a red and a blue pixel
        let bgra = Pixels::Bgra { data: vec![0, 0, 255, 255, 255, 0, 0, 255], width: 2, height: 1 };
        let rgb = Pixels::Rgb(RgbImage::from_raw(2, 1, vec![255, 0, 0, 0, 0, 255]).unwrap());
        assert_eq!(bgra.thumb(), rgb.thumb());
        assert_eq!(bgra.into_rgb(), rgb.into_rgb());
    }
}
