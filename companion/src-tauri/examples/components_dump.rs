//! Offline check of the character inventory read over folders of screenshots or debug exports:
//! `cargo run --release --example components_dump -- <screenshots dir>... [--threads n] [--gpu]`
//!
//! A debug recording's frames are read with the cursor stored next to them (`read-N.json`), each on its
//! own (sc-ohseearr's `read_components`: the page over every place, the tooltip always; adapted as in the
//! app, `components::to_legacy`).
//! Prints every frame's page, the tile under the cursor, tooltip title and lines as the OCR read them (what `components.ts`
//! matches the stat names against), then the boxes of the read areas; per frame and on average where
//! the read's time went (`ocr::Timings`, the rest is the read's own work).
//!
//! `--dataset <out dir>`: also cuts every tooltip line (title and lines) from its frame, a line-crop dataset for
//! sc-ohseearr's `training/rec` (the recognizer's evaluation set): `<out>/crops/<set>/<frame>_<k>.png` and
//! `<out>/index.tsv` (file, set, frame, k, kind, box, score, frame size, the line's text as read). A folder can be
//! given as `<set>=<dir>` (default set name: the folder's name). The labels come from
//! `tools/dataset-export/ocr-eval-label.ts` (index.tsv → labels.tsv).
use std::path::{Path, PathBuf};

use companion_lib::components::{to_legacy, Tooltip};
use companion_lib::ocr::{self, TextBox};
use image::RgbImage;
use sc_ohseearr_gear_inventory::read_components;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let threads = take_threads(&mut args);
    // --gpu: on DirectML (DirectML.dll 1.15 next to this exe, e.g. copied from resources/ocr)
    let gpu = args.iter().position(|a| a == "--gpu").map(|i| args.remove(i)).is_some();
    let mut dataset = args.iter().position(|a| a == "--dataset").map(|i| {
        let out = PathBuf::from(args.get(i + 1).expect("--dataset <out dir>"));
        args.drain(i..i + 2);
        Dataset { out, rows: Vec::new(), report: Vec::new() }
    });
    let mut ocr = ocr::load(threads, gpu).expect("ocr models");
    let (mut frames, mut total_ms, mut model_ms) = (0u128, 0u128, 0u128);
    for arg in args {
        let (set, dir) = match arg.split_once('=') {
            Some((set, dir)) => (set.to_string(), dir.to_string()),
            None => (Path::new(&arg).file_name().map_or(arg.clone(), |n| n.to_string_lossy().to_string()), arg),
        };
        if let Some(d) = &mut dataset {
            d.report.push((set.clone(), 0, 0, 0));
        }
        for path in sorted(Path::new(&dir), "jpg").into_iter().chain(sorted(Path::new(&dir), "png")) {
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let frame = image::open(&path).expect("frame").to_rgb8();
            let t = std::time::Instant::now();
            let cursor = cursor_of(&path);
            let (read, boxes) = to_legacy(read_components(&mut ocr, &frame, cursor, None).expect("read"));
            let ms = t.elapsed().as_millis();
            let phases = ocr.take_timings();
            frames += 1;
            total_ms += ms;
            model_ms += phases.total().as_millis();
            println!(
                "\n== {name}: page {:?}, cursor {cursor:?} in tile {:?}, {} boxes, {ms} ms",
                read.page.map(|p| format!("{}/{}", p.index, p.total)),
                read.cell.map(|c| (c.row, c.col, c.span)),
                boxes.len()
            );
            println!("  phases: {phases}, rest {} ms", ms.saturating_sub(phases.total().as_millis()));
            match &read.tooltip {
                Some(tip) => {
                    println!("  title: {}", tip.title);
                    for l in &tip.lines {
                        println!("  {:5.0} {:5.0}  {}", l.rect.x0, l.rect.y0, l.text);
                    }
                }
                None => println!("  no tooltip"),
            }
            println!("  boxes:");
            for b in &boxes {
                println!("  {:5.0} {:5.0} {:4.0} {:3.0}  {:.2}  {}", b.rect.x0, b.rect.y0, b.rect.w(), b.rect.h(), b.score, b.text);
            }
            if let (Some(d), Some(tip)) = (&mut dataset, &read.tooltip) {
                d.add(&set, &name, &frame, tip, &boxes);
            }
        }
    }
    if frames > 0 {
        let mode = if gpu { "GPU".to_string() } else { format!("{threads} threads") };
        println!("\n{frames} frames, {mode}: {} ms per read, models {} ms, rest {} ms", total_ms / frames, model_ms / frames, (total_ms - model_ms) / frames);
    }
    if let Some(d) = dataset {
        d.finish();
    }
}

/// The tooltip lines cut from their frames (`--dataset`).
struct Dataset {
    out: PathBuf,
    /// index.tsv's rows
    rows: Vec<String>,
    /// Per set: frames with a tooltip, lines cut, lines without a box
    report: Vec<(String, usize, usize, usize)>,
}

impl Dataset {
    /// Cuts the title and every line of a frame's tooltip, each at the box of the same text (the title: the topmost
    /// such box; a line: the one at its position, within 1 px). The boxes are taken in whole pixels, as the dump
    /// prints them (the datasets made before from that text output keep their boxes).
    fn add(&mut self, set: &str, frame_name: &str, frame: &RgbImage, tip: &Tooltip, boxes: &[TextBox]) {
        let px = |v: f32| -> i64 { format!("{v:.0}").parse().unwrap() };
        let boxes: Vec<(i64, i64, i64, i64, &TextBox)> =
            boxes.iter().map(|b| (px(b.rect.x0), px(b.rect.y0), px(b.rect.w()), px(b.rect.h()), b)).collect();
        let report = self.report.last_mut().expect("set");
        report.1 += 1;
        let dir = self.out.join("crops").join(set);
        std::fs::create_dir_all(&dir).expect("crops dir");
        let (w, h) = (frame.width() as i64, frame.height() as i64);
        let want = std::iter::once(("title", tip.title.as_str(), None))
            .chain(tip.lines.iter().map(|l| ("line", l.text.as_str(), Some((px(l.rect.x0), px(l.rect.y0))))));
        let (mut used, mut k) = (Vec::new(), 0);
        for (kind, text, at) in want {
            let mut cands: Vec<usize> = (0..boxes.len())
                .filter(|&i| boxes[i].4.text == text && !used.contains(&i))
                .filter(|&i| at.is_none_or(|(x, y)| (boxes[i].0 - x).abs() <= 1 && (boxes[i].1 - y).abs() <= 1))
                .collect();
            if at.is_none() {
                cands.sort_by_key(|&i| boxes[i].1);
            }
            let Some(&i) = cands.first() else {
                report.3 += 1;
                continue;
            };
            used.push(i);
            let (bx, by, bw, bh, b) = boxes[i];
            let (x0, y0, x1, y1) = (bx.max(0), by.max(0), (bx + bw).min(w), (by + bh).min(h));
            if x1 <= x0 || y1 <= y0 {
                report.3 += 1;
                continue;
            }
            let file = format!("crops/{set}/{frame_name}_{k}.png");
            image::imageops::crop_imm(frame, x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32)
                .to_image()
                .save(self.out.join(&file))
                .expect("crop");
            let text = text.replace('\t', " ");
            self.rows.push(format!("{file}\t{set}\t{frame_name}\t{k}\t{kind}\t{bx}\t{by}\t{bw}\t{bh}\t{:.2}\t{w}\t{h}\t{text}", b.score));
            report.2 += 1;
            k += 1;
        }
    }

    fn finish(self) {
        let header = "file\tset\tframe\tk\tkind\tx0\ty0\tw\th\tscore\tframe_w\tframe_h\ttext";
        let body: String = std::iter::once(header).chain(self.rows.iter().map(String::as_str)).map(|r| format!("{r}\n")).collect();
        std::fs::write(self.out.join("index.tsv"), body).expect("index.tsv");
        for (set, frames, lines, unmatched) in &self.report {
            println!("dataset {set}: {frames} frames with a tooltip, {lines} lines, {unmatched} without a box");
        }
    }
}

/// `--threads n` out of the arguments (ONNX Runtime's intra-op threads; the app uses 3), else 4.
fn take_threads(args: &mut Vec<String>) -> usize {
    let Some(i) = args.iter().position(|a| a == "--threads") else { return 4 };
    let n = args.get(i + 1).and_then(|n| n.parse().ok()).expect("--threads n");
    args.drain(i..i + 2);
    n
}

/// The cursor a debug recording stored with the frame (`read-N.json` next to `read-N.jpg`), if any.
fn cursor_of(frame: &Path) -> Option<(f32, f32)> {
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(frame.with_extension("json")).ok()?).ok()?;
    let c = json.get("cursor")?.as_array()?;
    Some((c.first()?.as_f64()? as f32, c.get(1)?.as_f64()? as f32))
}

fn sorted(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext))).collect())
        .unwrap_or_default();
    files.sort();
    files
}
