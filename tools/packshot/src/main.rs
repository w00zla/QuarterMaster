// packshot: control room for rendering the icons. Every set carries its target list (targets.json from
// `pnpm packshot:targets`, taken into a set with key t or --targets),
// computes pose and light rig from the game's tables, exports with StarBreaker export-batch and
// renders with src/icons/render.py, several export and Blender processes at once, selection by filter and scope
// (missing / failed / all), image preview. Every run is a run folder whose images land in the target set (store.rs;
// pnpm thumbs:build reads live). Every node starts with what it can do now (--render, --export); with a token in
// packshot.json the nodes find each other and every node can start a run, on itself or on another node as its main
// node (cluster.rs, node.rs). Runs in the repo (paths under local/) and in the bundle (paths next to the exe),
// without Node.js and without the DB.
mod cluster;
mod config;
mod engine;
mod events;
mod net;
mod node;
mod store;
mod tables;
mod ui;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};

use cluster::Caps;
use config::NetConfig;
use engine::{Config, Engine, Scope, Target};
use net::Hub;
use store::Store;
use tables::Tables;

const HELP: &str = "Usage: pnpm packshot [--render] [--export] [options]
  --render              This node renders (Blender); the count of Blender processes changes with + / -
  --export              This node exports (Data.p4k, build_manifest.id next to it, StarBreaker); the count changes
                        with < / >
                        Without both the node only starts runs, stores them and watches
  --filter <terms>      Only entities where one of the terms (blanks/commas) occurs in the class name, the display
                        name or the type (case-insensitive); change it in the TUI with /
  --scope <s>           missing (default): not in the set yet · failed: failed last time in the set · all: re-render
                        all (force)
  --force               = --scope all
  --set <name>          Target set here (default live); a new name branches off live
  --name <name>         Run name (default: filter terms and scope)
  --plain               No TUI: starts a run on this node at once and prints one line per item
  --serve               No TUI and no run of its own: works for the other nodes' runs and prints lines (as a service)
  --dry-run             Only list what would be rendered (with pose and rig), then exit
  --workers <n>         Blender processes at once (default ¾ of the physical cores)
  --exporters <n>       StarBreaker exports at once (default ¼ of the physical cores, at least 2)
  --chunk <n>           At most n entities per block (one export and one Blender process, default 50)
  --size <px>           Edge length (default 256)
  --targets <file>      Give the target set this target list (replaces its own); every set carries one, a new set
                        takes its base's; starting a run in the TUI asks for one while the set has none
                        (offering the target lists in the packshot folder)
  --p4k <path>          Data.p4k (default: $SC_DATA_P4K, .env, Data.p4k in the folder)
  --starbreaker <bin>   StarBreaker CLI, our fork (default: local/starbreaker-qm/ or starbreaker/)
  --blender <bin>       Blender (default: local/blender/*/ or blender/)
  --render-script <py>  render.py (default: src/icons/render.py or cli/render.py)
  --store <dir>         The packshot folder: packshot.json, targets.json, runs/, sets/, work/ (default: local/packshot
                        in the repo, else the folder itself, as in a bundle)
  --work <dir>          Work directory (default: work/ in the packshot folder)
  --refresh-tables      Read the pose and light tables from the DataCore again
  --report [log]        Evaluate an event log or run folder (default: the latest run), then exit
Every run is a folder runs/<date>_<time>_<name>/ on its head node: its images (<Name> (<class>) <uuid>.png),
run.json (origin, result per entity) and events.jsonl (processes, phases per item, CPU/GPU every 2 s, failures). A
set (sets/<name>/) holds all icons as hard links to the runs' images, per entity the latest run with an image.
Cluster: packshot.json in the store folder, e.g. {\"token\": \"<secret>\"}; the nodes with the same token find each
other by UDP broadcast on port 47950 (TCP the same); optional: \"listen\": \"0.0.0.0:47950\", \"peers\": [\"host\",
\"192.168.1.20:47950\"] for nodes the broadcast does not reach, \"discovery\": false; every node is known by its host
name; without a token everything stays local.
Target list in the repo: pnpm packshot:targets (writes local/packshot/targets.json from the DB), then key t in
view 2 or --targets";

pub struct Args {
    pub filter: String,
    pub scope: Scope,
    pub plain: bool,
    pub serve: bool,
    pub dry_run: bool,
    pub workers: usize,
    pub exporters: usize,
    pub name: String,
    pub line: String,
}

/// Process counts from the physical cores: throughput levelled off at ~¾ of the cores as Blender (9800X3D, 8 cores:
/// 4 → 5.3, 6 → 6.3, 8 → 6.2, 12 → 6.7 items/s, 2026-11-02), the exports need the rest. At least 2 exports: on
/// 4 cores (emulated by affinity) a single export held back 3 Blender (101 s instead of 80 s for 459 items)
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

/// SC_DATA_P4K from .env when the environment has none (like node --env-file-if-exists)
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
            "plain" | "serve" | "dry-run" | "force" | "refresh-tables" | "render" | "export" | "help" => {
                flags.insert(key.to_string());
            }
            "node" => bail!("--node is gone: every node starts with what it can do, e.g. --render (and --export)\n\n{HELP}"),
            // --report [log.jsonl]: the file is optional, else the latest run
            "report" => {
                flags.insert(key.to_string());
                if let Some(next) = it.clone().next().filter(|n| !n.starts_with("--")) {
                    opt.insert(key.to_string(), next.clone());
                    it.next();
                }
            }
            "filter" | "scope" | "set" | "name" | "workers" | "exporters" | "chunk" | "size" | "targets" | "p4k" | "starbreaker" | "blender" | "render-script" | "store" | "work" => {
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

    // The packshot folder, laid out like a bundle (packshot.json, targets.json, runs/, sets/, work/): local/packshot in
    // the repo, else the current folder (the bundle, next to the exe)
    let root = env::current_dir()?;
    let repo = root.join("local").is_dir() && root.join("src/icons").is_dir();
    let path = |key: &str| opt.get(key).map(|p| root.join(p));
    let store_dir = path("store").unwrap_or_else(|| if repo { root.join("local/packshot") } else { root.clone() });
    let work = path("work").unwrap_or_else(|| store_dir.join("work"));
    let num = |key: &str, default: usize| -> Result<usize> { opt.get(key).map(|v| v.parse::<usize>().with_context(|| format!("--{key} {v}"))).unwrap_or(Ok(default)) };
    let auto = auto_workers();

    let mut store = Store::open(&store_dir)?;
    if flags.contains("report") {
        let log = path("report")
            .map(|p| if p.is_dir() { p.join("events.jsonl") } else { p })
            .or_else(|| store.latest_events())
            .ok_or_else(|| anyhow!("No run with an event log in {}", store_dir.join("runs").display()))?;
        println!("{}", events::report(&log)?);
        return Ok(());
    }
    let (render, export) = (flags.contains("render"), flags.contains("export"));
    let net_cfg = NetConfig::load(&store_dir.join("packshot.json"))?;
    let serve = flags.contains("serve");
    if serve && !net_cfg.enabled() {
        bail!("--serve works for the other nodes: it needs a token in {}", store_dir.join("packshot.json").display());
    }

    // Blender and StarBreaker: every bundle carries both and every node reports their versions (the head node's
    // state is the one all match); needed to work only with --render and --export
    let blender = path("blender").or_else(|| find_blender(&root)).or_else(|| first_existing(&[root.join("blender").join(exe("blender"))]));
    if render && blender.is_none() {
        bail!("--render: Blender not found (local/blender/*/ or --blender)");
    }
    let starbreaker = path("starbreaker").or_else(|| first_existing(&[root.join("local/starbreaker-qm").join(exe("starbreaker")), root.join("starbreaker").join(exe("starbreaker"))]));
    if export && starbreaker.is_none() {
        bail!("--export: StarBreaker not found (local/starbreaker-qm/ or --starbreaker)");
    }
    // export: Data.p4k with build_manifest.id next to it
    let p4k = if export {
        let p4k = path("p4k")
            .or_else(|| env_p4k(&root).map(PathBuf::from))
            .or_else(|| first_existing(&[root.join("Data.p4k")]))
            .ok_or_else(|| anyhow!("--export: no Data.p4k (--p4k, $SC_DATA_P4K or .env)"))?;
        if !p4k.exists() {
            bail!("--export: Data.p4k not found: {}", p4k.display());
        }
        // the game version comes from build_manifest.id next to Data.p4k: shown everywhere and part of the state
        if cluster::p4k_version(&p4k).is_none() {
            bail!(
                "--export: build_manifest.id missing or unreadable next to {}\nCopy it from the game folder (.../StarCitizen/LIVE/) next to Data.p4k, or point --p4k into the game folder.",
                p4k.display()
            );
        }
        p4k
    } else {
        PathBuf::new()
    };
    let render_script = path("render-script")
        .or_else(|| first_existing(&[root.join("src/icons/render.py"), root.join("cli/render.py")]))
        .ok_or_else(|| anyhow!("render.py not found (--render-script)"))?;

    let scope = match opt.get("scope") {
        Some(s) => Scope::parse(s).ok_or_else(|| anyhow!("--scope {s}: missing, failed or all"))?,
        None if flags.contains("force") => Scope::All,
        None => Scope::Missing,
    };
    let args = Args {
        filter: opt.get("filter").cloned().unwrap_or_default(),
        scope,
        plain: flags.contains("plain"),
        serve,
        dry_run: flags.contains("dry-run"),
        workers: if render { num("workers", auto.0)?.max(1) } else { 0 },
        exporters: if export { num("exporters", auto.1)?.max(1) } else { 0 },
        name: opt.get("name").cloned().unwrap_or_default(),
        line: raw.join(" "),
    };

    fs::create_dir_all(&work)?;
    let set_name = opt.get("set").cloned().unwrap_or_else(|| store::LIVE.to_string());
    let mut set = if store.sets()?.contains(&set_name) {
        store.load_set(&set_name)?
    } else if args.dry_run {
        bail!("Set {set_name} does not exist (a run would create it from live)");
    } else {
        println!("New set {set_name}, branched off live");
        store.create_set(&set_name, store::LIVE)?
    };
    println!("Set: {} ({} runs) in {}", set.name, set.chain().count(), store.set_dir(&set.name).display());
    // the set's target list: --targets gives it a new one
    if let Some(f) = path("targets") {
        let n = store.set_targets(&mut set, &f)?;
        println!("Target list of {}: {n} targets from {}", set.name, f.display());
    }
    let targets: Vec<Target> = store.load_targets(&set)?;
    match &set.targets {
        Some(t) => println!("Target list of {}: {} targets (from {})", set.name, targets.len(), t.source),
        None => println!("Set {} has no target list: runs start once it has one (key t in view 2, or --targets <file>)", set.name),
    }
    if (args.plain || args.dry_run) && targets.is_empty() {
        bail!("--plain and --dry-run need a target list in set {} (--targets <file>)", set.name);
    }
    // the DataCore tables: in the TUI they load in the background (it shows the steps), the console modes wait
    let tables_later = export && !(args.plain || args.dry_run || args.serve);
    let tables = if export && !tables_later { Tables::load(starbreaker.as_deref().unwrap_or(Path::new("")), &p4k, &work, flags.contains("refresh-tables"), |s| println!("{s}"))? } else { Tables::default() };
    let disk_paths = if work.starts_with(&store_dir) { vec![store_dir.clone()] } else { vec![store_dir.clone(), work.clone()] };
    let caps = Caps { render, export, blender: blender.as_deref(), starbreaker: starbreaker.as_deref(), p4k: export.then_some(p4k.as_path()) };
    // no export workers offered before the tables are there
    let me = cluster::own_hello(&net_cfg.name, caps, args.workers, if tables_later { 0 } else { args.exporters }, auto.2, cluster::disk_info(&disk_paths));
    let cfg = Config { p4k, starbreaker: starbreaker.unwrap_or_default(), blender: blender.unwrap_or_default(), render_script, work: work.clone(), size: num("size", 256)? as u32, chunk: num("chunk", 50)?.max(1) };
    // Network only with a token and not for a dry run; blocks of an earlier session in the inbox are stale
    if net_cfg.enabled() && !args.dry_run {
        let _ = fs::remove_dir_all(work.join("inbox"));
    }
    let hub = (net_cfg.enabled() && !args.dry_run).then(|| Hub::new(net_cfg.clone(), me.clone(), work.join("inbox")));
    if let Some(h) = hub.as_ref() {
        match &h.listen_error {
            Some(e) => println!("Cluster: {e}"),
            None => println!("Cluster: {} listening on {}", h.me.name, h.cfg.listen),
        }
        if let Some(e) = &h.discovery_error {
            println!("Cluster: {e}");
        }
    }
    // works for the head node of another node's run (packages: exports first)
    let renderer = hub.is_some().then(|| {
        let mut r = node::Renderer::new(cfg.blender.clone(), args.workers, work.join("preview.png"));
        r.export_slots = args.exporters;
        if export {
            r.tools = Some(node::ExportTools { starbreaker: cfg.starbreaker.clone(), p4k: cfg.p4k.clone(), rigs: work.join("dcb").join("rigs") });
        }
        r
    });
    let mut engine = Engine::new(cfg, targets, tables, store, set, hub, me)?;
    // the file the TUI offers for a set's target list
    engine.targets_file = store_dir.join("targets.json");
    engine.serve = renderer;
    engine.max_renderers = args.workers;
    engine.max_exporters = args.exporters;
    engine.cores = auto.2;
    engine.disk_paths = disk_paths;
    let caps_line = match (render, export) {
        (false, false) => "no --render/--export: this node only starts runs, stores them and watches".to_string(),
        _ => format!("{} export · {} render (Blender on Vulkan) · {} physical cores", args.exporters, args.workers, auto.2),
    };
    println!("{caps_line}");
    // what printed before the TUI took the screen: into its log as well
    startup_notes(&mut engine, &caps_line, &store_dir, &work);
    if tables_later {
        engine.load_tables(flags.contains("refresh-tables"));
    }

    if args.dry_run {
        let sel = engine.select(&args.filter, args.scope);
        for &t in &sel.todo {
            let tg = &engine.targets[t];
            let (pose, rig) = match engine.pose_rig(t) {
                Ok((pose, rig)) => (pose.iter().map(|v| format!("{v}")).collect::<Vec<_>>().join(","), rig.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()),
                Err(_) => ("–".into(), "– (pose and rig with --export)".into()),
            };
            println!("{}  {}/{}  pose {pose}  {rig}{}  -> {} uuid(s)", tg.entity, tg.kind, tg.sub_type, if tg.worn { "  worn" } else { "" }, tg.uuids.len());
        }
        println!("{} matches, {} to render ({}), {} would be overwritten", sel.matched, sel.todo.len(), args.scope.label(), sel.overwrite);
        return Ok(());
    }
    if args.serve {
        return serve_plain(&mut engine);
    }
    if args.plain {
        return plain(&mut engine, &args);
    }
    ui::run(engine, args)
}

/// The start in the log: version and node, capabilities, folders, target set and list, tools, cluster
fn startup_notes(engine: &mut Engine, caps_line: &str, store_dir: &Path, work: &Path) {
    use engine::Level::{Error, Info};
    let me = engine.me.clone();
    let mut notes = vec![
        (Info, format!("packshot {} on {} ({}) · {caps_line}", me.version, me.name, me.os)),
        (Info, format!("Packshot folder {} · work {}", store_dir.display(), work.display())),
    ];
    let set = &engine.set;
    notes.push(match &set.targets {
        Some(t) => (Info, format!("Target set {}: {} runs, {} images, {} targets from {}", set.name, set.chain().count(), set.files.len(), t.count, t.source)),
        None => (Error, format!("Target set {}: {} runs, {} images, no target list (t in view 2)", set.name, set.chain().count(), set.files.len())),
    });
    let tool = |name: &str, version: Option<&str>, path: &Path| match version {
        Some(v) if !v.is_empty() => (Info, format!("{name} {v} ({})", path.display())),
        _ => (Info, format!("{name}: not found")),
    };
    notes.push(tool("Blender", Some(me.blender.as_str()).filter(|_| !engine.cfg.blender.as_os_str().is_empty()), &engine.cfg.blender));
    notes.push(tool("StarBreaker", me.starbreaker.as_deref(), &engine.cfg.starbreaker));
    if me.export {
        let gb = me.p4k_bytes.map(|b| format!(" · {:.0} GB", b as f64 / 1e9)).unwrap_or_default();
        notes.push((Info, format!("Data.p4k {}{gb} ({})", me.p4k_version.as_deref().unwrap_or("?"), engine.cfg.p4k.display())));
    }
    match engine.hub.as_ref() {
        None => notes.push((Info, "Cluster: off (no token in packshot.json)".into())),
        Some(h) => {
            let peers = if h.cfg.peers.is_empty() { String::new() } else { format!(" · peers {}", h.cfg.peers.join(", ")) };
            notes.push((Info, format!("Cluster: {} on {} · discovery {}{peers}", if h.listen_error.is_some() { "not listening" } else { "listening" }, h.cfg.listen, if h.cfg.discovery { "on" } else { "off" })));
            for e in h.listen_error.iter().chain(h.discovery_error.iter()) {
                notes.push((Error, format!("Cluster: {e}")));
            }
        }
    }
    for (level, text) in notes {
        engine.note(level, text);
    }
}

/// --serve: no TUI, no run of its own; works for the other nodes' runs and prints the log until Ctrl+C
fn serve_plain(engine: &mut Engine) -> Result<()> {
    engine.echo = Some(Vec::new());
    loop {
        engine.tick();
        for l in engine.echo.as_mut().map(std::mem::take).unwrap_or_default() {
            println!("{} {l}", chrono::Local::now().format("%H:%M:%S"));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// Console mode: start a run on this node at once, print lines, exit code 1 on failures. With a cluster it first
/// waits 5 s for the other nodes; all of them must have the same state
fn plain(engine: &mut Engine, args: &Args) -> Result<()> {
    let sel = engine.select(&args.filter, args.scope);
    println!("{} matches, {} to render ({}), {} existing will be overwritten", sel.matched, sel.todo.len(), args.scope.label(), sel.overwrite);
    if sel.todo.is_empty() {
        return Ok(());
    }
    engine.echo = Some(Vec::new());
    if engine.hub.is_some() {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) {
            engine.tick();
            thread::sleep(Duration::from_millis(100));
        }
    }
    for (name, diff) in engine.state_problems() {
        println!("{name} has another state: {}", diff.join(", "));
    }
    let starter = engine.me.name.clone();
    engine.start_local(&sel.todo, &args.line, &args.filter, args.scope, &args.name, &starter)?;
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
