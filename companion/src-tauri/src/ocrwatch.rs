//! Feeds frames to the OCR off the main thread. Platform independent: frames come through a channel
//! from a source — the screen capture (`capture.rs`, Windows so far) or, for tests, a folder of images
//! (`QM_OCR_FRAMES=<dir>`: every image put there is read once, its modification time as the frame time).
//!
//! Reading is a **scan session** the user starts and stops (`Scan`: off, inventory, components or
//! refinery; off at every start). A live frame is read once the view came to rest after it moved,
//! during a session also every 2 s (the `Gate`, a 96×40 grey thumbnail: the game's scene changes a
//! little all the time, checking every changed frame took ~5 % CPU). Inventory: each read goes out as
//! `inventory-read` (`inventory.rs`: the tiles, the tooltip, the layout). Components: each read of the
//! character inventory goes out as `components-read` (`components.rs`: the hovered item's tooltip
//! lines, the page, the cursor's cell). Refinery: the session is a visit
//! (`refinery-visit` true) and each work order overview goes out as `refinery-overview`; a minute
//! without frames ends the visit. The OCR is dropped as soon as the session stops (its memory arena
//! keeps the full reads' peak); the next session loads it again.
//!
//! The former automatic refinery detection (idle: the cheap check `terminal_in_view` on every view that
//! came to rest, a hit starting the visit, a few reads without the terminal ending it) is kept behind
//! `AUTO_REFINERY` for a possible return.
//!
//! Troubleshooting (`Debug`, the inventory panel's debug dialog): while on, every inventory event
//! carries the frame as a JPEG (scaled to 1280 px wide) for the overlay view, and the last reads are
//! kept with their full frames (`DebugStore`); a recording the user starts writes them and every
//! read after into a folder (PNG + JSON per read, an info file) the user can send in.

use std::collections::VecDeque;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use image::{GrayImage, ImageFormat, RgbImage};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::components::{cell_of, read_page, read_tooltip, ComponentRead};
use crate::inventory::{read_grid, Grid};
use crate::locale::LabelSource;
use crate::ocr::{Ocr, TextBox};
use crate::refinery::{read_overview, terminal_in_view, Overview, Read};

pub const REFINERY_OVERVIEW: &str = "refinery-overview";
pub const REFINERY_VISIT: &str = "refinery-visit";
pub const INVENTORY_READ: &str = "inventory-read";
/// Whether a refinery session waits for the terminal's titles before reading (the former automatic
/// detection); off: the session reads right away
const AUTO_REFINERY: bool = false;
/// Width of the frame sent with an inventory event while debugging
const DEBUG_FRAME_WIDTH: u32 = 1280;
/// Reads kept for the debug window and a recording (full frames as JPEG: ~0.6 MB each on 3840×1600)
const DEBUG_KEEP: usize = 3;
const RECORD_JPEG_QUALITY: u8 = 90;
// ONNX Runtime threads: the game runs at the same time (3: the inventory reads confirm every stack
// twice, the user waits for them)
const OCR_THREADS: usize = 3;
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
// The inventory scan reads every frame the capture delivers (one per second, a read takes about as
// long): a stack counts after two agreeing reads, the user waits for them
const INVENTORY_REREAD_MS: u64 = 0;
// Full reads in a row without the terminal that end a visit
const LEAVE_AFTER: u32 = 3;
// A visit also ends without any frame for this long (the game not in front)
const VISIT_GAP: Duration = Duration::from_secs(60);

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
    /// The mouse cursor in frame pixels (the capture knows it; test frames have none)
    pub cursor: Option<(f32, f32)>,
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InventoryEvent {
    at_ms: u64,
    /// The read's duration
    ms: u64,
    /// The frame's size (the overlays of the debug view scale with it)
    width: u32,
    height: u32,
    /// None: no warehouse grid in the frame (or the frame was read as the character inventory)
    grid: Option<Grid>,
    /// The character inventory's read (tooltip, page, cursor cell); None when the frame was read as
    /// the warehouse
    components: Option<ComponentRead>,
    /// The mouse cursor in frame pixels, if known
    cursor: Option<(f32, f32)>,
    /// Every text the OCR detected (for the debug view)
    boxes: Vec<TextBox>,
    /// While debugging: the frame as a JPEG data URL, DEBUG_FRAME_WIDTH wide
    frame: Option<String>,
}

/// Which screen an inventory session is looking at: decided once (the page number marks the character
/// inventory, a fitted grid the warehouse) and kept until the reader found nothing `SCREEN_MISSES`
/// times in a row (a switch between the screens takes the player seconds).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Screen {
    Unknown,
    Warehouse,
    Inventory,
}
const SCREEN_MISSES: u32 = 3;
/// How often an inventory session that knows no screen looks for one
const PROBE_MS: u64 = 2_000;

/// One inventory read kept for the debug export.
pub struct DebugRead {
    pub at_ms: u64,
    pub ms: u64,
    pub width: u32,
    pub height: u32,
    pub grid: Option<Grid>,
    pub components: Option<ComponentRead>,
    pub boxes: Vec<TextBox>,
    /// The frame as PNG
    /// The frame as JPEG
    pub jpeg: Vec<u8>,
}

/// Whether the debug view is open: frames go with the events and the last reads are kept.
#[derive(Default, Clone)]
pub struct Debug(pub Arc<AtomicBool>);

/// A running recording: every read goes into this folder as `read-N.jpg` + `read-N.json`.
pub struct Recording {
    folder: PathBuf,
    next: usize,
}

/// What the debug window holds: the last reads (RAM, `DEBUG_KEEP`) and the recording, if one runs.
#[derive(Default)]
pub struct DebugState {
    pub reads: VecDeque<DebugRead>,
    pub recording: Option<Recording>,
}

impl DebugState {
    /// Drops the kept reads and ends a recording (the debug window closed).
    pub fn clear(&mut self) {
        self.reads.clear();
        self.recording = None;
    }
}

/// The debug window's state, shared with the worker and the commands.
#[derive(Default, Clone)]
pub struct DebugStore(pub Arc<Mutex<DebugState>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportRead<'a> {
    at_ms: u64,
    ms: u64,
    width: u32,
    height: u32,
    grid: &'a Option<Grid>,
    components: &'a Option<ComponentRead>,
    boxes: &'a [TextBox],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportInfo<'a> {
    version: &'a str,
    platform: &'a str,
    exported_at_ms: u64,
    game_dir: &'a str,
    reads: usize,
}

/// Writes one read as `read-N.jpg` + `read-N.json` into `folder`.
fn write_read(folder: &Path, n: usize, r: &DebugRead) -> Result<(), String> {
    std::fs::write(folder.join(format!("read-{n}.jpg")), &r.jpeg).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&ExportRead { at_ms: r.at_ms, ms: r.ms, width: r.width, height: r.height, grid: &r.grid, components: &r.components, boxes: &r.boxes })
        .map_err(|e| e.to_string())?;
    std::fs::write(folder.join(format!("read-{n}.json")), json).map_err(|e| e.to_string())
}

fn write_info(folder: &Path, game_dir: &str, reads: usize) -> Result<(), String> {
    let info = ExportInfo {
        version: env!("CARGO_PKG_VERSION"),
        platform: if cfg!(windows) { "windows" } else { "linux" },
        exported_at_ms: unix_ms(SystemTime::now()),
        game_dir,
        reads,
    };
    std::fs::write(folder.join("info.json"), serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

impl DebugStore {
    /// Starts a recording into a new folder below `dir`: the reads kept so far go in first, every
    /// read from now on follows as it happens (`info.json` holds the count, rewritten at the stop).
    /// The folder's path.
    pub fn start_recording(&self, dir: &Path, game_dir: &str) -> Result<PathBuf, String> {
        let folder = dir.join(format!("qm-inventory-debug-{}", unix_ms(SystemTime::now()) / 1000));
        std::fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
        let mut state = self.0.lock().unwrap();
        for (n, r) in state.reads.iter().enumerate() {
            write_read(&folder, n, r)?;
        }
        write_info(&folder, game_dir, state.reads.len())?;
        state.recording = Some(Recording { folder: folder.clone(), next: state.reads.len() });
        Ok(folder)
    }

    /// Ends the recording; its folder, if one ran.
    pub fn stop_recording(&self, game_dir: &str) -> Option<PathBuf> {
        let rec = self.0.lock().unwrap().recording.take()?;
        if let Err(e) = write_info(&rec.folder, game_dir, rec.next) {
            log::warn!("debug recording info: {e}");
        }
        Some(rec.folder)
    }
}

/// The frame as a JPEG data URL, `width` pixels wide.
fn jpeg_data_url(image: &RgbImage, width: u32) -> Result<String, String> {
    let (w, h) = image.dimensions();
    let scaled = if w > width { image::imageops::resize(image, width, (h as u64 * width as u64 / w as u64).max(1) as u32, image::imageops::FilterType::Triangle) } else { image.clone() };
    let mut bytes = Cursor::new(Vec::new());
    scaled.write_to(&mut bytes, ImageFormat::Jpeg).map_err(|e| e.to_string())?;
    Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())))
}

/// The frame as JPEG at `RECORD_JPEG_QUALITY` (~0.6 MB on 3840×1600 instead of ~7 MB as PNG, and
/// encoded in a fraction of the time; the OCR reads such frames like the game's own screenshots).
fn jpeg_bytes(image: &RgbImage) -> Result<Vec<u8>, String> {
    let mut bytes = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, RECORD_JPEG_QUALITY);
    encoder.encode_image(image).map_err(|e| e.to_string())?;
    Ok(bytes.into_inner())
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
    /// How long after a read a still view is read again during a visit
    reread_ms: u64,
}

impl Default for Gate {
    fn default() -> Self {
        // The first still view is checked
        Self { previous: None, last_read: None, last_read_ms: 0, moved: true, visit: false, reread_ms: REREAD_MS }
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
                new || at_ms.saturating_sub(self.last_read_ms) >= self.reread_ms
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

/// Whether a scan session runs (the capture runs only then; off at start). Off: every frame is
/// dropped unread.
pub type Detect = Arc<AtomicBool>;

/// What a scan session reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanMode {
    Off,
    /// The freight manager's warehouse (materials and items) and the character inventory (ship
    /// components): the worker tells the screens apart
    Inventory,
    Refinery,
}

impl ScanMode {
    pub fn name(self) -> &'static str {
        match self {
            ScanMode::Off => "off",
            ScanMode::Inventory => "inventory",
            ScanMode::Refinery => "refinery",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "off" => Some(ScanMode::Off),
            "inventory" => Some(ScanMode::Inventory),
            "refinery" => Some(ScanMode::Refinery),
            _ => None,
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => ScanMode::Inventory,
            2 => ScanMode::Refinery,
            _ => ScanMode::Off,
        }
    }
}

/// The session's mode, shared with the commands (`Detect` says whether one runs at all: the capture
/// only looks at that). Its own type: Tauri keeps managed state by type.
#[derive(Default, Clone)]
pub struct Scan(pub Arc<AtomicU8>);

impl Scan {
    pub fn get(&self) -> ScanMode {
        ScanMode::from_u8(self.0.load(Ordering::Relaxed))
    }

    pub fn set(&self, mode: ScanMode) {
        self.0.store(mode as u8, Ordering::Relaxed);
    }
}

/// Whether Star Citizen runs, as the screen capture sees it while detection is on (never true on
/// platforms without a capture); changes go to the frontend as `game-seen`. Its own type, not an alias
/// like `Detect`: Tauri keeps managed state by type, a second `Arc<AtomicBool>` would be ignored.
#[derive(Default, Clone)]
pub struct GameSeen(pub Arc<AtomicBool>);
pub const GAME_SEEN: &str = "game-seen";

/// Starts the OCR worker; frames sent to the returned channel are read in order while a session runs.
pub fn spawn(app: AppHandle, detect: Detect, scan: Scan, debug: Debug, store: DebugStore) -> Sender<Frame> {
    let (tx, rx) = channel::<Frame>();
    std::thread::spawn(move || Worker::new(app, detect, scan, debug, store).run(rx));
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
    scan: Scan,
    debug: Debug,
    store: DebugStore,
    ocr: Option<Ocr>,
    gate: Gate,
    labels: LabelSource,
    visit: Option<Visit>,
    /// The last inventory read's grid pitch: the next fit's prior
    last_pitch: Option<(f32, f32)>,
    /// Which screen the inventory session looks at, and how many reads in a row found nothing there
    screen: Screen,
    screen_misses: u32,
    /// When an inventory session last read a frame (probing without a known screen is throttled)
    last_probe_ms: u64,
}

fn unix_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The OCR, loaded on first use.
fn ensure_ocr(slot: &mut Option<Ocr>) -> Result<&mut Ocr, String> {
    if slot.is_none() {
        let started = Instant::now();
        *slot = Some(Ocr::new(OCR_THREADS).map_err(|e| format!("models: {e}"))?);
        log::info!("OCR loaded in {:?}", started.elapsed());
    }
    Ok(slot.as_mut().expect("loaded above"))
}

impl Worker {
    fn new(app: AppHandle, detect: Detect, scan: Scan, debug: Debug, store: DebugStore) -> Self {
        Self { app, detect, scan, debug, store, ocr: None, gate: Gate::default(), labels: LabelSource::default(), visit: None, last_pitch: None, screen: Screen::Unknown, screen_misses: 0, last_probe_ms: 0 }
    }

    fn run(mut self, rx: Receiver<Frame>) {
        loop {
            let Ok(frame) = next_frame(&rx, Duration::from_secs(5)) else { return };
            if self.visit.as_ref().is_some_and(|v| v.last_frame.elapsed() > VISIT_GAP) {
                self.end_visit("no frames");
            }
            let Some(frame) = frame else { continue };
            let mode = if self.detect.load(Ordering::Relaxed) { self.scan.get() } else { ScanMode::Off };
            if mode != ScanMode::Refinery {
                self.end_visit("scan stopped");
            }
            if mode == ScanMode::Off {
                self.gate = Gate::default();
                // The next session may see the terminal from elsewhere, or another screen
                self.last_pitch = None;
                self.screen = Screen::Unknown;
                self.screen_misses = 0;
                // No session: the OCR's memory goes right away (the next start loads it again in
                // well under a second); while a session runs it stays, read or not
                if self.ocr.take().is_some() {
                    log::info!("OCR unloaded (scan stopped)");
                }
                continue;
            }
            if let Some(v) = &mut self.visit {
                v.last_frame = Instant::now();
            }
            self.gate.reread_ms = if mode == ScanMode::Refinery { REREAD_MS } else { INVENTORY_REREAD_MS };
            // An inventory session reads every frame: the character and the world behind the
            // translucent inventory screen never come to rest, and the user waits for each stack.
            // While it does not know its screen (nothing in view: a menu, the verse) it probes
            // every PROBE_MS only: a frame with neither screen costs the grid and the tooltip read
            if frame.live && mode != ScanMode::Inventory && !self.gate.pass(frame.pixels.thumb(), frame.at_ms) {
                continue;
            }
            if frame.live && mode == ScanMode::Inventory && self.screen == Screen::Unknown && frame.at_ms.saturating_sub(self.last_probe_ms) < PROBE_MS {
                continue;
            }
            self.last_probe_ms = frame.at_ms;
            let result = match mode {
                ScanMode::Inventory => self.look_inventory(frame),
                _ => self.look(frame),
            };
            if let Err(e) = result {
                log::warn!("OCR: {e}");
            }
            // A session reads again every REREAD_MS, not only when the view moved
            self.gate.read(true);
        }
    }

    /// Reads a frame of an inventory session: the warehouse grid and its tooltip (every tile's badge
    /// only while debugging: the sightings need the hovered tile's), or the character inventory's
    /// tooltip, page and cursor cell. Which one is decided by `Screen` (see there): unknown, the cheap
    /// page read decides, else the grid read, and a frame with neither is tried as the inventory too.
    fn look_inventory(&mut self, frame: Frame) -> Result<(), String> {
        let debug = self.debug.0.load(Ordering::Relaxed);
        let ocr = ensure_ocr(&mut self.ocr)?;
        let image = frame.pixels.into_rgb();
        let (width, height) = image.dimensions();
        let started = Instant::now();
        let mut grid = None;
        let mut components = None;
        let mut boxes = Vec::new();
        let mut found = false;
        // The storage grid's cell under the cursor; without one no tooltip can belong to a tile, so
        // the tooltip read is skipped (the page read keeps the screen)
        let cell = frame.cursor.and_then(|c| cell_of(c, width as f32, height as f32));
        let tooltip_read = |ocr: &mut Ocr, boxes: &mut Vec<TextBox>| -> Result<_, String> {
            if cell.is_none() && frame.cursor.is_some() {
                return Ok(None);
            }
            let (tooltip, tip_boxes) = read_tooltip(ocr, &image)?;
            boxes.extend(tip_boxes);
            Ok(tooltip)
        };
        if self.screen != Screen::Inventory {
            let probe_page = self.screen == Screen::Unknown;
            let page = if probe_page {
                let (page, page_boxes) = read_page(ocr, &image)?;
                boxes.extend(page_boxes);
                page
            } else {
                None
            };
            if page.is_none() {
                let (g, grid_boxes) = read_grid(ocr, &image, frame.cursor, self.last_pitch, debug)?;
                boxes.extend(grid_boxes);
                if let Some(g) = &g {
                    // Only a strong fit sets the pitch the weaker reads keep
                    if g.fit_weight >= crate::inventory::STRONG_FIT_WEIGHT {
                        self.last_pitch = Some((g.pitch_x, g.pitch_y));
                    }
                    found = true;
                    self.screen = Screen::Warehouse;
                }
                grid = g;
            }
            if self.screen == Screen::Unknown || page.is_some() {
                // The page or nothing at all: try the character inventory
                let tooltip = tooltip_read(ocr, &mut boxes)?;
                let page = if probe_page { page } else { read_page(ocr, &image).map(|(p, b)| { boxes.extend(b); p })? };
                found = found || page.is_some() || tooltip.is_some();
                if page.is_some() {
                    self.screen = Screen::Inventory;
                }
                components = Some(ComponentRead { tooltip, page, cell });
            }
        } else {
            let tooltip = tooltip_read(ocr, &mut boxes)?;
            let (page, page_boxes) = read_page(ocr, &image)?;
            boxes.extend(page_boxes);
            found = page.is_some() || tooltip.is_some();
            components = Some(ComponentRead { tooltip, page, cell });
        }
        // A screen that shows nothing SCREEN_MISSES times in a row is left: the next frame probes again
        if found {
            self.screen_misses = 0;
        } else if self.screen != Screen::Unknown {
            self.screen_misses += 1;
            if self.screen_misses >= SCREEN_MISSES {
                log::info!("inventory scan: left the {:?} screen", self.screen);
                self.screen = Screen::Unknown;
                self.screen_misses = 0;
            }
        }
        let ms = started.elapsed().as_millis() as u64;
        match (&grid, &components) {
            (Some(g), _) => {
                let tip = g.tooltip.as_ref().map_or("no tooltip".to_string(), |t| format!("tooltip {} Q{:?} {:?}", t.name, t.quality, t.scu));
                let hovered = g.tiles.iter().find(|t| t.hovered).map_or(String::new(), |t| format!(", hovered r{} c{} Q{:?} x{:?}", t.row, t.col, t.quality, t.count));
                log::info!("inventory read in {ms} ms: {}×{} tiles at pitch {:.0}×{:.0} (weight {}), cursor {:?}, {tip}{hovered}", g.cols.len(), g.rows.len(), g.pitch_x, g.pitch_y, g.fit_weight, frame.cursor);
            }
            (None, Some(c)) if c.tooltip.is_some() || c.page.is_some() => {
                // The lines as read: what the frontend matches the stat names against
                let tip = c.tooltip.as_ref().map_or("no tooltip".to_string(), |t| format!("tooltip {:?} with {} lines: {}", t.title, t.lines.len(), t.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" | ")));
                log::info!("components read in {ms} ms: page {:?}, cursor {:?} in cell {:?}, {tip}", c.page.map(|p| (p.index, p.total)), frame.cursor, c.cell.map(|x| (x.row, x.col)));
            }
            _ => log::debug!("no warehouse grid, no inventory tooltip ({ms} ms, screen {:?})", self.screen),
        }
        let frame_url = if debug { Some(jpeg_data_url(&image, DEBUG_FRAME_WIDTH)?) } else { None };
        if debug {
            let jpeg = jpeg_bytes(&image)?;
            let read = DebugRead { at_ms: frame.at_ms, ms, width, height, grid: grid.clone(), components: components.clone(), boxes: boxes.clone(), jpeg };
            let mut state = self.store.0.lock().unwrap();
            // A running recording gets every read as a file right away
            if let Some(rec) = &mut state.recording {
                if let Err(e) = write_read(&rec.folder, rec.next, &read) {
                    log::warn!("debug recording: {e}");
                }
                rec.next += 1;
            }
            if state.reads.len() >= DEBUG_KEEP {
                state.reads.pop_front();
            }
            state.reads.push_back(read);
        }
        let _ = self.app.emit(INVENTORY_READ, InventoryEvent { at_ms: frame.at_ms, ms, width, height, grid, components, cursor: frame.cursor, boxes, frame: frame_url });
        Ok(())
    }

    /// Reads the refinery terminal's work order overview in a frame (the session is the visit; with
    /// `AUTO_REFINERY` the visit starts only once the terminal's titles are seen).
    fn look(&mut self, frame: Frame) -> Result<(), String> {
        let game_dir = PathBuf::from(&self.app.state::<Mutex<crate::AppData>>().lock().unwrap().config.game_dir);
        let labels = self.labels.get(&game_dir).clone();
        let ocr = ensure_ocr(&mut self.ocr)?;
        let image = frame.pixels.into_rgb();
        let started = Instant::now();
        if self.visit.is_none() {
            if AUTO_REFINERY {
                let found = terminal_in_view(ocr, &image, &labels)?;
                log::debug!("terminal check in {:?}: {found}", started.elapsed());
                if !found {
                    return Ok(());
                }
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
                // A manual session goes on until stopped (the user looks away and back)
                if AUTO_REFINERY && visit.misses >= LEAVE_AFTER {
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
                        if tx.send(Frame { at_ms, pixels: Pixels::Rgb(img.to_rgb8()), live: false, cursor: None }).is_err() {
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
