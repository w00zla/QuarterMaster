//! Text detection and recognition with PaddleOCR's PP-OCRv6 "tiny" models (PaddlePaddle's own ONNX,
//! Apache-2.0; multi-language with one dictionary of 6904 characters; the recognizer in git under
//! `resources/rec/`: cut to 318 Latin characters, `scripts/cut-rec.py`, and fine-tuned on the game's
//! font, `ocrtrain/`, docs/companion.md "OCR"; since 2026-10-31 for every
//! screen, PP-OCRv6 "small" read the warehouse before, PP-OCRv5 mobile/latin until 2026-10-18) on
//! ONNX Runtime. Pre- and post-processing follow RapidOCR (`rapidocr` 3.x) with tiny's own detector
//! input and thresholds (its inference.yml): the detector sees the image in BGR `/255` with the
//! ImageNet mean/std, its probability map is thresholded at 0.2, dilated, split into connected
//! regions (box score ≥ 0.4) and each region's box is grown by `area * 1.4 / perimeter` ("unclip");
//! the recognizer sees one text line at height 48 and is decoded greedily (CTC: blank first, the
//! dictionary, then a space). Tiny reads small texts (the warehouse's badges) only scaled up: the
//! readers scale their crops before the detector.
//!
//! Simplification: boxes are axis-aligned (the refinery terminal is read frontally), no rotated text.
//! The models are compiled into the app (the Windows release is a bare exe without resources); they
//! come from `scripts/fetch-ocr-models.mjs` (`resources/ocr/`, not in git), which every build needs once.
//!
//! Besides them the warehouse's own layout detector (`detect_layout`, since 2026-10-31): a NanoDet-Plus-m
//! trained on the warehouse's recordings (`companion/detector/`, `resources/layout/`, in git) that finds
//! the count badges, quality texts, the tooltip's title and its other lines as boxes of their kind in a
//! 480×320 image, in ~4 ms on the CPU where tiny's detector took ~75 ms for the same area.

use fast_image_resize::images::{Image, ImageRef};
pub use fast_image_resize::FilterType;
use fast_image_resize::{PixelType, ResizeAlg, ResizeOptions, Resizer};
use image::imageops;
use image::RgbImage;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::{Tensor, ValueType};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const DET_MIN_SIZE: f32 = 3.0;
const REC_HEIGHT: u32 = 48;
// The recognizer's nominal input width (RapidOCR's rec_img_shape); wider lines widen the input
const REC_WIDTH: u32 = 320;
// Text lines per recognizer run (RapidOCR's rec_batch_num): lines of similar shape go together
const REC_BATCH: usize = 6;

/// An axis-aligned box in image pixels (x1, y1 exclusive).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Rect {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl Rect {
    pub fn w(&self) -> f32 {
        self.x1 - self.x0
    }
    pub fn h(&self) -> f32 {
        self.y1 - self.y0
    }
    pub fn cx(&self) -> f32 {
        (self.x0 + self.x1) / 2.0
    }
    pub fn cy(&self) -> f32 {
        (self.y0 + self.y1) / 2.0
    }
}

/// A recognized text line.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TextBox {
    pub rect: Rect,
    pub text: String,
    pub score: f32,
}

pub struct Ocr {
    det: Engine,
    // The detector on the CPU in GPU mode (`detect_on_cpu`, inputs up to DET_CPU_MAX_HEIGHT), made on first use
    det_cpu: Option<Engine>,
    rec: Engine,
    // The layout detector, made on its first use (only the warehouse needs it)
    layout: Option<Engine>,
    threads: usize,
    on_gpu: bool,
    // Index 0 is the CTC blank
    chars: Vec<String>,
    spec: &'static Spec,
    timings: Timings,
}

/// What the layout detector finds (its classes, in the model's order).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LayoutKind {
    /// A tile's count badge, its light box ("X 14")
    Badge,
    /// A tile's quality text ("526Q")
    Quality,
    /// The tooltip's title (its first line)
    Title,
    /// Another line of the tooltip ("Capacity: 1.00mSCU", the chip's name and quality, "0.001 SCU")
    TipLine,
}

/// A box the layout detector found, with its score (0–1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Detection {
    pub kind: LayoutKind,
    pub score: f32,
    pub rect: Rect,
}

/// The layout detector: NanoDet-Plus-m (Apache-2.0, RangiLyu/nanodet) with our weights, a fixed input of
/// LAYOUT_W×LAYOUT_H in BGR with its training's mean/std (in 0–255: 103.53, 116.28, 123.675 /
/// 57.375, 57.12, 58.395), output per prior point the classes' scores (sigmoid) and per side a
/// distribution over LAYOUT_REG_MAX + 1 bins of the stride
const LAYOUT_MODEL: &[u8] = include_bytes!("../resources/layout/warehouse.onnx");
pub const LAYOUT_W: u32 = 480;
pub const LAYOUT_H: u32 = 320;
const LAYOUT_MEAN: [f32; 3] = [0.406, 0.456, 0.485];
const LAYOUT_STD: [f32; 3] = [0.225, 0.224, 0.229];
const LAYOUT_STRIDES: [u32; 4] = [8, 16, 32, 64];
const LAYOUT_REG_MAX: usize = 7;
const LAYOUT_KINDS: [LayoutKind; 4] = [LayoutKind::Badge, LayoutKind::Quality, LayoutKind::Title, LayoutKind::TipLine];
/// A box counts from this score; boxes of one kind overlapping more than LAYOUT_NMS (IoU) are one
const LAYOUT_SCORE: f32 = 0.35;
pub const LAYOUT_NMS: f32 = 0.5;

// Detector inputs up to this height run on the CPU in GPU mode too: ~1 ms each there, while each of
// their shapes held a DirectML session of its own (~13 MB VRAM each, 2026-10-31)
const DET_CPU_MAX_HEIGHT: u32 = 192;

// The recognizer's input widths on the GPU (lines padded to the next; wider ones get their own)
const REC_WIDTHS_GPU: [usize; 7] = [320, 480, 640, 960, 1280, 1920, 2560];

/// A model's ONNX Runtime sessions. On the CPU one for every input shape. On the GPU (DirectML, its
/// redistributable DirectML.dll next to the exe) one per input shape with its dimensions fixed:
/// DirectML compiles a session's graph for the first shape it runs, every other shape cost ~20 ms of
/// CPU per run (2026-10-27, RTX 5080); the detector's shapes are fixed per screen area and
/// resolution, the recognizer's batches are padded to REC_BATCH lines of a width in REC_WIDTHS_GPU.
/// A read then takes a few ms of CPU instead of hundreds.
enum Engine {
    Cpu(Session),
    Gpu { model: &'static [u8], symbols: Vec<String>, sessions: HashMap<Vec<usize>, Session> },
}

impl Engine {
    fn new(name: &str, model: &'static [u8], threads: usize, gpu: bool) -> Result<Self, String> {
        if !gpu {
            return Ok(Self::Cpu(session(name, model, threads, None)?));
        }
        // A first session tells whether DirectML works at all and the input's dimension names
        let probe = session(name, model, 1, Some(&[]))?;
        let symbols = match probe.inputs()[0].dtype() {
            ValueType::Tensor { dimension_symbols, .. } => dimension_symbols.to_vec(),
            other => return Err(format!("{name}: input {other:?}")),
        };
        Ok(Self::Gpu { model, symbols, sessions: HashMap::new() })
    }

    /// The session for an input of `shape`.
    fn session(&mut self, name: &str, shape: &[usize]) -> Result<&mut Session, String> {
        match self {
            Self::Cpu(s) => Ok(s),
            Self::Gpu { model, symbols, sessions } => {
                if !sessions.contains_key(shape) {
                    let started = Instant::now();
                    let dims: Vec<(String, i64)> = symbols.iter().zip(shape).filter(|(s, _)| !s.is_empty()).map(|(s, &v)| (s.clone(), v as i64)).collect();
                    sessions.insert(shape.to_vec(), session(name, model, 1, Some(&dims))?);
                    log::debug!("OCR {name} on the GPU for {shape:?} in {:?} ({} sessions)", started.elapsed(), sessions.len());
                }
                Ok(sessions.get_mut(shape).expect("inserted above"))
            }
        }
    }

    fn gpu(&self) -> bool {
        matches!(self, Self::Gpu { .. })
    }
}

/// One session on the CPU (`gpu` None) or on DirectML with these dimensions fixed.
fn session(name: &str, model: &[u8], threads: usize, gpu: Option<&[(String, i64)]>) -> Result<Session, String> {
    let e = |x: &dyn std::fmt::Display| format!("{name}: {x}");
    let mut b = Session::builder().map_err(|x| e(&x))?;
    b = b.with_optimization_level(GraphOptimizationLevel::Level3).map_err(|x| e(&x))?.with_intra_threads(threads).map_err(|x| e(&x))?;
    if let Some(dims) = gpu {
        #[cfg(not(windows))]
        return Err(format!("{name}: no GPU on this platform ({dims:?})"));
        // DirectML needs sequential runs without memory patterns (ONNX Runtime's documentation)
        #[cfg(windows)]
        {
            b = b.with_memory_pattern(false).map_err(|x| e(&x))?.with_parallel_execution(false).map_err(|x| e(&x))?;
            b = b.with_execution_providers([ort::ep::directml::DirectML::default().build().error_on_failure()]).map_err(|x| e(&x))?;
            for (symbol, size) in dims {
                b = b.with_dimension_override(symbol, *size).map_err(|x| e(&x))?;
            }
        }
    }
    b.commit_from_memory(model).map_err(|x| e(&x))
}

/// Where the OCR's time went since the last `take_timings`: per model the preparation (resize, crops,
/// input tensor), the model run and the post-processing (DB boxes, CTC decoding).
#[derive(Debug, Default, Clone, Copy)]
pub struct Timings {
    pub det_prep: Duration,
    pub det_run: Duration,
    pub det_post: Duration,
    pub det_runs: u32,
    pub rec_prep: Duration,
    pub rec_run: Duration,
    pub rec_post: Duration,
    pub rec_runs: u32,
    pub rec_lines: u32,
}

impl Timings {
    pub fn total(&self) -> Duration {
        self.det_prep + self.det_run + self.det_post + self.rec_prep + self.rec_run + self.rec_post
    }
}

impl std::fmt::Display for Timings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let ms = |d: Duration| d.as_millis();
        write!(
            f,
            "det {}+{}+{} ms ({} runs), rec {}+{}+{} ms ({} lines in {} runs)",
            ms(self.det_prep),
            ms(self.det_run),
            ms(self.det_post),
            self.det_runs,
            ms(self.rec_prep),
            ms(self.rec_run),
            ms(self.rec_post),
            self.rec_lines,
            self.rec_runs
        )
    }
}

/// The compiled-in PP-OCRv6 models (one tier since 2026-10-31; the enum stays for the log and the
/// debug data, "tiny").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    Tiny,
}

impl Model {
    fn spec(self) -> &'static Spec {
        match self {
            Self::Tiny => &TINY,
        }
    }
}

/// A model pair with its dictionary, the detector's input normalization (`(x/255 - mean) / std` per
/// channel, in B, G, R order as the models see it) and its DB thresholds.
struct Spec {
    det: &'static [u8],
    rec: &'static [u8],
    dict: &'static str,
    mean: [f32; 3],
    std: [f32; 3],
    thresh: f32,
    box_thresh: f32,
    unclip: f32,
}

// PaddleX applies the ImageNet mean/std (given in RGB) to the BGR image as it is
const TINY: Spec = Spec {
    det: include_bytes!("../resources/ocr/det-tiny.onnx"),
    rec: include_bytes!("../resources/rec/rec-tiny-latin.onnx"),
    dict: include_str!("../resources/rec/rec_dict-tiny-latin.txt"),
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    thresh: 0.2,
    box_thresh: 0.4,
    unclip: 1.4,
};

impl Ocr {
    /// The compiled-in models, on the CPU or the GPU (`Engine`; an error when DirectML does not work).
    /// `threads`: ONNX Runtime's intra-op threads on the CPU (the game runs at the same time, so few).
    /// ONNX Runtime's memory arena keeps the largest run's memory (without it the reads took 30 %
    /// longer): `ocrwatch` drops the whole `Ocr` when the scan stops.
    pub fn new(threads: usize, model: Model, gpu: bool) -> Result<Self, String> {
        let spec = model.spec();
        let mut chars = vec![String::new()];
        chars.extend(spec.dict.lines().map(|l| l.trim_end_matches('\r').to_string()));
        chars.push(" ".into());
        Ok(Self {
            det: Engine::new("det", spec.det, threads, gpu)?,
            det_cpu: None,
            rec: Engine::new("rec", spec.rec, threads, gpu)?,
            layout: None,
            threads,
            on_gpu: gpu,
            chars,
            spec,
            timings: Timings::default(),
        })
    }

    /// Whether it runs on the GPU.
    pub fn gpu(&self) -> bool {
        self.det.gpu()
    }

    /// The timings since the last call (and starts over).
    pub fn take_timings(&mut self) -> Timings {
        std::mem::take(&mut self.timings)
    }

    /// Text boxes in `img`, detected on a copy scaled down to at most `max_height` pixels high (never
    /// up), in `img`'s pixels, top to bottom. In GPU mode small inputs run on the CPU (DET_CPU_MAX_HEIGHT).
    pub fn detect(&mut self, img: &RgbImage, max_height: u32) -> Result<Vec<Rect>, String> {
        self.detect_in(img, max_height, false)
    }

    /// The same on the CPU in GPU mode too: for a large input read while no screen is known (the
    /// character inventory's page probe), whose DirectML session held ~150 (1080p) to ~315 MB
    /// (3840×1600) of VRAM for the whole scan; ~16 / ~43 ms on 3 threads (2026-10-31).
    pub fn detect_on_cpu(&mut self, img: &RgbImage, max_height: u32) -> Result<Vec<Rect>, String> {
        self.detect_in(img, max_height, true)
    }

    fn detect_in(&mut self, img: &RgbImage, max_height: u32, cpu: bool) -> Result<Vec<Rect>, String> {
        let started = Instant::now();
        let (w, h) = img.dimensions();
        let ratio = (max_height as f32 / h as f32).min(1.0);
        let round32 = |v: f32| (((v / 32.0).round() as u32) * 32).max(32);
        let (rw, rh) = (round32(w as f32 * ratio), round32(h as f32 * ratio));
        let resized = resize(img, rw, rh, FilterType::Bilinear);
        let input = Tensor::from_array(([1usize, 3, rh as usize, rw as usize], to_chw_bgr(&resized, rw, self.spec.mean, self.spec.std))).map_err(|e| e.to_string())?;
        let prepared = Instant::now();
        let det = if self.det.gpu() && (cpu || rh <= DET_CPU_MAX_HEIGHT) {
            if self.det_cpu.is_none() {
                self.det_cpu = Some(Engine::new("det", self.spec.det, self.threads, false)?);
            }
            self.det_cpu.as_mut().expect("made above")
        } else {
            &mut self.det
        };
        let outputs = det.session("det", &[1, 3, rh as usize, rw as usize])?.run(ort::inputs![input]).map_err(|e| e.to_string())?;
        let ran = Instant::now();
        self.timings.det_prep += prepared - started;
        self.timings.det_run += ran - prepared;
        self.timings.det_runs += 1;
        let (_, prob) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let mut boxes = db_boxes(prob, rw as usize, rh as usize, self.spec);
        let (sx, sy) = (w as f32 / rw as f32, h as f32 / rh as f32);
        for b in &mut boxes {
            *b = Rect {
                x0: (b.x0 * sx).clamp(0.0, w as f32),
                y0: (b.y0 * sy).clamp(0.0, h as f32),
                x1: (b.x1 * sx).clamp(0.0, w as f32),
                y1: (b.y1 * sy).clamp(0.0, h as f32),
            };
        }
        boxes.sort_by(|a, b| a.y0.total_cmp(&b.y0).then(a.x0.total_cmp(&b.x0)));
        self.timings.det_post += ran.elapsed();
        Ok(boxes)
    }

    /// The warehouse's badges, quality texts and tooltip lines in `img` (scaled to the detector's
    /// LAYOUT_W×LAYOUT_H; the callers crop to that aspect), in `img`'s pixels. Counted in the
    /// detector's timings.
    pub fn detect_layout(&mut self, img: &RgbImage) -> Result<Vec<Detection>, String> {
        let started = Instant::now();
        if self.layout.is_none() {
            self.layout = Some(Engine::new("layout", LAYOUT_MODEL, self.threads, self.on_gpu)?);
        }
        let (w, h) = img.dimensions();
        let resized = resize(img, LAYOUT_W, LAYOUT_H, FilterType::Bilinear);
        let shape = [1usize, 3, LAYOUT_H as usize, LAYOUT_W as usize];
        let input = Tensor::from_array((shape, to_chw_bgr(&resized, LAYOUT_W, LAYOUT_MEAN, LAYOUT_STD))).map_err(|e| e.to_string())?;
        let prepared = Instant::now();
        let outputs = self.layout.as_mut().expect("made above").session("layout", &shape)?.run(ort::inputs![input]).map_err(|e| e.to_string())?;
        let ran = Instant::now();
        self.timings.det_prep += prepared - started;
        self.timings.det_run += ran - prepared;
        self.timings.det_runs += 1;
        let (_, out) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let mut found = layout_boxes(out);
        let (sx, sy) = (w as f32 / LAYOUT_W as f32, h as f32 / LAYOUT_H as f32);
        for d in &mut found {
            let r = d.rect;
            d.rect = Rect { x0: (r.x0 * sx).clamp(0.0, w as f32), y0: (r.y0 * sy).clamp(0.0, h as f32), x1: (r.x1 * sx).clamp(0.0, w as f32), y1: (r.y1 * sy).clamp(0.0, h as f32) };
        }
        self.timings.det_post += ran.elapsed();
        Ok(found)
    }

    /// The text in `rect` of `img` as one line, with its mean character confidence.
    pub fn recognize(&mut self, img: &RgbImage, rect: Rect) -> Result<(String, f32), String> {
        Ok(self.recognize_all(img, &[rect])?.pop().expect("one line"))
    }

    /// The text of every rect (in their order), read in batches of lines of similar shape.
    pub fn recognize_all(&mut self, img: &RgbImage, rects: &[Rect]) -> Result<Vec<(String, f32)>, String> {
        let started = Instant::now();
        let crops: Vec<RgbImage> = rects.iter().map(|r| crop(img, *r)).collect();
        self.timings.rec_prep += started.elapsed();
        self.recognize_images(&crops)
    }

    /// The text of every image (one text line each, in their order), read in batches of lines of
    /// similar shape.
    pub fn recognize_images(&mut self, crops: &[RgbImage]) -> Result<Vec<(String, f32)>, String> {
        self.recognize_images_in(crops, None)
    }

    /// The same, picking only characters of `allowed` (a count badge: "Xx× 0123456789"): the
    /// recognizer otherwise takes a look-alike now and then (a thin "6" for "日" before the cut).
    pub fn recognize_images_only(&mut self, crops: &[RgbImage], allowed: &str) -> Result<Vec<(String, f32)>, String> {
        let mask: Vec<bool> = self.chars.iter().map(|c| c.chars().count() == 1 && c.chars().all(|ch| allowed.contains(ch))).collect();
        self.recognize_images_in(crops, Some(&mask))
    }

    fn recognize_images_in(&mut self, crops: &[RgbImage], allowed: Option<&[bool]>) -> Result<Vec<(String, f32)>, String> {
        let ratio = |c: &RgbImage| c.width() as f32 / c.height() as f32;
        // Similar widths in one batch: the narrow lines are padded less
        let mut order: Vec<usize> = (0..crops.len()).collect();
        order.sort_by(|&a, &b| ratio(&crops[a]).total_cmp(&ratio(&crops[b])));
        let mut out = vec![(String::new(), 0f32); crops.len()];
        for batch in order.chunks(REC_BATCH) {
            let started = Instant::now();
            let max_ratio = batch.iter().map(|&i| ratio(&crops[i])).fold(REC_WIDTH as f32 / REC_HEIGHT as f32, f32::max);
            let mut padded = (REC_HEIGHT as f32 * max_ratio) as u32;
            // On the GPU one of a few shapes (`Engine`): a full batch, the next of its widths
            let rows = if self.rec.gpu() {
                padded = REC_WIDTHS_GPU.into_iter().find(|&w| w >= padded as usize).map_or(padded, |w| w as u32);
                REC_BATCH
            } else {
                batch.len()
            };
            let plane = (REC_HEIGHT * padded) as usize;
            // Zero padding on the right, as RapidOCR does
            let mut data = vec![0f32; rows * 3 * plane];
            for (n, &i) in batch.iter().enumerate() {
                let c = &crops[i];
                let resized_w = ((REC_HEIGHT as f32 * ratio(c)).ceil() as u32).clamp(1, padded);
                let resized = resize(c, resized_w, REC_HEIGHT, FilterType::Bilinear);
                let base = n * 3 * plane;
                for (x, y, p) in resized.enumerate_pixels() {
                    let j = (y * padded + x) as usize;
                    for (ch, v) in [p[2], p[1], p[0]].into_iter().enumerate() {
                        data[base + ch * plane + j] = v as f32 / 127.5 - 1.0;
                    }
                }
            }
            let shape = [rows, 3, REC_HEIGHT as usize, padded as usize];
            let input = Tensor::from_array((shape, data)).map_err(|e| e.to_string())?;
            let prepared = Instant::now();
            let outputs = self.rec.session("rec", &shape)?.run(ort::inputs![input]).map_err(|e| e.to_string())?;
            let ran = Instant::now();
            self.timings.rec_prep += prepared - started;
            self.timings.rec_run += ran - prepared;
            self.timings.rec_runs += 1;
            self.timings.rec_lines += batch.len() as u32;
            let (shape, probs) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            let (steps, classes) = (shape[1] as usize, shape[2] as usize);
            if classes != self.chars.len() {
                return Err(format!("rec model has {classes} classes, the dictionary {}: wrong dictionary", self.chars.len()));
            }
            for (n, &i) in batch.iter().enumerate() {
                out[i] = ctc_decode(&probs[n * steps * classes..(n + 1) * steps * classes], steps, classes, &self.chars, allowed);
            }
            self.timings.rec_post += ran.elapsed();
        }
        Ok(out)
    }

    /// Detects and recognizes every text line (see `detect`).
    pub fn read(&mut self, img: &RgbImage, max_height: u32) -> Result<Vec<TextBox>, String> {
        let rects = self.detect(img, max_height)?;
        let texts = self.recognize_all(img, &rects)?;
        Ok(rects.into_iter().zip(texts).filter(|(_, (t, _))| !t.trim().is_empty()).map(|(rect, (text, score))| TextBox { rect, text, score }).collect())
    }
}

/// `img` scaled to `width`×`height` (at least one pixel each) with `filter`: SIMD (`fast_image_resize`),
/// the reads' largest cost besides the models with `image`'s resize (its Triangle is `Bilinear` here,
/// the same kernel; the detector needs that smoothing).
pub fn resize(img: &RgbImage, width: u32, height: u32, filter: FilterType) -> RgbImage {
    let src = ImageRef::new(img.width(), img.height(), img.as_raw(), PixelType::U8x3).expect("an RgbImage's buffer");
    let mut dst = Image::new(width, height, PixelType::U8x3);
    Resizer::new().resize(&src, &mut dst, &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(filter))).expect("one pixel type, no crop");
    RgbImage::from_raw(width, height, dst.into_vec()).expect("width × height × 3 bytes")
}

/// The part of `img` in `rect` (at least one pixel).
fn crop(img: &RgbImage, rect: Rect) -> RgbImage {
    let (w, h) = img.dimensions();
    let x0 = (rect.x0.floor().max(0.0) as u32).min(w.saturating_sub(1));
    let y0 = (rect.y0.floor().max(0.0) as u32).min(h.saturating_sub(1));
    let cw = ((rect.x1.ceil() as u32).min(w)).saturating_sub(x0).max(1);
    let ch = ((rect.y1.ceil() as u32).min(h)).saturating_sub(y0).max(1);
    imageops::crop_imm(img, x0, y0, cw, ch).to_image()
}

/// CHW planes in BGR order, normalized as `(x/255 - mean) / std` per channel (B, G, R).
fn to_chw_bgr(img: &RgbImage, width: u32, mean: [f32; 3], std: [f32; 3]) -> Vec<f32> {
    let plane = (img.height() * width) as usize;
    let mut data = vec![0f32; 3 * plane];
    let scale: [f32; 3] = std::array::from_fn(|c| 1.0 / (255.0 * std[c]));
    let offset: [f32; 3] = std::array::from_fn(|c| mean[c] / std[c]);
    for (x, y, p) in img.enumerate_pixels() {
        let i = (y * width + x) as usize;
        for (c, v) in [p[2], p[1], p[0]].into_iter().enumerate() {
            data[c * plane + i] = v as f32 * scale[c] - offset[c];
        }
    }
    data
}

/// The layout detector's boxes from its output (NanoDet-Plus: prior points of every stride, row by
/// row, each with its kinds' scores and per side a distribution over the bins), above LAYOUT_SCORE,
/// one box per overlapping group of a kind (the best scored), in input pixels.
fn layout_boxes(out: &[f32]) -> Vec<Detection> {
    let kinds = LAYOUT_KINDS.len();
    let bins = LAYOUT_REG_MAX + 1;
    let stride_of = kinds + 4 * bins;
    let mut found: Vec<Detection> = Vec::new();
    let mut i = 0;
    for s in LAYOUT_STRIDES {
        let (fw, fh) = (LAYOUT_W.div_ceil(s), LAYOUT_H.div_ceil(s));
        for y in 0..fh {
            for x in 0..fw {
                let p = &out[i * stride_of..(i + 1) * stride_of];
                i += 1;
                let (k, &score) = p[..kinds].iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).expect("kinds");
                if score < LAYOUT_SCORE {
                    continue;
                }
                // Each side's distance: the expectation of its bins (softmax), in strides
                let side = |n: usize| {
                    let d = &p[kinds + n * bins..kinds + (n + 1) * bins];
                    let max = d.iter().copied().fold(f32::MIN, f32::max);
                    let e: Vec<f32> = d.iter().map(|v| (v - max).exp()).collect();
                    let sum: f32 = e.iter().sum();
                    e.iter().enumerate().map(|(b, v)| b as f32 * v).sum::<f32>() / sum * s as f32
                };
                let (cx, cy) = ((x * s) as f32, (y * s) as f32);
                let rect = Rect { x0: cx - side(0), y0: cy - side(1), x1: cx + side(2), y1: cy + side(3) };
                found.push(Detection { kind: LAYOUT_KINDS[k], score, rect });
            }
        }
    }
    nms(found, LAYOUT_NMS)
}

/// Of boxes of one kind overlapping more than `limit` (IoU) only the best scored, best first.
pub fn nms(mut boxes: Vec<Detection>, limit: f32) -> Vec<Detection> {
    boxes.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for d in boxes {
        if !kept.iter().any(|k| k.kind == d.kind && iou(k.rect, d.rect) > limit) {
            kept.push(d);
        }
    }
    kept
}

fn iou(a: Rect, b: Rect) -> f32 {
    let w = (a.x1.min(b.x1) - a.x0.max(b.x0)).max(0.0);
    let h = (a.y1.min(b.y1) - a.y0.max(b.y0)).max(0.0);
    let i = w * h;
    i / (a.w() * a.h() + b.w() * b.h() - i).max(1e-6)
}

/// Boxes of the regions above the threshold in a `w`×`h` probability map (DB post-processing,
/// axis-aligned, the spec's thresholds), in map pixels.
fn db_boxes(prob: &[f32], w: usize, h: usize, spec: &Spec) -> Vec<Rect> {
    // Threshold, then dilate with a 2×2 kernel (as RapidOCR's use_dilation)
    let raw: Vec<bool> = prob.iter().map(|&p| p > spec.thresh).collect();
    let mut mask = raw.clone();
    for y in 0..h {
        for x in 0..w {
            if raw[y * w + x] {
                continue;
            }
            let left = x > 0 && raw[y * w + x - 1];
            let up = y > 0 && raw[(y - 1) * w + x];
            let diag = x > 0 && y > 0 && raw[(y - 1) * w + x - 1];
            mask[y * w + x] = left || up || diag;
        }
    }
    let mut seen = vec![false; w * h];
    let mut stack = Vec::new();
    let mut boxes = Vec::new();
    for start in 0..w * h {
        if !mask[start] || seen[start] {
            continue;
        }
        // One 8-connected region: its bounding box and the mean probability of its own pixels (not of
        // the box: a tilted line, as on a terminal in the world, fills its axis-aligned box only partly,
        // and the box's mean fell below the threshold for whole tooltips)
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        let (mut sum, mut count) = (0f32, 0usize);
        seen[start] = true;
        stack.push(start);
        while let Some(i) = stack.pop() {
            sum += prob[i];
            count += 1;
            let (x, y) = (i % w, i / w);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    let j = ny as usize * w + nx as usize;
                    if mask[j] && !seen[j] {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        let (bw, bh) = ((x1 - x0) as f32, (y1 - y0) as f32);
        if bw.min(bh) < DET_MIN_SIZE {
            continue;
        }
        if sum / (count as f32) < spec.box_thresh {
            continue;
        }
        let d = bw * bh * spec.unclip / (2.0 * (bw + bh));
        let r = Rect { x0: x0 as f32 - d, y0: y0 as f32 - d, x1: x1 as f32 + d + 1.0, y1: y1 as f32 + d + 1.0 };
        if r.w().min(r.h()) < DET_MIN_SIZE + 2.0 {
            continue;
        }
        boxes.push(r);
    }
    boxes
}

/// Greedy CTC decoding of `steps`×`classes` probabilities: the most likely class per step, repeats
/// and blanks dropped; the score is the mean probability of the kept characters.
/// `allowed`: only these classes (and the blank) can be picked, each step's probability taken among
/// them (a "6" the model rates just below a "日" is still a sure "6"); None = every class.
fn ctc_decode(probs: &[f32], steps: usize, classes: usize, chars: &[String], allowed: Option<&[bool]>) -> (String, f32) {
    let mut text = String::new();
    let mut scores = Vec::new();
    let mut last = 0usize;
    let ok = |i: usize| i == 0 || allowed.is_none_or(|a| a.get(i).copied().unwrap_or(false));
    for t in 0..steps {
        let row = &probs[t * classes..(t + 1) * classes];
        let (best, p) = row.iter().enumerate().filter(|&(i, _)| ok(i)).fold((0, f32::MIN), |acc, (i, &v)| if v > acc.1 { (i, v) } else { acc });
        let p = match allowed {
            Some(_) => {
                let mass: f32 = row.iter().enumerate().filter(|&(i, _)| ok(i)).map(|(_, &v)| v).sum();
                if mass > 0.0 { p / mass } else { 0.0 }
            }
            None => p,
        };
        if best != 0 && best != last {
            if let Some(c) = chars.get(best) {
                text.push_str(c);
                scores.push(p);
            }
        }
        last = best;
    }
    let score = if scores.is_empty() { 0.0 } else { scores.iter().sum::<f32>() / scores.len() as f32 };
    (text, score)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctc_drops_blanks_and_repeats() {
        let chars: Vec<String> = ["", "a", "b"].iter().map(|s| s.to_string()).collect();
        // a a _ a b b _
        let seq = [1, 1, 0, 1, 2, 2, 0];
        let mut probs = vec![0f32; seq.len() * 3];
        for (t, &c) in seq.iter().enumerate() {
            probs[t * 3 + c] = 0.9;
        }
        assert_eq!(ctc_decode(&probs, seq.len(), 3, &chars, None).0, "aab");
    }

    #[test]
    fn ctc_picks_only_allowed_characters() {
        let chars: Vec<String> = ["", "X", "6", "日"].iter().map(|s| s.to_string()).collect();
        // X, then a step the model rates 日 0.6, 6 0.3, blank 0.1
        let probs = [0.0, 0.9, 0.05, 0.05, 0.1, 0.0, 0.3, 0.6];
        assert_eq!(ctc_decode(&probs, 2, 4, &chars, None).0, "X日");
        let allowed = [true, true, true, false];
        let (text, score) = ctc_decode(&probs, 2, 4, &chars, Some(&allowed));
        assert_eq!(text, "X6");
        // 6 among the allowed: 0.3 / (0.1 + 0.3)
        assert!(score > 0.8, "{score}");
    }

    #[test]
    fn db_finds_separate_regions() {
        let (w, h) = (40, 20);
        let mut prob = vec![0f32; w * h];
        for y in 5..12 {
            for x in 2..15 {
                prob[y * w + x] = 0.9;
            }
            for x in 25..38 {
                prob[y * w + x] = 0.9;
            }
        }
        let boxes = db_boxes(&prob, w, h, &TINY);
        assert_eq!(boxes.len(), 2);
        assert!(boxes.iter().all(|b| b.y0 < 5.0 && b.y1 > 12.0));
    }

    #[test]
    fn layout_boxes_from_prior_points() {
        let per = LAYOUT_KINDS.len() + 4 * (LAYOUT_REG_MAX + 1);
        let points: u32 = LAYOUT_STRIDES.iter().map(|s| LAYOUT_W.div_ceil(*s) * LAYOUT_H.div_ceil(*s)).sum();
        let mut out = vec![0f32; points as usize * per];
        // A quality text at the stride-8 point (10, 5), every side 2 bins (16 px) away, and a weaker
        // neighbour on almost the same box; a badge somewhere else below the score
        let mut set = |point: usize, kind: usize, score: f32, bins: [usize; 4]| {
            let p = &mut out[point * per..(point + 1) * per];
            p[kind] = score;
            for (side, b) in bins.into_iter().enumerate() {
                p[LAYOUT_KINDS.len() + side * (LAYOUT_REG_MAX + 1) + b] = 20.0;
            }
        };
        let fw = LAYOUT_W.div_ceil(8) as usize;
        set(5 * fw + 10, 1, 0.9, [2, 2, 2, 2]);
        set(5 * fw + 11, 1, 0.6, [3, 2, 1, 2]);
        set(9 * fw + 30, 0, 0.2, [1, 1, 1, 1]);
        let found = layout_boxes(&out);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].kind, LayoutKind::Quality);
        let r = found[0].rect;
        assert!((r.x0 - 64.0).abs() < 0.1 && (r.y0 - 24.0).abs() < 0.1 && (r.x1 - 96.0).abs() < 0.1 && (r.y1 - 56.0).abs() < 0.1, "{r:?}");
    }
}
