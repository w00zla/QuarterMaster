//! Reads the tooltip of the hovered item in the character inventory (the "Storage Access" screen,
//! SC 4.x; the user's screenshots of 2026-10-18, 3840×1600): the ship component part of the
//! companion's inventory scan. The storage pane on the right is a grid 4 units wide, a tile 1 unit
//! (coolers, missiles) or 2 (weapons) wide, 6 rows in view, scrolled row by row (a green thumb on
//! its right), pages "2/3" at its bottom; the tooltip of the hovered tile opens
//! at a fixed place right of the character, not at the cursor: title ("Mil/3/A Blizzard"),
//! "Volume: …", "Item Type: Cooler", manufacturer, size, grade, class, the description and, for
//! components with stats, lines like "Coolant Rating:  60.00" with the value in a column of its own.
//! Everything is read as text lines; what they mean is decided in the frontend (`components.ts`: the
//! title against the catalog, the stat lines against the stat names in the player's language).
//!
//! The UI scales with the frame height and sits around the frame's centre, so every position is a
//! share of the height, horizontally from the centre. Only the tooltip's area and the page number's
//! are run through the OCR; the page number read (`read_page`, ~30 ms) also tells this screen from
//! the freight manager's terminal (`ocrwatch`). The hovered tile (`hovered_tile`): under the mouse
//! cursor (the capture passes it), its units from the lit frame the game draws around it, its row in
//! the page's content from the scrollbar thumb's place, so a tile keeps its place when the pane
//! scrolls and equal tiles stay apart. Verified on 3840×1600 only.
//!
//! Anything unexpected yields `None` fields, never a panic.

use image::imageops::{self, FilterType};
use image::RgbImage;
use serde::Serialize;

use crate::ocr::{Ocr, Rect, TextBox};

/// The tooltip's area: right of the centre, below the screen's title row
const TIP_LEFT: f32 = 0.02;
/// Short of the storage grid (GRID_LEFT): its tiles' texts ("110/0") must not read as tooltip lines
const TIP_RIGHT: f32 = 0.39;
const TIP_TOP: f32 = 0.22;
const TIP_BOTTOM: f32 = 0.76;
/// The tooltip's texts are small (~0.012 of the height): its crop is scaled up to what this frame
/// height would show
const TIP_SCALE_HEIGHT: f32 = 1800.0;
/// The page number ("2/3") below the storage grid
const PAGE_LEFT: f32 = 0.50;
const PAGE_RIGHT: f32 = 0.70;
const PAGE_TOP: f32 = 0.81;
const PAGE_BOTTOM: f32 = 0.87;
const PAGE_SCALE: u32 = 2;
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
/// The hovered tile's light frame: searched this far around a unit edge (tiles leave a gap of ~9 px
/// between them, their frames sit up to ~11 px off the edge at 1600 px height), lit when this share
/// of a column of pixels in the row's middle band has its colour
const EDGE_SEARCH: f32 = 0.008;
const EDGE_SHARE: f32 = 0.6;
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
/// scrolled out of view), its first unit (0–3) and how many it spans, its area in frame pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub row: u32,
    pub col: u32,
    pub span: u32,
    pub rect: Rect,
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

fn union(a: Rect, b: Rect) -> Rect {
    Rect { x0: a.x0.min(b.x0), y0: a.y0.min(b.y0), x1: a.x1.max(b.x1), y1: a.y1.max(b.y1) }
}

/// The scrollbar thumb's green
fn is_thumb(p: &image::Rgb<u8>) -> bool {
    let [r, g, b] = p.0.map(i32::from);
    g > 150 && g > r + 80 && g > b + 40
}

/// The hovered tile's light cyan frame (icons are neutral grey or white, the thumb green)
fn is_frame(p: &image::Rgb<u8>) -> bool {
    let [r, g, b] = p.0.map(i32::from);
    g >= 150 && b >= 150 && g - r >= 25 && b - r >= 30
}

/// The scrollbar thumb (top, length in frame pixels): the longest green run in the columns around
/// the scrollbar; None when the page's content fits (no thumb).
fn find_thumb(frame: &RgbImage) -> Option<(f32, f32)> {
    let (w, h) = frame.dimensions();
    let (cx, s) = (w as f32 / 2.0, h as f32);
    let (y0, y1) = ((TRACK_TOP * s - 2.0).max(0.0) as u32, ((TRACK_BOTTOM * s + 2.0) as u32).min(h));
    let x_mid = cx + SCROLL_X * s;
    let mut best: Option<(u32, u32)> = None;
    for x in (x_mid - SCROLL_SEARCH * s).max(0.0) as u32..((x_mid + SCROLL_SEARCH * s) as u32).min(w) {
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
    best.filter(|&(_, len)| len as f32 >= MIN_THUMB * s).map(|(top, len)| (top as f32, len as f32))
}

/// How far the pane is scrolled (content pixels) for a thumb (top, length); 0 without one. Close to
/// whole rows it is whole rows (the pane snaps to them; between them it animates).
fn scroll_of(thumb: Option<(f32, f32)>, s: f32) -> f32 {
    let Some((top, len)) = thumb else { return 0.0 };
    let rows = ((top - TRACK_TOP * s).max(0.0) * SCROLL_VIEW * s / len) / (CELL_H * s);
    let whole = rows.round();
    (if (rows - whole).abs() <= ROW_SNAP { whole } else { rows }) * CELL_H * s
}

/// The units a tile spans around the cursor's unit, from which unit edges (0–4) are lit: the nearest
/// lit edge at or left of it and the nearest right of it; None when one is missing.
fn span_of(unit: u32, lit: [bool; 5]) -> Option<(u32, u32)> {
    let left = (0..=unit).rev().find(|&k| lit[k as usize])?;
    let right = (unit + 1..=GRID_COLS).find(|&k| lit[k as usize])?;
    Some((left, right - left))
}

/// Whether a lit tile frame runs down near `x` between `y0` and `y1` (a column of pixels that mostly
/// has the frame's colour).
fn frame_edge_at(frame: &RgbImage, x: f32, y0: f32, y1: f32) -> bool {
    let (w, h) = frame.dimensions();
    let s = h as f32;
    let (y0, y1) = (y0.max(0.0) as u32, (y1 as u32).min(h));
    if y1 <= y0 {
        return false;
    }
    let (x0, x1) = ((x - EDGE_SEARCH * s).max(0.0) as u32, ((x + EDGE_SEARCH * s) as u32).min(w.saturating_sub(1)));
    (x0..=x1).any(|x| (y0..y1).filter(|&y| is_frame(frame.get_pixel(x, y))).count() as f32 >= EDGE_SHARE * (y1 - y0) as f32)
}

/// The tile under the cursor (frame pixels): its row in the content (the pane's scroll from the
/// scrollbar thumb), and its units from the lit frame the game draws around the hovered tile, which
/// sits on unit edges. None outside the grid or without a lit tile there.
pub fn hovered_tile(frame: &RgbImage, cursor: (f32, f32)) -> Option<Cell> {
    let (w, h) = frame.dimensions();
    let (cx, s) = (w as f32 / 2.0, h as f32);
    let (x, y) = ((cursor.0 - cx) / s, cursor.1 / s);
    let fx = (x - GRID_LEFT) / CELL_W;
    if fx < 0.0 || fx >= GRID_COLS as f32 || y < GRID_TOP || y >= GRID_TOP + GRID_ROWS as f32 * CELL_H {
        return None;
    }
    let scroll = scroll_of(find_thumb(frame), s);
    let row = ((cursor.1 - GRID_TOP * s + scroll) / (CELL_H * s)) as u32;
    // The row's top in the frame, and its middle band (clear of the frame's corners)
    let top = GRID_TOP * s + row as f32 * CELL_H * s - scroll;
    let (band0, band1) = (top + 0.3 * CELL_H * s, top + 0.7 * CELL_H * s);
    let edge_x = |k: u32| cx + (GRID_LEFT + k as f32 * CELL_W) * s;
    let lit: [bool; 5] = std::array::from_fn(|k| frame_edge_at(frame, edge_x(k as u32), band0, band1));
    let (col, span) = span_of(fx as u32, lit)?;
    Some(Cell { row, col, span, rect: Rect { x0: edge_x(col), y0: top, x1: edge_x(col + span), y1: top + CELL_H * s } })
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

/// The tooltip in the area's lines: the first line is the title (it must hold letters), the rest its
/// body; None with fewer than MIN_BODY_LINES body lines (stray texts of the scene are no tooltip).
pub fn tooltip_of(lines: Vec<Line>) -> Option<Tooltip> {
    let mut it = lines.into_iter();
    let title = it.next()?;
    if title.text.chars().filter(|c| c.is_alphabetic()).count() < MIN_TITLE_LETTERS {
        return None;
    }
    let lines: Vec<Line> = it.collect();
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
    if scale <= 1.0 {
        return crop;
    }
    imageops::resize(&crop, (cw as f32 * scale) as u32, (ch as f32 * scale) as u32, FilterType::CatmullRom)
}

/// Reads the texts in `rect` of `frame` (scaled up by `scale` first); boxes in frame pixels.
fn read_area(ocr: &mut Ocr, frame: &RgbImage, rect: Rect, scale: f32) -> Result<Vec<TextBox>, String> {
    let crop = scaled_crop(frame, rect, scale);
    let mut boxes = ocr.read(&crop, crop.height())?;
    let (ox, oy) = (rect.x0.max(0.0), rect.y0.max(0.0));
    for b in &mut boxes {
        b.rect = Rect { x0: ox + b.rect.x0 / scale, y0: oy + b.rect.y0 / scale, x1: ox + b.rect.x1 / scale, y1: oy + b.rect.y1 / scale };
    }
    Ok(boxes)
}

/// Reads the storage pane's page number ("2/3"): cheap (a small area), and present only on the
/// inventory screen. The boxes read, in frame pixels.
pub fn read_page(ocr: &mut Ocr, frame: &RgbImage) -> Result<(Option<Page>, Vec<TextBox>), String> {
    let (w, h) = frame.dimensions();
    let (s, cx) = (h as f32, w as f32 / 2.0);
    let page_area = Rect { x0: cx + PAGE_LEFT * s, y0: PAGE_TOP * s, x1: cx + PAGE_RIGHT * s, y1: PAGE_BOTTOM * s };
    let boxes = read_area(ocr, frame, page_area, PAGE_SCALE as f32)?;
    let page = boxes.iter().find_map(|b| parse_page(&b.text));
    Ok((page, boxes))
}

/// Reads the hovered item's tooltip in its fixed area. The boxes read, in frame pixels.
pub fn read_tooltip(ocr: &mut Ocr, frame: &RgbImage) -> Result<(Option<Tooltip>, Vec<TextBox>), String> {
    let (w, h) = frame.dimensions();
    let (s, cx) = (h as f32, w as f32 / 2.0);
    let tip_area = Rect { x0: cx + TIP_LEFT * s, y0: TIP_TOP * s, x1: cx + TIP_RIGHT * s, y1: TIP_BOTTOM * s };
    let boxes = read_area(ocr, frame, tip_area, (TIP_SCALE_HEIGHT / s).max(1.0))?;
    let tooltip = tooltip_of(lines_of(&boxes, s));
    Ok((tooltip, boxes))
}

/// Reads the hovered item's tooltip, the storage pane's page number and the tile under the `cursor`
/// (frame pixels) in a frame of the inventory screen. The boxes read, in frame pixels.
pub fn read_components(ocr: &mut Ocr, frame: &RgbImage, cursor: Option<(f32, f32)>) -> Result<(ComponentRead, Vec<TextBox>), String> {
    let (tooltip, mut boxes) = read_tooltip(ocr, frame)?;
    let (page, page_boxes) = read_page(ocr, frame)?;
    boxes.extend(page_boxes);
    let cell = cursor.and_then(|c| hovered_tile(frame, c));
    Ok((ComponentRead { tooltip, page, cell }, boxes))
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
    fn scroll_from_the_thumb() {
        // 3840×1600 (the recording of 2026-10-18): the thumb is 373 px long, at 376 when not scrolled,
        // 621 four rows down, 740 six (or nearly), 930 nine rows down
        let rows = |top: f32| scroll_of(Some((top, 373.0)), 1600.0) / (CELL_H * 1600.0);
        assert_eq!(rows(376.0), 0.0);
        assert_eq!(rows(621.0), 4.0);
        assert_eq!(rows(740.0), 6.0);
        assert_eq!(rows(930.0), 9.0);
        // Halfway between rows (the scroll animation): as it is
        assert!((rows(715.0) - 5.5).abs() < 0.1, "{}", rows(715.0));
        assert_eq!(scroll_of(None, 1600.0), 0.0, "no thumb: the page fits");
    }

    #[test]
    fn spans_from_the_lit_edges() {
        // A wide tile over units 1–2 (edges 1 and 3 lit), the cursor in either of its units
        let wide = [false, true, false, true, false];
        assert_eq!(span_of(1, wide), Some((1, 2)));
        assert_eq!(span_of(2, wide), Some((1, 2)));
        // A single tile at the left edge
        assert_eq!(span_of(0, [true, true, false, false, false]), Some((0, 1)));
        // No lit frame around the cursor
        assert_eq!(span_of(3, wide), None);
        assert_eq!(span_of(0, [false; 5]), None);
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
        let (top, bottom) = (540u32, 690u32);
        for y in top..bottom {
            for x in [2716u32, 2717, 3029, 3030] {
                frame.put_pixel(x, y, image::Rgb([183, 226, 233]));
            }
        }
        // An icon's white inside the tile is no edge
        for y in 580..640 {
            frame.put_pixel(2873, y, image::Rgb([230, 230, 230]));
        }
        let tile = hovered_tile(&frame, (2950.0, 600.0)).expect("a tile");
        assert_eq!((tile.row, tile.col, tile.span), (5, 1, 2), "content row 4 + 1");
        assert!((tile.rect.x0 - 2716.8).abs() < 1.0 && (tile.rect.x1 - 3030.4).abs() < 1.0, "{:?}", tile.rect);
        assert_eq!(hovered_tile(&frame, (2600.0, 600.0)), None, "unit 0: no lit frame");
        assert_eq!(hovered_tile(&frame, (2400.0, 600.0)), None, "left of the grid");
        assert_eq!(hovered_tile(&frame, (2950.0, 1400.0)), None, "below the grid");
    }

    #[test]
    fn lines_join_the_boxes_of_a_row_and_the_first_is_the_title() {
        // The Blizzard tooltip (3840×1600): the title, body lines, two stat lines with the value in a box of its own
        let boxes = vec![
            tb(2015.0, 426.0, 140.0, 20.0, "Mil/3/A Blizzard"),
            tb(2015.0, 448.0, 170.0, 19.0, "Volume: 756000 µSCU"),
            tb(2015.0, 492.0, 150.0, 19.0, "Item Type: Cooler"),
            tb(2015.0, 748.0, 130.0, 19.0, "Coolant Rating:"),
            tb(2195.0, 749.0, 50.0, 18.0, "60.00"),
            tb(2195.0, 771.0, 60.0, 18.0, "1800.00"),
            tb(2015.0, 770.0, 80.0, 19.0, "Integrity:"),
            // Noise: a low score and an oversized box
            TextBox { rect: Rect { x0: 2100.0, y0: 600.0, x1: 2140.0, y1: 620.0 }, text: "|".into(), score: 0.1 },
            tb(2015.0, 300.0, 300.0, 80.0, "START"),
        ];
        let lines = lines_of(&boxes, 1600.0);
        let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["Mil/3/A Blizzard", "Volume: 756000 µSCU", "Item Type: Cooler", "Coolant Rating: 60.00", "Integrity: 1800.00"]);
        let tip = tooltip_of(lines).expect("tooltip");
        assert_eq!(tip.title, "Mil/3/A Blizzard");
        assert_eq!(tip.lines.len(), 4);
        assert!(tip.rect.x1 >= 2255.0 && tip.rect.y1 >= 789.0);
        // A title alone, a few stray lines or digits alone are no tooltip
        assert!(tooltip_of(lines_of(&boxes[..1], 1600.0)).is_none());
        assert!(tooltip_of(lines_of(&boxes[..3], 1600.0)).is_none(), "two body lines: a stray read like \"DDS\" / \"11\"");
        assert!(tooltip_of(lines_of(&[tb(2015.0, 426.0, 40.0, 20.0, "0/0"), tb(2015.0, 450.0, 40.0, 20.0, "0/0")], 1600.0)).is_none());
    }

    // The user's screenshots (local/, not in git) against what the tooltips show; skipped without
    // them. Slow in debug builds: cargo test --release.
    mod screenshots {
        use super::super::*;
        use crate::locale::norm;
        use std::path::Path;

        fn setup() -> Option<(Ocr, std::path::PathBuf)> {
            let shots = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../local/screenshots/inventory 3");
            if !shots.is_dir() {
                eprintln!("screenshots missing, skipped");
                return None;
            }
            Some((Ocr::new(4).unwrap(), shots))
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
            let Some((mut ocr, dir)) = setup() else { return };
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
    }
}
