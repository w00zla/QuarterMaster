//! Reads the freight manager's warehouse (freight elevator terminal, SC 4.x; screenshots and live
//! frames of 2026-10-18): a grid of 4 columns of tiles, scrolled without pages. Every tile has a
//! count badge top right ("X1", "X14") and an info icon top left; a material tile shows its quality
//! bottom left ("572Q", the Q dim); the icons look alike, so the name comes from the tooltip of the
//! hovered tile, which opens at the cursor, inside that tile: the title, for materials also
//! "Capacity: 1.00SCU", the chip "<name>" "<quality>" and the stack's amount in SCU; items show the
//! title only (and lines like "Registered To You").
//!
//! The terminal is a screen in the world: the grid's size and spacing change with where the player
//! stands (column pitch 260–290 px at 1600 px frame height, rows a little tighter), so nothing is
//! fixed on the screen. The grid is fitted per frame: the detected badge boxes and quality texts are
//! anchors, each implying its tile's corner for a given pitch; the pitch and phase with the most
//! agreeing anchors win (per axis), and the four consecutive columns with the most anchors are the
//! warehouse's. Each tile's badge (upscaled) and quality band are then recognized on their own (the
//! detector merges and misses small texts). The hovered tile is the one under the tooltip's cursor
//! point (a little up and left of the title). Only the pane right of the screen centre is read; the
//! elevator pane on the left is ignored.
//!
//! Anything unexpected yields fewer tiles or `None` fields, never a panic.

use image::imageops::{self, FilterType};
use image::RgbImage;
use serde::Serialize;

use crate::locale::norm;
use crate::ocr::{Ocr, Rect, TextBox};

/// The warehouse pane lies right of this share of the frame's width
const PANE_LEFT: f32 = 0.45;
/// The grid lies within these shares of the frame's height (the filter row and "LOCATION" above,
/// the button bar below)
const GRID_TOP: f32 = 0.3;
const GRID_BOTTOM: f32 = 0.84;
/// Height of a badge or quality text (shares of the frame height)
const TEXT_MIN_H: f32 = 0.012;
const TEXT_MAX_H: f32 = 0.032;
/// Badge boxes at most this wide
const BADGE_MAX_W: f32 = 0.06;
/// Pitch candidates (shares of the frame height) and the step between them
const PITCH_MIN: f32 = 0.13;
const PITCH_MAX: f32 = 0.20;
const PITCH_STEP: f32 = 0.0015;
/// Anchors within this share of the pitch agree on a phase
const PHASE_TOL: f32 = 0.05;
/// Agreeing anchor weight a fit needs (badge 1, quality text 2), and the weight from which a fit is
/// strong enough to set the pitch on its own; a weaker fit keeps the pitch of the last strong one
/// (`hint`: the terminal does not move while the player stands) and fits only the phase
const MIN_FIT_WEIGHT: u32 = 3;
pub const STRONG_FIT_WEIGHT: u32 = 6;
/// Rows are a little tighter than columns (the terminal is seen from above): the row pitch as a
/// share of the column pitch
const ROW_RATIO: (f32, f32) = (0.85, 1.05);
/// Columns of the warehouse grid
const COLUMNS: usize = 4;
/// Tile geometry as shares of the pitch: the tile's size, and where its texts sit (the badge's right
/// edge and top, the quality text's left edge and bottom) relative to the tile's top left
const TILE_SIZE: f32 = 0.93;
const BADGE_RIGHT: f32 = 0.89;
const BADGE_TOP: f32 = 0.03;
const QUALITY_LEFT: f32 = 0.02;
const QUALITY_BOTTOM: f32 = 0.92;
/// The quality band at the tile's bottom left and the badge area at its top right, as shares of the
/// tile (reaching into the gaps around it: the fitted edges are a few pixels off)
const QUALITY_BAND: (f32, f32, f32, f32) = (-0.08, 0.76, 0.55, 1.02);
const BADGE_AREA: (f32, f32, f32, f32) = (0.66, -0.02, 1.06, 0.19);
/// The badge crops are upscaled by this before recognition (small text in a dark box)
const BADGE_SCALE: u32 = 3;
/// Padding around a detected badge box when it is read on its own
const BADGE_PAD: f32 = 6.0;
/// Minimum recognizer confidence of a cell's text
const MIN_SCORE: f32 = 0.5;
/// The tooltip opens right below the cursor: the cursor is about this far up and left of its title
const CURSOR_OFFSET: f32 = 0.01;
/// A quality band covered by the tooltip beyond this share is not read
const TOOLTIP_COVER: f32 = 0.2;

/// One tile as a frame shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    /// The whole tile in frame pixels
    pub rect: Rect,
    /// Grid column (0 = leftmost) and row (0 = topmost in this frame; the scroll offset is unknown)
    pub col: u32,
    pub row: u32,
    /// None: no quality text (an item, or the text hidden or cut off)
    pub quality: Option<u32>,
    /// `true` when the OCR text could also be read as another quality ("1000" = 100Q or 1000)
    pub quality_ambiguous: bool,
    /// The badge's count; None when the badge could not be read
    pub count: Option<u32>,
    /// The badge read "X" without digits (taken as 1)
    pub count_uncertain: bool,
    /// Whether this is the hovered tile the tooltip belongs to
    pub hovered: bool,
    pub quality_text: String,
    pub badge_text: String,
}

/// The tooltip of the hovered tile.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tooltip {
    /// The title (the item's name)
    pub name: String,
    /// The chip's quality (materials)
    pub quality: Option<u32>,
    /// The stack's amount in SCU (materials in SCU; "0.001" for one piece of an item material)
    pub scu: Option<String>,
    /// The title's top left corner in frame pixels
    pub x: f32,
    pub y: f32,
    /// The area its texts cover
    pub rect: Rect,
}

/// What a tile's sub-area read (for the debug view).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub row: u32,
    pub col: u32,
    /// "badge" or "quality"
    pub kind: &'static str,
    pub rect: Rect,
    pub text: String,
    pub score: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grid {
    pub tiles: Vec<Tile>,
    pub tooltip: Option<Tooltip>,
    pub cells: Vec<Cell>,
    /// The tiles' left edges per column and tops per row, the pitch, the fit's weight
    pub cols: Vec<f32>,
    pub rows: Vec<f32>,
    pub pitch_x: f32,
    pub pitch_y: f32,
    pub fit_weight: u32,
}

/// Where the grid's tiles are in a frame.
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    /// The tiles' left edges, left to right
    pub cols: Vec<f32>,
    /// The tiles' tops, top to bottom
    pub rows: Vec<f32>,
    pub pitch_x: f32,
    pub pitch_y: f32,
    /// The weaker axis' agreeing anchor weight (≥ `STRONG_FIT_WEIGHT`: trust the pitch)
    pub weight: u32,
}

impl Layout {
    pub fn tile_rect(&self, row: usize, col: usize) -> Rect {
        let (x0, y0) = (self.cols[col], self.rows[row]);
        Rect { x0, y0, x1: x0 + TILE_SIZE * self.pitch_x, y1: y0 + TILE_SIZE * self.pitch_y }
    }
}

fn part(tile: Rect, (fx0, fy0, fx1, fy1): (f32, f32, f32, f32)) -> Rect {
    Rect { x0: tile.x0 + fx0 * tile.w(), y0: tile.y0 + fy0 * tile.h(), x1: tile.x0 + fx1 * tile.w(), y1: tile.y0 + fy1 * tile.h() }
}

fn contains(r: Rect, x: f32, y: f32) -> bool {
    x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1
}

/// The share of `b` that `a` covers.
fn covered(a: Rect, b: Rect) -> f32 {
    let w = (a.x1.min(b.x1) - a.x0.max(b.x0)).max(0.0);
    let h = (a.y1.min(b.y1) - a.y0.max(b.y0)).max(0.0);
    w * h / (b.w() * b.h()).max(1.0)
}

fn union(a: Rect, b: Rect) -> Rect {
    Rect { x0: a.x0.min(b.x0), y0: a.y0.min(b.y0), x1: a.x1.max(b.x1), y1: a.y1.max(b.y1) }
}

// --- texts -----------------------------------------------------------------------------------------

/// "523Q", "523 Q", "5230", "523.0", "371g" (the dim Q read as a zero, a dot or a letter) -> 523.
/// Second value: ambiguous ("1000" may be 100Q or 1000; a quality is 1–1000). Without the Q at
/// least three digits ("31" is a cut-off text, not a quality).
pub fn parse_quality(text: &str) -> Option<(u32, bool)> {
    let t: String = text.chars().filter(|c| !c.is_whitespace() && !matches!(c, '.' | '-' | ':' | ',')).collect();
    let (digits, suffix) = match t.chars().last()? {
        c if c.is_ascii_digit() => (t.as_str(), None),
        // Any letter but the count's x
        c if c.is_alphabetic() && !matches!(c, 'x' | 'X') => (&t[..t.len() - c.len_utf8()], Some(c)),
        _ => return None,
    };
    // No leading zero: "0.263" (an SCU amount) is no quality
    if digits.is_empty() || digits.len() > 5 || !digits.chars().all(|c| c.is_ascii_digit()) || digits.starts_with('0') {
        return None;
    }
    let value: u32 = digits.parse().ok()?;
    if suffix.is_some() {
        if (1..=1000).contains(&value) {
            return Some((value, false));
        }
        // "3100Q": the dim Q read as a 0 and then the Q itself
        if digits.len() == 4 && digits.ends_with('0') {
            let v: u32 = digits[..3].parse().ok()?;
            return Some((v, false));
        }
        return None;
    }
    if digits.len() < 3 {
        return None;
    }
    if value <= 1000 {
        // 4 digits ending in 0 could be a 3-digit quality with the Q read as 0
        return Some((value, digits.len() == 4 && digits.ends_with('0')));
    }
    // "5230": the trailing Q became a 0
    if digits.ends_with('0') {
        let v: u32 = digits[..digits.len() - 1].parse().ok()?;
        return (1..=1000).contains(&v).then_some((v, false));
    }
    None
}

/// A count badge: "X1", "X 14", "×1", "XI" (the 1 read as I or l), "X1D" (the 0 read as D or O),
/// "X" (digits lost) -> (count, uncertain). Anything else is no badge.
pub fn parse_badge(text: &str) -> Option<(u32, bool)> {
    let t: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let rest = t.strip_prefix(['X', 'x', '×'])?;
    if rest.is_empty() {
        return Some((1, true));
    }
    let digits: String = rest
        .chars()
        .map(|c| match c {
            'I' | 'l' | '|' => '1',
            'D' | 'O' | 'o' => '0',
            _ => c,
        })
        .collect();
    if !digits.chars().all(|c| c.is_ascii_digit()) || digits.len() > 4 {
        return None;
    }
    let n: u32 = digits.parse().ok()?;
    (n >= 1).then_some((n, false))
}

/// "0.263 SCU", "2 sCu", "0,5 SCU" -> "0.263", "2", "0.5".
pub fn parse_scu(text: &str) -> Option<String> {
    let t = text.trim();
    let n = t.len().checked_sub(3)?;
    if !t.is_char_boundary(n) || !t[n..].eq_ignore_ascii_case("scu") {
        return None;
    }
    let number: String = t[..n].trim().chars().map(|c| if c == ',' { '.' } else { c }).collect();
    let ok = !number.is_empty() && number.chars().all(|c| c.is_ascii_digit() || c == '.') && number.matches('.').count() <= 1 && number.chars().any(|c| c.is_ascii_digit());
    ok.then_some(number)
}

fn is_text_sized(b: &TextBox, s: f32) -> bool {
    b.rect.h() >= TEXT_MIN_H * s && b.rect.h() <= TEXT_MAX_H * s
}

fn is_badge_box(b: &TextBox, s: f32) -> bool {
    is_text_sized(b, s) && b.rect.w() <= BADGE_MAX_W * s && parse_badge(&b.text).is_some()
}

fn is_quality_box(b: &TextBox, s: f32) -> bool {
    is_text_sized(b, s) && b.text.split_whitespace().next().and_then(parse_quality).is_some()
}

/// Whether a detected box may be a tooltip's title: an item name (Title Case: at least three
/// letters, one of them lower case), not a tile's own text (badge, quality, the info icon, the
/// small labels) and not one of the panel's or an icon's capitals ("CLEAR", "CITIZENCON").
fn is_title_box(b: &TextBox, s: f32) -> bool {
    let letters = b.text.chars().filter(|c| c.is_ascii_alphabetic()).count();
    is_text_sized(b, s)
        && letters >= 3
        && b.text.chars().any(|c| c.is_ascii_lowercase())
        && parse_badge(&b.text).is_none()
        && !is_quality_box(b, s)
        && !norm(&b.text).is_empty()
}

// --- the grid fit ----------------------------------------------------------------------------------

/// An anchor's implied tile corner for a pitch: `base - factor * pitch`.
#[derive(Clone, Copy)]
struct Anchor {
    base: f32,
    factor: f32,
    weight: u32,
}

/// The pitch and phase (tile corner = phase + k · pitch) most anchors agree on, with the agreeing
/// anchors' weight, over the pitches in `range` (frame pixels); among equal weights the pitch nearest
/// `hint`. None without anchors.
fn fit_axis(anchors: &[Anchor], range: (f32, f32), hint: Option<f32>) -> Option<(f32, f32, u32)> {
    if anchors.is_empty() {
        return None;
    }
    let better = |weight: u32, pitch: f32, best: &Option<(f32, f32, u32)>| match best {
        None => true,
        Some((bp, _, bw)) => weight > *bw || (weight == *bw && hint.is_some_and(|h| (pitch - h).abs() < (bp - h).abs())),
    };
    let mut best: Option<(f32, f32, u32)> = None;
    let step = PITCH_STEP * (range.1 / PITCH_MAX);
    let steps = ((range.1 - range.0) / step).round().max(0.0) as usize;
    for i in 0..=steps {
        let pitch = range.0 + i as f32 * step;
        let tol = PHASE_TOL * pitch;
        // Phases on the circle [0, pitch); the window of width tol with the most weight
        let mut phases: Vec<(f32, u32)> = anchors.iter().map(|a| ((a.base - a.factor * pitch).rem_euclid(pitch), a.weight)).collect();
        phases.sort_by(|a, b| a.0.total_cmp(&b.0));
        let n = phases.len();
        for start in 0..n {
            let (p0, _) = phases[start];
            let mut weight = 0;
            let mut sum = 0.0;
            for k in 0..n {
                let (p, w) = phases[(start + k) % n];
                // Unwrap past the circle's end
                let p = if k > 0 && p < p0 { p + pitch } else { p };
                if p - p0 > tol {
                    break;
                }
                weight += w;
                sum += p * w as f32;
            }
            let phase = (sum / weight as f32).rem_euclid(pitch);
            if better(weight, pitch, &best) {
                best = Some((pitch, phase, weight));
            }
        }
    }
    best
}

/// An axis fitted freely over the pitch range, or, when that fit is weak and a `hint` pitch exists,
/// locked to the hint (phase only).
fn fit_or_lock(anchors: &[Anchor], range: (f32, f32), hint: Option<f32>) -> Option<(f32, f32, u32)> {
    let free = fit_axis(anchors, range, hint).filter(|f| f.2 >= MIN_FIT_WEIGHT)?;
    match hint {
        Some(h) if free.2 < STRONG_FIT_WEIGHT => fit_axis(anchors, (h, h), None).filter(|f| f.2 >= MIN_FIT_WEIGHT).or(Some(free)),
        _ => Some(free),
    }
}

/// The grid's layout from the detected boxes: the badges and quality texts right of the screen
/// centre as anchors; `hint` is the last strong read's pitch (a weak fit keeps it, ties go to it).
/// `None` without any, or without a column with an anchor. The layout's `weight` tells how strong
/// the weaker axis' fit was.
pub fn layout_from_boxes(boxes: &[TextBox], frame_w: f32, frame_h: f32, hint: Option<(f32, f32)>) -> Option<Layout> {
    let s = frame_h;
    let in_pane = |b: &TextBox| b.rect.x0 >= PANE_LEFT * frame_w && b.rect.y0 >= GRID_TOP * s && b.rect.y1 <= GRID_BOTTOM * s;
    let badges: Vec<&TextBox> = boxes.iter().filter(|b| in_pane(b) && is_badge_box(b, s)).collect();
    let qualities: Vec<&TextBox> = boxes.iter().filter(|b| in_pane(b) && is_quality_box(b, s)).collect();
    let xs: Vec<Anchor> = badges
        .iter()
        .map(|b| Anchor { base: b.rect.x1, factor: BADGE_RIGHT, weight: 1 })
        .chain(qualities.iter().map(|b| Anchor { base: b.rect.x0, factor: QUALITY_LEFT, weight: 2 }))
        .collect();
    let ys: Vec<Anchor> = badges
        .iter()
        .map(|b| Anchor { base: b.rect.y0, factor: BADGE_TOP, weight: 1 })
        .chain(qualities.iter().map(|b| Anchor { base: b.rect.y1, factor: QUALITY_BOTTOM, weight: 2 }))
        .collect();
    // A single anchor (the tooltip chip's number is a quality-like text too) fits anything
    let (pitch_x, phase_x, weight_x) = fit_or_lock(&xs, (PITCH_MIN * s, PITCH_MAX * s), hint.map(|h| h.0))?;
    // Rows only a little tighter than the columns
    let (pitch_y, phase_y, weight_y) = fit_or_lock(&ys, (pitch_x * ROW_RATIO.0, pitch_x * ROW_RATIO.1), hint.map(|h| h.1))?;
    let weight = weight_x.min(weight_y);
    // Candidate columns across the pane; the COLUMNS consecutive ones with the most anchors
    let first_k = ((PANE_LEFT * frame_w - phase_x) / pitch_x).ceil() as i32;
    let last_k = ((frame_w - TILE_SIZE * pitch_x - phase_x) / pitch_x).floor() as i32;
    let candidates: Vec<f32> = (first_k..=last_k).map(|k| phase_x + k as f32 * pitch_x).collect();
    if candidates.is_empty() {
        return None;
    }
    let weight_at = |x0: f32| -> u32 {
        xs.iter().filter(|a| ((a.base - a.factor * pitch_x) - x0).abs() <= PHASE_TOL * pitch_x).map(|a| a.weight).sum()
    };
    let weights: Vec<u32> = candidates.iter().map(|&x| weight_at(x)).collect();
    let n = candidates.len().min(COLUMNS);
    let (start, total) = (0..=candidates.len() - n).map(|i| (i, weights[i..i + n].iter().sum::<u32>())).max_by_key(|&(i, w)| (w, i))?;
    if total == 0 {
        return None;
    }
    let cols = candidates[start..start + n].to_vec();
    // Rows: every tile fully inside the grid area
    let first_r = ((GRID_TOP * s - phase_y) / pitch_y).ceil() as i32;
    let last_r = ((GRID_BOTTOM * s - TILE_SIZE * pitch_y - phase_y) / pitch_y).floor() as i32;
    let rows: Vec<f32> = (first_r..=last_r).map(|k| phase_y + k as f32 * pitch_y).collect();
    if rows.is_empty() {
        return None;
    }
    Some(Layout { cols, rows, pitch_x, pitch_y, weight })
}

/// The tooltip: its title is a text that is no tile's own and whose cursor point (a little up and
/// left of it) lies in a tile; the lines below it within the tooltip's reach may hold the material's
/// "Capacity" line, the chip "<name>" "<quality>" and the amount. Returns the tooltip and the index
/// of the hovered tile.
fn tooltip_from_boxes(boxes: &[TextBox], tiles: &[Rect], frame_h: f32) -> Option<(Tooltip, usize)> {
    let s = frame_h;
    let (title, hovered) = boxes
        .iter()
        .filter(|b| is_title_box(b, s))
        .find_map(|b| {
            let (cx, cy) = (b.rect.x0 - CURSOR_OFFSET * s, b.rect.y0 - CURSOR_OFFSET * s);
            tiles.iter().position(|t| contains(*t, cx, cy)).map(|i| (b, i))
        })?;
    let line = title.rect.h().max(0.012 * s);
    let group: Vec<&TextBox> = boxes
        .iter()
        .filter(|b| b.rect.x0 > title.rect.x0 - 2.0 * line && b.rect.x0 < title.rect.x1 + 12.0 * line && b.rect.y0 >= title.rect.y0 && b.rect.y0 < title.rect.y1 + 6.0 * line)
        .collect();
    let digits = |t: &str| (!t.is_empty() && t.chars().all(|c| c.is_ascii_digit())).then(|| t.parse::<u32>().ok()).flatten().filter(|q| (1..=1000).contains(q));
    let key = norm(&title.text);
    let mut quality = None;
    let mut scu = None;
    let mut rect = title.rect;
    for b in &group {
        rect = union(rect, b.rect);
        if std::ptr::eq(*b, title) {
            continue;
        }
        let t = b.text.trim();
        if let Some(v) = parse_scu(t) {
            scu = scu.or(Some(v));
        } else if let Some(q) = digits(t) {
            quality = quality.or(Some(q));
        } else if let Some(rest) = norm(t).strip_prefix(key.as_str()) {
            // The chip's name with its number in one box ("Aphorite 523")
            if let Some(q) = digits(rest) {
                quality = quality.or(Some(q));
            }
        }
    }
    let name = title.text.trim().to_string();
    (!name.is_empty()).then_some((Tooltip { name, quality, scu, x: title.rect.x0, y: title.rect.y0, rect }, hovered))
}

/// The pixels of `rect` in `frame`.
pub fn crop(frame: &RgbImage, rect: Rect) -> RgbImage {
    let (w, h) = frame.dimensions();
    let x0 = (rect.x0.max(0.0) as u32).min(w.saturating_sub(1));
    let y0 = (rect.y0.max(0.0) as u32).min(h.saturating_sub(1));
    let cw = ((rect.x1 as u32).min(w)).saturating_sub(x0).max(1);
    let ch = ((rect.y1 as u32).min(h)).saturating_sub(y0).max(1);
    imageops::crop_imm(frame, x0, y0, cw, ch).to_image()
}

/// Reads the warehouse grid in `frame`: the detector over the pane right of the screen centre at the
/// frame's height, the layout from its badges and quality texts (`hint`: the last read's pitch),
/// then every tile's quality band and the hovered tile's badge (every tile's with `all_badges`, for
/// the debug view; both upscaled) recognized from the frame, and the tooltip. Every cell is a tile
/// (unread fields None). The hovered tile is the one under the mouse `cursor` (frame pixels) when the
/// capture knows it; else (screenshots) the one with the tooltip chip's quality or whose quality the
/// tooltip hides, else the one under the tooltip's cursor point. `None` when no grid is in view.
pub fn read_grid(ocr: &mut Ocr, frame: &RgbImage, cursor: Option<(f32, f32)>, hint: Option<(f32, f32)>, all_badges: bool) -> Result<(Option<Grid>, Vec<TextBox>), String> {
    let (w, h) = frame.dimensions();
    let s = h as f32;
    let x0 = (PANE_LEFT * w as f32) as u32;
    let pane = imageops::crop_imm(frame, x0, 0, w - x0, h).to_image();
    let mut boxes = ocr.read(&pane, h)?;
    for b in &mut boxes {
        b.rect.x0 += x0 as f32;
        b.rect.x1 += x0 as f32;
    }
    let Some(layout) = layout_from_boxes(&boxes, w as f32, s, hint) else { return Ok((None, boxes)) };
    let positions: Vec<(usize, usize)> = (0..layout.rows.len()).flat_map(|r| (0..layout.cols.len()).map(move |c| (r, c))).collect();
    let tile_rects: Vec<Rect> = positions.iter().map(|&(r, c)| layout.tile_rect(r, c)).collect();
    let tooltip = tooltip_from_boxes(&boxes, &tile_rects, s);
    // The qualities of every tile (the hovered rule without a cursor needs them)
    let quality_rects: Vec<Rect> = tile_rects.iter().map(|&t| part(t, QUALITY_BAND)).collect();
    let quality_texts = ocr.recognize_all(frame, &quality_rects)?;
    let hidden: Vec<bool> = quality_rects.iter().map(|&r| tooltip.as_ref().is_some_and(|(t, _)| covered(t.rect, r) > TOOLTIP_COVER)).collect();
    let qualities: Vec<Option<(u32, bool)>> = quality_texts
        .iter()
        .zip(&hidden)
        .map(|((text, score), hidden)| (*score >= MIN_SCORE && !hidden).then(|| text.split_whitespace().next().and_then(parse_quality)).flatten())
        .collect();
    // The hovered tile
    let hovered: Option<usize> = match cursor {
        Some((cx, cy)) => tile_rects.iter().position(|t| contains(*t, cx, cy)),
        None => tooltip.as_ref().and_then(|(tip, under_point)| {
            let candidates: Vec<usize> = (0..positions.len()).filter(|&i| tip.quality.is_some() && (qualities[i].map(|q| q.0) == tip.quality || (qualities[i].is_none() && hidden[i]))).collect();
            match candidates.as_slice() {
                [one] => Some(*one),
                _ => Some(*under_point),
            }
        }),
    };
    // The badges: the area at the tile's top right and, when the detector found the badge there, that
    // box on its own (the count's digits are thin: whichever read has them wins), both upscaled
    let wanted: Vec<usize> = if all_badges { (0..positions.len()).collect() } else { hovered.into_iter().collect() };
    let upscaled = |r: Rect| {
        let c = crop(frame, r);
        imageops::resize(&c, c.width() * BADGE_SCALE, c.height() * BADGE_SCALE, FilterType::CatmullRom)
    };
    let mut badge_rects: Vec<(usize, Rect)> = Vec::new();
    for &i in &wanted {
        let area = part(tile_rects[i], BADGE_AREA);
        badge_rects.push((i, area));
        if let Some(b) = boxes.iter().find(|b| is_badge_box(b, s) && contains(area, b.rect.cx(), b.rect.cy())) {
            badge_rects.push((i, Rect { x0: b.rect.x0 - BADGE_PAD, y0: b.rect.y0 - BADGE_PAD, x1: b.rect.x1 + BADGE_PAD, y1: b.rect.y1 + BADGE_PAD }));
        }
    }
    let badge_texts = ocr.recognize_images(&badge_rects.iter().map(|&(_, r)| upscaled(r)).collect::<Vec<_>>())?;
    let mut cells = Vec::new();
    let mut tiles = Vec::new();
    for (i, (&(row, col), &rect)) in positions.iter().zip(&tile_rects).enumerate() {
        let (quality_text, quality_score) = &quality_texts[i];
        cells.push(Cell { row: row as u32, col: col as u32, kind: "quality", rect: quality_rects[i], text: quality_text.clone(), score: *quality_score });
        let reads: Vec<(&Rect, &(String, f32))> = badge_rects.iter().zip(&badge_texts).filter(|((j, _), _)| *j == i).map(|((_, r), t)| (r, t)).collect();
        for (r, (text, score)) in &reads {
            cells.push(Cell { row: row as u32, col: col as u32, kind: "badge", rect: **r, text: text.clone(), score: *score });
        }
        // The badge read with digits, else the uncertain one
        let parsed: Vec<((u32, bool), &String)> = reads.iter().filter(|(_, (_, sc))| *sc >= MIN_SCORE).filter_map(|(_, (t, _))| parse_badge(t).map(|p| (p, t))).collect();
        let (count, badge_text) = match parsed.iter().find(|(p, _)| !p.1).or(parsed.first()) {
            Some((p, t)) => (Some(*p), (*t).clone()),
            None => (None, reads.iter().map(|(_, (t, _))| t.as_str()).collect::<Vec<_>>().join(" | ")),
        };
        tiles.push(Tile {
            rect,
            col: col as u32,
            row: row as u32,
            quality: qualities[i].map(|q| q.0),
            quality_ambiguous: qualities[i].is_some_and(|q| q.1),
            count: count.map(|c| c.0),
            count_uncertain: count.is_some_and(|c| c.1),
            hovered: hovered == Some(i),
            quality_text: quality_text.clone(),
            badge_text,
        });
    }
    let grid = Grid {
        tiles,
        tooltip: tooltip.map(|(t, _)| t),
        cells,
        cols: layout.cols,
        rows: layout.rows,
        pitch_x: layout.pitch_x,
        pitch_y: layout.pitch_y,
        fit_weight: layout.weight,
    };
    Ok((Some(grid), boxes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualities() {
        assert_eq!(parse_quality("523Q"), Some((523, false)));
        assert_eq!(parse_quality("523 Q"), Some((523, false)));
        assert_eq!(parse_quality("5230"), Some((523, false)));
        assert_eq!(parse_quality("1000"), Some((1000, true)));
        assert_eq!(parse_quality("1000Q"), Some((1000, false)));
        assert_eq!(parse_quality("10000"), Some((1000, false)));
        assert_eq!(parse_quality("686"), Some((686, false)));
        assert_eq!(parse_quality("523.0"), Some((523, false)));
        assert_eq!(parse_quality("371g"), Some((371, false)));
        assert_eq!(parse_quality("31Q"), Some((31, false)));
        assert_eq!(parse_quality("3100Q"), Some((310, false)));
        assert_eq!(parse_quality("31"), None, "a cut-off text");
        assert_eq!(parse_quality("30x"), None);
        assert_eq!(parse_quality("0"), None);
        assert_eq!(parse_quality("0.263"), None);
        assert_eq!(parse_quality("4x"), None);
        assert_eq!(parse_quality("1234Q"), None);
    }

    #[test]
    fn badges_and_scu() {
        assert_eq!(parse_badge("X1"), Some((1, false)));
        assert_eq!(parse_badge("X 14"), Some((14, false)));
        assert_eq!(parse_badge("×1"), Some((1, false)));
        assert_eq!(parse_badge("XI"), Some((1, false)));
        assert_eq!(parse_badge("X51"), Some((51, false)));
        assert_eq!(parse_badge("X1D"), Some((10, false)));
        assert_eq!(parse_badge("X1O"), Some((10, false)));
        assert_eq!(parse_badge("X"), Some((1, true)));
        assert_eq!(parse_badge("Xa"), None);
        assert_eq!(parse_badge("EXPAND"), None);
        assert_eq!(parse_badge("4x"), None);
        assert_eq!(parse_scu("0.263 sCu"), Some("0.263".into()));
        assert_eq!(parse_scu("2 SCU"), Some("2".into()));
        assert_eq!(parse_scu("0,5 SCU"), Some("0.5".into()));
        assert_eq!(parse_scu("10/5000 scu"), None);
        assert_eq!(parse_scu("SCU"), None);
        assert_eq!(parse_scu("µ"), None);
    }

    fn tb(x0: f32, y0: f32, w: f32, h: f32, text: &str) -> TextBox {
        TextBox { rect: Rect { x0, y0, x1: x0 + w, y1: y0 + h }, text: text.into(), score: 1.0 }
    }

    /// The live frame of 2026-10-18 (3840×1600): badges at a pitch of ~275 px, rows ~250 px apart,
    /// some badges missed, the panel's close button an "X" too.
    fn live_boxes() -> Vec<TextBox> {
        vec![
            tb(2185.0, 509.0, 40.0, 31.0, "XI"),
            tb(2457.0, 511.0, 40.0, 29.0, "X"),
            tb(3007.0, 515.0, 41.0, 31.0, "X"),
            tb(2187.0, 755.0, 45.0, 33.0, "X"),
            tb(2750.0, 759.0, 45.0, 33.0, "X"),
            tb(3032.0, 762.0, 43.0, 31.0, "X"),
            tb(2190.0, 1014.0, 47.0, 37.0, "X"),
            tb(1972.0, 954.0, 83.0, 39.0, "310Q"),
            tb(2259.0, 958.0, 83.0, 37.0, "310Q"),
            tb(2546.0, 960.0, 84.0, 37.0, "310Q"),
            tb(1970.0, 1227.0, 86.0, 41.0, "310Q"),
            // The panel's close button, the elevator pane's and the panel's texts: no anchors
            tb(2819.0, 208.0, 30.0, 30.0, "X"),
            tb(1426.0, 354.0, 258.0, 34.0, "SELECT ALL SHOWN"),
            tb(2089.0, 588.0, 57.0, 18.0, "STOR=ALL"),
            tb(2786.0, 930.0, 201.0, 33.0, "Hephaestanite"),
            tb(2789.0, 968.0, 169.0, 26.0, "Capacity: 1.00SCU"),
            tb(2972.0, 993.0, 45.0, 27.0, "572"),
            tb(2805.0, 994.0, 137.0, 26.0, "Hephaestanite"),
            tb(3055.0, 995.0, 98.0, 25.0, "0.263 SCU"),
        ]
    }

    #[test]
    fn layout_fitted_to_the_anchors_of_a_live_frame() {
        let l = layout_from_boxes(&live_boxes(), 3840.0, 1600.0, None).expect("layout");
        assert_eq!(l.cols.len(), 4);
        assert!((l.pitch_x - 280.0).abs() < 12.0, "{}", l.pitch_x);
        assert!((l.pitch_y - 250.0).abs() < 12.0, "{}", l.pitch_y);
        // Column 0 starts a little left of its quality texts (1970), the last column holds the badges at ~3050
        assert!((l.cols[0] - 1965.0).abs() < 12.0, "{:?}", l.cols);
        let last = l.tile_rect(0, 3);
        assert!(last.x1 > 3050.0 && last.x1 < 3100.0, "{last:?}");
        // Rows: the first anchors' row near y 500, one row per pitch down to the grid's bottom
        let row_of = |y: f32| l.rows.iter().position(|&r| (r - y).abs() < 15.0);
        assert!(row_of(503.0).is_some() && row_of(753.0).is_some() && row_of(1003.0).is_some(), "{:?}", l.rows);
        assert!(l.rows.iter().all(|&r| r >= 0.25 * 1600.0 && r + TILE_SIZE * l.pitch_y <= 0.92 * 1600.0));
        assert!(layout_from_boxes(&live_boxes()[11..], 3840.0, 1600.0, None).is_none(), "no anchors in the grid");
        // The last read's pitch decides among equally good fits
        let hinted = layout_from_boxes(&live_boxes(), 3840.0, 1600.0, Some((l.pitch_x + 2.0, l.pitch_y))).expect("layout");
        assert!((hinted.pitch_x - l.pitch_x).abs() <= 3.0);
        assert!(l.weight >= 3);
    }

    #[test]
    fn a_weak_fit_keeps_the_hinted_pitch() {
        // Two rows of items: badges only, few of them (weight 4 per axis at most)
        let boxes = vec![
            tb(2185.0, 509.0, 40.0, 31.0, "X1"),
            tb(2457.0, 511.0, 40.0, 29.0, "X"),
            tb(2187.0, 755.0, 45.0, 33.0, "X"),
            tb(2750.0, 759.0, 45.0, 33.0, "X"),
        ];
        let locked = layout_from_boxes(&boxes, 3840.0, 1600.0, Some((275.0, 250.0))).expect("layout");
        assert!((locked.pitch_x - 275.0).abs() < 0.5 && (locked.pitch_y - 250.0).abs() < 0.5, "{locked:?}");
        assert!(locked.weight < STRONG_FIT_WEIGHT);
        // The rows follow the badges' tops
        assert!(locked.rows.iter().any(|&r| (r - 503.0).abs() < 15.0), "{:?}", locked.rows);
    }

    #[test]
    fn tooltip_under_the_cursor_names_the_hovered_tile() {
        let boxes = live_boxes();
        let l = layout_from_boxes(&boxes, 3840.0, 1600.0, None).unwrap();
        let tiles: Vec<Rect> = (0..l.rows.len()).flat_map(|r| (0..4).map(move |c| (r, c))).map(|(r, c)| l.tile_rect(r, c)).collect();
        let (t, hovered) = tooltip_from_boxes(&boxes, &tiles, 1600.0).expect("tooltip");
        assert_eq!((t.name.as_str(), t.quality, t.scu.as_deref()), ("Hephaestanite", Some(572), Some("0.263")));
        // The title at (2786, 930): the cursor at (2770, 914) is in the row starting near 753, column 2
        let (row, col) = (hovered / 4, hovered % 4);
        assert_eq!(col, 2);
        assert!((l.rows[row] - 753.0).abs() < 15.0, "{}", l.rows[row]);
        assert!(t.rect.x1 >= 3153.0 && t.rect.y1 >= 1020.0);
        // An item's tooltip: the title alone; an icon's capitals and the panel's labels are no titles
        let mut item = live_boxes();
        item.truncate(14);
        item.push(tb(2500.0, 660.0, 140.0, 28.0, "CITIZENCON"));
        item.push(tb(2300.0, 820.0, 240.0, 30.0, "RediMake Item Fabricator"));
        item.push(tb(2300.0, 860.0, 160.0, 24.0, "Registered To You"));
        let (t, hovered) = tooltip_from_boxes(&item, &tiles, 1600.0).expect("tooltip");
        assert_eq!((t.name.as_str(), t.quality, t.scu), ("RediMake Item Fabricator", None, None));
        assert_eq!(hovered % 4, 1);
    }
}
