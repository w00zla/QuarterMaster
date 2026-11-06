//! Prints what the OCR reads in an image: `cargo run --release --example ocr_dump -- <image> [max_height] [threads]`
use companion_lib::ocr::Model;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let img = image::open(&args[1]).expect("image").to_rgb8();
    let side: u32 = args.get(2).map_or(800, |s| s.parse().unwrap());
    let threads: usize = args.get(3).map_or(4, |s| s.parse().unwrap());
    let mut ocr = companion_lib::ocr::load(threads, Model::Tiny, false).expect("models");
    let t = std::time::Instant::now();
    let boxes = ocr.read(&img, side).expect("read");
    for b in &boxes {
        println!("{:5.0} {:5.0} {:5.0} {:5.0}  {:.2}  {}", b.rect.x0, b.rect.y0, b.rect.w(), b.rect.h(), b.score, b.text);
    }
    eprintln!("{} boxes in {:?}", boxes.len(), t.elapsed());
}
