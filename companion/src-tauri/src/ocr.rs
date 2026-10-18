//! Text detection and recognition with PaddleOCR's PP-OCRv6 "small" models (ONNX, Apache-2.0, as
//! converted by RapidOCR; multi-language with one dictionary of 18708 characters, since 2026-10-18,
//! PP-OCRv5 mobile/latin before) on ONNX Runtime. Pre- and post-processing follow RapidOCR
//! (`rapidocr` 3.x, the same for v5 and v6): the detector
//! sees the image in BGR scaled to `(x/255 - 0.5) / 0.5`, its probability map is thresholded at 0.3,
//! dilated, split into connected regions (box score ≥ 0.5) and each region's box is grown by
//! `area * 1.6 / perimeter` ("unclip"); the recognizer sees one text line at height 48 and is
//! decoded greedily (CTC: blank first, the dictionary, then a space).
//!
//! Simplification: boxes are axis-aligned (the refinery terminal is read frontally), no rotated text.
//! The models are compiled into the app (the Windows release is a bare exe without resources); they
//! come from `scripts/fetch-ocr-models.mjs` (`resources/ocr/`, not in git), which every build needs once.

use image::imageops::{self, FilterType};
use image::RgbImage;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;

const DET_THRESH: f32 = 0.3;
const DET_BOX_THRESH: f32 = 0.5;
const DET_UNCLIP: f32 = 1.6;
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
    det: Session,
    rec: Session,
    // Index 0 is the CTC blank
    chars: Vec<String>,
}

const DET_MODEL: &[u8] = include_bytes!("../resources/ocr/det.onnx");
const REC_MODEL: &[u8] = include_bytes!("../resources/ocr/rec.onnx");
const REC_DICT: &str = include_str!("../resources/ocr/rec_dict.txt");

impl Ocr {
    /// The compiled-in models. `threads`: ONNX Runtime's intra-op threads (the game runs at the same
    /// time, so few). ONNX Runtime's memory arena keeps the largest run's memory (without it the reads
    /// took 30 % longer): `ocrwatch` drops the whole `Ocr` when no panel was seen for a while.
    pub fn new(threads: usize) -> Result<Self, String> {
        let session = |name: &str, model: &[u8]| -> Result<Session, String> {
            Session::builder()
                .map_err(|e| e.to_string())?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| e.to_string())?
                .with_intra_threads(threads)
                .map_err(|e| e.to_string())?
                .commit_from_memory(model)
                .map_err(|e| format!("{name}: {e}"))
        };
        let mut chars = vec![String::new()];
        chars.extend(REC_DICT.lines().map(|l| l.trim_end_matches('\r').to_string()));
        chars.push(" ".into());
        Ok(Self { det: session("det", DET_MODEL)?, rec: session("rec", REC_MODEL)?, chars })
    }

    /// Text boxes in `img`, detected on a copy scaled down to at most `max_height` pixels high (never
    /// up), in `img`'s pixels, top to bottom.
    pub fn detect(&mut self, img: &RgbImage, max_height: u32) -> Result<Vec<Rect>, String> {
        let (w, h) = img.dimensions();
        let ratio = (max_height as f32 / h as f32).min(1.0);
        let round32 = |v: f32| (((v / 32.0).round() as u32) * 32).max(32);
        let (rw, rh) = (round32(w as f32 * ratio), round32(h as f32 * ratio));
        let resized = imageops::resize(img, rw, rh, FilterType::Triangle);
        let input = Tensor::from_array(([1usize, 3, rh as usize, rw as usize], to_chw_bgr(&resized, rw))).map_err(|e| e.to_string())?;
        let outputs = self.det.run(ort::inputs![input]).map_err(|e| e.to_string())?;
        let (_, prob) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let mut boxes = db_boxes(prob, rw as usize, rh as usize);
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
        Ok(boxes)
    }

    /// The text in `rect` of `img` as one line, with its mean character confidence.
    pub fn recognize(&mut self, img: &RgbImage, rect: Rect) -> Result<(String, f32), String> {
        Ok(self.recognize_all(img, &[rect])?.pop().expect("one line"))
    }

    /// The text of every rect (in their order), read in batches of lines of similar shape.
    pub fn recognize_all(&mut self, img: &RgbImage, rects: &[Rect]) -> Result<Vec<(String, f32)>, String> {
        let crops: Vec<RgbImage> = rects.iter().map(|r| crop(img, *r)).collect();
        self.recognize_images(&crops)
    }

    /// The text of every image (one text line each, in their order), read in batches of lines of
    /// similar shape.
    pub fn recognize_images(&mut self, crops: &[RgbImage]) -> Result<Vec<(String, f32)>, String> {
        self.recognize_images_in(crops, None)
    }

    /// The same, picking only characters of `allowed` (a count badge: "Xx× 0123456789"): the
    /// multi-language recognizer otherwise takes a thin "6" for "日" now and then.
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
            let max_ratio = batch.iter().map(|&i| ratio(&crops[i])).fold(REC_WIDTH as f32 / REC_HEIGHT as f32, f32::max);
            let padded = (REC_HEIGHT as f32 * max_ratio) as u32;
            let plane = (REC_HEIGHT * padded) as usize;
            // Zero padding on the right, as RapidOCR does
            let mut data = vec![0f32; batch.len() * 3 * plane];
            for (n, &i) in batch.iter().enumerate() {
                let c = &crops[i];
                let resized_w = ((REC_HEIGHT as f32 * ratio(c)).ceil() as u32).clamp(1, padded);
                let resized = imageops::resize(c, resized_w, REC_HEIGHT, FilterType::Triangle);
                let base = n * 3 * plane;
                for (x, y, p) in resized.enumerate_pixels() {
                    let j = (y * padded + x) as usize;
                    for (ch, v) in [p[2], p[1], p[0]].into_iter().enumerate() {
                        data[base + ch * plane + j] = v as f32 / 127.5 - 1.0;
                    }
                }
            }
            let input = Tensor::from_array(([batch.len(), 3, REC_HEIGHT as usize, padded as usize], data)).map_err(|e| e.to_string())?;
            let outputs = self.rec.run(ort::inputs![input]).map_err(|e| e.to_string())?;
            let (shape, probs) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            let (steps, classes) = (shape[1] as usize, shape[2] as usize);
            if classes != self.chars.len() {
                return Err(format!("rec model has {classes} classes, the dictionary {}: wrong dictionary", self.chars.len()));
            }
            for (n, &i) in batch.iter().enumerate() {
                out[i] = ctc_decode(&probs[n * steps * classes..(n + 1) * steps * classes], steps, classes, &self.chars, allowed);
            }
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

/// The part of `img` in `rect` (at least one pixel).
fn crop(img: &RgbImage, rect: Rect) -> RgbImage {
    let (w, h) = img.dimensions();
    let x0 = (rect.x0.floor().max(0.0) as u32).min(w.saturating_sub(1));
    let y0 = (rect.y0.floor().max(0.0) as u32).min(h.saturating_sub(1));
    let cw = ((rect.x1.ceil() as u32).min(w)).saturating_sub(x0).max(1);
    let ch = ((rect.y1.ceil() as u32).min(h)).saturating_sub(y0).max(1);
    imageops::crop_imm(img, x0, y0, cw, ch).to_image()
}

/// CHW planes in BGR order, scaled to [-1, 1].
fn to_chw_bgr(img: &RgbImage, width: u32) -> Vec<f32> {
    let plane = (img.height() * width) as usize;
    let mut data = vec![0f32; 3 * plane];
    for (x, y, p) in img.enumerate_pixels() {
        let i = (y * width + x) as usize;
        data[i] = p[2] as f32 / 127.5 - 1.0;
        data[plane + i] = p[1] as f32 / 127.5 - 1.0;
        data[2 * plane + i] = p[0] as f32 / 127.5 - 1.0;
    }
    data
}

/// Boxes of the regions above the threshold in a `w`×`h` probability map (DB post-processing,
/// axis-aligned), in map pixels.
fn db_boxes(prob: &[f32], w: usize, h: usize) -> Vec<Rect> {
    // Threshold, then dilate with a 2×2 kernel (as RapidOCR's use_dilation)
    let raw: Vec<bool> = prob.iter().map(|&p| p > DET_THRESH).collect();
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
        // One 8-connected region: its bounding box and mean probability
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        seen[start] = true;
        stack.push(start);
        while let Some(i) = stack.pop() {
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
        let mut sum = 0f32;
        for y in y0..=y1 {
            sum += prob[y * w + x0..=y * w + x1].iter().sum::<f32>();
        }
        if sum / (((x1 - x0 + 1) * (y1 - y0 + 1)) as f32) < DET_BOX_THRESH {
            continue;
        }
        let d = bw * bh * DET_UNCLIP / (2.0 * (bw + bh));
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
        let boxes = db_boxes(&prob, w, h);
        assert_eq!(boxes.len(), 2);
        assert!(boxes.iter().all(|b| b.y0 < 5.0 && b.y1 > 12.0));
    }
}
