//! Reads the tooltip of the hovered item in the character inventory (the "Storage Access" screen,
//! SC 4.x; the user's screenshots of 2026-10-18, 3840×1600): the ship component part of the
//! companion's inventory scan. The storage pane on the right is a grid 4 units wide, a tile 1 unit
//! (coolers, missiles) or 2 (weapons) wide, 6 rows in view, scrolled row by row (a green thumb on
//! its right), pages "2/3" at its bottom; the tooltip of the hovered tile opens
//! at a fixed place right of the character, not at the cursor: title ("Mil/3/A Blizzard"),
//! "Volume: …", "Item Type: Cooler", manufacturer, size, grade, class, the description and, for
//! components with stats, lines like "Coolant Rating:  60.00" with the value in a column of its own.
//! FPS gear (2026-10-22, `local/screenshots/inventory 4`) shows the same tooltip, often with a second
//! one right below it (the equipped piece to compare, or the list "1: MaxLift Tractor Beam"): the
//! tooltip ends at the first wide gap. Stackable items (weapon attachments) show their count ("2x")
//! in the tile's top right corner.
//! Everything is read as text lines; what they mean is decided in the frontend (`components.ts`: the
//! title against the catalog, the stat lines against the stat names in the player's language).
//!
//! The screen is a panel in perspective around the frame's centre: the FOV and the aspect ratio scale
//! it as a whole about the centre. Every position is measured on 3840×1600 (the user's FOV) as a share
//! of the height from the centre and scaled by the frame's `Ui::k` (1080p 16:9: ~1.05), which the page
//! number's place tells (`read_page`: its x and y must agree on it). Only the tooltip's area and the
//! page number's are run through the OCR; the page number read (~30 ms) also tells this screen from
//! the freight manager's terminal (`ocrwatch`). The hovered tile (`hovered_tile`): under the mouse
//! cursor (the capture passes it), its units from the lit frame the game draws around it, its row in
//! the page's content from the scrollbar thumb's place, so a tile keeps its place when the pane
//! scrolls and equal tiles stay apart. Verified on 3840×1600 and 1920×1080.
//!
//! Anything unexpected yields `None` fields, never a panic.

use image::imageops;
use image::RgbImage;
use serde::Serialize;

use crate::ocr::{resize, FilterType, Ocr, Rect, TextBox};

/// The tooltip's area: right of the centre, below the screen's title row
const TIP_LEFT: f32 = 0.02;
/// Short of the storage grid (GRID_LEFT): its tiles' texts ("110/0") must not read as tooltip lines
const TIP_RIGHT: f32 = 0.39;
const TIP_TOP: f32 = 0.22;
const TIP_BOTTOM: f32 = 0.76;
/// The tooltip's texts are small (~0.012 of the height): its crop is scaled to what this frame height
/// would show (up on smaller frames, down on larger ones like 2160p: more pixels only cost time)
const TIP_SCALE_HEIGHT: f32 = 1800.0;
/// The page number ("2/3") below the storage grid: where it is looked for once the scale is known, and
/// its centre (from the frame's centre) the scale is taken from
const PAGE_LEFT: f32 = 0.50;
const PAGE_RIGHT: f32 = 0.70;
const PAGE_TOP: f32 = 0.81;
const PAGE_BOTTOM: f32 = 0.87;
const PAGE_SCALE: u32 = 2;
const PAGE_CX: f32 = 0.597;
const PAGE_CY: f32 = 0.340;
/// The scales looked for without a known one (the whole range of FOVs and aspect ratios), and how far
/// the page's x and y may disagree on it (a tile's "40/40" ammo count elsewhere does not fit both)
const K_MIN: f32 = 0.75;
const K_MAX: f32 = 1.4;
const K_AGREE: f32 = 0.06;
/// The storage grid: left edge and top of its first row (unscrolled), unit width and row pitch, the
/// units per row and the rows in view. A tile spans 1 unit (coolers, missiles) or 2 (weapons).
const GRID_LEFT: f32 = 0.400;
const GRID_TOP: f32 = 0.244;
const CELL_W: f32 = 0.098;
const CELL_H: f32 = 0.0938;
const GRID_COLS: u32 = 4;
const GRID_ROWS: u32 = 6;
/// The pane's scrollbar: its column, the track's ends and the content height its thumb's length
/// stands for (the thumb moves ~61.6 px per row of 150 px at 1600 px height; the pane snaps to rows)
const SCROLL_X: f32 = 0.802;
const SCROLL_SEARCH: f32 = 0.005;
const TRACK_TOP: f32 = 0.235;
const TRACK_BOTTOM: f32 = 0.815;
const SCROLL_VIEW: f32 = 0.5675;
/// A thumb is at least this long; a scroll this close to whole rows is taken as whole rows
const MIN_THUMB: f32 = 0.03;
const ROW_SNAP: f32 = 0.15;
/// The hovered tile's light frame: a column (row) of pixels near the cursor is one of its sides when
/// it holds a run of its colour this long (a share of the row pitch, or of the tile's width; the
/// corners are rounded)
const EDGE_SIDE: f32 = 0.4;
const LINE_SLANT: u32 = 2;
/// Boxes below this confidence are noise (the character shows through the tooltip's panel)
const MIN_SCORE: f32 = 0.3;
/// A tooltip has at least this many lines below its title (a real one has 10 and more: volume,
/// type, manufacturer, size, the description; stray texts of the scene read 1–3) and that many
/// letters in the title
const MIN_BODY_LINES: usize = 4;
const MIN_TITLE_LETTERS: usize = 3;
/// Text heights (shares of the frame height) a tooltip line can have
const LINE_MIN_H: f32 = 0.006;
const LINE_MAX_H: f32 = 0.03;
/// A gap this wide (top to top, a share of the height) between two lines ends the tooltip: within one
/// the widest is 0.035 (above "Registered To You"), the next tooltip below starts 0.041 and more down
/// (3840×1600, 29 FPS and 22 component shots)
const TIP_GAP: f32 = 0.038;
/// The stack count ("2x") in a tile's top right corner: the share of the tile's width and height
/// read, and the scale the small text is read at
const COUNT_W: f32 = 0.5;
const COUNT_H: f32 = 0.35;
const COUNT_SCALE: f32 = 2.0;

/// One text line of the tooltip (the boxes of one row joined by a space, left to right).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub text: String,
    pub rect: Rect,
}

/// The hovered item's tooltip.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tooltip {
    /// The first line
    pub title: String,
    /// Every line below it, top to bottom
    pub lines: Vec<Line>,
    /// The area its texts cover (frame pixels)
    pub rect: Rect,
}

/// The storage pane's page ("2/3").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub index: u32,
    pub total: u32,
}

/// The hovered tile of the storage grid: its row in the page's content (0 = the first, also when
/// scrolled out of view), its first unit (0–3) and how many it spans, its area in frame pixels, and
/// the stack's count where the tile shows one ("2x"; None: a single piece).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub row: u32,
    pub col: u32,
    pub span: u32,
    pub rect: Rect,
    pub count: Option<u32>,
}

/// What one frame of the inventory screen read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentRead {
    pub tooltip: Option<Tooltip>,
    pub page: Option<Page>,
    /// The tile under the mouse cursor (None: no cursor, outside the grid, or no lit tile there)
    pub cell: Option<Cell>,
}

/// Where the screen's parts are in a frame: the measured shares (x from the centre, y from the top,
/// lengths) scaled by `k` about the frame's centre.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ui {
    cx: f32,
    cy: f32,
    s: f32,
    pub k: f32,
}

impl Ui {
    pub fn new(frame: &RgbImage, k: f32) -> Self {
        let (w, h) = frame.dimensions();
        Self { cx: w as f32 / 2.0, cy: h as f32 / 2.0, s: h as f32, k }
    }

    fn x(&self, share: f32) -> f32 {
        self.cx + self.k * share * self.s
    }

    fn y(&self, share: f32) -> f32 {
        self.cy + self.k * (share - 0.5) * self.s
    }

    fn len(&self, share: f32) -> f32 {
        self.k * share * self.s
    }
}

fn union(a: Rect, b: Rect) -> Rect {
    Rect { x0: a.x0.min(b.x0), y0: a.y0.min(b.y0), x1: a.x1.max(b.x1), y1: a.y1.max(b.y1) }
}

/// The scrollbar thumb's green
fn is_thumb(p: &image::Rgb<u8>) -> bool {
    let [r, g, b] = p.0.map(i32::from);
    g > 150 && g > r + 80 && g > b + 40
}

/// The hovered tile's light cyan frame (icons are neutral grey or white, the thumb green; at 1080p its
/// 1 px lines read as dim as 138/167/175)
fn is_frame(p: &image::Rgb<u8>) -> bool {
    let [r, g, b] = p.0.map(i32::from);
    g >= 130 && b >= 130 && g - r >= 20 && b - r >= 25
}

/// The scrollbar thumb (top, length in frame pixels): the longest green run in the columns around
/// the scrollbar; None when the page's content fits (no thumb).
fn find_thumb(frame: &RgbImage, ui: Ui) -> Option<(f32, f32)> {
    let (w, h) = frame.dimensions();
    let (y0, y1) = ((ui.y(TRACK_TOP) - 2.0).max(0.0) as u32, ((ui.y(TRACK_BOTTOM) + 2.0) as u32).min(h));
    let x_mid = ui.x(SCROLL_X);
    let mut best: Option<(u32, u32)> = None;
    for x in (x_mid - ui.len(SCROLL_SEARCH)).max(0.0) as u32..((x_mid + ui.len(SCROLL_SEARCH)) as u32).min(w) {
        let mut run: Option<(u32, u32)> = None;
        for y in y0..y1 {
            if is_thumb(frame.get_pixel(x, y)) {
                let start = run.map_or(y, |(start, _)| start);
                run = Some((start, y + 1 - start));
                if best.is_none_or(|(_, len)| y + 1 - start > len) {
                    best = run;
                }
            } else {
                run = None;
            }
        }
    }
    best.filter(|&(_, len)| len as f32 >= ui.len(MIN_THUMB)).map(|(top, len)| (top as f32, len as f32))
}

/// How far the pane is scrolled (content pixels) for a thumb (top, length); 0 without one. Close to
/// whole rows it is whole rows (the pane snaps to them; between them it animates).
fn scroll_of(thumb: Option<(f32, f32)>, ui: Ui) -> f32 {
    let Some((top, len)) = thumb else { return 0.0 };
    let rows = ((top - ui.y(TRACK_TOP)).max(0.0) * ui.len(SCROLL_VIEW) / len) / ui.len(CELL_H);
    let whole = rows.round();
    (if (rows - whole).abs() <= ROW_SNAP { whole } else { rows }) * ui.len(CELL_H)
}

/// The longest run of the lit frame's colour along a column (`vertical`, at `at`, from `from` to `to`)
/// or a row, a pixel counting as lit when it or one up to LINE_SLANT pixels across the line is: the
/// panel's perspective slants the 1 px lines (2 px over a tile's width at 1080p).
fn lit_run(frame: &RgbImage, vertical: bool, at: u32, from: u32, to: u32) -> f32 {
    let (w, h) = frame.dimensions();
    let (mut run, mut best) = (0usize, 0usize);
    for i in from..=to {
        let lit = (at.saturating_sub(LINE_SLANT)..=at + LINE_SLANT).any(|a| {
            let (x, y) = if vertical { (a, i) } else { (i, a) };
            x < w && y < h && is_frame(frame.get_pixel(x, y))
        });
        run = if lit { run + 1 } else { 0 };
        best = best.max(run);
    }
    best as f32
}

/// The first coordinate from `from` stepping by `step` (at most `max` steps) where `lit(c)` holds.
fn first_lit(from: f32, step: i32, max: f32, lit: impl Fn(u32) -> bool) -> Option<f32> {
    (0..max as i32).map(|d| from as i32 + step * d).take_while(|&c| c >= 0).find(|&c| lit(c as u32)).map(|c| c as f32)
}

/// The tile under the cursor (frame pixels): the lit frame the game draws around the hovered tile,
/// found from the cursor outwards (left, right, then up and down between them; the panel's
/// perspective puts it some pixels off the measured grid), its units and its row in the content (the
/// pane's scroll from the scrollbar thumb) rounded on the scaled grid. None outside the grid or
/// without a lit frame around the cursor.
pub fn hovered_tile(frame: &RgbImage, ui: Ui, cursor: (f32, f32)) -> Option<Cell> {
    let (w, h) = frame.dimensions();
    let (cell_w, cell_h, grid_left, grid_top) = (ui.len(CELL_W), ui.len(CELL_H), ui.x(GRID_LEFT), ui.y(GRID_TOP));
    let (cx, cy) = cursor;
    // With some room: the scaled grid can sit a few pixels off (the lit frame decides)
    let (mx, my) = (0.3 * cell_w, 0.3 * cell_h);
    if cx < grid_left - mx || cx >= grid_left + GRID_COLS as f32 * cell_w + mx || cy < grid_top - my || cy >= grid_top + GRID_ROWS as f32 * cell_h + my || cx >= w as f32 || cy >= h as f32 {
        return None;
    }
    // Left and right: columns with a long lit run in a band around the cursor's height (wherever the
    // cursor is in the tile, its sides run through the band; a tile is at most 2 units wide)
    let (b0, b1) = ((cy - 0.6 * cell_h).max(0.0) as u32, ((cy + 0.6 * cell_h) as u32).min(h - 1));
    let column = |x: u32| x < w && lit_run(frame, true, x, b0, b1) >= EDGE_SIDE * cell_h;
    // The other side at least half a unit away: the cursor may sit on the frame's line itself
    let half = 0.5 * cell_w;
    let (left, right) = first_lit(cx, -1, 2.2 * cell_w, column)
        .and_then(|l| Some((l, first_lit(l + half, 1, 2.2 * cell_w - half, column)?)))
        .filter(|&(_, r)| r >= cx)
        .or_else(|| first_lit(cx, 1, 2.2 * cell_w, column).and_then(|r| Some((first_lit(r - half, -1, 2.2 * cell_w - half, column)?, r))))?;
    // Top and bottom: rows with a long lit run between them
    let (a0, a1) = (left as u32, (right as u32).min(w - 1));
    let row_lit = |y: u32| y < h && lit_run(frame, false, y, a0, a1) >= EDGE_SIDE * (right - left);
    let top = first_lit(cy, -1, 1.2 * cell_h, row_lit)?;
    let bottom = first_lit(cy, 1, 1.2 * cell_h, row_lit)?;
    let span = ((right - left) / cell_w).round().clamp(1.0, GRID_COLS as f32) as u32;
    let col = ((left - grid_left) / cell_w).round().clamp(0.0, (GRID_COLS - span) as f32) as u32;
    let scroll = scroll_of(find_thumb(frame, ui), ui);
    let row = ((top - grid_top + scroll) / cell_h).round().max(0.0) as u32;
    Some(Cell { row, col, span, rect: Rect { x0: left, y0: top, x1: right, y1: bottom }, count: None })
}

/// "2x" (also "2 x", "12X", "2×") -> 2; a count below 2 or without the x is none.
pub fn parse_count(text: &str) -> Option<u32> {
    let t: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let digits = t.strip_suffix(['x', 'X', '×'])?;
    let n = digits.parse::<u32>().ok()?;
    (n >= 2).then_some(n)
}

/// "2/3" (also "2 / 3", "2/ 3") -> (2, 3); at most 99 pages (an SCU text like "10/5000" is none).
pub fn parse_page(text: &str) -> Option<Page> {
    let t: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let (a, b) = t.split_once('/')?;
    let (index, total) = (a.parse::<u32>().ok()?, b.parse::<u32>().ok()?);
    (index >= 1 && total >= index && total <= 99).then_some(Page { index, total })
}

/// The OCR boxes of the tooltip area grouped into text lines, top to bottom: boxes whose vertical
/// centres lie within half a line height of each other share a line; a line's boxes are joined left
/// to right with a space (the stat lines keep label and value in two boxes). `s` = frame height.
pub fn lines_of(boxes: &[TextBox], s: f32) -> Vec<Line> {
    let mut sorted: Vec<&TextBox> = boxes
        .iter()
        .filter(|b| b.score >= MIN_SCORE && !b.text.trim().is_empty() && b.rect.h() >= LINE_MIN_H * s && b.rect.h() <= LINE_MAX_H * s)
        .collect();
    sorted.sort_by(|a, b| a.rect.cy().total_cmp(&b.rect.cy()).then(a.rect.x0.total_cmp(&b.rect.x0)));
    let mut lines: Vec<Vec<&TextBox>> = Vec::new();
    for b in sorted {
        match lines.last_mut() {
            Some(line) if line.iter().any(|o| (o.rect.cy() - b.rect.cy()).abs() < 0.5 * o.rect.h().min(b.rect.h())) => line.push(b),
            _ => lines.push(vec![b]),
        }
    }
    lines
        .into_iter()
        .map(|mut line| {
            line.sort_by(|a, b| a.rect.x0.total_cmp(&b.rect.x0));
            let rect = line.iter().skip(1).fold(line[0].rect, |r, b| union(r, b.rect));
            Line { text: line.iter().map(|b| b.text.trim()).collect::<Vec<_>>().join(" "), rect }
        })
        .collect()
}

/// The tooltip in the area's lines: the first line with letters is the title (lines above it are
/// strays of the scene, like a lamp read as "I"), the rest its body up to the first gap of TIP_GAP (a
/// second tooltip below); None with fewer than MIN_BODY_LINES body lines (stray texts of the scene
/// are no tooltip). `s` = the UI's height (`Ui::len(1.0)`).
pub fn tooltip_of(lines: Vec<Line>, s: f32) -> Option<Tooltip> {
    let mut it = lines.into_iter();
    let title = it.find(|l| l.text.chars().filter(|c| c.is_alphabetic()).count() >= MIN_TITLE_LETTERS)?;
    let mut top = title.rect.y0;
    let lines: Vec<Line> = it
        .take_while(|l| {
            let near = l.rect.y0 - top <= TIP_GAP * s;
            top = l.rect.y0;
            near
        })
        .collect();
    if lines.len() < MIN_BODY_LINES {
        return None;
    }
    let rect = lines.iter().fold(title.rect, |r, l| union(r, l.rect));
    Some(Tooltip { title: title.text, lines, rect })
}

/// The pixels of `rect` in `frame`, scaled by `scale`; the boxes read on it map back through `rect`.
fn scaled_crop(frame: &RgbImage, rect: Rect, scale: f32) -> RgbImage {
    let (w, h) = frame.dimensions();
    let x0 = (rect.x0.max(0.0) as u32).min(w.saturating_sub(1));
    let y0 = (rect.y0.max(0.0) as u32).min(h.saturating_sub(1));
    let cw = ((rect.x1 as u32).min(w)).saturating_sub(x0).max(1);
    let ch = ((rect.y1 as u32).min(h)).saturating_sub(y0).max(1);
    let crop = imageops::crop_imm(frame, x0, y0, cw, ch).to_image();
    if scale == 1.0 {
        return crop;
    }
    resize(&crop, ((cw as f32 * scale) as u32).max(1), ((ch as f32 * scale) as u32).max(1), FilterType::CatmullRom)
}

/// Reads the texts in `rect` of `frame` (scaled up by `scale` first); boxes in frame pixels. Only the
/// detected lines `keep` (their boxes in frame pixels) picks are recognized.
fn read_area(ocr: &mut Ocr, frame: &RgbImage, rect: Rect, scale: f32, keep: impl FnOnce(&[Rect]) -> Vec<bool>) -> Result<Vec<TextBox>, String> {
    let crop = scaled_crop(frame, rect, scale);
    let (ox, oy) = (rect.x0.max(0.0), rect.y0.max(0.0));
    let found = ocr.detect(&crop, crop.height())?;
    let in_frame: Vec<Rect> = found.iter().map(|r| Rect { x0: ox + r.x0 / scale, y0: oy + r.y0 / scale, x1: ox + r.x1 / scale, y1: oy + r.y1 / scale }).collect();
    let keep = keep(&in_frame);
    let picked: Vec<usize> = (0..found.len()).filter(|&i| keep[i]).collect();
    let texts = ocr.recognize_all(&crop, &picked.iter().map(|&i| found[i]).collect::<Vec<_>>())?;
    Ok(picked.into_iter().zip(texts).filter(|(_, (t, _))| !t.trim().is_empty()).map(|(i, (text, score))| TextBox { rect: in_frame[i], text, score }).collect())
}

/// Every detected line.
fn all(rects: &[Rect]) -> Vec<bool> {
    vec![true; rects.len()]
}

/// The detected lines of the tooltip, before they are recognized (the recognizer is the read's
/// largest cost): the boxes of a line's height grouped into rows as `lines_of` does, the rows into
/// blocks at gaps wider than TIP_GAP as `tooltip_of` does, and of these the first with a title and
/// MIN_BODY_LINES rows below it. Not recognized: a second tooltip below and strays of the scene
/// (unrecognized boxes only make rows closer, never a gap wider). `s` = the UI's height.
fn tooltip_block(rects: &[Rect], s: f32) -> Vec<bool> {
    let mut order: Vec<usize> = (0..rects.len()).filter(|&i| rects[i].h() >= LINE_MIN_H * s && rects[i].h() <= LINE_MAX_H * s).collect();
    order.sort_by(|&a, &b| rects[a].cy().total_cmp(&rects[b].cy()));
    let mut rows: Vec<Vec<usize>> = Vec::new();
    for i in order {
        match rows.last_mut() {
            Some(row) if row.iter().any(|&o| (rects[o].cy() - rects[i].cy()).abs() < 0.5 * rects[o].h().min(rects[i].h())) => row.push(i),
            _ => rows.push(vec![i]),
        }
    }
    let top = |row: &Vec<usize>| row.iter().map(|&i| rects[i].y0).fold(f32::MAX, f32::min);
    let mut keep = vec![false; rects.len()];
    let mut start = 0;
    for end in 1..=rows.len() {
        if end < rows.len() && top(&rows[end]) - top(&rows[end - 1]) <= TIP_GAP * s {
            continue;
        }
        if end - start > MIN_BODY_LINES {
            rows[start..end].iter().flatten().for_each(|&i| keep[i] = true);
            break;
        }
        start = end;
    }
    keep
}

/// The page number among `boxes` and the scale its place tells: its centre's x and y (from the
/// frame's centre) against the measured place, both within K_MIN–K_MAX and agreeing within K_AGREE;
/// of several the best agreeing.
fn page_and_scale(boxes: &[TextBox], frame: &RgbImage) -> Option<(Page, f32)> {
    let ui = Ui::new(frame, 1.0);
    boxes
        .iter()
        .filter_map(|b| {
            let page = parse_page(&b.text)?;
            let kx = (b.rect.cx() - ui.cx) / (PAGE_CX * ui.s);
            let ky = (b.rect.cy() - ui.cy) / (PAGE_CY * ui.s);
            let off = (kx - ky).abs() / ky;
            ((K_MIN..=K_MAX).contains(&ky) && off <= K_AGREE).then_some((page, (kx + ky) / 2.0, off))
        })
        .min_by(|a, b| a.2.total_cmp(&b.2))
        .map(|(page, k, _)| (page, k))
}

/// Reads the storage pane's page number ("2/3"), present only on the inventory screen, and the scale
/// its place tells. With a known scale (`hint`) only around where the page should be (cheap, ~30 ms),
/// else over every place it can have. The boxes read, in frame pixels.
pub fn read_page(ocr: &mut Ocr, frame: &RgbImage, hint: Option<f32>) -> Result<(Option<(Page, f32)>, Vec<TextBox>), String> {
    let area = match hint {
        Some(k) => {
            let ui = Ui::new(frame, k);
            Rect { x0: ui.x(PAGE_LEFT), y0: ui.y(PAGE_TOP), x1: ui.x(PAGE_RIGHT), y1: ui.y(PAGE_BOTTOM) }
        }
        None => {
            let (lo, hi) = (Ui::new(frame, K_MIN), Ui::new(frame, K_MAX));
            let pad = |ui: Ui| ui.len(0.05);
            Rect { x0: lo.x(PAGE_CX) - pad(lo), y0: lo.y(0.5 + PAGE_CY) - pad(lo), x1: hi.x(PAGE_CX) + pad(hi), y1: hi.y(0.5 + PAGE_CY) + pad(hi) }
        }
    };
    let boxes = read_area(ocr, frame, area, PAGE_SCALE as f32, all)?;
    Ok((page_and_scale(&boxes, frame), boxes))
}

/// Reads the hovered item's tooltip in its fixed area. The boxes read, in frame pixels.
pub fn read_tooltip(ocr: &mut Ocr, frame: &RgbImage, ui: Ui) -> Result<(Option<Tooltip>, Vec<TextBox>), String> {
    let tip_area = Rect { x0: ui.x(TIP_LEFT), y0: ui.y(TIP_TOP), x1: ui.x(TIP_RIGHT), y1: ui.y(TIP_BOTTOM) };
    let s = ui.len(1.0);
    let boxes = read_area(ocr, frame, tip_area, TIP_SCALE_HEIGHT / s, |rects| tooltip_block(rects, s))?;
    let tooltip = tooltip_of(lines_of(&boxes, ui.len(1.0)), ui.len(1.0));
    Ok((tooltip, boxes))
}

/// Reads a tile's stack count ("2x") in its top right corner. The boxes read, in frame pixels.
pub fn read_count(ocr: &mut Ocr, frame: &RgbImage, tile: Rect) -> Result<(Option<u32>, Vec<TextBox>), String> {
    let (w, h) = (tile.x1 - tile.x0, tile.y1 - tile.y0);
    let area = Rect { x0: tile.x1 - COUNT_W * w, y0: tile.y0, x1: tile.x1, y1: tile.y0 + COUNT_H * h };
    let boxes = read_area(ocr, frame, area, COUNT_SCALE, all)?;
    let count = boxes.iter().filter(|b| b.score >= MIN_SCORE).find_map(|b| parse_count(&b.text));
    Ok((count, boxes))
}

/// Reads the storage pane's page number (and so the scale; without one the measured place, k = 1),
/// the hovered item's tooltip and the tile under the `cursor` (frame pixels) with its stack count in a
/// frame of the inventory screen. The boxes read, in frame pixels.
pub fn read_components(ocr: &mut Ocr, frame: &RgbImage, cursor: Option<(f32, f32)>) -> Result<(ComponentRead, Vec<TextBox>), String> {
    let (page, mut boxes) = read_page(ocr, frame, None)?;
    let ui = Ui::new(frame, page.map_or(1.0, |p| p.1));
    let (tooltip, tip_boxes) = read_tooltip(ocr, frame, ui)?;
    boxes.extend(tip_boxes);
    let mut cell = cursor.and_then(|c| hovered_tile(frame, ui, c));
    if let (Some(c), Some(_)) = (cell.as_mut(), &tooltip) {
        let (count, count_boxes) = read_count(ocr, frame, c.rect)?;
        c.count = count;
        boxes.extend(count_boxes);
    }
    Ok((ComponentRead { tooltip, page: page.map(|p| p.0), cell }, boxes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tb(x0: f32, y0: f32, w: f32, h: f32, text: &str) -> TextBox {
        TextBox { rect: Rect { x0, y0, x1: x0 + w, y1: y0 + h }, text: text.into(), score: 1.0 }
    }

    #[test]
    fn pages() {
        assert_eq!(parse_page("2/3"), Some(Page { index: 2, total: 3 }));
        assert_eq!(parse_page(" 1 / 1"), Some(Page { index: 1, total: 1 }));
        assert_eq!(parse_page("0/3"), None);
        assert_eq!(parse_page("4/3"), None);
        assert_eq!(parse_page("2-3"), None);
        assert_eq!(parse_page("10/5000"), None, "an SCU text");
    }

    #[test]
    fn counts() {
        assert_eq!(parse_count("2x"), Some(2));
        assert_eq!(parse_count("12 X"), Some(12));
        assert_eq!(parse_count("3×"), Some(3));
        assert_eq!(parse_count("1x"), None);
        assert_eq!(parse_count("2"), None, "no x: an ammo count, a slot number");
        assert_eq!(parse_count("x2"), None);
    }

    #[test]
    fn a_second_tooltip_below_is_cut_off() {
        // Artimex Arms Canuto (3840×1600, 2026-10-22, lines left out): its last line, then the equipped piece's tooltip 68 px down
        let boxes = vec![
            tb(2015.0, 422.0, 188.0, 24.0, "Artimex Arms Canuto"),
            tb(2014.0, 444.0, 182.0, 24.0, "Volume: 10000 μSCU"),
            tb(2014.0, 489.0, 224.0, 24.0, "Item Type: Medium Armor"),
            tb(2013.0, 535.0, 169.0, 26.0, "Damage Mitigation:"),
            tb(2206.0, 534.0, 48.0, 27.0, "0.30"),
            tb(2013.0, 580.0, 338.0, 26.0, "Radiation Dissipation: 145.80 mRem/s"),
            tb(2013.0, 629.0, 131.0, 25.0, "Registered To You"),
            tb(2013.0, 697.0, 209.0, 26.0, "Dust Devil Arms Epoque"),
            tb(2014.0, 720.0, 182.0, 24.0, "Volume: 16000 μSCU"),
        ];
        let tip = tooltip_of(lines_of(&boxes, 1600.0), 1600.0).expect("tooltip");
        assert_eq!(tip.lines.last().map(|l| l.text.as_str()), Some("Registered To You"));
        assert_eq!(tip.lines.len(), 5);
    }

    #[test]
    fn only_the_tooltips_lines_go_to_the_recognizer() {
        let r = |x0: f32, y0: f32, w: f32, h: f32| Rect { x0, y0, x1: x0 + w, y1: y0 + h };
        // Canuto (as above): a stray far above, the tooltip (label and value of a row in two boxes),
        // the equipped piece's tooltip 68 px below its last line
        let rects = [
            r(2554.0, 300.0, 16.0, 24.0),
            r(2015.0, 422.0, 188.0, 24.0),
            r(2014.0, 444.0, 182.0, 24.0),
            r(2014.0, 489.0, 224.0, 24.0),
            r(2013.0, 535.0, 169.0, 26.0),
            r(2206.0, 534.0, 48.0, 27.0),
            r(2013.0, 580.0, 338.0, 26.0),
            r(2013.0, 629.0, 131.0, 25.0),
            r(2013.0, 697.0, 209.0, 26.0),
            r(2014.0, 720.0, 182.0, 24.0),
        ];
        let keep = tooltip_block(&rects, 1600.0);
        assert_eq!(keep, [false, true, true, true, true, true, true, true, false, false]);
        // Too few rows for a tooltip: nothing is recognized
        assert!(!tooltip_block(&rects[..4], 1600.0).contains(&true));
    }

    #[test]
    fn a_stray_above_the_title_is_skipped() {
        // IonSurge (3840×2160, a user's recording of 2026-10-25): a lamp of the scene above the panel read as "I"
        let boxes = vec![
            tb(2554.0, 461.0, 16.0, 24.0, "I"),
            tb(2051.0, 549.0, 237.0, 36.0, "lonSurge (Civ/2/B)"),
            tb(2050.0, 578.0, 288.0, 39.0, "Volumen: 252000 μSCU"),
            tb(2048.0, 641.0, 393.0, 39.0, "Hersteller: Lightning Power Ltd."),
            tb(2050.0, 703.0, 270.0, 39.0, "Typ (En): Power Plant"),
            tb(2050.0, 734.0, 273.0, 41.0, "Typ (De): Power Plant"),
            tb(2051.0, 795.0, 131.0, 37.0, "Größe: S2"),
            tb(2052.0, 829.0, 153.0, 35.0, "Gütegrad: B"),
        ];
        let tip = tooltip_of(lines_of(&boxes, 2160.0), 2268.0).expect("tooltip");
        assert_eq!(tip.title, "lonSurge (Civ/2/B)");
        assert_eq!(tip.lines.len(), 6);
    }

    #[test]
    fn scroll_from_the_thumb() {
        // 3840×1600 (the recording of 2026-10-18): the thumb is 373 px long, at 376 when not scrolled,
        // 621 four rows down, 740 six (or nearly), 930 nine rows down
        let ui = Ui { cx: 1920.0, cy: 800.0, s: 1600.0, k: 1.0 };
        let rows = |top: f32| scroll_of(Some((top, 373.0)), ui) / (CELL_H * 1600.0);
        assert_eq!(rows(376.0), 0.0);
        assert_eq!(rows(621.0), 4.0);
        assert_eq!(rows(740.0), 6.0);
        assert_eq!(rows(930.0), 9.0);
        // Halfway between rows (the scroll animation): as it is
        assert!((rows(715.0) - 5.5).abs() < 0.1, "{}", rows(715.0));
        assert_eq!(scroll_of(None, ui), 0.0, "no thumb: the page fits");
    }

    #[test]
    fn hovered_tile_in_a_scrolled_pane() {
        // A dark 3840×1600 frame scrolled four rows down (thumb at 621), the lit frame around a wide
        // tile over units 1–2 in the second visible row
        let mut frame = RgbImage::from_pixel(3840, 1600, image::Rgb([20, 30, 40]));
        for y in 621..994 {
            for x in 3201..3207 {
                frame.put_pixel(x, y, image::Rgb([58, 233, 140]));
            }
        }
        let lit = image::Rgb([183, 226, 233]);
        let (top, bottom) = (545u32, 688u32);
        for y in top..=bottom {
            for x in [2716u32, 2717, 3029, 3030] {
                frame.put_pixel(x, y, lit);
            }
        }
        for x in 2716..=3030u32 {
            for y in [top, top + 1, bottom - 1, bottom] {
                frame.put_pixel(x, y, lit);
            }
        }
        // An icon's white inside the tile is no edge
        for y in 580..640 {
            frame.put_pixel(2873, y, image::Rgb([230, 230, 230]));
        }
        let ui = Ui::new(&frame, 1.0);
        let tile = hovered_tile(&frame, ui, (2950.0, 600.0)).expect("a tile");
        assert_eq!((tile.row, tile.col, tile.span), (5, 1, 2), "content row 4 + 1");
        // Within the slant window (LINE_SLANT) of the lines
        assert!((tile.rect.x0 - 2717.0).abs() <= 3.0 && (tile.rect.x1 - 3029.0).abs() <= 3.0, "{:?}", tile.rect);
        // The same tile seen ~5 % larger (another FOV): found from the cursor all the same
        assert_eq!(hovered_tile(&frame, Ui::new(&frame, 1.05), (2950.0, 600.0)).map(|t| (t.col, t.span)), Some((1, 2)));
        assert_eq!(hovered_tile(&frame, ui, (2600.0, 600.0)), None, "unit 0: no lit frame");
        assert_eq!(hovered_tile(&frame, ui, (2400.0, 600.0)), None, "left of the grid");
        assert_eq!(hovered_tile(&frame, ui, (2950.0, 1400.0)), None, "below the grid");
    }

    #[test]
    fn the_scale_from_the_page_numbers_place() {
        let frame = RgbImage::new(1920, 1080);
        // 1080p 16:9 (2026-10-19): "1/3" centred at (1633, 927)
        let (page, k) = page_and_scale(&[tb(1617.0, 916.0, 33.0, 22.0, "1/3")], &frame).expect("page");
        assert_eq!((page.index, page.total), (1, 3));
        assert!((k - 1.05).abs() < 0.01, "{k}");
        // A tile's ammo count in the bottom row's first unit: x and y disagree on the scale
        assert_eq!(page_and_scale(&[tb(1430.0, 870.0, 40.0, 20.0, "40/40")], &frame), None);
    }

    #[test]
    fn lines_join_the_boxes_of_a_row_and_the_first_is_the_title() {
        // The Blizzard tooltip (3840×1600): the title, body lines, two stat lines with the value in a box of its own
        let boxes = vec![
            tb(2015.0, 426.0, 140.0, 20.0, "Mil/3/A Blizzard"),
            tb(2015.0, 448.0, 170.0, 19.0, "Volume: 756000 µSCU"),
            tb(2015.0, 492.0, 150.0, 19.0, "Item Type: Cooler"),
            tb(2015.0, 536.0, 130.0, 19.0, "Coolant Rating:"),
            tb(2195.0, 537.0, 50.0, 18.0, "60.00"),
            tb(2195.0, 559.0, 60.0, 18.0, "1800.00"),
            tb(2015.0, 558.0, 80.0, 19.0, "Integrity:"),
            // Noise: a low score and an oversized box
            TextBox { rect: Rect { x0: 2100.0, y0: 600.0, x1: 2140.0, y1: 620.0 }, text: "|".into(), score: 0.1 },
            tb(2015.0, 300.0, 300.0, 80.0, "START"),
        ];
        let lines = lines_of(&boxes, 1600.0);
        let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["Mil/3/A Blizzard", "Volume: 756000 µSCU", "Item Type: Cooler", "Coolant Rating: 60.00", "Integrity: 1800.00"]);
        let tip = tooltip_of(lines, 1600.0).expect("tooltip");
        assert_eq!(tip.title, "Mil/3/A Blizzard");
        assert_eq!(tip.lines.len(), 4);
        assert!(tip.rect.x1 >= 2255.0 && tip.rect.y1 >= 577.0);
        // A title alone, a few stray lines or digits alone are no tooltip
        assert!(tooltip_of(lines_of(&boxes[..1], 1600.0), 1600.0).is_none());
        assert!(tooltip_of(lines_of(&boxes[..3], 1600.0), 1600.0).is_none(), "two body lines: a stray read like \"DDS\" / \"11\"");
        assert!(tooltip_of(lines_of(&[tb(2015.0, 426.0, 40.0, 20.0, "0/0"), tb(2015.0, 450.0, 40.0, 20.0, "0/0")], 1600.0), 1600.0).is_none());
    }

    // The user's screenshots (local/, not in git) against what the tooltips show; skipped without
    // them. Slow in debug builds: cargo test --release.
    mod screenshots {
        use super::super::*;
        use crate::locale::norm;
        use std::path::Path;

        fn setup(dir: &str) -> Option<(Ocr, std::path::PathBuf)> {
            let shots = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../local/screenshots").join(dir);
            if !shots.is_dir() {
                eprintln!("screenshots missing, skipped");
                return None;
            }
            Some((Ocr::new(4, crate::ocr::Model::Tiny, false).unwrap(), shots))
        }

        fn frame(dir: &Path, suffix: &str) -> RgbImage {
            let file = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).find(|p| p.to_string_lossy().ends_with(&format!("{suffix}.jpg"))).unwrap();
            image::open(file).unwrap().to_rgb8()
        }

        /// Whether a line reads as `label` followed by `value` (letters and digits compared)
        fn has_stat(tip: &Tooltip, label: &str, value: &str) -> bool {
            tip.lines.iter().any(|l| norm(&l.text) == norm(&format!("{label}{value}")) || norm(&l.text).starts_with(&norm(&format!("{label}{value}"))))
        }

        #[test]
        fn tooltips_of_the_inventory_screen() {
            let Some((mut ocr, dir)) = setup("inventory 3") else { return };
            let cases: &[(&str, &str, &[(&str, &str)], u32)] = &[
                ("19-58-50-5AE", "Ardor-3 Salvaged Repeater", &[], 2),
                ("19-58-53-039", "M3A Cannon Defense Division", &[], 2),
                ("19-59-02-415", "Civ/1/A Atlas", &[("Integrity:", "200.00"), ("Quantum Speed:", "259.05 Mm/s"), ("Quantum Fuel Burn:", "7.55 per Km")], 2),
                ("19-59-09-0F9", "Mil/3/A Blizzard", &[("Coolant Rating:", "60.00"), ("Integrity:", "1800.00")], 2),
                ("19-59-22-420", "Sth/1/C HeatSafe", &[("Coolant Rating:", "22.00"), ("Integrity:", "110.00")], 2),
                ("19-59-28-865", "Mil/2/B CoverAll", &[("Integrity:", "660.00"), ("Max. Shield Strength:", "10560.00")], 2),
                ("19-59-35-5AD", "Mil/1/B Sovereign IP-10", &[], 2),
                ("19-59-38-F64", "Mil/1/B BriskAir IC-10", &[], 3),
            ];
            for (suffix, title, stats, page) in cases {
                let started = std::time::Instant::now();
                let (read, _boxes) = read_components(&mut ocr, &frame(&dir, suffix), None).unwrap();
                eprintln!("{suffix}: {:?} in {:?}, page {:?}", read.tooltip.as_ref().map(|t| &t.title), started.elapsed(), read.page);
                let tip = read.tooltip.unwrap_or_else(|| panic!("{suffix}: no tooltip"));
                assert_eq!(norm(&tip.title), norm(title), "{suffix}: {}", tip.title);
                for (label, value) in *stats {
                    assert!(has_stat(&tip, label, value), "{suffix}: {label} {value} not in {:?}", tip.lines.iter().map(|l| &l.text).collect::<Vec<_>>());
                }
                // No stat line reads as one where the tooltip has none
                if stats.is_empty() {
                    assert!(!tip.lines.iter().any(|l| norm(&l.text).starts_with("INTEGRITY")), "{suffix}: {:?}", tip.lines);
                }
                assert_eq!(read.page.map(|p| (p.index, p.total)), Some((*page, 3)), "{suffix}");
            }
        }

        #[test]
        fn fps_gear_tooltips_tiles_and_stacks() {
            let Some((mut ocr, dir)) = setup("inventory 4") else { return };
            // Shot, title, stat lines, the last line before a second tooltip, a cursor on the hovered
            // tile (the shots have none: the tile's centre) with its span and stack count
            type Case<'a> = (&'a str, &'a str, &'a [(&'a str, &'a str)], &'a str, (f32, f32), u32, Option<u32>);
            let cases: &[Case] = &[
                ("15-53-26-8DE", "Artimex Arms Canuto", &[("Damage Mitigation:", "0.30"), ("Min Temp:", "-61.00"), ("Max Temp:", "+91.00")], "Registered To You", (2634.0, 467.0), 1, None),
                ("15-54-15-7E3", "Gallant Rifle", &[("Fire Rate:", "900.00 RPM"), ("Impact Force:", "+0.00 %"), ("Recoil Handling:", "-0.00 %")], "Recoil Handling: -0.00 %", (2867.0, 612.0), 2, None),
                ("15-55-06-F11", "CQ7 Rifle", &[("Fire Rate:", "713.49 RPM"), ("Impact Force:", "+6.11 %"), ("Recoil Kick:", "-28.44 %"), ("Recoil Smoothness:", "+28.44 %")], "Recoil Handling: +28.44 %", (0.0, 0.0), 0, None),
                ("15-54-40-B2A", "Emod Stabilizer3", &[], "", (2788.0, 1219.0), 1, Some(2)),
                ("15-54-54-211", "Veil Flash Hider2", &[], "", (0.0, 0.0), 0, None),
            ];
            for (suffix, title, stats, last, cursor, span, count) in cases {
                let frame = frame(&dir, suffix);
                let (read, _boxes) = read_components(&mut ocr, &frame, (*span > 0).then_some(*cursor)).unwrap();
                let tip = read.tooltip.unwrap_or_else(|| panic!("{suffix}: no tooltip"));
                let texts: Vec<&str> = tip.lines.iter().map(|l| l.text.as_str()).collect();
                assert_eq!(norm(&tip.title), norm(title), "{suffix}: {}", tip.title);
                for (label, value) in *stats {
                    assert!(has_stat(&tip, label, value), "{suffix}: {label} {value} not in {texts:?}");
                }
                if !last.is_empty() {
                    assert_eq!(texts.last().map(|t| norm(t)), Some(norm(last)), "{suffix}: {texts:?}");
                }
                // Nothing of the tooltip below (the equipped piece, the weapon list)
                assert!(!texts.iter().any(|t| t.starts_with("1:") || t.contains("Dust Devil") || t.contains("Sion")), "{suffix}: {texts:?}");
                if *span > 0 {
                    let cell = read.cell.unwrap_or_else(|| panic!("{suffix}: no tile at {cursor:?}"));
                    assert_eq!((cell.span, cell.count), (*span, *count), "{suffix}: {cell:?}");
                }
            }
        }
    }
}
