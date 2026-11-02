// Event log per run for the evaluation: runs/<run>/events.jsonl, one JSON line per event with "t" (seconds
// since the run start) and "ev". Events: run_start (origin: machine, processes, hashes of render.py and addon,
// StarBreaker commit, p4k), export_start/export_item/export_end, render_start/render_item/render_end (phases from
// render.py), failure, sample (every 2 s: CPU, GPU, processes, queue), run_end. `packshot --report` evaluates a log.
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::engine::PHASES;

pub struct EventLog {
    out: BufWriter<File>,
    t0: Instant,
    pub path: PathBuf,
}

pub fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

impl EventLog {
    pub fn create(path: &Path) -> Result<Self> {
        Ok(Self { out: BufWriter::new(File::create(path).with_context(|| path.display().to_string())?), t0: Instant::now(), path: path.to_path_buf() })
    }

    pub fn emit(&mut self, ev: &str, mut fields: Value) {
        if let Value::Object(m) = &mut fields {
            m.insert("t".into(), json!(round3(self.t0.elapsed().as_secs_f64())));
            m.insert("ev".into(), json!(ev));
        }
        let _ = writeln!(self.out, "{fields}");
        let _ = self.out.flush();
    }
}

const FNV0: u64 = 0xcbf2_9ce4_8422_2325;

fn fnv(bytes: &[u8], mut h: u64) -> u64 {
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// Short content hash of a file (FNV-1a), to tell runs with different render.py versions apart
pub fn file_hash(path: &Path) -> Option<String> {
    fs::read(path).ok().map(|b| format!("{:016x}", fnv(&b, FNV0)))
}

/// Hash over all .py files of a folder (relative path and content, sorted, without __pycache__): the addon version
pub fn tree_hash(root: &Path) -> Option<String> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() {
                if p.file_name().is_some_and(|n| n != "__pycache__") {
                    stack.push(p);
                }
            } else if p.extension().is_some_and(|x| x == "py") {
                files.push(p);
            }
        }
    }
    files.sort();
    let mut h = FNV0;
    for f in &files {
        h = fnv(f.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/").as_bytes(), h);
        h = fnv(&fs::read(f).ok()?, h);
    }
    Some(format!("{h:016x}"))
}

/// GPU load via `nvidia-smi -l 2` in the background (Windows and Linux); without an NVIDIA driver there is no value
pub struct GpuProbe {
    child: Child,
    util: Arc<AtomicU32>,
}

impl GpuProbe {
    pub fn start() -> Option<Self> {
        let mut child = Command::new("nvidia-smi")
            .args(["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits", "-l", "2"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let util = Arc::new(AtomicU32::new(u32::MAX));
        let out = child.stdout.take()?;
        let u = util.clone();
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Ok(v) = line.trim().parse::<u32>() {
                    u.store(v, Ordering::Relaxed);
                }
            }
        });
        Some(Self { child, util })
    }

    pub fn get(&self) -> Option<u32> {
        let v = self.util.load(Ordering::Relaxed);
        (v != u32::MAX).then_some(v)
    }
}

impl Drop for GpuProbe {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 }
}

fn pct(v: &[f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    s[((s.len() - 1) as f64 * p).round() as usize]
}

fn f(v: f64, digits: usize) -> String {
    format!("{v:.digits$}")
}

/// Evaluation of a log as text: origin, result, phases (mean, p50, p95), Blender starts and slot use,
/// export, wait times, CPU/GPU, slowest items, failures
pub fn report(path: &Path) -> Result<String> {
    let text = fs::read_to_string(path).with_context(|| path.display().to_string())?;
    let evs: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let of = |name: &'static str| evs.iter().filter(move |e| e["ev"] == name);
    let Some(start) = of("run_start").next() else { bail!("{}: no run_start", path.display()) };
    let end = of("run_end").next();
    let wall = end.and_then(|e| e["wall"].as_f64()).or_else(|| evs.last().and_then(|e| e["t"].as_f64())).unwrap_or(0.0);
    let num = |v: &Value| v.as_f64().unwrap_or(0.0);

    let mut out = Vec::new();
    out.push(format!("Run {} · set {}", start["run"].as_str().unwrap_or("?"), start["set"].as_str().unwrap_or("?")));
    out.push(format!(
        "  Node {} ({}) · {} cores · {} Blender, {} export · Blender {} ({})",
        start["host"].as_str().unwrap_or("?"),
        start["os"].as_str().unwrap_or("?"),
        start["cores"],
        start["renderers"],
        start["exporters"],
        start["blender_version"].as_str().unwrap_or("?"),
        start["gpu_backend"].as_str().unwrap_or("?")
    ));
    out.push(format!(
        "  render.py {} · Addon {} · StarBreaker {} · p4k {} GB",
        start["render_py"].as_str().unwrap_or("?"),
        start["addon"].as_str().unwrap_or("?"),
        start["starbreaker"].as_str().unwrap_or("?").chars().take(8).collect::<String>(),
        f(num(&start["p4k_bytes"]) / 1e9, 1)
    ));
    out.push(format!(
        "  Selection: filter \"{}\" · scope {} · {} entities in {} blocks of {}",
        start["filter"].as_str().unwrap_or(""),
        start["scope"].as_str().unwrap_or("?"),
        start["total"],
        start["blocks"],
        start["block_size"]
    ));

    let items: Vec<&Value> = of("render_item").collect();
    let ok: Vec<&Value> = items.iter().copied().filter(|e| e["ok"] == true).collect();
    let failures: Vec<&Value> = of("failure").collect();
    let aborted = end.is_some_and(|e| e["aborted"] == true);
    out.push(String::new());
    out.push(format!(
        "Result: {} ok, {} failed in {} s → {} items/s{}",
        ok.len(),
        failures.len(),
        f(wall, 1),
        f(if wall > 0.0 { ok.len() as f64 / wall } else { 0.0 }, 2),
        if aborted { " (aborted)" } else if end.is_none() { " (no run_end: run incomplete)" } else { "" }
    ));

    // phases per render
    out.push(String::new());
    out.push(format!("Render per item (s)   {:>8} {:>8} {:>8}", "Mean", "p50", "p95"));
    let walls: Vec<f64> = ok.iter().map(|e| num(&e["wall"])).collect();
    out.push(format!("  wall                {:>8} {:>8} {:>8}", f(mean(&walls), 3), f(pct(&walls, 0.5), 3), f(pct(&walls, 0.95), 3)));
    for p in PHASES {
        let v: Vec<f64> = ok.iter().filter_map(|e| e["phases"][p].as_f64()).collect();
        if !v.is_empty() {
            out.push(format!("  {p:<20}{:>8} {:>8} {:>8}", f(mean(&v), 3), f(pct(&v, 0.5), 3), f(pct(&v, 0.95), 3)));
        }
    }

    // Blender: start (first item of a block minus its phases) and slot use
    let mut first_by_block: HashMap<i64, &Value> = HashMap::new();
    for e in &items {
        let b = e["block"].as_i64().unwrap_or(-1);
        first_by_block.entry(b).or_insert(e);
    }
    let startup: Vec<f64> = first_by_block
        .values()
        .filter(|e| e["phases"].is_object())
        .map(|e| num(&e["wall"]) - PHASES.iter().map(|p| num(&e["phases"][*p])).sum::<f64>())
        .collect();
    let render_walls: f64 = of("render_end").map(|e| num(&e["wall"])).sum();
    let samples: Vec<&Value> = of("sample").collect();
    let slots = if samples.is_empty() { num(&start["renderers"]) } else { mean(&samples.iter().map(|s| num(&s["max_renderers"])).collect::<Vec<_>>()) };
    out.push(String::new());
    out.push(format!(
        "Blender: {} processes, start avg {} s, slots {} % busy",
        of("render_end").count(),
        f(mean(&startup), 2),
        f(if wall > 0.0 && slots > 0.0 { render_walls / (wall * slots) * 100.0 } else { 0.0 }, 0)
    ));

    // Export: seconds per item according to StarBreaker, process overhead (loading p4k/DataCore, writing) per block
    let ex_items: Vec<f64> = of("export_item").filter(|e| e["ok"] == true).map(|e| num(&e["seconds"])).collect();
    let overhead: Vec<f64> = of("export_end").map(|e| num(&e["wall"]) - num(&e["item_seconds"])).collect();
    let ex_walls: Vec<f64> = of("export_end").map(|e| num(&e["wall"])).collect();
    out.push(format!(
        "Export: {} blocks, avg {} s per item, block avg {} s, of which overhead avg {} s",
        ex_walls.len(),
        f(mean(&ex_items), 3),
        f(mean(&ex_walls), 1),
        f(mean(&overhead), 1)
    ));

    // Wait times: blocks for a free Blender, Blender for the export
    let waits: Vec<f64> = of("render_start").map(|e| num(&e["queue_wait"])).collect();
    let starved = samples
        .iter()
        .filter(|s| num(&s["rendering"]) < num(&s["max_renderers"]) && num(&s["ready"]) == 0.0 && num(&s["exporting"]) + num(&s["pending"]) > 0.0)
        .count();
    out.push(format!(
        "Waiting: blocks for Blender avg {} s (max {} s) · Blender for export in {} % of samples",
        f(mean(&waits), 1),
        f(waits.iter().copied().fold(0.0, f64::max), 1),
        f(if samples.is_empty() { 0.0 } else { starved as f64 / samples.len() as f64 * 100.0 }, 0)
    ));

    let cpu: Vec<f64> = samples.iter().filter_map(|s| s["cpu"].as_f64()).collect();
    let gpu: Vec<f64> = samples.iter().filter_map(|s| s["gpu"].as_f64()).collect();
    out.push(format!(
        "Load: CPU avg {} % (max {}) · GPU {} · {} samples",
        f(mean(&cpu), 0),
        f(cpu.iter().copied().fold(0.0, f64::max), 0),
        if gpu.is_empty() { "no values".to_string() } else { format!("avg {} % (max {})", f(mean(&gpu), 0), f(gpu.iter().copied().fold(0.0, f64::max), 0)) },
        samples.len()
    ));

    // Slowest items
    let mut slow = ok.clone();
    slow.sort_by(|a, b| num(&b["wall"]).total_cmp(&num(&a["wall"])));
    if !slow.is_empty() {
        out.push(String::new());
        out.push("Slowest items (wall · load · render · glass)".into());
        for e in slow.iter().take(8) {
            out.push(format!(
                "  {:<48} {} · {} · {} · {}",
                e["entity"].as_str().unwrap_or("?"),
                f(num(&e["wall"]), 2),
                f(num(&e["phases"]["load"]), 2),
                f(num(&e["phases"]["render"]), 2),
                f(num(&e["phases"]["glass"]), 2)
            ));
        }
    }
    if !failures.is_empty() {
        out.push(String::new());
        out.push(format!("Failed ({})", failures.len()));
        for e in failures.iter().take(15) {
            out.push(format!("  {:<48} {} {}", e["entity"].as_str().unwrap_or("?"), e["stage"].as_str().unwrap_or("?"), e["error"].as_str().unwrap_or("")));
        }
        if failures.len() > 15 {
            out.push(format!("  … {} more", failures.len() - 15));
        }
    }
    out.push(String::new());
    out.push(format!("Log: {}", path.display()));
    Ok(out.join("\n"))
}
