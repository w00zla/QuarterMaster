//! Offline check of the character inventory read over folders of screenshots or debug exports:
//! `cargo run --release --example components_dump -- <screenshots dir>...`
//!
//! Prints every frame's page, tooltip title and lines as the OCR read them (what `components.ts`
//! matches the stat names against), then the boxes of the read areas.
use std::path::{Path, PathBuf};

use companion_lib::components::read_components;
use companion_lib::ocr::Ocr;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut ocr = Ocr::new(4).expect("ocr models");
    for dir in args {
        for path in sorted(Path::new(&dir), "jpg").into_iter().chain(sorted(Path::new(&dir), "png")) {
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let frame = image::open(&path).expect("frame").to_rgb8();
            let t = std::time::Instant::now();
            let (read, boxes) = read_components(&mut ocr, &frame, None).expect("read");
            let ms = t.elapsed().as_millis();
            println!("\n== {name}: page {:?}, {} boxes, {ms} ms", read.page.map(|p| format!("{}/{}", p.index, p.total)), boxes.len());
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
}

fn sorted(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext))).collect())
        .unwrap_or_default();
    files.sort();
    files
}
