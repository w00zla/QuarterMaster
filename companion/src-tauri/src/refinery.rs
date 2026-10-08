//! Reads the refinery terminal's work order panel from a frame: the quote ("SETUP" after "GET
//! QUOTE": method, ores with quality, quantity and yield in cSCU, processing time) or a running job
//! ("PROCESSING": refined materials with quality, yield, to do, done, time remaining), plus the
//! station's name from the terminal's title.
//!
//! Resolution independent: the panel is found by its texts (header, table head, time label), the
//! columns by the table head's words, the rows by the material names below it. A cell the full-frame
//! pass missed (single digits are small) is read again on its own. Names stay as the game shows them
//! (its language); matching them to the catalog happens in the frontend (`refinery.ts`).
//!
//! Layout as of SC 4.x (screenshots 2026-10-07); anything unexpected yields `None` or empty fields,
//! never a panic.

use image::RgbImage;
use serde::Serialize;

use crate::ocr::{Ocr, Rect, TextBox};

/// Longer side the frame is scaled to for the full pass (3840 px wide frames: half).
const READ_SIDE: u32 = 1920;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenKind {
    Quote,
    Processing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub kind: ScreenKind,
    /// The terminal's title, e.g. "CRU-L1 AMBITIOUS DREAM STATION"
    pub station: Option<String>,
    /// Quote only: the picked method as shown ("Dinyx Solventation")
    pub method: Option<String>,
    /// Quote: processing time; processing: time remaining
    pub seconds: Option<u32>,
    pub rows: Vec<Row>,
}

/// One table row. Numbers in cSCU (quality 0–1000); `None` where the game shows "--" or nothing
/// could be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub name: String,
    /// The "INERT MATERIALS" line (never refined)
    pub inert: bool,
    pub quality: Option<u32>,
    /// Quote only: the ore quantity
    pub qty: Option<u32>,
    pub yield_cscu: Option<u32>,
    /// Processing only
    pub todo: Option<u32>,
    pub done: Option<u32>,
}

/// Letters and digits only, upper case: "// PROCESSING TIME" -> "PROCESSINGTIME".
fn norm(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_uppercase).collect()
}

/// "57m 54s", "1h 2m 3s", "0m 36s" -> seconds.
pub fn parse_duration(text: &str) -> Option<u32> {
    let mut total = 0u32;
    let mut number = String::new();
    let mut any = false;
    for c in text.chars() {
        if c.is_ascii_digit() {
            number.push(c);
        } else if matches!(c, 'h' | 'm' | 's' | 'H' | 'M' | 'S') {
            let n: u32 = number.parse().ok()?;
            total += n * match c.to_ascii_lowercase() {
                'h' => 3600,
                'm' => 60,
                _ => 1,
            };
            number.clear();
            any = true;
        } else if !c.is_whitespace() {
            return None;
        }
    }
    (any && number.is_empty()).then_some(total)
}

/// A whole number cell ("175"); "--" and anything else is `None`.
fn parse_number(text: &str) -> Option<u32> {
    let t = text.trim();
    (!t.is_empty() && t.chars().all(|c| c.is_ascii_digit())).then(|| t.parse().ok()).flatten()
}

/// A column of the table: its name (normalized) and center.
#[derive(Debug, Clone)]
struct Column {
    key: String,
    cx: f32,
}

/// The words of the table head with their (estimated) centers: OCR may merge neighbouring heads
/// into one box ("QUALITY YIELD"), each word then gets its share of the box by its characters.
fn head_words(boxes: &[&TextBox]) -> Vec<Column> {
    let mut out = Vec::new();
    for b in boxes {
        let chars: Vec<char> = b.text.chars().collect();
        let total = chars.len().max(1) as f32;
        let mut start = None;
        for (i, c) in chars.iter().chain(std::iter::once(&' ')).enumerate() {
            match (c.is_whitespace(), start) {
                (false, None) => start = Some(i),
                (true, Some(s)) => {
                    let word: String = chars[s..i].iter().collect();
                    let mid = (s + i) as f32 / 2.0;
                    out.push(Column { key: norm(&word), cx: b.rect.x0 + b.rect.w() * mid / total });
                    start = None;
                }
                _ => {}
            }
        }
    }
    out.sort_by(|a, b| a.cx.total_cmp(&b.cx));
    out
}

/// Where a parse found things, before the cells are read.
struct Layout {
    kind: ScreenKind,
    station: Option<String>,
    method: Option<String>,
    seconds: Option<u32>,
    /// Name boxes of the rows, top to bottom
    rows: Vec<Rect>,
    names: Vec<String>,
    /// The value columns in table order (quote: QUALITY QTY YIELD; processing: QUALITY YIELD TODO DONE)
    columns: Vec<Column>,
}

fn layout(boxes: &[TextBox]) -> Option<Layout> {
    let find = |pred: &dyn Fn(&str) -> bool| boxes.iter().filter(|b| pred(&norm(&b.text))).collect::<Vec<_>>();
    // The table head decides what the panel shows
    let (kind, head) = if let Some(h) = find(&|t| t.starts_with("MATERIALSSELECTED")).first().copied() {
        (ScreenKind::Quote, h)
    } else {
        (ScreenKind::Processing, find(&|t| t.starts_with("MATERIALSYIELDED")).first().copied()?)
    };
    let unit = head.rect.h();
    // The panel header above the table (the biggest "SETUP"/"PROCESSING" there)
    let title = if kind == ScreenKind::Quote { "SETUP" } else { "PROCESSING" };
    let header = find(&|t| t == title)
        .into_iter()
        .filter(|b| b.rect.cy() < head.rect.y0)
        .max_by(|a, b| a.rect.h().total_cmp(&b.rect.h()))?;
    let time_label = if kind == ScreenKind::Quote { "PROCESSINGTIME" } else { "TIMEREMAINING" };
    let time = find(&|t| t == time_label).into_iter().find(|b| b.rect.cy() > head.rect.cy());
    let panel_left = head.rect.x0 - unit;
    let panel_right = header.rect.x1 + unit;
    let in_panel = |b: &TextBox| b.rect.cx() > panel_left && b.rect.cx() < panel_right;

    // Columns: the head's words right of "MATERIALS …"
    let line: Vec<&TextBox> = boxes
        .iter()
        .filter(|b| (b.rect.cy() - head.rect.cy()).abs() < unit * 0.6 && b.rect.x0 > head.rect.x1 - 1.0 && b.rect.cx() < panel_right)
        .collect();
    let wanted: &[&str] = if kind == ScreenKind::Quote { &["QUALITY", "QTY", "YIELD"] } else { &["QUALITY", "YIELD", "TO", "DONE"] };
    let mut columns: Vec<Column> = Vec::new();
    let words = head_words(&line);
    for (i, w) in words.iter().enumerate() {
        // "TO DO" is two words: its center lies between them
        if w.key == "TO" {
            if let Some(next) = words.get(i + 1).filter(|n| n.key == "DO") {
                columns.push(Column { key: "TODO".into(), cx: (w.cx + next.cx) / 2.0 });
                continue;
            }
        }
        if wanted.contains(&w.key.as_str()) && w.key != "TO" {
            columns.push(w.clone());
        }
    }
    let expected = if kind == ScreenKind::Quote { 3 } else { 4 };
    if columns.len() != expected {
        return None;
    }

    // Rows: the names below the head, left of the first column, above the summary lines
    let end = boxes
        .iter()
        .filter(|b| b.rect.cy() > head.rect.y1 && in_panel(b))
        .filter(|b| {
            let t = norm(&b.text);
            t == "TOTALCOST" || t == time_label || (t == "YIELD" && b.rect.x0 < columns[0].cx - unit)
        })
        .map(|b| b.rect.y0)
        .fold(time.map_or(f32::MAX, |t| t.rect.y0), f32::min);
    // Names start at the table's left edge and end before the first column's center
    let mut rows: Vec<&TextBox> = boxes
        .iter()
        .filter(|b| b.rect.y0 > head.rect.y1 - unit * 0.2 && b.rect.y1 < end)
        .filter(|b| (b.rect.x0 - head.rect.x0).abs() < unit * 2.0 && b.rect.x1 < columns[0].cx)
        .filter(|b| {
            let t = norm(&b.text);
            t.len() >= 3 && t.chars().any(|c| c.is_alphabetic())
        })
        .collect();
    rows.sort_by(|a, b| a.rect.y0.total_cmp(&b.rect.y0));

    let seconds = time.and_then(|t| {
        boxes
            .iter()
            .filter(|b| b.rect.x0 > t.rect.x1 && b.rect.x0 < panel_right && (b.rect.cy() - t.rect.cy()).abs() < t.rect.h())
            .find_map(|b| parse_duration(&b.text))
    });

    // Quote: the method below "// PROCESSING SELECTION, …" (not the "… SPEED // … COST // … YIELD" line)
    let method = (kind == ScreenKind::Quote)
        .then(|| {
            let anchor = find(&|t| t.starts_with("PROCESSINGSELECTION")).into_iter().next()?;
            boxes
                .iter()
                .filter(|b| b.rect.y0 > anchor.rect.y1 - 1.0 && b.rect.y1 < head.rect.y0 && in_panel(b) && !b.text.contains("//"))
                .min_by(|a, b| a.rect.y0.total_cmp(&b.rect.y0))
                .map(|b| b.text.trim().to_string())
        })
        .flatten();

    // The station: the biggest text above the panel header, left of it
    let station = boxes
        .iter()
        .filter(|b| b.rect.cy() < header.rect.cy() && b.rect.x1 < header.rect.x0 && norm(&b.text).len() >= 3)
        .max_by(|a, b| a.rect.h().total_cmp(&b.rect.h()))
        .map(|b| b.text.trim().to_string());

    Some(Layout {
        kind,
        station,
        method,
        seconds,
        names: rows.iter().map(|b| b.text.trim().to_string()).collect(),
        rows: rows.iter().map(|b| b.rect).collect(),
        columns,
    })
}

/// The cell of a row in a column: between the column's neighbours, the row's height.
fn cell(row: Rect, columns: &[Column], i: usize) -> Rect {
    let cx = columns[i].cx;
    let left = if i > 0 { (columns[i - 1].cx + cx) / 2.0 } else { cx - (columns[1].cx - cx) / 2.0 };
    let right = if i + 1 < columns.len() { (columns[i + 1].cx + cx) / 2.0 } else { cx + (cx - columns[i - 1].cx) / 2.0 };
    let pad = row.h() * 0.2;
    Rect { x0: left, y0: row.y0 - pad, x1: right, y1: row.y1 + pad }
}

/// Reads the refinery panel in a frame; `None` when there is none (or it cannot be made out).
pub fn read_screen(ocr: &mut Ocr, frame: &RgbImage) -> Result<Option<Screen>, String> {
    let boxes = ocr.read(frame, READ_SIDE)?;
    let Some(l) = layout(&boxes) else { return Ok(None) };
    let mut rows = Vec::new();
    for (rect, name) in l.rows.iter().zip(&l.names) {
        let mut values = Vec::new();
        for i in 0..l.columns.len() {
            let c = cell(*rect, &l.columns, i);
            // The full pass's box in this cell, else the cell read on its own
            let found = boxes.iter().find(|b| b.rect.cx() > c.x0 && b.rect.cx() < c.x1 && b.rect.cy() > c.y0 && b.rect.cy() < c.y1);
            let text = match found {
                Some(b) => b.text.clone(),
                None => ocr.recognize(frame, c)?.0,
            };
            values.push(parse_number(&text));
        }
        let inert = norm(name).ends_with("MATERIALS");
        rows.push(match l.kind {
            ScreenKind::Quote => Row { name: name.clone(), inert, quality: values[0], qty: values[1], yield_cscu: values[2], todo: None, done: None },
            ScreenKind::Processing => Row { name: name.clone(), inert, quality: values[0], qty: None, yield_cscu: values[1], todo: values[2], done: values[3] },
        });
    }
    Ok(Some(Screen { kind: l.kind, station: l.station, method: l.method, seconds: l.seconds, rows }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(parse_duration("57m 54s"), Some(3474));
        assert_eq!(parse_duration("0m 36s"), Some(36));
        assert_eq!(parse_duration("1h 2m 3s"), Some(3723));
        assert_eq!(parse_duration("--"), None);
        assert_eq!(parse_duration("12"), None);
        assert_eq!(parse_duration("CONFIRM"), None);
    }

    #[test]
    fn numbers() {
        assert_eq!(parse_number(" 175 "), Some(175));
        assert_eq!(parse_number("--"), None);
        assert_eq!(parse_number("1O"), None);
    }

    #[test]
    fn merged_head_words_get_their_share() {
        let b = TextBox { rect: Rect { x0: 0.0, y0: 0.0, x1: 130.0, y1: 10.0 }, text: "QUALITY YIELD".into(), score: 1.0 };
        let w = head_words(&[&b]);
        assert_eq!(w.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(), ["QUALITY", "YIELD"]);
        assert!((w[0].cx - 35.0).abs() < 1.0 && (w[1].cx - 105.0).abs() < 1.0);
    }

    // The user's screenshots (local/, not in git) against what the terminal shows; skipped without
    // them. Slow in debug builds: cargo test --release.
    mod screenshots {
        use super::super::*;
        use std::path::Path;

        fn setup() -> Option<(Ocr, std::path::PathBuf)> {
            let shots = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../local/screenshots/refinery flow");
            if !shots.is_dir() {
                eprintln!("screenshots missing, skipped");
                return None;
            }
            Some((Ocr::new(4).unwrap(), shots))
        }

        fn read(ocr: &mut Ocr, dir: &Path, suffix: &str) -> Option<Screen> {
            let file = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).find(|p| p.to_string_lossy().ends_with(&format!("{suffix}.jpg"))).unwrap();
            read_screen(ocr, &image::open(file).unwrap().to_rgb8()).unwrap()
        }

        #[test]
        fn quotes_and_the_running_job() {
            let Some((mut ocr, dir)) = setup() else { return };
            let quotes = [
                ("05E", "Cormack Method", [6, 5, 122, 13, 14], 72),
                ("0F4", "Dinyx Solventation", [9, 8, 175, 19, 20], 3474),
                ("7E7", "Thermonatic Deposition", [8, 7, 148, 16, 17], 868),
                ("FF2", "XCR Reaction", [6, 5, 122, 13, 14], 36),
                ("607", "Gaskin Process", [8, 7, 148, 16, 17], 144),
                ("493", "Kazen Winnowing", [6, 5, 122, 13, 14], 217),
                ("989", "Pyrometric Chromalysis", [9, 8, 175, 19, 20], 579),
                ("F3B", "Ferron Exchange", [9, 8, 175, 19, 20], 1158),
                ("55D", "Electrostarolysis", [8, 7, 148, 16, 17], 289),
            ];
            let ores = [("TITANIUM (ORE)", 516, 21), ("ASLARITE (RAW)", 575, 18), ("AGRICIUM (ORE)", 346, 389), ("AGRICIUM (ORE)", 588, 43), ("AGRICIUM (ORE)", 667, 46)];
            for (suffix, method, yields, seconds) in quotes {
                let s = read(&mut ocr, &dir, suffix).unwrap_or_else(|| panic!("{suffix}: no panel"));
                assert_eq!(s.kind, ScreenKind::Quote, "{suffix}");
                assert_eq!(s.station.as_deref(), Some("CRU-L1 AMBITIOUS DREAM STATION"), "{suffix}");
                assert_eq!(s.method.as_deref(), Some(method), "{suffix}");
                assert_eq!(s.seconds, Some(seconds), "{suffix}");
                let refined: Vec<_> = s.rows.iter().filter(|r| !r.inert).collect();
                let got: Vec<_> = refined.iter().map(|r| (r.name.as_str(), r.quality, r.qty, r.yield_cscu)).collect();
                let want: Vec<_> = ores.iter().zip(yields).map(|(&(n, q, a), y)| (n, Some(q), Some(a), Some(y))).collect();
                assert_eq!(got, want, "{suffix}");
            }

            let p = read(&mut ocr, &dir, "E87").expect("processing panel");
            assert_eq!(p.kind, ScreenKind::Processing);
            assert_eq!(p.seconds, Some(57 * 60 + 45));
            let got: Vec<_> = p.rows.iter().map(|r| (r.name.as_str(), r.quality, r.yield_cscu, r.todo, r.done)).collect();
            assert_eq!(got, vec![
                ("TITANIUM", Some(516), Some(9), Some(10), Some(0)),
                ("ASLARITE", Some(575), Some(8), Some(9), Some(0)),
                ("AGRICIUM", Some(346), Some(175), Some(175), Some(0)),
                ("AGRICIUM", Some(588), Some(19), Some(20), Some(0)),
                ("AGRICIUM", Some(667), Some(20), Some(21), Some(0)),
            ]);
        }

        #[test]
        fn no_panel_on_other_screens() {
            let Some((mut ocr, dir)) = setup() else { return };
            // The welcome screen, and the terminal from the side
            for suffix in ["20D", "130"] {
                assert_eq!(read(&mut ocr, &dir, suffix), None, "{suffix}");
            }
        }
    }
}
