//! The OCR comes from sc-ohseearr (`../sc-ohseearr`, a sibling checkout, path dependency): its engine
//! (`sc-ohseearr-core`) with the model packages `paddle-det-tiny` (PP-OCRv6 tiny detector), `sc-rec-latin` (our
//! recognizer: cut to Latin, fine-tuned on the game's font; trained here, `ocrtrain/`) and
//! `sc-warehouse-layout` (our NanoDet layout detector; trained here, `detector/`), all compiled in (the Windows
//! release is a bare exe). docs/companion.md "OCR".
//!
//! This module keeps the companion's own interface on top of it until the readers move to sc-ohseearr: one `Ocr`
//! holding the detector, the recognizer and the warehouse's layout detector (made on its first use: only the
//! warehouse needs it), with shared timings, and the layout's classes as `LayoutKind`.

use std::ops::{Deref, DerefMut};

use image::RgbImage;
use sc_ohseearr_core as core;
pub use sc_ohseearr_core::{resize, FilterType, Rect, TextBox, Timings};

/// The layout detector's input size (its manifest's; the callers crop to that aspect) and the IoU above which
/// boxes of one kind are one.
pub const LAYOUT_W: u32 = 480;
pub const LAYOUT_H: u32 = 320;
pub const LAYOUT_NMS: f32 = 0.5;

/// What the layout detector finds (its classes).
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

const KINDS: [(LayoutKind, &str); 4] = [(LayoutKind::Badge, "badge"), (LayoutKind::Quality, "quality"), (LayoutKind::Title, "title"), (LayoutKind::TipLine, "tipline")];

impl LayoutKind {
    fn index(self) -> usize {
        KINDS.iter().position(|(k, _)| *k == self).expect("every kind is listed")
    }
}

/// A box the layout detector found, with its score (0–1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Detection {
    pub kind: LayoutKind,
    pub score: f32,
    pub rect: Rect,
}

/// Of boxes of one kind overlapping more than `limit` (IoU) only the best scored, best first.
pub fn nms(boxes: Vec<Detection>, limit: f32) -> Vec<Detection> {
    let plain = boxes.iter().map(|d| core::Detection { class: d.kind.index(), score: d.score, rect: d.rect }).collect();
    core::nms(plain, limit).into_iter().map(|d| Detection { kind: KINDS[d.class].0, score: d.score, rect: d.rect }).collect()
}

/// The compiled-in models (one tier since 2026-10-31; the enum stays for the log and the debug data, "tiny").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    Tiny,
}

pub struct Ocr {
    ocr: core::Ocr,
    // The layout detector with its classes as kinds, made on its first use
    layout: Option<(core::NanoDet, Vec<LayoutKind>)>,
    threads: usize,
    on_gpu: bool,
}

impl Ocr {
    /// The compiled-in models, on the CPU or the GPU (an error when DirectML does not work). `threads`: ONNX
    /// Runtime's intra-op threads on the CPU (the game runs at the same time, so few). ONNX Runtime's memory
    /// arena keeps the largest run's memory (without it the reads took 30 % longer): `ocrwatch` drops the whole
    /// `Ocr` when the scan stops.
    pub fn new(threads: usize, model: Model, gpu: bool) -> Result<Self, String> {
        let Model::Tiny = model;
        let ocr = core::Ocr::new(&sc_ohseearr_model_paddle_det_tiny::package(), &sc_ohseearr_model_sc_rec_latin::package(), threads, gpu)?;
        Ok(Self { ocr, layout: None, threads, on_gpu: gpu })
    }

    /// The timings since the last call (and starts over); the layout detector's count as the detector's.
    pub fn take_timings(&mut self) -> Timings {
        let mut t = self.ocr.take_timings();
        if let Some((layout, _)) = &mut self.layout {
            t += layout.take_timings();
        }
        t
    }

    /// The warehouse's badges, quality texts and tooltip lines in `img` (scaled to the detector's
    /// LAYOUT_W×LAYOUT_H; the callers crop to that aspect), in `img`'s pixels.
    pub fn detect_layout(&mut self, img: &RgbImage) -> Result<Vec<Detection>, String> {
        if self.layout.is_none() {
            let detector = core::NanoDet::new(&sc_ohseearr_model_sc_warehouse_layout::package(), self.threads, self.on_gpu)?;
            if detector.input_size() != (LAYOUT_W, LAYOUT_H) || detector.nms_limit() != LAYOUT_NMS {
                return Err(format!("layout model: input {:?}, NMS {}, expected ({LAYOUT_W}, {LAYOUT_H}), {LAYOUT_NMS}", detector.input_size(), detector.nms_limit()));
            }
            let kinds = detector.classes().iter().map(|c| KINDS.iter().find(|(_, name)| name == c).map(|(k, _)| *k).ok_or_else(|| format!("layout model: unknown class {c}"))).collect::<Result<_, _>>()?;
            self.layout = Some((detector, kinds));
        }
        let (detector, kinds) = self.layout.as_mut().expect("made above");
        Ok(detector.detect(img)?.into_iter().map(|d| Detection { kind: kinds[d.class], score: d.score, rect: d.rect }).collect())
    }
}

/// The detector and the recognizer (`detect`, `detect_on_cpu`, `recognize*`, `read`, `gpu`).
impl Deref for Ocr {
    type Target = core::Ocr;
    fn deref(&self) -> &core::Ocr {
        &self.ocr
    }
}

impl DerefMut for Ocr {
    fn deref_mut(&mut self) -> &mut core::Ocr {
        &mut self.ocr
    }
}
