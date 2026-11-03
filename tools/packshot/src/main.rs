// packshot: control room for rendering the icons. Reads the target list (targets.json from `pnpm packshot:targets`),
// computes pose and light rig from the game's tables, exports with StarBreaker export-batch and
// renders with src/icons/render.py, several export and Blender processes at once, selection by filter and scope
// (missing / failed / all), image preview. Every run is a run folder whose images land in the target set (store.rs;
// pnpm thumbs:build reads live). With a token in packshot.json the coordinator also hands blocks to nodes
// (cluster.rs, node.rs). Runs in the repo (paths under local/) and in the bundle (paths next to the exe), without
// Node.js and without the DB.
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

use config::NetConfig;
use engine::{Config, Engine, Scope, Target};
use net::{Hub, Role};
use store::Store;
use tables::Tables;

const HELP: &str = "Usage: pnpm packshot [options]
  --filter <terms>      Only entities where one of the terms (blanks/commas) occurs in the class name, the display
                        name or the type (case-insensitive); change it in the TUI with /
  --scope <s>           missing (default): not in the set yet · failed: failed last time in the set · all: re-render
                        all (force)
  --force               = --scope all
  --set <name>          Target set (default live); a new name branches off live
  --name <name>         Run name (default: filter terms and scope)
  --plain               No TUI: starts at once and prints one line per item
  --dry-run             Only list what would be rendered (with pose and rig), then exit
  --node                Node mode: connect to the coordinators in packshot.json and render their blocks
                        (needs only Blender, no Data.p4k, no StarBreaker); the TUI shows them, --plain prints lines
  --workers <n>         Blender processes at once (default ¾ of the physical cores)
  --exporters <n>       StarBreaker exports at once (default ¼ of the physical cores, at least 2)
  --chunk <n>           At most n entities per block (one export and one Blender process, default 50)
  --size <px>           Edge length (default 256)
  --targets <file>      Target list (default: targets.json in the packshot folder)
  --p4k <path>          Data.p4k (default: $SC_DATA_P4K, .env, Data.p4k in the folder)
  --starbreaker <bin>   StarBreaker CLI, our fork (default: local/starbreaker-qm/ or starbreaker/)
  --blender <bin>       Blender (default: local/blender/*/ or blender/)
  --render-script <py>  render.py (default: src/icons/render.py or cli/render.py)
  --store <dir>         The packshot folder: packshot.json, targets.json, runs/, sets/, work/ (default: local/packshot
                        in the repo, else the folder itself, as in a bundle)
  --work <dir>          Work directory (default: work/ in the packshot folder)
  --refresh-tables      Read the pose and light tables from the DataCore again
  --report [log]        Evaluate an event log or run folder (default: the latest run), then exit
Every run is a folder runs/<date>_<time>_<name>/: its images (<Name> (<class>) <uuid>.png), run.json (origin, result
per entity) and events.jsonl (processes, phases per item, CPU/GPU every 2 s, failures). A set (sets/<name>/) holds
all icons as hard links to the runs' images, per entity the latest run with an image.
Cluster: packshot.json in the store folder, e.g. {\"token\": \"<secret>\", \"listen\": \"0.0.0.0:47800\",
\"coordinators\": [\"win-3080\", \"192.168.1.20:47800\"]} (host name or IP, port optional, default 47800); every box is
known by its host name; without a token everything stays local.
Target list in the repo: pnpm packshot:targets (writes local/packshot/targets.json from the DB)";

pub struct Args {
    pub filter: String,
    pub scope: Scope,
    pub plain: bool,
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
            "plain" | "dry-run" | "force" | "refresh-tables" | "node" | "help" => {
                flags.insert(key.to_string());
            }
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
    let blender = || {
        path("blender")
            .or_else(|| find_blender(&root))
            .or_else(|| first_existing(&[root.join("blender").join(exe("blender"))]))
            .ok_or_else(|| anyhow!("Blender not found (local/blender/*/ or --blender)"))
    };
    let net_cfg = NetConfig::load(&store_dir.join("packshot.json"))?;

    if flags.contains("node") {
        node::check(&net_cfg)?;
        let blender = blender()?;
        let slots = num("workers", auto.0)?.max(1);
        // blocks of an earlier session are stale
        let _ = fs::remove_dir_all(work.join("node"));
        fs::create_dir_all(&work)?;
        let me = cluster::own_hello(&net_cfg.name, Role::Node, &blender, slots, 0, auto.2, None);
        let hub = Hub::new(net_cfg, me.clone(), work.join("node"), false);
        if flags.contains("plain") {
            return node::run(hub, node::NodeArgs { blender, slots });
        }
        // the same TUI, reduced: an engine without targets and runs of its own, rendering what the coordinators send
        let store = Store::open(&work.join("store"))?;
        let set = store.load_set(store::LIVE)?;
        let cfg = Config { p4k: PathBuf::new(), starbreaker: PathBuf::new(), blender: blender.clone(), render_script: PathBuf::new(), work, size: 256, chunk: 50 };
        let mut engine = Engine::new(cfg, Vec::new(), Tables::default(), store, set, Some(hub), me)?;
        engine.serve = Some(node::Renderer::new(blender, slots));
        engine.max_renderers = slots;
        engine.max_exporters = 0;
        engine.cores = auto.2;
        let args = Args { filter: String::new(), scope: Scope::Missing, plain: false, dry_run: false, workers: slots, exporters: 0, name: String::new(), line: String::new() };
        return ui::run(engine, args);
    }

    let mut store = Store::open(&store_dir)?;
    if flags.contains("report") {
        let log = path("report")
            .map(|p| if p.is_dir() { p.join("events.jsonl") } else { p })
            .or_else(|| store.latest_events())
            .ok_or_else(|| anyhow!("No run with an event log in {}", store_dir.join("runs").display()))?;
        println!("{}", events::report(&log)?);
        return Ok(());
    }
    let set_name = opt.get("set").cloned().unwrap_or_else(|| store::LIVE.to_string());
    let targets_file = path("targets")
        .or_else(|| first_existing(&[store_dir.join("targets.json")]))
        .ok_or_else(|| {
            let hint = if repo { "In the repo: pnpm packshot:targets" } else { "A pure node starts with --node (run-node.sh / run.cmd --node)" };
            anyhow!("No target list: {} is missing.\n{hint}", store_dir.join("targets.json").display())
        })?;
    let p4k = path("p4k")
        .or_else(|| env_p4k(&root).map(PathBuf::from))
        .or_else(|| first_existing(&[root.join("Data.p4k")]))
        .ok_or_else(|| anyhow!("No Data.p4k (--p4k, $SC_DATA_P4K or .env)"))?;
    if !p4k.exists() {
        bail!("Data.p4k not found: {}", p4k.display());
    }
    // the game version comes from build_manifest.id next to Data.p4k: shown everywhere, so it must be there
    if cluster::p4k_version(&p4k).is_none() {
        bail!(
            "build_manifest.id missing or unreadable next to {}\nCopy it from the game folder (...\\StarCitizen\\LIVE\\) next to Data.p4k, or point --p4k into the game folder.",
            p4k.display()
        );
    }
    let starbreaker = path("starbreaker")
        .or_else(|| first_existing(&[root.join("local/starbreaker-qm").join(exe("starbreaker")), root.join("starbreaker").join(exe("starbreaker"))]))
        .ok_or_else(|| anyhow!("StarBreaker not found (local/starbreaker-qm/ or --starbreaker)"))?;
    let blender = blender()?;
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
        dry_run: flags.contains("dry-run"),
        workers: num("workers", auto.0)?.max(1),
        exporters: num("exporters", auto.1)?.max(1),
        name: opt.get("name").cloned().unwrap_or_default(),
        line: raw.join(" "),
    };

    fs::create_dir_all(&work)?;
    let targets: Vec<Target> = serde_json::from_slice(&fs::read(&targets_file).with_context(|| targets_file.display().to_string())?).context("targets.json")?;
    println!("Target list: {} ({} entities)", targets_file.display(), targets.len());
    let tables = Tables::load(&starbreaker, &p4k, &work, flags.contains("refresh-tables"), |s| println!("{s}"))?;
    let me = cluster::own_hello(&net_cfg.name, Role::Coordinator, &blender, args.workers, args.exporters, auto.2, Some((&p4k, &starbreaker)));
    let cfg = Config { p4k, starbreaker, blender, render_script, work: work.clone(), size: num("size", 256)? as u32, chunk: num("chunk", 50)?.max(1) };
    let set = if store.sets()?.contains(&set_name) {
        store.load_set(&set_name)?
    } else if args.dry_run {
        bail!("Set {set_name} does not exist (a run would create it from live)");
    } else {
        println!("New set {set_name}, branched off live");
        store.create_set(&set_name, store::LIVE)?
    };
    println!("Set: {} ({} runs) in {}", set.name, set.chain().count(), store.set_dir(&set.name).display());
    // Network only with a token and not for a dry run
    let hub = (net_cfg.enabled() && !args.dry_run).then(|| Hub::new(net_cfg.clone(), me.clone(), work.join("inbox"), true));
    if let Some(h) = hub.as_ref() {
        match &h.listen_error {
            Some(e) => println!("Cluster: {e}"),
            None => println!("Cluster: {} listening on {}", h.me.name, h.cfg.listen),
        }
    }
    // renders (packages: exports first) what the other coordinators send
    let serve = hub.is_some().then(|| {
        let mut r = node::Renderer::new(cfg.blender.clone(), args.workers);
        r.tools = Some(node::ExportTools { starbreaker: cfg.starbreaker.clone(), p4k: cfg.p4k.clone(), rigs: work.join("dcb").join("rigs") });
        r
    });
    let mut engine = Engine::new(cfg, targets, tables, store, set, hub, me)?;
    engine.serve = serve;
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

/// Console mode: start at once, print lines, exit code 1 on failures. With a cluster it first waits 5 s for the
/// other boxes; all of them must have the same state
fn plain(engine: &mut Engine, args: &Args) -> Result<()> {
    let sel = engine.select(&args.filter, args.scope);
    println!("{} matches, {} to render ({}), {} existing will be overwritten", sel.matched, sel.todo.len(), args.scope.label(), sel.overwrite);
    if sel.todo.is_empty() {
        return Ok(());
    }
    engine.echo = Some(Vec::new());
    let mut nodes = Vec::new();
    if engine.hub.is_some() {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) {
            engine.tick();
            thread::sleep(Duration::from_millis(100));
        }
        nodes = engine.connected_nodes().into_iter().map(|(_, h)| h.name).collect();
    }
    if let Some(other) = engine.running_elsewhere() {
        bail!("{other} has a run going: the boxes work on one run at a time");
    }
    let problems = engine.state_problems();
    if !problems.is_empty() {
        for (name, diff) in &problems {
            println!("{name} has another state: {}", diff.join(", "));
        }
        bail!("No run: all boxes need the same packshot, Blender, add-on (coordinators also Data.p4k and StarBreaker)");
    }
    engine.start(&sel, &args.line, &args.filter, args.scope, &args.name, nodes)?;
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
