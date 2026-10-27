//! Offline check of the character inventory read over folders of screenshots or debug exports:
//! `cargo run --release --example components_dump -- <screenshots dir>... [--threads n] [--model small|tiny] [--gpu]`
//!
//! A debug recording's frames are read with the cursor stored next to them (`read-N.json`).
//! Prints every frame's page, the tile under the cursor, tooltip title and lines as the OCR read them (what `components.ts`
//! matches the stat names against), then the boxes of the read areas; per frame and on average where
//! the read's time went (`ocr::Timings`, the rest is the read's own work).
use std::path::{Path, PathBuf};

use companion_lib::components::read_components;
use companion_lib::ocr::{Model, Ocr};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let threads = take_threads(&mut args);
    let model = take_model(&mut args);
    // --gpu: on DirectML (DirectML.dll 1.15 next to this exe, e.g. copied from resources/ocr)
    let gpu = args.iter().position(|a| a == "--gpu").map(|i| args.remove(i)).is_some();
    let mut ocr = Ocr::new(threads, model, gpu).expect("ocr models");
    let (mut frames, mut total_ms, mut model_ms) = (0u128, 0u128, 0u128);
    for dir in args {
        for path in sorted(Path::new(&dir), "jpg").into_iter().chain(sorted(Path::new(&dir), "png")) {
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let frame = image::open(&path).expect("frame").to_rgb8();
            let t = std::time::Instant::now();
            let cursor = cursor_of(&path);
            let (read, boxes) = read_components(&mut ocr, &frame, cursor).expect("read");
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
        }
    }
    if frames > 0 {
        let mode = if gpu { "GPU".to_string() } else { format!("{threads} threads") };
        println!("\n{frames} frames, {model:?}, {mode}: {} ms per read, models {} ms, rest {} ms", total_ms / frames, model_ms / frames, (total_ms - model_ms) / frames);
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

/// `--model small|tiny` out of the arguments, else tiny (the app's model here).
fn take_model(args: &mut Vec<String>) -> Model {
    let Some(i) = args.iter().position(|a| a == "--model") else { return Model::Tiny };
    let m = args.get(i + 1).and_then(|n| Model::parse(n)).expect("--model small|tiny");
    args.drain(i..i + 2);
    m
}
