// Packs the rendered icons (packshot's set live, ../sc-packshot/local/packshot/sets/live/[<Name> (<class>) ]<uuid>.png, 256 px;
// only the UUID at the end counts) into thumbnails for the apps: three AVIFs per UUID (s/m/l, src/thumbs.ts),
// trimmed to the content and padded square with a small border, plus thumbs.json {uuid: hash}. Hash = the first 8
// hex characters of the PNG's SHA-256: a newly rendered icon gets a new URL, unchanged ones stay in the clients'
// cache. Stale files in the target are deleted.
// Usage: pnpm thumbs:build [--in ../sc-packshot/local/packshot/sets/live] [--out local/thumbs] [--force]

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use image::{ImageBuffer, Rgba, RgbaImage, imageops};
use rayon::prelude::*;
use sha2::{Digest, Sha256};

const HELP: &str = "Usage: pnpm thumbs:build [options]
  --in <dir>     The PNGs, …<uuid>.png (default: ../sc-packshot/local/packshot/sets/live; subfolders are not read)
  --out <dir>    Target: s/, m/, l/ and thumbs.json (default: local/thumbs)
  --force        Create existing thumbnails again";

// Pixel size per thumbnail size; must match THUMB_SIZES in src/thumbs.ts
const SIZES: [(&str, u32); 3] = [("s", 40), ("m", 96), ("l", 256)];
// AVIF quality (ravif's scale) and encoder speed (1 slowest .. 10 fastest). Measured 2026-11-05 on 304 icons without
// rav1e's asm (no nasm): speed 6 packs them in 3 s at about the sizes of the former sharp q45 output (S 0.9, M 1.6,
// L 3.5 KB); speed 4 is ~10 % smaller but 5x slower. 8-bit: sharp 0.34's libheif could not decode ravif's default 10-bit
// 4:4:4, 8-bit decodes everywhere tested and is no bigger.
const QUALITY: f32 = 45.0;
const SPEED: u8 = 6;
// Alpha at or below this counts as background when trimming
const TRIM_ALPHA: u8 = 1;

struct Args {
    input: PathBuf,
    output: PathBuf,
    force: bool,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        input: PathBuf::from("../sc-packshot/local/packshot/sets/live"),
        output: PathBuf::from("local/thumbs"),
        force: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--in" => args.input = it.next().context("--in needs a directory")?.into(),
            "--out" => args.output = it.next().context("--out needs a directory")?.into(),
            "--force" => args.force = true,
            "--help" | "-h" => {
                println!("{HELP}");
                std::process::exit(0);
            }
            _ => bail!("Unknown argument: {a}\n{HELP}"),
        }
    }
    Ok(args)
}

/// The lower-case UUID at the end of `…<uuid>.png`, if the name has one.
fn uuid_of(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".png").or_else(|| name.strip_suffix(".PNG"))?;
    let uuid = stem.get(stem.len().checked_sub(36)?..)?;
    is_uuid(uuid).then(|| uuid.to_ascii_lowercase())
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// `<uuid>.<hash>.avif` -> (uuid, hash), else None (src/thumbs.ts THUMB_FILE).
fn parse_thumb(name: &str) -> Option<(&str, &str)> {
    let stem = name.strip_suffix(".avif")?;
    let (uuid, hash) = stem.split_once('.')?;
    let lower = |s: &str| s.bytes().all(|b| !b.is_ascii_uppercase());
    (is_uuid(uuid) && lower(uuid) && hash.len() == 8 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        .then_some((uuid, hash))
}

fn thumb_file(uuid: &str, hash: &str) -> String {
    format!("{uuid}.{hash}.avif")
}

/// The bounding box of the pixels above TRIM_ALPHA; the whole image if none is.
fn trim(img: &RgbaImage) -> RgbaImage {
    let (w, h) = img.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for (x, y, p) in img.enumerate_pixels() {
        if p[3] > TRIM_ALPHA {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    if x0 > x1 {
        return img.clone();
    }
    imageops::crop_imm(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image()
}

/// Premultiplied float copy: resizing with straight alpha would bleed the transparent pixels' color into the edges.
fn premultiply(img: &RgbaImage) -> ImageBuffer<Rgba<f32>, Vec<f32>> {
    ImageBuffer::from_fn(img.width(), img.height(), |x, y| {
        let p = img.get_pixel(x, y);
        let a = p[3] as f32 / 255.0;
        Rgba([p[0] as f32 / 255.0 * a, p[1] as f32 / 255.0 * a, p[2] as f32 / 255.0 * a, a])
    })
}

/// Fits the trimmed image into `px` minus the border (Lanczos3, centered, enlarging too) on a transparent square.
fn fit(trimmed: &ImageBuffer<Rgba<f32>, Vec<f32>>, px: u32) -> RgbaImage {
    let pad = 2.max((px as f32 / 20.0).round() as u32);
    let inner = px - 2 * pad;
    let (w, h) = trimmed.dimensions();
    let scale = (inner as f32 / w as f32).min(inner as f32 / h as f32);
    let (nw, nh) = (((w as f32 * scale).round() as u32).clamp(1, inner), ((h as f32 * scale).round() as u32).clamp(1, inner));
    let resized = imageops::resize(trimmed, nw, nh, imageops::FilterType::Lanczos3);
    let (ox, oy) = (pad + (inner - nw) / 2, pad + (inner - nh) / 2);
    let mut out = RgbaImage::new(px, px);
    for (x, y, p) in resized.enumerate_pixels() {
        let a = p[3].clamp(0.0, 1.0);
        if a <= 0.0 {
            continue;
        }
        let c = |v: f32| ((v / a).clamp(0.0, 1.0) * 255.0).round() as u8;
        out.put_pixel(ox + x, oy + y, Rgba([c(p[0]), c(p[1]), c(p[2]), (a * 255.0).round() as u8]));
    }
    out
}

fn encode(img: &RgbaImage) -> Result<Vec<u8>> {
    let pixels: Vec<ravif::RGBA8> = img.pixels().map(|p| ravif::RGBA8::new(p[0], p[1], p[2], p[3])).collect();
    let encoded = ravif::Encoder::new()
        .with_quality(QUALITY)
        .with_speed(SPEED)
        .with_bit_depth(ravif::BitDepth::Eight)
        .with_num_threads(Some(1))
        .with_alpha_color_mode(ravif::AlphaColorMode::UnassociatedClean)
        .encode_rgba(ravif::Img::new(&pixels[..], img.width() as usize, img.height() as usize))?;
    Ok(encoded.avif_file)
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn pack(file: &Path, uuid: &str, hash: &str, out_dir: &Path, force: bool) -> Result<()> {
    let img = image::open(file)?.to_rgba8();
    let trimmed = premultiply(&trim(&img));
    for (size, px) in SIZES {
        let out = out_dir.join(size).join(thumb_file(uuid, hash));
        if !force && out.exists() {
            continue;
        }
        write_atomic(&out, &encode(&fit(&trimmed, px))?)?;
    }
    Ok(())
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let in_dir = &args.input;
    let out_dir = &args.output;
    if !in_dir.is_dir() {
        bail!("Not found: {}", in_dir.display());
    }
    for (size, _) in SIZES {
        fs::create_dir_all(out_dir.join(size))?;
    }

    let mut sources: Vec<(String, PathBuf)> = Vec::new();
    for entry in fs::read_dir(in_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        if let Some(uuid) = entry.file_name().to_str().and_then(uuid_of) {
            sources.push((uuid, entry.path()));
        }
    }
    sources.sort();
    // Two files for one UUID (an old <uuid>.png next to one with a name): which one holds cannot be decided
    let mut seen: HashMap<&str, &Path> = HashMap::new();
    let mut doubles: Vec<String> = Vec::new();
    for (uuid, file) in &sources {
        match seen.get(uuid.as_str()) {
            Some(prev) => doubles.push(format!("{} | {}", prev.display(), file.display())),
            None => {
                seen.insert(uuid, file);
            }
        }
    }
    if !doubles.is_empty() {
        let list: Vec<&str> = doubles.iter().take(20).map(String::as_str).collect();
        eprintln!("{} UUIDs twice in {}, delete one file per UUID:\n  {}", doubles.len(), in_dir.display(), list.join("\n  "));
        std::process::exit(1);
    }
    println!("{} Icons in {} -> {}", sources.len(), in_dir.display(), out_dir.display());

    // rav1e overflowed rayon's default 2 MB worker stack on some icons of the full set
    rayon::ThreadPoolBuilder::new().stack_size(16 << 20).build_global()?;
    let started = Instant::now();
    let packed = AtomicUsize::new(0);
    let skipped = AtomicUsize::new(0);
    let failures: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let manifest: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
    let done_count = AtomicUsize::new(0);
    sources.par_iter().for_each(|(uuid, file)| {
        let result = (|| -> Result<bool> {
            let hash = hex8(&Sha256::digest(fs::read(file)?));
            let done = SIZES.iter().all(|(s, _)| out_dir.join(s).join(thumb_file(uuid, &hash)).exists());
            let fresh = !(done && !args.force);
            if fresh {
                pack(file, uuid, &hash, out_dir, args.force)?;
            }
            manifest.lock().unwrap().insert(uuid.clone(), hash);
            Ok(fresh)
        })();
        match result {
            Ok(true) => packed.fetch_add(1, Ordering::Relaxed),
            Ok(false) => skipped.fetch_add(1, Ordering::Relaxed),
            Err(err) => {
                failures.lock().unwrap().push(format!("{uuid}: {err:#}"));
                0
            }
        };
        let n = done_count.fetch_add(1, Ordering::Relaxed) + 1;
        if n.is_multiple_of(250) {
            println!("{n}/{} ({} s)", sources.len(), started.elapsed().as_secs());
        }
    });
    let manifest = manifest.into_inner().unwrap();
    let failures = failures.into_inner().unwrap();

    // Stale: old hashes and UUIDs that are gone
    let mut removed = 0;
    for (size, _) in SIZES {
        for entry in fs::read_dir(out_dir.join(size))? {
            let entry = entry?;
            let name = entry.file_name();
            let keep = name
                .to_str()
                .and_then(parse_thumb)
                .is_some_and(|(uuid, hash)| manifest.get(uuid).is_some_and(|h| h == hash));
            if !keep {
                fs::remove_file(entry.path())?;
                removed += 1;
            }
        }
    }
    write_atomic(&out_dir.join("thumbs.json"), serde_json::to_string(&manifest)?.as_bytes())?;

    println!(
        "Done: {} packed, {} present, {removed} stale files deleted, {} failures, {} s",
        packed.into_inner(),
        skipped.into_inner(),
        failures.len(),
        started.elapsed().as_secs()
    );
    for f in &failures {
        println!("  ! {f}");
    }
    if !failures.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}

fn hex8(digest: &[u8]) -> String {
    digest[..4].iter().map(|b| format!("{b:02x}")).collect()
}
