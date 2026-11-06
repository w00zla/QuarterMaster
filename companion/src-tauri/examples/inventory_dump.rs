//! Offline check of the freight manager read over folders of screenshots:
//! `cargo run --release --example inventory_dump -- <out dir> <screenshots dir>... [--threads n] [--gpu]`
//!
//! A debug recording's frames are read with the cursor stored next to them (`read-N.json`), and,
//! as in the app, around the cursor once a frame of the folder gave a strong layout (one
//! `WarehouseReader` per folder, every tile's badge read as while debugging; its output adapted as in
//! the app, `inventory::to_legacy`).
//! Prints every frame's layout, tooltip and tiles (cell, quality, count, hovered, texts), the cells
//! read and where the read's time went (`ocr::Timings`, the rest is the read's own work; the average
//! at the end), then writes an overlay per frame into the out dir (the frame at half size: tiles green,
//! the hovered one white, OCR boxes yellow, the tooltip magenta) and the OCR boxes as text.
use std::fs;
use std::path::{Path, PathBuf};

use companion_lib::inventory::to_legacy;
use companion_lib::ocr::{self, Model, Rect};
use image::{Rgb, RgbImage};
use sc_ohseearr_sc::{Frame, ScreenReader};
use sc_ohseearr_warehouse::WarehouseReader;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let out = PathBuf::from(args.remove(0));
    fs::create_dir_all(&out).expect("out dir");
    let threads = take_threads(&mut args);
    // --gpu: on DirectML (DirectML.dll 1.15 next to this exe, e.g. copied from resources/ocr)
    let gpu = args.iter().position(|a| a == "--gpu").map(|i| args.remove(i)).is_some();
    let mut ocr = ocr::load(threads, Model::Tiny, gpu).expect("ocr models");
    let mut reader = WarehouseReader::new();
    reader.set_diagnostics(true);
    let (mut frames, mut total_ms, mut model_ms) = (0u128, 0u128, 0u128);
    for dir in args {
        reader.reset();
        for path in sorted(Path::new(&dir), "jpg").into_iter().chain(sorted(Path::new(&dir), "png")) {
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let frame = image::open(&path).expect("frame").to_rgb8();
            let t = std::time::Instant::now();
            let reading = reader.read(&mut ocr, &Frame { id: frames as u64, image: &frame, cursor: cursor_of(&path), locale: None }).expect("read");
            let (grid, boxes) = to_legacy(reading);
            let ms = t.elapsed().as_millis();
            let mut phases = ocr.take_timings();
            phases += reader.take_timings();
            frames += 1;
            total_ms += ms;
            model_ms += phases.total().as_millis();
            let phases = format!("  phases: {phases}, rest {} ms", ms.saturating_sub(phases.total().as_millis()));
            let dump: Vec<String> = boxes.iter().map(|b| format!("{:5.0} {:5.0} {:4.0} {:3.0}  {:.2}  {}", b.rect.x0, b.rect.y0, b.rect.w(), b.rect.h(), b.score, b.text)).collect();
            fs::write(out.join(format!("boxes-{name}.txt")), dump.join("\n")).unwrap();
            let Some(grid) = grid else {
                println!("\n== {name}: no grid ({} boxes, {ms} ms)", boxes.len());
                println!("{phases}");
                continue;
            };
            println!(
                "\n== {name}: {} cols × {} rows, pitch {:.0}×{:.0}, {} boxes, {} tiles, {ms} ms",
                grid.cols.len(),
                grid.rows.len(),
                grid.pitch_x,
                grid.pitch_y,
                boxes.len(),
                grid.tiles.len()
            );
            println!("{phases}");
            match &grid.tooltip {
                Some(t) => println!("  tooltip: {} Q{:?} {:?} SCU at ({:.0}, {:.0})", t.name, t.quality, t.scu, t.x, t.y),
                None => println!("  tooltip: none"),
            }
            for tile in grid.tiles.iter().filter(|t| t.hovered || t.quality.is_some() || t.count.is_some()) {
                println!(
                    "  r{} c{}  Q{:>5} x{:<3}{} {} \"{}\" \"{}\"",
                    tile.row,
                    tile.col,
                    tile.quality.map_or("-".to_string(), |q| format!("{q}{}", if tile.quality_ambiguous { "?" } else { "" })),
                    tile.count.map_or("-".to_string(), |c| c.to_string()),
                    if tile.count_uncertain { "?" } else { " " },
                    if tile.hovered { "HOVER" } else { "     " },
                    tile.badge_text,
                    tile.quality_text
                );
            }
            let mut overlay = frame.clone();
            for b in &boxes {
                draw(&mut overlay, b.rect, Rgb([255, 220, 0]));
            }
            for tile in &grid.tiles {
                draw(&mut overlay, tile.rect, if tile.hovered { Rgb([255, 255, 255]) } else { Rgb([0, 255, 80]) });
            }
            for c in &grid.cells {
                draw(&mut overlay, c.rect, Rgb([0, 200, 255]));
            }
            if let Some(t) = &grid.tooltip {
                draw(&mut overlay, t.rect, Rgb([255, 80, 255]));
            }
            let small = image::imageops::resize(&overlay, overlay.width() / 2, overlay.height() / 2, image::imageops::FilterType::Triangle);
            small.save(out.join(format!("overlay-{name}.png"))).unwrap();
        }
    }
    if frames > 0 {
        let mode = if gpu { "GPU".to_string() } else { format!("{threads} threads") };
        println!("\n{frames} frames, {mode}: {} ms per read, models {} ms, rest {} ms", total_ms / frames, model_ms / frames, (total_ms - model_ms) / frames);
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
    let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(frame.with_extension("json")).ok()?).ok()?;
    let c = json.get("cursor")?.as_array()?;
    Some((c.first()?.as_f64()? as f32, c.get(1)?.as_f64()? as f32))
}

fn sorted(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(dir)
        .expect("dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case(ext)))
        .collect();
    v.sort();
    v
}

fn draw(img: &mut RgbImage, r: Rect, colour: Rgb<u8>) {
    let (w, h) = img.dimensions();
    let clamp = |v: f32, max: u32| (v.max(0.0) as u32).min(max.saturating_sub(1));
    let (x0, y0, x1, y1) = (clamp(r.x0, w), clamp(r.y0, h), clamp(r.x1, w), clamp(r.y1, h));
    for x in x0..=x1 {
        for y in [y0, y0 + 1, y1.saturating_sub(1), y1] {
            img.put_pixel(x, y.min(h - 1), colour);
        }
    }
    for y in y0..=y1 {
        for x in [x0, x0 + 1, x1.saturating_sub(1), x1] {
            img.put_pixel(x.min(w - 1), y, colour);
        }
    }
}
