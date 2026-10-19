//! Offline check of the freight manager read over folders of screenshots:
//! `cargo run --release --example inventory_dump -- <out dir> <screenshots dir>...`
//!
//! A debug recording's frames are read with the cursor stored next to them (`read-N.json`).
//! Prints every frame's layout, tooltip and tiles (cell, quality, count, hovered, texts) and the
//! cells read, then writes an overlay per frame into the out dir (the frame at half size: tiles green,
//! the hovered one white, OCR boxes yellow, the tooltip magenta) and the OCR boxes as text.
use std::fs;
use std::path::{Path, PathBuf};

use companion_lib::inventory::read_grid;
use companion_lib::ocr::{Ocr, Rect};
use image::{Rgb, RgbImage};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let out = PathBuf::from(args.remove(0));
    fs::create_dir_all(&out).expect("out dir");
    let mut ocr = Ocr::new(4).expect("ocr models");
    for dir in args {
        for path in sorted(Path::new(&dir), "jpg").into_iter().chain(sorted(Path::new(&dir), "png")) {
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let frame = image::open(&path).expect("frame").to_rgb8();
            let t = std::time::Instant::now();
            let (grid, boxes) = read_grid(&mut ocr, &frame, cursor_of(&path), None, true).expect("read");
            let ms = t.elapsed().as_millis();
            let dump: Vec<String> = boxes.iter().map(|b| format!("{:5.0} {:5.0} {:4.0} {:3.0}  {:.2}  {}", b.rect.x0, b.rect.y0, b.rect.w(), b.rect.h(), b.score, b.text)).collect();
            fs::write(out.join(format!("boxes-{name}.txt")), dump.join("\n")).unwrap();
            let Some(grid) = grid else {
                println!("\n== {name}: no grid ({} boxes, {ms} ms)", boxes.len());
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
