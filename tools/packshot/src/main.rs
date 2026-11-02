// packshot: Leitstand für das Icon-Rendern (Ansicht A), Alternative zur Render-Schleife von `pnpm icons:render`
// (src/icons/cli.ts): dieselbe Zielliste (targets.json aus `--write-targets`), dieselben Pose-/Licht-Tabellen, derselbe
// Export (StarBreaker export-batch) und dasselbe Blender-Skript (src/icons/render.py), aber mit mehreren Export- und
// Blender-Prozessen gleichzeitig, Auswahl per Filter und Umfang (fehlende / gescheiterte / alle neu) und Bildvorschau.
// Läuft im Repo (Pfade unter local/) und im Bundle (Pfade neben der exe), ohne Node und ohne DB.
mod engine;
mod events;
mod tables;
mod ui;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};

use engine::{Config, Engine, Scope, Target};
use tables::Tables;

const HELP: &str = "Usage: pnpm packshot [options]
  --filter <terms>      Only entities where one of the terms (blanks/commas) occurs in the class name, the display
                        name or the type (case-insensitive); change it in the TUI with /
  --scope <s>           missing (default): no render yet · failed: failed last time · all: re-render all (force)
  --force               = --scope all
  --plain               No TUI: starts at once and prints lines like pnpm icons:render
  --dry-run             Only list what would be rendered (with pose and rig), then exit
  --workers <n>         Blender processes at once (default ¾ of the physical cores)
  --exporters <n>       StarBreaker exports at once (default ¼ of the physical cores, at least 2)
  --chunk <n>           At most n entities per block (one export and one Blender process, default 50)
  --size <px>           Edge length (default 256)
  --targets <file>      Target list (default: <work>/targets.json, else targets.json next to the exe/in the folder)
  --p4k <path>          Data.p4k (default: $SC_DATA_P4K, .env, Data.p4k in the folder)
  --starbreaker <bin>   StarBreaker CLI, our fork (default: local/starbreaker-qm/ or starbreaker/)
  --blender <bin>       Blender (default: local/blender/*/ or blender/)
  --render-script <py>  render.py (default: src/icons/render.py or cli/render.py)
  --out <dir>           Output, one PNG per UUID (default: local/icons or icons)
  --work <dir>          Work directory (default: local/work/icons or work)
  --refresh-tables      Read the pose and light tables from the DataCore again
  --report [log]        Evaluate an event log (default: the latest in <work>/logs), then exit
Every run writes <work>/logs/<date>_<node>.jsonl: processes, phases per item, CPU/GPU every 2 s, failures.
Target list in the repo: pnpm icons:render --write-targets local/work/icons/targets.json";

pub struct Args {
    pub filter: String,
    pub scope: Scope,
    pub plain: bool,
    pub dry_run: bool,
    pub workers: usize,
    pub exporters: usize,
    pub line: String,
}

/// Prozesszahlen aus den physischen Kernen: der Durchsatz flachte bei ~¾ der Kerne Blender ab (9800X3D, 8 Kerne:
/// 4 → 5,3, 6 → 6,3, 8 → 6,2, 12 → 6,7 Items/s, 2026-11-02), die Exporte brauchen den Rest. Mindestens 2 Exporte:
/// auf 4 Kernen (per Affinität nachgestellt) bremste ein einzelner Export 3 Blender aus (101 s statt 80 s für 459 Items)
fn auto_workers() -> (usize, usize, usize) {
    let cores = sysinfo::System::physical_core_count()
        .ok()
        .filter(|&n| n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get().div_ceil(2)).unwrap_or(4));
    ((cores * 3).div_ceil(4).max(1), (cores / 4).max(2), cores)
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.exists()).cloned()
}

fn find_blender(root: &Path) -> Option<PathBuf> {
    let dir = root.join("local/blender");
    let mut found = fs::read_dir(&dir).ok()?.flatten().map(|e| e.path().join(exe("blender"))).filter(|p| p.exists()).collect::<Vec<_>>();
    found.sort();
    found.into_iter().next()
}

/// SC_DATA_P4K aus .env, wenn die Umgebung keinen hat (wie node --env-file-if-exists)
fn env_p4k(root: &Path) -> Option<String> {
    if let Ok(v) = env::var("SC_DATA_P4K") {
        if !v.is_empty() {
            return Some(v);
        }
    }
    let text = fs::read_to_string(root.join(".env")).ok()?;
    text.lines().find_map(|l| {
        let v = l.trim().strip_prefix("SC_DATA_P4K=")?.trim();
        Some(v.trim_matches(|c| c == '"' || c == '\'').to_string())
    })
}

fn main() {
    if let Err(e) = real_main() {
        eprintln!("{e:#}");
        std::process::exit(1);
    }
}

fn real_main() -> Result<()> {
    let mut opt: std::collections::HashMap<String, String> = Default::default();
    let mut flags: std::collections::HashSet<String> = Default::default();
    let raw: Vec<String> = env::args().skip(1).collect();
    let mut it = raw.iter();
    while let Some(a) = it.next() {
        let Some(key) = a.strip_prefix("--") else { bail!("Unknown argument: {a}\n\n{HELP}") };
        match key {
            "plain" | "dry-run" | "force" | "refresh-tables" | "help" => {
                flags.insert(key.to_string());
            }
            // --report [log.jsonl]: Datei optional, sonst das jüngste Log
            "report" => {
                flags.insert(key.to_string());
                if let Some(next) = it.clone().next().filter(|n| !n.starts_with("--")) {
                    opt.insert(key.to_string(), next.clone());
                    it.next();
                }
            }
            "filter" | "scope" | "workers" | "exporters" | "chunk" | "size" | "targets" | "p4k" | "starbreaker" | "blender" | "render-script" | "out" | "work" => {
                let v = it.next().ok_or_else(|| anyhow!("--{key} needs a value"))?;
                opt.insert(key.to_string(), v.clone());
            }
            _ => bail!("Unknown option --{key}\n\n{HELP}"),
        }
    }
    if flags.contains("help") {
        println!("{HELP}");
        return Ok(());
    }

    // Repo (local/ vorhanden) oder Bundle (alles neben der exe bzw. im aktuellen Ordner)
    let root = env::current_dir()?;
    let repo = root.join("local").is_dir() && root.join("src/icons").is_dir();
    let path = |key: &str| opt.get(key).map(|p| root.join(p));
    let work = path("work").unwrap_or_else(|| root.join(if repo { "local/work/icons" } else { "work" }));
    if flags.contains("report") {
        let log = path("report")
            .or_else(|| events::latest_log(&work.join("logs")))
            .ok_or_else(|| anyhow!("No event log in {}", work.join("logs").display()))?;
        println!("{}", events::report(&log)?);
        return Ok(());
    }
    let out = path("out").unwrap_or_else(|| root.join(if repo { "local/icons" } else { "icons" }));
    let targets_file = path("targets")
        .or_else(|| first_existing(&[work.join("targets.json"), root.join("targets.json")]))
        .ok_or_else(|| anyhow!("No target list: {} is missing.\nIn the repo: pnpm icons:render --write-targets local/work/icons/targets.json", work.join("targets.json").display()))?;
    let p4k = path("p4k")
        .or_else(|| env_p4k(&root).map(PathBuf::from))
        .or_else(|| first_existing(&[root.join("Data.p4k")]))
        .ok_or_else(|| anyhow!("No Data.p4k (--p4k, $SC_DATA_P4K or .env)"))?;
    if !p4k.exists() {
        bail!("Data.p4k not found: {}", p4k.display());
    }
    let starbreaker = path("starbreaker")
        .or_else(|| first_existing(&[root.join("local/starbreaker-qm").join(exe("starbreaker")), root.join("starbreaker").join(exe("starbreaker"))]))
        .ok_or_else(|| anyhow!("StarBreaker not found (local/starbreaker-qm/ or --starbreaker)"))?;
    let blender = path("blender")
        .or_else(|| find_blender(&root))
        .or_else(|| first_existing(&[root.join("blender").join(exe("blender"))]))
        .ok_or_else(|| anyhow!("Blender not found (local/blender/*/ or --blender)"))?;
    let render_script = path("render-script")
        .or_else(|| first_existing(&[root.join("src/icons/render.py"), root.join("cli/render.py")]))
        .ok_or_else(|| anyhow!("render.py not found (--render-script)"))?;
    let num = |key: &str, default: usize| -> Result<usize> { opt.get(key).map(|v| v.parse::<usize>().with_context(|| format!("--{key} {v}"))).unwrap_or(Ok(default)) };

    let auto = auto_workers();
    let scope = match opt.get("scope") {
        Some(s) => Scope::parse(s).ok_or_else(|| anyhow!("--scope {s}: missing, failed or all"))?,
        None if flags.contains("force") => Scope::All,
        None => Scope::Missing,
    };
    let args = Args {
        filter: opt.get("filter").cloned().unwrap_or_default(),
        scope,
        plain: flags.contains("plain"),
        dry_run: flags.contains("dry-run"),
        workers: num("workers", auto.0)?.max(1),
        exporters: num("exporters", auto.1)?.max(1),
        line: raw.join(" "),
    };

    fs::create_dir_all(&work)?;
    let targets: Vec<Target> = serde_json::from_slice(&fs::read(&targets_file).with_context(|| targets_file.display().to_string())?).context("targets.json")?;
    println!("Target list: {} ({} entities)", targets_file.display(), targets.len());
    let tables = Tables::load(&starbreaker, &p4k, &work, flags.contains("refresh-tables"), |s| println!("{s}"))?;
    let cfg = Config { p4k, starbreaker, blender, render_script, out, work, size: num("size", 256)? as u32, chunk: num("chunk", 50)?.max(1) };
    let mut engine = Engine::new(cfg, targets, tables)?;
    engine.max_renderers = args.workers;
    engine.max_exporters = args.exporters;
    engine.cores = auto.2;
    println!("{} physical cores: {} Blender (Vulkan), {} export", auto.2, args.workers, args.exporters);

    if args.dry_run {
        let sel = engine.select(&args.filter, args.scope);
        for &t in &sel.todo {
            let tg = &engine.targets[t];
            let (pose, rig) = engine.pose_rig(t)?;
            let rig = rig.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let pose: Vec<String> = pose.iter().map(|v| format!("{v}")).collect();
            println!("{}  {}/{}  pose {}  {rig}{}  -> {} uuid(s)", tg.entity, tg.kind, tg.sub_type, pose.join(","), if tg.worn { "  worn" } else { "" }, tg.uuids.len());
        }
        println!("{} matches, {} to render ({}), {} would be overwritten", sel.matched, sel.todo.len(), args.scope.label(), sel.overwrite);
        return Ok(());
    }
    if args.plain {
        return plain(&mut engine, &args);
    }
    ui::run(engine, args)
}

/// Konsolenmodus: sofort starten, Zeilen ausgeben, mit Exit-Code 1 bei Fehlern
fn plain(engine: &mut Engine, args: &Args) -> Result<()> {
    let sel = engine.select(&args.filter, args.scope);
    println!("{} matches, {} to render ({}), {} existing will be overwritten", sel.matched, sel.todo.len(), args.scope.label(), sel.overwrite);
    engine.echo = Some(Vec::new());
    engine.place_missing_icons(&args.filter);
    engine.start(&sel, &args.line, &args.filter, args.scope)?;
    while engine.running() {
        engine.tick();
        for l in engine.echo.as_mut().map(std::mem::take).unwrap_or_default() {
            println!("{l}");
        }
        thread::sleep(Duration::from_millis(50));
    }
    for l in engine.echo.as_mut().map(std::mem::take).unwrap_or_default() {
        println!("{l}");
    }
    if let Some(avg) = engine.run.as_ref().and_then(|r| r.phase_avg()) {
        let parts: Vec<String> = engine::PHASES.iter().zip(avg).map(|(k, v)| format!("{k} {v:.3}")).collect();
        println!("Avg per render (s): {}", parts.join(" · "));
    }
    if let Some(log) = engine.events.as_ref() {
        println!("Event log: {} · report: pnpm packshot --report", log.path.display());
    }
    for (t, e) in &engine.errors {
        println!("  ! {}: {e}", engine.targets[*t].entity);
    }
    if !engine.errors.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}
