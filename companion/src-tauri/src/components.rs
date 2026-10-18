//! Reads the tooltip of the hovered item in the character inventory (the "Storage Access" screen,
//! SC 4.x; the user's screenshots of 2026-10-18, 3840×1600): the ship component part of the
//! companion's inventory scan. The storage pane on the right is a fixed grid of 4 columns × 6 cells
//! per page (pages "2/3" at its bottom; the pane also scrolls), the tooltip of the hovered tile opens
//! at a fixed place right of the character, not at the cursor: title ("Mil/3/A Blizzard"),
//! "Volume: …", "Item Type: Cooler", manufacturer, size, grade, class, the description and, for
//! components with stats, lines like "Coolant Rating:  60.00" with the value in a column of its own.
//! Everything is read as text lines; what they mean is decided in the frontend (`components.ts`: the
//! title against the catalog, the stat lines against the stat names in the player's language).
//!
//! The UI scales with the frame height and sits around the frame's centre, so every position is a
//! share of the height, horizontally from the centre. Only the tooltip's area and the page number's
//! are run through the OCR; the page number read (`read_page`, ~30 ms) also tells this screen from
//! the freight manager's terminal (`ocrwatch`). The grid cell under the mouse cursor (the capture
//! passes it) gives the column a tile sits in (rows shift with the pane's scroll). Verified on
//! 3840×1600 only.
//!
//! Anything unexpected yields `None` fields, never a panic.

use image::imageops::{self, FilterType};
use image::RgbImage;
use serde::Serialize;

use crate::ocr::{Ocr, Rect, TextBox};

/// The tooltip's area: right of the centre, below the screen's title row
const TIP_LEFT: f32 = 0.02;
const TIP_RIGHT: f32 = 0.42;
const TIP_TOP: f32 = 0.22;
const TIP_BOTTOM: f32 = 0.76;
/// The tooltip's texts are small (~0.012 of the height): its crop is scaled up to what this frame
/// height would show
const TIP_SCALE_HEIGHT: f32 = 2400.0;
/// The page number ("2/3") below the storage grid
const PAGE_LEFT: f32 = 0.50;
const PAGE_RIGHT: f32 = 0.70;
const PAGE_TOP: f32 = 0.81;
const PAGE_BOTTOM: f32 = 0.87;
const PAGE_SCALE: u32 = 2;
/// The storage grid's cells: left edge and top, cell pitch, cells per page
const GRID_LEFT: f32 = 0.400;
const GRID_TOP: f32 = 0.244;
const CELL_W: f32 = 0.098;
const CELL_H: f32 = 0.0938;
const GRID_COLS: u32 = 4;
const GRID_ROWS: u32 = 6;
/// Boxes below this confidence are noise (the character shows through the tooltip's panel)
const MIN_SCORE: f32 = 0.3;
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

/// A cell of the storage grid (0 = top left) with its area in frame pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub row: u32,
    pub col: u32,
    pub rect: Rect,
}

/// What one frame of the inventory screen read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentRead {
    pub tooltip: Option<Tooltip>,
    pub page: Option<Page>,
    /// The grid cell under the mouse cursor (None: no cursor, or outside the grid)
    pub cell: Option<Cell>,
}

fn union(a: Rect, b: Rect) -> Rect {
    Rect { x0: a.x0.min(b.x0), y0: a.y0.min(b.y0), x1: a.x1.max(b.x1), y1: a.y1.max(b.y1) }
}

/// The grid cell at a frame position, if inside the storage grid.
pub fn cell_of(cursor: (f32, f32), frame_w: f32, frame_h: f32) -> Option<Cell> {
    let (cx, s) = (frame_w / 2.0, frame_h);
    let (x, y) = ((cursor.0 - cx) / s, cursor.1 / s);
    let (fx, fy) = ((x - GRID_LEFT) / CELL_W, (y - GRID_TOP) / CELL_H);
    if fx < 0.0 || fy < 0.0 {
        return None;
    }
    let (col, row) = (fx as u32, fy as u32);
    if col >= GRID_COLS || row >= GRID_ROWS {
        return None;
    }
    let (x0, y0) = (cx + (GRID_LEFT + col as f32 * CELL_W) * s, (GRID_TOP + row as f32 * CELL_H) * s);
    Some(Cell { row, col, rect: Rect { x0, y0, x1: x0 + CELL_W * s, y1: y0 + CELL_H * s } })
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
/// body; None without a body line (a stray text is no tooltip).
pub fn tooltip_of(lines: Vec<Line>) -> Option<Tooltip> {
    let mut it = lines.into_iter();
    let title = it.next()?;
    if !title.text.chars().any(char::is_alphabetic) {
        return None;
    }
    let lines: Vec<Line> = it.collect();
    if lines.is_empty() {
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

/// Reads the hovered item's tooltip, the storage pane's page number and the grid cell under the
/// `cursor` (frame pixels) in a frame of the inventory screen. The boxes read, in frame pixels.
pub fn read_components(ocr: &mut Ocr, frame: &RgbImage, cursor: Option<(f32, f32)>) -> Result<(ComponentRead, Vec<TextBox>), String> {
    let (w, h) = frame.dimensions();
    let (tooltip, mut boxes) = read_tooltip(ocr, frame)?;
    let (page, page_boxes) = read_page(ocr, frame)?;
    boxes.extend(page_boxes);
    let cell = cursor.and_then(|c| cell_of(c, w as f32, h as f32));
    Ok((ComponentRead { tooltip, page, cell }, boxes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tb(x0: f32, y0: f32, w: f32, h: f32, text: &str) -> TextBox {
        TextBox { rect: Rect { x0, y0, x1: x0 + w, y1: y0 + h }, text: text.into(), score: 1.0 }
    }

    #[test]
    fn pages_and_cells() {
        assert_eq!(parse_page("2/3"), Some(Page { index: 2, total: 3 }));
        assert_eq!(parse_page(" 1 / 1"), Some(Page { index: 1, total: 1 }));
        assert_eq!(parse_page("0/3"), None);
        assert_eq!(parse_page("4/3"), None);
        assert_eq!(parse_page("2-3"), None);
        assert_eq!(parse_page("10/5000"), None, "an SCU text");
        // 3840×1600: the grid's first tile starts at x ≈ 2560, y ≈ 390; the tile in row 3, column 0 at y ≈ 845
        let at = |x: f32, y: f32| cell_of((x, y), 3840.0, 1600.0).map(|c| (c.row, c.col));
        assert_eq!(at(2600.0, 420.0), Some((0, 0)));
        assert_eq!(at(2640.0, 900.0), Some((3, 0)));
        assert_eq!(at(3100.0, 1200.0), Some((5, 3)));
        let first = cell_of((2600.0, 420.0), 3840.0, 1600.0).unwrap().rect;
        assert!((first.x0 - 2560.0).abs() < 2.0 && (first.y0 - 390.4).abs() < 2.0 && first.w() > 150.0, "{first:?}");
        assert_eq!(at(2400.0, 420.0), None, "left of the grid");
        assert_eq!(at(2600.0, 1400.0), None, "below the grid");
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
        // A title alone or digits alone are no tooltip
        assert!(tooltip_of(lines_of(&boxes[..1], 1600.0)).is_none());
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
