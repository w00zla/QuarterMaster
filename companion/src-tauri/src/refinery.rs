//! Reads the refinery terminal's work order overview from a frame: the station's name from the
//! terminal's title and every work order shown side by side (each a panel with its own table, the
//! newest not necessarily first), running ("PROCESSING": refined materials with quality and yield in
//! cSCU, time remaining) or finished ("COMPLETED": quality and yield). With more work orders than fit,
//! the terminal scrolls them sideways: a frame shows only some, a panel cut by the edge is left out.
//!
//! Resolution independent: frames are scaled by their height (the game's UI scales with it, on 16:9
//! as on ultrawide). A panel is found by its texts (table head, header, time label) in English or the
//! player's language pack (`locale.rs`), the columns by the table head's words, the rows by the
//! material names below it. A cell the full-frame
//! pass missed (single digits are small) is read again on its own. Names stay as the game shows them
//! (its language); matching them to the catalog happens in the frontend (`refinery.ts`).
//!
//! Layout as of SC 4.x (screenshots 2026-10-07/08); anything unexpected yields no panel or empty
//! fields, never a panic.

use image::RgbImage;
use serde::Serialize;

use crate::locale::{norm, Labels};
use crate::ocr::{resize, FilterType, Ocr, Rect, TextBox};

/// Height the frame is scaled to for the full pass (3840×1600: half)
const READ_HEIGHT: u32 = 800;
/// Height for the cheap check whether a refinery terminal is in view: only its big titles are read
const CHECK_HEIGHT: u32 = 320;
/// Width / height of a box that may hold the table head "MATERIALS YIELDED (CSCU)" (about 12 as
/// one box, about 7 when split before the parenthesis)
const HEAD_RATIO: f32 = 5.0;
/// A row's name starts at most this share of the table head's width ("MATERIALS YIELDED (CSCU)")
/// right of the head's left edge (the material's icon comes first)
const NAME_INDENT: f32 = 0.35;
/// A value cell the full pass missed is upscaled by this before it is read on its own
const CELL_SCALE: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Processing,
    Completed,
}

/// The work orders of one terminal as one frame shows them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// The terminal's title, e.g. "CRU-L1 AMBITIOUS DREAM STATION"
    pub station: Option<String>,
    /// Left to right
    pub orders: Vec<Order>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub status: Status,
    /// Processing: the time remaining
    pub seconds: Option<u32>,
    pub rows: Vec<Row>,
}

/// One table row. Quality 0–1000, yield in cSCU; `None` where nothing could be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub name: String,
    pub quality: Option<u32>,
    pub yield_cscu: Option<u32>,
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
/// into one box ("QUALITY YIELD"), each word then gets its share of the box by its characters. A
/// zero is an O (no label holds a digit; PP-OCRv6 tiny read "TO D0").
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
                    out.push(Column { key: norm(&word).replace('0', "O"), cx: b.rect.x0 + b.rect.w() * mid / total });
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
    status: Status,
    station: Option<String>,
    seconds: Option<u32>,
    /// Name boxes of the rows, top to bottom
    rows: Vec<Rect>,
    names: Vec<String>,
    /// The value columns in table order (processing: QUALITY YIELD TODO DONE; completed: QUALITY YIELD)
    columns: Vec<Column>,
}

/// The columns `wanted` (each: its label in every language) among the head's words, left to right;
/// a label may span up to three words ("TO DO"), its center then lies between them.
fn find_columns(words: &[Column], wanted: &[&Vec<String>]) -> Option<Vec<Column>> {
    let mut out: Vec<Column> = Vec::new();
    for labels in wanted {
        let found = (0..words.len()).find_map(|i| {
            (1..=3).filter(|n| i + n <= words.len()).find_map(|n| {
                let joined: String = words[i..i + n].iter().map(|w| w.key.as_str()).collect();
                labels.contains(&joined).then(|| Column { key: joined, cx: (words[i].cx + words[i + n - 1].cx) / 2.0 })
            })
        })?;
        out.push(found);
    }
    out.sort_by(|a, b| a.cx.total_cmp(&b.cx));
    Some(out)
}

/// The work order panels in a frame, left to right.
fn layouts(boxes: &[TextBox], labels: &Labels) -> Vec<Layout> {
    let mut heads: Vec<&TextBox> = boxes.iter().filter(|b| is_head(&b.text, labels)).collect();
    heads.sort_by(|a, b| a.rect.x0.total_cmp(&b.rect.x0));
    // Each table ends where the next one to its right starts
    (0..heads.len())
        .filter_map(|i| layout_at(boxes, heads[i], heads.get(i + 1).map_or(f32::MAX, |n| n.rect.x0), labels))
        .collect()
}

fn is_head(text: &str, labels: &Labels) -> bool {
    let t = norm(text);
    labels.head.iter().any(|h| t.starts_with(h.as_str()))
}

/// The panel whose table head is `head`, left of `right_limit`.
fn layout_at(boxes: &[TextBox], head: &TextBox, right_limit: f32, labels: &Labels) -> Option<Layout> {
    let find = |pred: &dyn Fn(&str) -> bool| boxes.iter().filter(|b| pred(&norm(&b.text))).collect::<Vec<_>>();
    let unit = head.rect.h();
    // The panel header above the table (the biggest "PROCESSING"/"COMPLETED" there, within this panel)
    let header = find(&|t| labels.processing.iter().chain(&labels.completed).any(|l| l == t))
        .into_iter()
        .filter(|b| b.rect.cy() < head.rect.y0 && b.rect.x0 > head.rect.x0 - unit * 2.0 && b.rect.x1 < right_limit)
        .max_by(|a, b| a.rect.h().total_cmp(&b.rect.h()))?;
    let status = if labels.completed.contains(&norm(&header.text)) { Status::Completed } else { Status::Processing };
    let panel_left = head.rect.x0 - unit;
    let panel_right = (header.rect.x1 + unit).min(right_limit);
    let in_panel = |b: &TextBox| b.rect.cx() > panel_left && b.rect.cx() < panel_right;
    let time = find(&|t| labels.time_remaining.iter().any(|l| l == t)).into_iter().find(|b| b.rect.cy() > head.rect.cy() && in_panel(b));

    // Columns: the head's words right of "MATERIALS …"
    let line: Vec<&TextBox> = boxes
        .iter()
        .filter(|b| (b.rect.cy() - head.rect.cy()).abs() < unit * 0.6 && b.rect.x0 > head.rect.x1 - 1.0 && b.rect.cx() < panel_right)
        .collect();
    let wanted: Vec<&Vec<String>> = if status == Status::Processing {
        vec![&labels.quality, &labels.yield_, &labels.todo, &labels.done]
    } else {
        vec![&labels.quality, &labels.yield_]
    };
    let columns = find_columns(&head_words(&line), &wanted)?;

    // Rows: the names below the head, left of the first column, above the summary lines
    let end = boxes
        .iter()
        .filter(|b| b.rect.y1 > head.rect.y1 && in_panel(b))
        .filter(|b| {
            let t = norm(&b.text);
            // A section label ("// PROCESSING", "// RESULTS") too: a message over the panel may hide the summary lines
            labels.time_remaining.contains(&t) || (labels.yield_.contains(&t) && b.rect.x0 < columns[0].cx - unit) || b.text.trim_start().starts_with("//")
        })
        .filter(|b| b.rect.cy() > head.rect.y1)
        .map(|b| b.rect.y0)
        .fold(time.map_or(f32::MAX, |t| t.rect.y0), f32::min);
    // Names start near the table's left edge, after the material's icon (~50 px at 1600 px height: a
    // share of the head's width, its height is too small a unit), and end before the first column's center
    let mut rows: Vec<&TextBox> = boxes
        .iter()
        .filter(|b| b.rect.y0 > head.rect.y1 - unit * 0.2 && b.rect.y1 < end)
        .filter(|b| b.rect.x0 > head.rect.x0 - unit * 2.0 && b.rect.x0 < head.rect.x0 + NAME_INDENT * head.rect.w() && b.rect.x1 < columns[0].cx)
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

    // The station: the biggest text wholly above the panel header (not another panel's header) that starts left of it (the
    // title may reach over the first panel); not a "// REFINERY SYSTEM C47.02" label (the slanted terminal makes its
    // box as tall as the title's)
    let station = boxes
        .iter()
        .filter(|b| b.rect.y1 < header.rect.y0 && b.rect.x0 < header.rect.x0 && norm(&b.text).len() >= 3 && !b.text.trim_start().starts_with(['/', '|']))
        .max_by(|a, b| a.rect.h().total_cmp(&b.rect.h()))
        .map(|b| b.text.trim().to_string());

    Some(Layout {
        status,
        station,
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

/// What a full read of a frame found.
#[derive(Debug, PartialEq, Eq)]
pub enum Read {
    Overview(Overview),
    /// A refinery terminal, but no work order panel (its start page, a quote, a message over it)
    Terminal,
    Nothing,
}

/// Whether a refinery terminal is likely in view: its big titles ("Refinement Center", a work
/// order's "Processing"/"Completed") read at a low resolution. Cheap (~30–110 ms at two threads on
/// 3840×1600); a false hit only costs a full read.
pub fn terminal_in_view(ocr: &mut Ocr, frame: &RgbImage, labels: &Labels) -> Result<bool, String> {
    let boxes = ocr.read(frame, CHECK_HEIGHT)?;
    Ok(boxes.iter().any(|b| is_title(&b.text, labels)))
}

fn is_title(text: &str, labels: &Labels) -> bool {
    let t = norm(text);
    labels.center.iter().any(|c| t.contains(c.as_str())) || labels.processing.contains(&t) || labels.completed.contains(&t)
}

/// Reads the work order overview in a frame. Only the wide boxes are read first: without a table head
/// among them (most frames) the rest is not read at all.
pub fn read_overview(ocr: &mut Ocr, frame: &RgbImage, labels: &Labels) -> Result<Read, String> {
    let rects = ocr.detect(frame, READ_HEIGHT)?;
    let (wide, rest): (Vec<Rect>, Vec<Rect>) = rects.into_iter().partition(|r| r.w() >= r.h() * HEAD_RATIO);
    let mut boxes = text_boxes(wide.clone(), ocr.recognize_all(frame, &wide)?);
    let terminal = boxes.iter().any(|b| is_title(&b.text, labels) || is_head(&b.text, labels));
    if !boxes.iter().any(|b| is_head(&b.text, labels)) {
        return Ok(if terminal { Read::Terminal } else { Read::Nothing });
    }
    boxes.extend(text_boxes(rest.clone(), ocr.recognize_all(frame, &rest)?));
    boxes.sort_by(|a, b| a.rect.y0.total_cmp(&b.rect.y0).then(a.rect.x0.total_cmp(&b.rect.x0)));
    let found = layouts(&boxes, labels);
    if found.is_empty() {
        return Ok(Read::Terminal);
    }
    // The title is the same for every panel: the leftmost's
    let station = found[0].station.clone();
    let orders = found.into_iter().map(|l| read_order(ocr, frame, &boxes, l)).collect::<Result<_, _>>()?;
    Ok(Read::Overview(Overview { station, orders }))
}

fn text_boxes(rects: Vec<Rect>, texts: Vec<(String, f32)>) -> Vec<TextBox> {
    rects.into_iter().zip(texts).filter(|(_, (t, _))| !t.trim().is_empty()).map(|(rect, (text, score))| TextBox { rect, text, score }).collect()
}

fn read_order(ocr: &mut Ocr, frame: &RgbImage, boxes: &[TextBox], l: Layout) -> Result<Order, String> {
    let mut rows = Vec::new();
    // Quality and yield are the first two columns of both tables
    for (rect, name) in l.rows.iter().zip(&l.names) {
        let mut values = Vec::new();
        for i in 0..2 {
            let c = cell(*rect, &l.columns, i);
            // The full pass's number in this cell, else the cell read on its own: upscaled and as
            // digits only (a lone thin "1" went missing or read as a letter)
            let found = boxes.iter().find(|b| b.rect.cx() > c.x0 && b.rect.cx() < c.x1 && b.rect.cy() > c.y0 && b.rect.cy() < c.y1);
            let value = match found.and_then(|b| parse_number(&b.text)) {
                Some(v) => Some(v),
                None => {
                    let crop = crate::inventory::crop(frame, c);
                    let big = resize(&crop, crop.width() * CELL_SCALE, crop.height() * CELL_SCALE, FilterType::CatmullRom);
                    ocr.recognize_images_only(&[big], "0123456789")?.pop().and_then(|(t, _)| parse_number(&t))
                }
            };
            values.push(value);
        }
        // A row always shows its quality: without one it is a stray text (a message over the panel,
        // "YIELD" half hidden)
        if values[0].is_none() {
            continue;
        }
        rows.push(Row { name: name.clone(), quality: values[0], yield_cscu: values[1] });
    }
    Ok(Order { status: l.status, seconds: l.seconds, rows })
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

    #[test]
    fn columns_of_one_or_more_words_in_any_language() {
        let words = |keys: &[(&str, f32)]| keys.iter().map(|(k, cx)| Column { key: k.to_string(), cx: *cx }).collect::<Vec<_>>();
        let l = Labels::english();
        let found = find_columns(&words(&[("QUALITY", 10.0), ("YIELD", 20.0), ("TO", 29.0), ("DO", 31.0), ("DONE", 40.0)]), &[&l.quality, &l.yield_, &l.todo, &l.done]).unwrap();
        assert_eq!(found.iter().map(|c| (c.key.as_str(), c.cx)).collect::<Vec<_>>(), [("QUALITY", 10.0), ("YIELD", 20.0), ("TODO", 30.0), ("DONE", 40.0)]);
        let de: std::collections::HashMap<String, String> =
            [("refinery_ui_jobcard_table_yield", "Ertrag"), ("refinery_ui_jobcard_table_todo", "To-Do"), ("refinery_ui_jobcard_table_done", "Fertig")]
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
        let l = Labels::with(&de);
        let found = find_columns(&words(&[("QUALITY", 10.0), ("ERTRAG", 20.0), ("TODO", 30.0), ("FERTIG", 40.0)]), &[&l.quality, &l.yield_, &l.todo, &l.done]);
        assert_eq!(found.map(|f| f.len()), Some(4));
        // A column missing: no table
        assert!(find_columns(&words(&[("QUALITY", 10.0), ("YIELD", 20.0)]), &[&l.quality, &l.yield_, &l.todo]).is_none());
    }

    // The user's screenshots (local/, not in git) against what the terminal shows; skipped without
    // them. Slow in debug builds: cargo test --release.
    mod screenshots {
        use super::super::*;
        use std::path::Path;

        const STATION: &str = "CRU-L1 AMBITIOUS DREAM STATION";

        fn setup(folder: &str) -> Option<(Ocr, std::path::PathBuf)> {
            let shots = Path::new(env!("CARGO_MANIFEST_DIR")).join("../local/screenshots").join(folder);
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

        fn read(ocr: &mut Ocr, dir: &Path, suffix: &str) -> Option<Overview> {
            match read_overview(ocr, &frame(dir, suffix), &Labels::english()).unwrap() {
                Read::Overview(o) => Some(o),
                _ => None,
            }
        }

        type Rows<'a> = Vec<(&'a str, Option<u32>, Option<u32>)>;

        fn rows(o: &Order) -> Rows<'_> {
            o.rows.iter().map(|r| (r.name.as_str(), r.quality, r.yield_cscu)).collect()
        }

        #[test]
        fn the_running_job_and_no_overview_elsewhere() {
            let Some((mut ocr, dir)) = setup("refinery flow") else { return };
            let v = read(&mut ocr, &dir, "E87").expect("overview");
            assert_eq!(v.station.as_deref(), Some(STATION));
            assert_eq!(v.orders.len(), 1);
            assert_eq!(v.orders[0].status, Status::Processing);
            assert_eq!(v.orders[0].seconds, Some(57 * 60 + 45));
            assert_eq!(rows(&v.orders[0]), vec![
                ("TITANIUM", Some(516), Some(9)),
                ("ASLARITE", Some(575), Some(8)),
                ("AGRICIUM", Some(346), Some(175)),
                ("AGRICIUM", Some(588), Some(19)),
                ("AGRICIUM", Some(667), Some(20)),
            ]);
            // The welcome screen, the terminal from the side and the quotes
            for suffix in ["20D", "130", "05E", "0F4", "55D"] {
                assert_eq!(read(&mut ocr, &dir, suffix), None, "{suffix}");
            }
        }

        #[test]
        fn the_cheap_check_finds_the_terminal() {
            let l = Labels::english();
            for (folder, suffixes) in [("refinery flow", &["20D", "E87", "0F4"][..]), ("refinery flow 2", &["DC5", "2E4"]), ("refinery flow 3", &["BB4", "575"])] {
                let Some((mut ocr, dir)) = setup(folder) else { return };
                for suffix in suffixes {
                    assert!(terminal_in_view(&mut ocr, &frame(&dir, suffix), &l).unwrap(), "{suffix}");
                }
            }
            let Some((mut ocr, dir)) = setup("refinery flow") else { return };
            // The terminal from the side: nothing readable
            assert!(!terminal_in_view(&mut ocr, &frame(&dir, "130"), &l).unwrap());
        }

        // 2026-10-08: work order 2 started next to the finished work order 1 (right of it)
        #[test]
        fn running_work_order_next_to_a_finished_one() {
            let Some((mut ocr, dir)) = setup("refinery flow 2") else { return };
            let finished = vec![
                ("TITANIUM", Some(516), Some(9)),
                ("ASLARITE", Some(575), Some(8)),
                ("AGRICIUM", Some(346), Some(175)),
                ("AGRICIUM", Some(588), Some(19)),
                ("AGRICIUM", Some(667), Some(20)),
            ];
            // Only the finished work order
            for suffix in ["DC5", "DF8"] {
                let v = read(&mut ocr, &dir, suffix).unwrap_or_else(|| panic!("{suffix}: no overview"));
                assert_eq!(v.orders.len(), 1, "{suffix}");
                assert_eq!(v.orders[0].status, Status::Completed, "{suffix}");
                assert_eq!(rows(&v.orders[0]), finished, "{suffix}");
            }
            // Just accepted (a message over the panel), then the overview
            for suffix in ["2E4", "7A5", "578"] {
                let v = read(&mut ocr, &dir, suffix).unwrap_or_else(|| panic!("{suffix}: no overview"));
                assert_eq!(v.station.as_deref(), Some(STATION), "{suffix}");
                let running: Vec<_> = v.orders.iter().filter(|o| o.status == Status::Processing).collect();
                assert_eq!(running.len(), 1, "{suffix}");
                assert_eq!(running[0].seconds, Some(4 * 3600 + 17 * 60), "{suffix}");
                assert_eq!(rows(running[0]), vec![
                    ("HEPHAESTANITE", Some(572), Some(91)),
                    ("SILICON", Some(310), Some(540)),
                    ("SILICON", Some(510), Some(105)),
                ], "{suffix}");
            }
        }

        // 2026-10-08, later: work order 3 started next to the still running work order 2
        #[test]
        fn two_running_work_orders() {
            let Some((mut ocr, dir)) = setup("refinery flow 3") else { return };
            // Just accepted (a message over the panel), then the overview
            for suffix in ["84C", "F76", "575"] {
                let v = read(&mut ocr, &dir, suffix).unwrap_or_else(|| panic!("{suffix}: no overview"));
                let running: Vec<_> = v.orders.iter().filter(|o| o.status == Status::Processing).collect();
                assert_eq!(running.iter().map(|o| rows(o)).collect::<Vec<_>>(), vec![
                    vec![("HEPHAESTANITE", Some(572), Some(91)), ("SILICON", Some(310), Some(540)), ("SILICON", Some(510), Some(105))],
                    vec![("TITANIUM", Some(516), Some(3)), ("ASLARITE", Some(575), Some(3)), ("AGRICIUM", Some(346), Some(28)), ("AGRICIUM", Some(588), Some(16))],
                ], "{suffix}");
                assert!(running.iter().all(|o| o.seconds.is_some()), "{suffix}");
            }
            // The whole overview: the finished work order 1 left of both
            let v = read(&mut ocr, &dir, "575").unwrap();
            assert_eq!(v.orders.iter().map(|o| o.status).collect::<Vec<_>>(), [Status::Completed, Status::Processing, Status::Processing]);
            assert_eq!(v.orders[1].seconds, Some(2 * 3600 + 54 * 60));
            assert_eq!(v.orders[2].seconds, Some(13 * 60 + 55));
        }
    }
}
