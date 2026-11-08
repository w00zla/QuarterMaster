//! Feeds frames to the OCR off the main thread. Platform independent: frames come through a channel
//! from a source — the screen capture (`capture.rs`, Windows so far) or, for tests, a folder of images
//! (`QM_OCR_FRAMES=<dir>`: every image put there is read once, its modification time as the frame time).
//!
//! Reading is **one scan** the user switches on and off (off at every start), with a `Scope`: which of
//! the screens it reads (the frontend's filters). The worker finds the screen itself (`Screen`, sent as
//! `scan-screen` on every change): without one it probes every `PROBE_MS` (the refinery's big titles,
//! the character inventory's page number, the warehouse grid). The screens are read by sc-ohseearr's
//! readers (`Readers`), which keep what they learn across frames (the warehouse's layout, the character
//! inventory's UI scale); their output is adapted to the companion's payloads. Warehouse and character
//! inventory: each read goes out as `inventory-read` (`inventory.rs`: the tiles, the tooltip, the layout;
//! `components.rs`: the hovered item's tooltip lines, the page, the cursor's cell). Refinery: the
//! screen is a visit (`refinery-visit` true) and each work order overview goes out as
//! `refinery-overview`; a live frame is read once the view came to rest after it moved and every 2 s
//! (sc-ohseearr's `Gate`, a 96×40 grey thumbnail: the game's scene changes a little all the time,
//! checking every changed frame took ~5 % CPU); a few reads without the terminal or a minute without
//! frames end the visit. The refinery reader finds the terminal by its texts in the player's language:
//! the game's `global.ini` (`Locale`: the language pack, else the English table `global-english.ini` in
//! the app's local data folder); without either the refinery is not read. The OCR and the readers are
//! dropped as soon as the scan stops (the OCR's memory arena keeps the full reads' peak, the warehouse
//! reader holds its layout detector); the next start loads them again.
//!
//! Troubleshooting (`Debug`, the inventory panel's debug dialog): while on, every read goes out a
//! second time as `inventory-debug` with the frame as a JPEG (scaled to 1280 px wide) for the overlay
//! view, and the last reads are kept with their full frames (`DebugStore`); a recording the user
//! starts writes them and every read after into a folder (JPEG + JSON per read, an info file) the user
//! can send in. That happens off the worker (`spawn_debug_writer`) and never holds a read back.

use std::collections::VecDeque;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use image::{ImageFormat, RgbImage};
use sc_ohseearr_gear_inventory::GearInventoryReader;
use sc_ohseearr_refinery::RefineryReader;
use sc_ohseearr_sc::{Locale, LocaleSource, Reader};
use sc_ohseearr_warehouse::WarehouseReader;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub use sc_ohseearr_capture_win::{Gate, Pixels, PULL_TIMEOUT_MS};

use crate::components::ComponentRead;
use crate::inventory::Grid;
use crate::ocr::{Ocr, TextBox};
use crate::refinery::{Overview, Read};

pub const REFINERY_OVERVIEW: &str = "refinery-overview";
pub const REFINERY_VISIT: &str = "refinery-visit";
pub const INVENTORY_READ: &str = "inventory-read";
pub const INVENTORY_DEBUG: &str = "inventory-debug";
pub const SCAN_SCREEN: &str = "scan-screen";
/// Width of the frame sent with an inventory event while debugging
const DEBUG_FRAME_WIDTH: u32 = 1280;
/// Reads kept for the debug window and a recording (full frames as JPEG: ~0.6 MB each on 3840×1600)
const DEBUG_KEEP: usize = 3;
/// Reads waiting for the debug writer (each with its raw frame: 18 MB on 3840×1600); a read that finds
/// the queue full is left out of the debug view and a recording. Unbounded, the queue grew to 24 s
/// behind and ~1.5 GB within three minutes of a recording, and the scan's own events waited in it
const DEBUG_QUEUE: usize = 2;
const RECORD_JPEG_QUALITY: u8 = 90;
// ONNX Runtime threads: the game runs at the same time (3: the inventory reads confirm every stack
// twice, the user waits for them)
const OCR_THREADS: usize = 3;
// Full reads in a row without the terminal that end a visit
const LEAVE_AFTER: u32 = 3;
// A visit also ends without any frame for this long (the game not in front)
const VISIT_GAP: Duration = Duration::from_secs(60);
/// The English `global.ini` in the app's local data folder: the game's texts for players without a language
/// pack (the game keeps its English texts in `Data.p4k`; sc-ohseearr's `scripts/extract-global-ini.*` extracts
/// them)
const ENGLISH_TABLE: &str = "global-english.ini";

pub struct Frame {
    /// When it was taken (Unix ms)
    pub at_ms: u64,
    pub pixels: Pixels,
    /// From the screen capture: passes the gate; test frames are always read
    pub live: bool,
    /// The mouse cursor in frame pixels (the capture knows it; test frames have none)
    pub cursor: Option<(f32, f32)>,
    /// How it was captured (test frames: all 0)
    pub capture: CaptureInfo,
}

/// How the frame behind a read came about, for the debug view and recordings (remote diagnosis of
/// slow reads): the grab, the grabs without a new image before it, the frames not read since the read
/// before, how long it waited. The counts cover everything since the read before.
#[derive(Serialize, Clone, Copy, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    /// The grab's duration (desktop image to the CPU)
    pub grab_ms: u32,
    /// Grabs without a new image: none within the timeout, only the pointer moved, the window
    /// outside the monitor (the next try comes a full interval later)
    pub skipped_timeout: u32,
    pub skipped_pointer: u32,
    pub skipped_outside: u32,
    /// Frames the worker did not read: older ones dropped while the OCR was busy, and ones held back
    /// by the probe throttle or the refinery's rest gate
    pub dropped: u32,
    pub gated: u32,
    /// From the grab to the read's start
    pub wait_ms: u64,
    /// How long the mouse cursor had rested when the frame was grabbed (pulled frames; 0: not waited for)
    pub rest_ms: u32,
}

impl CaptureInfo {
    /// Adds the counts of a frame that was not read (its grab and wait are its own).
    fn add_unread(&mut self, other: CaptureInfo) {
        self.skipped_timeout += other.skipped_timeout;
        self.skipped_pointer += other.skipped_pointer;
        self.skipped_outside += other.skipped_outside;
        self.dropped += other.dropped;
        self.gated += other.gated;
    }
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
    /// A refinery read (sent only while debugging: the sync gets `refinery-overview`)
    refinery: Option<RefineryRead>,
    /// How the frame was captured
    capture: CaptureInfo,
    /// Which models read it, where, and their share of `ms`
    ocr: OcrInfo,
}

/// The OCR of a read (debug view, recordings): the models that ran ([`MODELS`] or none), on the GPU or
/// the CPU and why (the setting, the GPU's state), and their time (preparation, runs, post-processing;
/// the rest of the read is its own work).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OcrInfo {
    models: Vec<&'static str>,
    gpu: bool,
    setting: bool,
    status: GpuState,
    ms: u64,
}

/// What a read of the refinery terminal found, for the debug view and a recording.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RefineryRead {
    /// "overview", "terminal" (no work order panel) or "nothing"
    kind: &'static str,
    overview: Option<Overview>,
}

/// Which screen the scan is looking at: decided once (the refinery's titles, the page number of the
/// character inventory, a fitted grid the warehouse) and kept until the reader found nothing
/// `SCREEN_MISSES` (refinery: `LEAVE_AFTER`) times in a row (a switch between the screens takes the
/// player seconds).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Screen {
    Unknown,
    Warehouse,
    Inventory,
    Refinery,
}

impl Screen {
    fn name(self) -> &'static str {
        match self {
            Screen::Unknown => "none",
            Screen::Warehouse => "warehouse",
            Screen::Inventory => "inventory",
            Screen::Refinery => "refinery",
        }
    }
}
const SCREEN_MISSES: u32 = 3;
/// How often the scan looks for a screen while it knows none
const PROBE_MS: u64 = 2_000;

/// One read kept for the debug export.
pub struct DebugRead {
    pub at_ms: u64,
    pub ms: u64,
    pub width: u32,
    pub height: u32,
    pub grid: Option<Grid>,
    pub components: Option<ComponentRead>,
    pub refinery: Option<RefineryRead>,
    pub cursor: Option<(f32, f32)>,
    pub boxes: Vec<TextBox>,
    pub capture: CaptureInfo,
    pub ocr: OcrInfo,
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
    refinery: &'a Option<RefineryRead>,
    /// The mouse cursor in frame pixels (replays pass it to the reads)
    cursor: Option<(f32, f32)>,
    boxes: &'a [TextBox],
    /// How the frame was captured (grab time, skipped and unread frames, wait, cursor rest)
    capture: CaptureInfo,
    /// The models that read it, GPU or CPU and why, their time
    ocr: &'a OcrInfo,
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
    let json = serde_json::to_string_pretty(&ExportRead {
        at_ms: r.at_ms,
        ms: r.ms,
        width: r.width,
        height: r.height,
        grid: &r.grid,
        components: &r.components,
        refinery: &r.refinery,
        cursor: r.cursor,
        boxes: &r.boxes,
        capture: r.capture,
        ocr: &r.ocr,
    })
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

/// Starts the debug writer: for each read it gets while debugging it encodes the frame (the JPEG
/// data URL for the event, the full frame for the kept reads and a recording), keeps it, writes it
/// to a running recording and emits the event as `inventory-debug`. Off the worker: encoding and
/// writing a 3840×1600 frame held the next read back (1.8 s between reads while recording instead of
/// 1.05 s). The worker hands reads over with `try_send` (`DEBUG_QUEUE`).
fn spawn_debug_writer(app: AppHandle, store: DebugStore) -> SyncSender<(RgbImage, InventoryEvent)> {
    let (tx, rx) = sync_channel::<(RgbImage, InventoryEvent)>(DEBUG_QUEUE);
    std::thread::spawn(move || {
        for (image, mut event) in rx {
            event.frame = jpeg_data_url(&image, DEBUG_FRAME_WIDTH).map_err(|e| log::warn!("debug frame: {e}")).ok();
            match jpeg_bytes(&image) {
                Ok(jpeg) => {
                    let read = DebugRead {
                        at_ms: event.at_ms,
                        ms: event.ms,
                        width: event.width,
                        height: event.height,
                        grid: event.grid.clone(),
                        components: event.components.clone(),
                        refinery: event.refinery.clone(),
                        cursor: event.cursor,
                        boxes: event.boxes.clone(),
                        capture: event.capture,
                        ocr: event.ocr.clone(),
                        jpeg,
                    };
                    let mut state = store.0.lock().unwrap();
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
                Err(e) => log::warn!("debug frame: {e}"),
            }
            let _ = app.emit(INVENTORY_DEBUG, event);
        }
    });
    tx
}

/// The frame as a JPEG data URL, `width` pixels wide (scaled with the OCR's SIMD resize: `image`'s
/// own took a large part of the writer's time).
fn jpeg_data_url(image: &RgbImage, width: u32) -> Result<String, String> {
    let (w, h) = image.dimensions();
    let scaled = if w > width { crate::ocr::resize(image, width, (h as u64 * width as u64 / w as u64).max(1) as u32, crate::ocr::FilterType::Bilinear) } else { image.clone() };
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

/// Whether the scan runs (the capture runs only then; off at start). Off: every frame is dropped
/// unread.
pub type Detect = Arc<AtomicBool>;

/// Which screens the scan reads (the frontend's filters): the freight manager's warehouse (materials,
/// items), the character inventory (ship components), the refinery terminal (jobs). A screen out of
/// scope is neither looked for nor read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Scope {
    pub warehouse: bool,
    pub inventory: bool,
    pub refinery: bool,
}

impl Scope {
    fn bits(self) -> u8 {
        self.warehouse as u8 | (self.inventory as u8) << 1 | (self.refinery as u8) << 2
    }

    fn from_bits(v: u8) -> Self {
        Self { warehouse: v & 1 != 0, inventory: v & 2 != 0, refinery: v & 4 != 0 }
    }

    fn allows(self, screen: Screen) -> bool {
        match screen {
            Screen::Unknown => true,
            Screen::Warehouse => self.warehouse,
            Screen::Inventory => self.inventory,
            Screen::Refinery => self.refinery,
        }
    }
}

/// The scan's scope, shared with the commands (`Detect` says whether it runs at all: the capture only
/// looks at that). Its own type: Tauri keeps managed state by type.
#[derive(Default, Clone)]
pub struct Scan(pub Arc<AtomicU8>);

impl Scan {
    pub fn get(&self) -> Scope {
        Scope::from_bits(self.0.load(Ordering::Relaxed))
    }

    pub fn set(&self, scope: Scope) {
        self.0.store(scope.bits(), Ordering::Relaxed);
    }
}

/// Whether Star Citizen runs, as the screen capture sees it while detection is on (never true on
/// platforms without a capture); changes go to the frontend as `game-seen`. Its own type, not an alias
/// like `Detect`: Tauri keeps managed state by type, a second `Arc<AtomicBool>` would be ignored.
#[derive(Default, Clone)]
pub struct GameSeen(pub Arc<AtomicBool>);

/// Whether the game window is in front (only then the capture sends frames; the companion in front does
/// not count); changes go to the frontend as `game-front`. While it is not, the worker leaves its screen
/// and reads nothing. Always true on platforms without a capture (the test frames of `QM_OCR_FRAMES`).
#[derive(Clone)]
pub struct GameFront(pub Arc<AtomicBool>);

impl Default for GameFront {
    fn default() -> Self {
        Self(Arc::new(AtomicBool::new(!cfg!(windows))))
    }
}

pub const GAME_FRONT: &str = "game-front";

/// The worker's pull on the screens read every frame (warehouse, character inventory): when the capture
/// may grab the next frame (Unix ms; 0: off, the normal once a second). The worker sets it once a read
/// is done (now: a fresh frame for the next read, none grabbed while it reads), the capture grabs as
/// soon as the mouse cursor rests (sc-ohseearr's `REST`) and sets it PULL_TIMEOUT_MS ahead, in case no
/// read answers (the screen changed, the scan stopped).
#[derive(Default, Clone)]
pub struct FastCapture(pub Arc<AtomicU64>);
pub const GAME_SEEN: &str = "game-seen";

/// Whether the OCR can run on the GPU (sc-ohseearr's engine, DirectML): the redistributable DirectML.dll next
/// to the exe (the setup brings it; Windows' own is too old) and no failure in this run (then the OCR
/// goes on on the CPU). The settings grey their switch out otherwise (`gpu_status`, event `ocr-gpu`).
#[derive(Clone)]
pub struct Gpu(pub Arc<Mutex<GpuState>>);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum GpuState {
    Ready,
    Missing,
    Failed { error: String },
}

pub const OCR_GPU: &str = "ocr-gpu";

impl Gpu {
    pub fn new() -> Self {
        let dll = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.join("DirectML.dll")));
        let state = if cfg!(windows) && dll.is_some_and(|d| d.is_file()) { GpuState::Ready } else { GpuState::Missing };
        log::info!("OCR GPU: {state:?}");
        Self(Arc::new(Mutex::new(state)))
    }

    pub fn state(&self) -> GpuState {
        self.0.lock().unwrap().clone()
    }

    /// No GPU any more in this run.
    fn fail(&self, app: &AppHandle, error: String) {
        log::warn!("OCR GPU failed, on the CPU from now on: {error}");
        let state = GpuState::Failed { error };
        *self.0.lock().unwrap() = state.clone();
        let _ = app.emit(OCR_GPU, state);
    }
}

/// Starts the OCR worker; frames sent to the returned channel are read in order while a session runs.
pub fn spawn(app: AppHandle, detect: Detect, scan: Scan, debug: Debug, store: DebugStore, fast: FastCapture, front: GameFront, gpu: Gpu) -> Sender<Frame> {
    let (tx, rx) = channel::<Frame>();
    std::thread::spawn(move || Worker::new(app, detect, scan, debug, store, fast, front, gpu).run(rx));
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
            Ok(mut newer) => {
                // The older one dropped: counted with the newer
                newer.capture.add_unread(frame.capture);
                newer.capture.dropped += 1;
                frame = newer;
            }
            Err(_) => break,
        }
    }
    Ok(Some(frame))
}

struct Visit {
    last_frame: Instant,
}

/// The readers (sc-ohseearr's), each with what it keeps across frames: the warehouse reader its last
/// strong layout (the next read's prior: its area around the cursor, its pitch, its columns for ties; dropped when
/// the screen is left) and its layout detector, the character inventory reader its UI scale (from the last page
/// number read), the refinery reader its labels. Made anew when the scan stops: their memory goes, and the next
/// start may see the screens from elsewhere.
#[derive(Default)]
struct Readers {
    warehouse: WarehouseReader,
    gear: GearInventoryReader,
    refinery: RefineryReader,
}

/// The game's texts for the readers (`LocaleSource`: the language pack of the configured game folder, the English
/// table in the app's local data folder), None without either. That the refinery cannot be read then is logged
/// once per change (`missing`).
fn locale_of<'a>(source: &'a mut LocaleSource, app: &AppHandle, missing: &mut bool) -> Option<&'a Locale> {
    let game_dir = PathBuf::from(&app.state::<Mutex<crate::AppData>>().lock().unwrap().config.game_dir);
    let english = app.path().app_local_data_dir().ok().map(|d| d.join(ENGLISH_TABLE));
    match source.get(&game_dir, english.as_deref()) {
        Ok(locale) => {
            if std::mem::replace(missing, false) {
                log::info!("refinery readable again: the game's texts found");
            }
            Some(locale)
        }
        Err(e) => {
            if !std::mem::replace(missing, true) {
                let english = english.map_or("(no local data folder)".to_string(), |p| p.display().to_string());
                log::warn!("refinery not readable: {e} (language pack of {}, English table {english})", game_dir.display());
            }
            None
        }
    }
}

struct Worker {
    app: AppHandle,
    detect: Detect,
    scan: Scan,
    debug: Debug,
    /// While debugging, the reads go with their frame to the debug writer (`spawn_debug_writer`)
    debug_tx: SyncSender<(RgbImage, InventoryEvent)>,
    /// Set while the warehouse or the character inventory is in view: the worker pulls the frames
    fast: FastCapture,
    /// The game in front (else no frames come, and the screen is left)
    front: GameFront,
    /// The OCR (`ensure_ocr`), loaded once needed, on the GPU (`on_gpu`) or the CPU
    ocr: Option<Ocr>,
    gpu: Gpu,
    on_gpu: bool,
    gate: Gate,
    readers: Readers,
    /// The game's texts (`locale_of`), and whether the last look found none
    locale: LocaleSource,
    locale_missing: bool,
    /// The frame being read (`sc_ohseearr_sc::Frame::id`: a probe's work is kept for the read of the same frame)
    frame_id: u64,
    visit: Option<Visit>,
    /// Which screen the scan looks at, and how many reads in a row found nothing there
    screen: Screen,
    screen_misses: u32,
    /// When the scan last probed a frame for a screen (probing without a known screen is throttled)
    last_probe_ms: u64,
    /// The capture of the frame being read, and the counts of the frames not read since the last read
    capture: CaptureInfo,
    unread: CaptureInfo,
    /// The frame's conversion to RGB before the read (logged with the read's phases)
    rgb_time: Duration,
}

pub(crate) fn unix_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The name of the compiled-in models in the debug data (`OcrInfo::models`) and the log ("tiny": PP-OCRv6
/// tiny's detector, our recognizer).
const MODELS: &str = "tiny";

/// The OCR, loaded on first use.
fn ensure_ocr(slot: &mut Option<Ocr>, gpu: bool) -> Result<&mut Ocr, String> {
    if slot.is_none() {
        let started = Instant::now();
        *slot = Some(crate::ocr::load(OCR_THREADS, gpu).map_err(|e| format!("models: {e}"))?);
        log::info!("OCR Tiny loaded in {:?} on the {}", started.elapsed(), if gpu { "GPU" } else { "CPU" });
    }
    Ok(slot.as_mut().expect("loaded above"))
}

impl Worker {
    fn new(app: AppHandle, detect: Detect, scan: Scan, debug: Debug, store: DebugStore, fast: FastCapture, front: GameFront, gpu: Gpu) -> Self {
        let debug_tx = spawn_debug_writer(app.clone(), store);
        Self {
            app,
            detect,
            scan,
            debug,
            fast,
            front,
            debug_tx,
            ocr: None,
            gpu,
            on_gpu: false,
            gate: Gate::default(),
            readers: Readers::default(),
            locale: LocaleSource::default(),
            locale_missing: false,
            frame_id: 0,
            visit: None,
            screen: Screen::Unknown,
            screen_misses: 0,
            last_probe_ms: 0,
            capture: CaptureInfo::default(),
            unread: CaptureInfo::default(),
            rgb_time: Duration::ZERO,
        }
    }

    fn run(mut self, rx: Receiver<Frame>) {
        loop {
            // A second at most: the game leaving the front is noticed that soon
            let Ok(frame) = next_frame(&rx, Duration::from_secs(1)) else { return };
            if self.visit.as_ref().is_some_and(|v| v.last_frame.elapsed() > VISIT_GAP) {
                self.set_screen(Screen::Unknown, "no frames");
            }
            // Checked without a frame too: once off, the capture sends none
            if !self.detect.load(Ordering::Relaxed) {
                self.set_screen(Screen::Unknown, "scan stopped");
                // The next start may see the terminal from elsewhere: the readers start over (their memory,
                // the layout detector's, goes too), the game's texts are read again
                self.readers = Readers::default();
                self.locale = LocaleSource::default();
                // Off: the OCR's memory goes right away (the next start loads it again in well under a
                // second); while the scan runs it stays, read or not
                if self.ocr.take().is_some() {
                    log::info!("OCR unloaded (scan stopped)");
                }
                continue;
            }
            let Some(frame) = frame else {
                // The game not in front (the companion or another window is): the scan is idle, its screen
                // left, until the game is back
                if !self.front.0.load(Ordering::Relaxed) {
                    self.set_screen(Screen::Unknown, "game not in front");
                }
                continue;
            };
            let scope = self.scan.get();
            // A screen the filters left out is left (and not looked for again)
            if !scope.allows(self.screen) {
                self.set_screen(Screen::Unknown, "out of scope");
            }
            if let Some(v) = &mut self.visit {
                v.last_frame = Instant::now();
            }
            // Held back (refinery: not at rest; nothing in view: the probe throttle): counted with the next read
            let held = match self.screen {
                Screen::Refinery => frame.live && !self.gate.pass(frame.pixels.thumb(), frame.at_ms),
                Screen::Warehouse | Screen::Inventory => false,
                Screen::Unknown => frame.live && frame.at_ms.saturating_sub(self.last_probe_ms) < PROBE_MS,
            };
            if held {
                self.unread.add_unread(frame.capture);
                self.unread.gated += 1;
                continue;
            }
            self.capture = frame.capture;
            self.capture.add_unread(std::mem::take(&mut self.unread));
            self.capture.wait_ms = unix_ms(SystemTime::now()).saturating_sub(frame.at_ms);
            let converting = Instant::now();
            let image = frame.pixels.into_rgb();
            self.rgb_time = converting.elapsed();
            self.frame_id += 1;
            self.use_gpu();
            let result = match self.screen {
                // The terminal: once the view came to rest after it moved, and every REREAD_MS
                Screen::Refinery => self.look_refinery(frame.at_ms, frame.cursor, image),
                // Warehouse and character inventory: every frame (the character and the world behind
                // the translucent inventory screen never come to rest, and the user waits for each stack)
                Screen::Warehouse | Screen::Inventory => self.look_inventory(scope, frame.at_ms, frame.cursor, image),
                // Nothing in view (a menu, the verse): a probe costs the reads, so every PROBE_MS only
                Screen::Unknown => {
                    self.last_probe_ms = frame.at_ms;
                    self.probe(scope, frame.at_ms, frame.cursor, image)
                }
            };
            if let Err(e) = result {
                log::warn!("OCR: {e}");
                // On the GPU: the CPU from the next frame on (`use_gpu`)
                if self.on_gpu {
                    self.gpu.fail(&self.app, e);
                }
            }
        }
    }

    /// The models on the GPU or the CPU as the settings and the GPU's state say; on a switch they are
    /// loaded anew.
    fn use_gpu(&mut self) {
        let want = self.app.state::<Mutex<crate::AppData>>().lock().unwrap().config.gpu && self.gpu.state() == GpuState::Ready;
        if want != self.on_gpu {
            self.on_gpu = want;
            if self.ocr.take().is_some() {
                log::info!("OCR unloaded (now on the {})", if want { "GPU" } else { "CPU" });
            }
        }
    }

    /// The models' phases since the last call (for the log; empty when they did not run) and what ran.
    fn take_phases(&mut self) -> (String, OcrInfo) {
        let setting = self.app.state::<Mutex<crate::AppData>>().lock().unwrap().config.gpu;
        let mut info = OcrInfo { models: Vec::new(), gpu: self.on_gpu, setting, status: self.gpu.state(), ms: 0 };
        let Some(mut t) = self.ocr.as_mut().map(Ocr::take_timings) else { return (String::new(), info) };
        // The warehouse reader's layout detector counts as the detector's
        t += self.readers.warehouse.take_timings();
        if t.det_runs + t.rec_runs == 0 {
            return (String::new(), info);
        }
        info.models.push(MODELS);
        info.ms = t.total().as_millis() as u64;
        (format!("{MODELS}: {t}"), info)
    }

    /// Switches the screen: the refinery's starts or ends a visit; the frontend hears of every change.
    fn set_screen(&mut self, screen: Screen, why: &str) {
        if screen == self.screen {
            return;
        }
        let at_ms = unix_ms(SystemTime::now());
        if self.screen == Screen::Warehouse {
            // The next warehouse may be seen from elsewhere: its first read fits the whole pane again
            self.readers.warehouse.reset();
        }
        if self.screen == Screen::Refinery {
            self.visit = None;
            log::info!("refinery visit ended ({why})");
            let _ = self.app.emit(REFINERY_VISIT, VisitEvent { at_ms, active: false });
        }
        if screen == Screen::Refinery {
            self.visit = Some(Visit { last_frame: Instant::now() });
            log::info!("refinery visit started");
            let _ = self.app.emit(REFINERY_VISIT, VisitEvent { at_ms, active: true });
        }
        log::info!("scan screen {} ({why})", screen.name());
        self.screen = screen;
        self.screen_misses = 0;
        self.gate = Gate::default();
        // The screens read every frame pull them (`FastCapture`), the others take the normal interval
        let pull = matches!(screen, Screen::Warehouse | Screen::Inventory);
        self.fast.0.store(if pull { unix_ms(SystemTime::now()) } else { 0 }, Ordering::Relaxed);
        let _ = self.app.emit(SCAN_SCREEN, screen.name());
    }

    /// Looks for a screen in a frame: the refinery's big titles first (cheap; not without the game's
    /// texts), then the inventory's reads (the page number, else the warehouse grid; a frame with
    /// neither is tried as the character inventory too), each only when in scope.
    fn probe(&mut self, scope: Scope, at_ms: u64, cursor: Option<(f32, f32)>, image: RgbImage) -> Result<(), String> {
        if scope.refinery {
            let found = match locale_of(&mut self.locale, &self.app, &mut self.locale_missing) {
                Some(locale) => {
                    let ocr = ensure_ocr(&mut self.ocr, self.on_gpu)?;
                    let started = Instant::now();
                    let frame = sc_ohseearr_sc::Frame { id: self.frame_id, image: &image, cursor, locale: Some(locale) };
                    let found = self.readers.refinery.probe(ocr, &frame)?;
                    log::debug!("terminal check in {:?}: {found}", started.elapsed());
                    found
                }
                // Not readable (logged by `locale_of`)
                None => false,
            };
            if found {
                self.set_screen(Screen::Refinery, "titles seen");
                return self.look_refinery(at_ms, cursor, image);
            }
        }
        if scope.warehouse || scope.inventory {
            return self.look_inventory(scope, at_ms, cursor, image);
        }
        Ok(())
    }

    /// Reads a frame of the warehouse or the character inventory: the warehouse grid and its tooltip
    /// (every tile's badge only while debugging: the sightings need the hovered tile's), or the
    /// character inventory's tooltip, page and cursor cell. Which one is decided by `Screen` (see
    /// there): unknown, the cheap page read decides, else the grid read, and a frame with neither is
    /// tried as the inventory too; a screen out of `scope` is not read.
    fn look_inventory(&mut self, scope: Scope, at_ms: u64, cursor: Option<(f32, f32)>, image: RgbImage) -> Result<(), String> {
        let debug = self.debug.0.load(Ordering::Relaxed);
        let (width, height) = image.dimensions();
        // Only this read's phases (a probe's terminal check came before)
        self.take_phases();
        // For the names' loc keys (not used yet); the readers read without it too, and only the refinery's
        // paths log that it is missing
        let mut quiet = self.locale_missing;
        let locale = locale_of(&mut self.locale, &self.app, &mut quiet);
        let frame = sc_ohseearr_sc::Frame { id: self.frame_id, image: &image, cursor, locale };
        let started = Instant::now();
        let mut grid = None;
        let mut components = None;
        let mut boxes = Vec::new();
        let mut found = false;
        // Applied once the OCR is done (set_screen needs the whole worker)
        let mut screen = self.screen;
        let ocr = ensure_ocr(&mut self.ocr, self.on_gpu)?;
        let readers = &mut self.readers;
        if screen != Screen::Inventory {
            // Probing: the page number over every place it can have (a kept scale is not trusted yet; the
            // read below still starts from it)
            let page = screen == Screen::Unknown && scope.inventory && readers.gear.probe_with(ocr, &frame, false)?;
            if !page && scope.warehouse {
                // Every tile's badge only while debugging. A strong fit becomes the reader's prior: the next
                // reads look around the cursor, weaker fits keep its pitch
                readers.warehouse.set_diagnostics(debug);
                let (g, grid_boxes) = crate::inventory::to_legacy(readers.warehouse.read(ocr, &frame)?);
                boxes.extend(grid_boxes);
                if g.is_some() {
                    found = true;
                    screen = Screen::Warehouse;
                }
                grid = g;
            }
            if scope.inventory && (screen == Screen::Unknown || page) {
                // The page or nothing at all: try the character inventory (the probe's page read is reused;
                // the reader keeps the scale the page tells)
                let (read, gear_boxes) = crate::components::to_legacy(readers.gear.read(ocr, &frame)?);
                boxes.extend(gear_boxes);
                found = found || read.page.is_some() || read.tooltip.is_some();
                if page {
                    screen = Screen::Inventory;
                }
                components = Some(read);
            }
        } else {
            // The page number where the kept scale puts it (cheap), the rest
            let (read, gear_boxes) = crate::components::to_legacy(readers.gear.read(ocr, &frame)?);
            boxes.extend(gear_boxes);
            found = read.page.is_some() || read.tooltip.is_some();
            components = Some(read);
        }
        // A screen that shows nothing SCREEN_MISSES times in a row is left: the next frame probes again
        if found {
            self.screen_misses = 0;
        } else if screen != Screen::Unknown {
            self.screen_misses += 1;
            if self.screen_misses >= SCREEN_MISSES {
                screen = Screen::Unknown;
            }
        }
        let ms = started.elapsed().as_millis() as u64;
        // Where the read's time went: the models' phases, the rest is the reads' own work (crops and
        // their scaling, page, grid, hover)
        let (phases, ocr) = self.take_phases();
        log::debug!("read phases: rgb {} ms, {phases}, rest {} ms", self.rgb_time.as_millis(), ms.saturating_sub(ocr.ms));
        match (&grid, &components) {
            (Some(g), _) => {
                let tip = g.tooltip.as_ref().map_or("no tooltip".to_string(), |t| format!("tooltip {} Q{:?} {:?}", t.name, t.quality, t.scu));
                let hovered = g.tiles.iter().find(|t| t.hovered).map_or(String::new(), |t| format!(", hovered r{} c{} Q{:?} x{:?}", t.row, t.col, t.quality, t.count));
                log::info!("inventory read in {ms} ms: {}×{} tiles at pitch {:.0}×{:.0} (weight {}), cursor {:?}, {tip}{hovered}", g.cols.len(), g.rows.len(), g.pitch_x, g.pitch_y, g.fit_weight, cursor);
            }
            (None, Some(c)) if c.tooltip.is_some() || c.page.is_some() => {
                // The lines as read: what the frontend matches the stat names against
                let tip = c.tooltip.as_ref().map_or("no tooltip".to_string(), |t| format!("tooltip {:?} with {} lines: {}", t.title, t.lines.len(), t.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join(" | ")));
                log::info!("components read in {ms} ms: page {:?}, cursor {:?} in tile {:?}, {tip}", c.page.map(|p| (p.index, p.total)), cursor, c.cell.map(|x| (x.row, x.col, x.span, x.count)));
            }
            _ => log::debug!("no warehouse grid, no inventory tooltip ({ms} ms, screen {:?})", screen),
        }
        let event = InventoryEvent { at_ms, ms, width, height, grid, components, cursor, boxes, frame: None, refinery: None, capture: self.capture, ocr };
        // The scan gets the read right away; while debugging a copy goes to the debug writer
        if debug {
            self.to_debug(image, event.clone());
        }
        let _ = self.app.emit(INVENTORY_READ, event);
        self.set_screen(screen, if found { "seen" } else { "nothing seen" });
        // Still on a screen read every frame: the next one is grabbed as soon as the cursor rests
        if matches!(self.screen, Screen::Warehouse | Screen::Inventory) {
            self.fast.0.store(unix_ms(SystemTime::now()), Ordering::Relaxed);
        }
        Ok(())
    }

    /// Reads the refinery terminal's work order overview in a frame (the screen is the visit; a few
    /// reads in a row without the terminal leave it).
    fn look_refinery(&mut self, at_ms: u64, cursor: Option<(f32, f32)>, image: RgbImage) -> Result<(), String> {
        // Only this read's phases (a probe's terminal check came before)
        self.take_phases();
        let ocr = ensure_ocr(&mut self.ocr, self.on_gpu)?;
        let started = Instant::now();
        let read = match locale_of(&mut self.locale, &self.app, &mut self.locale_missing) {
            Some(locale) => {
                let frame = sc_ohseearr_sc::Frame { id: self.frame_id, image: &image, cursor, locale: Some(locale) };
                crate::refinery::to_legacy(self.readers.refinery.read(ocr, &frame)?.output)
            }
            // The game's texts went away during a visit (logged by `locale_of`): nothing can be read
            None => Read::Nothing,
        };
        let ms = started.elapsed().as_millis() as u64;
        // Read again every REREAD_MS, not only when the view moved
        self.gate.read(true);
        let debug = match read {
            Read::Overview(overview) => {
                self.screen_misses = 0;
                let orders: Vec<String> = overview.orders.iter().map(|o| format!("{:?} {} rows", o.status, o.rows.len())).collect();
                log::info!("refinery overview read in {ms} ms: {}", orders.join(", "));
                let debug = RefineryRead { kind: "overview", overview: Some(overview.clone()) };
                let _ = self.app.emit(REFINERY_OVERVIEW, OverviewEvent { at_ms, overview });
                debug
            }
            Read::Terminal => {
                self.screen_misses = 0;
                log::debug!("refinery terminal without work orders ({ms} ms)");
                RefineryRead { kind: "terminal", overview: None }
            }
            Read::Nothing => {
                self.screen_misses += 1;
                log::debug!("no refinery terminal ({ms} ms), {} in a row", self.screen_misses);
                RefineryRead { kind: "nothing", overview: None }
            }
        };
        // While debugging the read goes with its frame to the debug window and a recording
        if self.debug.0.load(Ordering::Relaxed) {
            let (width, height) = image.dimensions();
            let event = InventoryEvent { at_ms, ms, width, height, grid: None, components: None, cursor, boxes: Vec::new(), frame: None, refinery: Some(debug), capture: self.capture, ocr: self.take_phases().1 };
            self.to_debug(image, event);
        }
        if self.screen_misses >= LEAVE_AFTER {
            self.set_screen(Screen::Unknown, "left");
        }
        Ok(())
    }

    /// Hands a read with its frame to the debug writer, unless it is behind (`DEBUG_QUEUE`): then the
    /// read is left out of the debug view and a recording, never waited for.
    fn to_debug(&self, image: RgbImage, event: InventoryEvent) {
        if let Err(TrySendError::Full(_)) = self.debug_tx.try_send((image, event)) {
            log::debug!("debug writer behind: a read left out of the debug view and recording");
        }
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
                        if tx.send(Frame { at_ms, pixels: Pixels::Rgb(img.to_rgb8()), live: false, cursor: None, capture: CaptureInfo::default() }).is_err() {
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
