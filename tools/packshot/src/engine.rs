// The run: selection, blocks, export pool (StarBreaker `entity export-batch`, one process per block) and
// Blender pool (render.py --jobs, one process per block), the images into the run and the target set (store.rs), log.
// Everything runs in the main thread; the child processes report their lines through a channel (one reader thread per stream).
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::events::{EventLog, GpuProbe, file_hash, round3};
use crate::net::{Hello, Hub, RunSummary};
use crate::store::{EntityResult, Resolved, RunInfo, SetInfo, Store};
use crate::tables::Tables;

#[derive(Deserialize, Clone)]
pub struct Target {
    pub uuids: Vec<String>,
    #[serde(default)]
    pub names: Option<Vec<String>>,
    pub entity: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "subType")]
    pub sub_type: String,
    #[serde(default)]
    pub worn: bool,
}

impl Target {
    pub fn name(&self) -> &str {
        self.names.as_ref().and_then(|n| n.first()).map(String::as_str).unwrap_or(&self.entity)
    }
}

pub struct Config {
    pub p4k: PathBuf,
    pub starbreaker: PathBuf,
    pub blender: PathBuf,
    pub render_script: PathBuf,
    pub work: PathBuf,
    pub size: u32,
    pub chunk: usize,
}

/// What gets rendered from the filter selection
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// only without a render
    Missing,
    /// those that failed on the last attempt in the set, even if an old image exists
    Failed,
    /// everything in the filter anew, overwrites existing ones
    All,
}

impl Scope {
    pub fn label(self) -> &'static str {
        match self {
            Scope::Missing => "missing",
            Scope::Failed => "failed last time",
            Scope::All => "re-render all (force)",
        }
    }
    pub fn next(self) -> Self {
        match self {
            Scope::Missing => Scope::Failed,
            Scope::Failed => Scope::All,
            Scope::All => Scope::Missing,
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "missing" => Some(Scope::Missing),
            "failed" => Some(Scope::Failed),
            "all" | "force" => Some(Scope::All),
            _ => None,
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Scope::Missing => "missing",
            Scope::Failed => "failed",
            Scope::All => "all",
        }
    }
}

/// Name of a run without --name: filter terms and scope ("arms-legs_missing", "all_failed")
pub fn default_run_name(filter: &str, scope: Scope) -> String {
    let terms: Vec<&str> = filter.split([' ', ',']).filter(|s| !s.is_empty()).collect();
    let f = if terms.is_empty() { "all".to_string() } else { terms.join("-") };
    format!("{}_{}", crate::store::slug(&f).chars().take(32).collect::<String>(), scope.key())
}

pub struct Selection {
    /// matches of the filter
    pub matched: usize,
    /// of those: with render, without render, last failed
    pub existing: usize,
    pub missing: usize,
    pub failed: usize,
    /// what would be rendered (indices into targets, plan order)
    pub todo: Vec<usize>,
    /// of those with an existing render that gets overwritten
    pub overwrite: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Ok,
    Error,
}

pub struct LogLine {
    pub time: String,
    pub level: Level,
    pub text: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Export,
    Render,
}

pub struct Worker {
    pub id: u64,
    pub kind: Kind,
    pub slot: usize,
    pub block: usize,
    /// local process; None for a Blender on a node
    child: Option<Child>,
    /// node, connection and block number there (cluster.rs)
    pub node: Option<String>,
    /// host name of the box doing the work (this one or the node)
    pub host: String,
    /// an item package on another coordinator: it exports and renders there
    pub package: bool,
    pub conn: u64,
    pub remote: u64,
    /// jobs in the order the process works through them
    pub order: Vec<usize>,
    pub reported: HashSet<usize>,
    pub since: Instant,
    started: Instant,
    /// sum of the seconds export-batch reports per item (the rest of the process time is loading and writing)
    item_secs: f64,
    pub(crate) eof: u8,
    pub(crate) stderr_tail: String,
    out_map: HashMap<String, usize>,
}

impl Worker {
    pub fn label(&self) -> String {
        format!("{}/{}{}", self.host, if self.kind == Kind::Export { 'E' } else { 'B' }, self.slot)
    }
    /// the item the process is currently working on (both tools work through their list in order)
    pub fn current(&self) -> Option<usize> {
        self.order.iter().copied().find(|t| !self.reported.contains(t))
    }
}

pub(crate) struct Block {
    pub(crate) items: Vec<usize>,
    pub(crate) root: PathBuf,
    pub(crate) packages: HashMap<usize, PathBuf>,
    failed: bool,
    /// exported, waiting for a Blender
    pub(crate) ready_at: Option<Instant>,
    /// an item package for another coordinator, which exports it itself
    pub(crate) package: bool,
}

pub struct Run {
    pub(crate) blocks: Vec<Block>,
    /// items not yet exported; blocks are only cut at export time (smaller towards the end)
    pub(crate) pending: VecDeque<usize>,
    pub(crate) ready: VecDeque<usize>,
    /// nodes that were connected at the start and take part
    pub nodes: Vec<String>,
    pub total: usize,
    pub ok: usize,
    pub failed: usize,
    pub exported: usize,
    pub started: Instant,
    pub finished: Option<Instant>,
    pub aborted: bool,
    /// times of finished renders (throughput, ETA)
    pub done_at: Vec<Instant>,
    /// sum of the phases from render.py (PHASES) over `phase_n` renders
    pub phase_sum: [f64; 5],
    pub phase_n: usize,
    /// run_end is already in the event log
    logged_end: bool,
}

/// Phases per render, as render.py appends them to the icon: line ("timing load=… prep=… render=… glass=… post=…")
pub const PHASES: [&str; 5] = ["load", "prep", "render", "glass", "post"];

fn parse_timing(info: &str) -> Option<[f64; 5]> {
    let rest = &info[info.find("timing ")? + 7..];
    let mut out = [0.0; 5];
    for pair in rest.split_whitespace() {
        let (k, v) = pair.split_once('=')?;
        out[PHASES.iter().position(|p| *p == k)?] = v.parse().ok()?;
    }
    Some(out)
}

impl Run {
    pub fn done(&self) -> usize {
        self.ok + self.failed
    }
    /// mean per phase over the renders so far
    pub fn phase_avg(&self) -> Option<[f64; 5]> {
        (self.phase_n > 0).then(|| self.phase_sum.map(|s| s / self.phase_n as f64))
    }
    /// (items before export, exported blocks waiting for a Blender)
    pub fn waiting(&self) -> (usize, usize) {
        (self.pending.len(), self.ready.len())
    }
}

enum Ev {
    Line { id: u64, line: String, stderr: bool },
    Eof { id: u64 },
}

pub struct Engine {
    pub cfg: Config,
    pub targets: Vec<Target>,
    pub(crate) tables: Tables,
    pub store: Store,
    /// the target set and its state per entity
    pub set: SetInfo,
    pub(crate) resolved: Resolved,
    /// run.json of the current or last run
    pub record: Option<RunInfo>,
    pub run: Option<Run>,
    pub workers: Vec<Worker>,
    pub max_exporters: usize,
    pub max_renderers: usize,
    /// physical cores (basis of the process counts, display)
    pub cores: usize,
    pub paused: bool,
    pub log: VecDeque<LogLine>,
    pub errors: Vec<(usize, String)>,
    /// most recently rendered items, newest last
    pub history: VecDeque<usize>,
    /// log lines for console mode (--plain), collected there
    pub echo: Option<Vec<String>>,
    haystack: Vec<String>,
    tx: Sender<Ev>,
    rx: Receiver<Ev>,
    next_id: u64,
    log_file: Option<File>,
    blender_log: Option<File>,
    /// event log of the current or last run (runs/<run>/events.jsonl)
    pub events: Option<EventLog>,
    gpu: Option<GpuProbe>,
    sys: Option<sysinfo::System>,
    last_sample: Instant,
    /// cluster (cluster.rs): connections, own versions, runs of the other coordinators, manifest
    pub hub: Option<Hub>,
    pub me: Hello,
    pub peer_runs: HashMap<String, Vec<RunSummary>>,
    pub manifest: Option<Manifest>,
    pub(crate) fetching: HashSet<String>,
    pub(crate) next_remote: u64,
    /// bytes sent to nodes in this session
    pub transferred: u64,
    /// renders the blocks of other coordinators while there is no run here (node.rs)
    pub serve: Option<crate::node::Renderer>,
}

/// State of a foreign set (another coordinator's live) for the scope "missing"
#[derive(Serialize, Deserialize, Clone)]
pub struct Manifest {
    pub from: String,
    pub set: String,
    pub at: String,
    pub entities: std::collections::BTreeMap<String, bool>,
}

/// Blender version from `blender --version` ("Blender 5.2.3"), otherwise from the folder name
pub fn blender_version(blender: &Path) -> String {
    if let Ok(out) = Command::new(blender).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(v) = text.lines().find_map(|l| l.trim().strip_prefix("Blender ")) {
            return v.split_whitespace().next().unwrap_or(v).to_string();
        }
    }
    let dir = blender.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    dir.split('-').find(|p| p.chars().next().is_some_and(|c| c.is_ascii_digit())).unwrap_or(&dir).to_string()
}

/// Keep about the last `max` bytes of a text, cut at a character boundary
pub fn keep_tail(s: &mut String, max: usize) {
    if s.len() > max {
        let mut cut = s.len() - max;
        while !s.is_char_boundary(cut) {
            cut += 1;
        }
        s.drain(..cut);
    }
}

fn now_local() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

fn sanitize(name: &str) -> String {
    let s: String = name.chars().filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') && (*c as u32) >= 0x20).collect();
    s.trim().chars().take(80).collect()
}

/// File name of an icon as in cli.ts: "display name (class name) <uuid>.png"
fn icon_file(t: &Target, k: usize) -> String {
    let name = sanitize(t.names.as_ref().and_then(|n| n.get(k)).map(String::as_str).unwrap_or(""));
    let prefix = if name.is_empty() { String::new() } else { format!("{name} ") };
    format!("{prefix}({}) {}.png", t.entity, t.uuids[k])
}

fn too_long(root: &Path, limit: usize) -> (usize, Option<PathBuf>) {
    let mut count = 0;
    let mut first = None;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.as_os_str().len() > limit {
                count += 1;
                first.get_or_insert(p.clone());
            }
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push(p);
            }
        }
    }
    (count, first)
}

impl Engine {
    /// `set`: the target set; its folder is checked against its chain and repaired
    pub fn new(cfg: Config, targets: Vec<Target>, tables: Tables, mut store: Store, mut set: SetInfo, hub: Option<Hub>, me: Hello) -> Result<Self> {
        for d in [&cfg.work.join("export"), &cfg.work.join("render")] {
            fs::create_dir_all(d).with_context(|| d.display().to_string())?;
        }
        store.sync(&mut set)?;
        let resolved = store.resolve(&set)?;
        let haystack = targets
            .iter()
            .map(|t| format!("{}\n{}\n{}/{}", t.entity, t.names.as_ref().map(|n| n.join("\n")).unwrap_or_default(), t.kind, t.sub_type).to_lowercase())
            .collect();
        let (tx, rx) = channel();
        let manifest = crate::cluster::load_manifest(&store.root);
        Ok(Self {
            cfg,
            targets,
            tables,
            store,
            set,
            resolved,
            hub,
            me,
            peer_runs: HashMap::new(),
            manifest,
            fetching: HashSet::new(),
            next_remote: 1,
            transferred: 0,
            serve: None,
            record: None,
            run: None,
            workers: Vec::new(),
            max_exporters: 2,
            max_renderers: 4,
            cores: 0,
            paused: false,
            log: VecDeque::new(),
            errors: Vec::new(),
            history: VecDeque::new(),
            echo: None,
            haystack,
            tx,
            rx,
            next_id: 1,
            log_file: None,
            blender_log: None,
            events: None,
            gpu: None,
            sys: sysinfo::System::new().ok(),
            last_sample: Instant::now(),
        })
    }

    pub(crate) fn emit(&mut self, ev: &str, fields: serde_json::Value) {
        if let Some(l) = self.events.as_mut() {
            l.emit(ev, fields);
        }
    }

    /// Origin of the run for run_start: machine, processes, versions of render.py, addon, StarBreaker and p4k
    fn run_meta(&self, run_id: &str, args_line: &str, filter: &str, scope: Scope, total: usize, blocks: usize, size: usize) -> serde_json::Value {
        let version = self.me.blender.clone();
        let commit = self.cfg.starbreaker.parent().and_then(|d| fs::read_to_string(d.join("COMMIT")).ok()).map(|s| s.split_whitespace().next().unwrap_or("").to_string());
        let p4k = fs::metadata(&self.cfg.p4k).ok();
        json!({
            "run": run_id,
            "set": self.set.name,
            "host": self.me.name,
            "nodes": self.run.as_ref().map(|r| r.nodes.clone()).unwrap_or_default(),
            "os": std::env::consts::OS,
            "args": args_line,
            "filter": filter,
            "scope": scope.key(),
            "total": total,
            "blocks": blocks,
            "block_size": size,
            "renderers": self.max_renderers,
            "exporters": self.max_exporters,
            "cores": self.cores,
            "blender": self.cfg.blender,
            "blender_version": version,
            "gpu_backend": "vulkan",
            "render_py": file_hash(&self.cfg.render_script),
            "addon": self.me.addon,
            "starbreaker": commit,
            "p4k": self.cfg.p4k,
            "p4k_bytes": p4k.as_ref().map(|m| m.len()),
            "p4k_id": self.me.p4k_id,
            "p4k_version": self.me.p4k_version,
            "p4k_mtime": p4k.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()),
            "size": self.cfg.size,
        })
    }

    /// Sample every 2 s during a run: CPU, GPU, running processes, queue
    fn sample(&mut self) {
        if !self.running() || self.last_sample.elapsed() < Duration::from_secs(2) {
            return;
        }
        self.last_sample = Instant::now();
        let cpu = self.sys.as_mut().map(|s| {
            s.refresh_cpu_usage();
            round3(f64::from(s.global_cpu_usage()))
        });
        let gpu = self.gpu.as_ref().and_then(GpuProbe::get);
        let exporting = self.workers.iter().filter(|w| w.kind == Kind::Export).count();
        let rendering = self.workers.len() - exporting;
        let (pending, ready, done) = self.run.as_ref().map(|r| (r.pending.len(), r.ready.len(), r.done())).unwrap_or_default();
        let (max_renderers, max_exporters, paused) = (self.max_renderers, self.max_exporters, self.paused);
        self.emit("sample", json!({
            "cpu": cpu, "gpu": gpu, "exporting": exporting, "rendering": rendering, "pending": pending, "ready": ready,
            "done": done, "max_renderers": max_renderers, "max_exporters": max_exporters, "paused": paused,
        }));
    }

    /// Conclusion in the event log (finished or aborted)
    fn emit_run_end(&mut self) {
        let Some(r) = self.run.as_mut() else { return };
        if r.logged_end {
            return;
        }
        r.logged_end = true;
        let r = &*r;
        let wall = r.finished.unwrap_or_else(Instant::now).duration_since(r.started).as_secs_f64();
        let phases: serde_json::Map<String, serde_json::Value> =
            r.phase_avg().map(|a| PHASES.iter().zip(a).map(|(k, v)| (k.to_string(), json!(round3(v)))).collect()).unwrap_or_default();
        let fields = json!({ "wall": round3(wall), "ok": r.ok, "failed": r.failed, "total": r.total, "aborted": r.aborted, "phase_avg": phases });
        self.emit("run_end", fields);
        self.gpu = None;
    }

    /// Where Blender renders to; the image then moves into the run
    pub(crate) fn render_png(&self, t: usize) -> PathBuf {
        self.cfg.work.join("render").join(format!("{}.png", self.targets[t].entity))
    }

    /// The entity's image in the target set (first UUID)
    pub fn image(&self, t: usize) -> Option<PathBuf> {
        let (_, files) = self.resolved.image.get(&self.targets[t].entity)?;
        files.first().map(|f| self.store.set_dir(&self.set.name).join(f))
    }

    pub fn has_render(&self, t: usize) -> bool {
        self.resolved.image.contains_key(&self.targets[t].entity)
    }

    /// For "missing": in the target set or, if that is live, in the fetched live manifest of another coordinator
    fn present(&self, t: usize) -> bool {
        self.has_render(t)
            || (self.set.name == crate::store::LIVE && self.manifest.as_ref().is_some_and(|m| m.entities.get(&self.targets[t].entity) == Some(&true)))
    }

    pub fn failed_last(&self, t: usize) -> bool {
        self.resolved.failed.contains(&self.targets[t].entity)
    }

    pub fn run_dir(&self) -> Option<PathBuf> {
        self.record.as_ref().map(|r| self.store.run_dir(&r.id))
    }

    pub fn pose_rig(&self, t: usize) -> Result<([f64; 3], PathBuf)> {
        let tg = &self.targets[t];
        Ok((self.tables.pose(&tg.kind, &tg.sub_type), self.tables.rig(&tg.kind, &tg.sub_type)?.clone()))
    }

    /// Filter: terms separated by spaces or commas, a match in class name, display name or
    /// type/subtype is enough (OR), case-insensitive. Empty = all.
    pub fn select(&self, filter: &str, scope: Scope) -> Selection {
        let terms: Vec<String> = filter.split([' ', ',']).filter(|s| !s.is_empty()).map(str::to_lowercase).collect();
        let mut s = Selection { matched: 0, existing: 0, missing: 0, failed: 0, todo: Vec::new(), overwrite: 0 };
        for (i, h) in self.haystack.iter().enumerate() {
            if !terms.is_empty() && !terms.iter().any(|t| h.contains(t.as_str())) {
                continue;
            }
            s.matched += 1;
            let has = self.present(i);
            let failed = self.failed_last(i);
            if has { s.existing += 1 } else { s.missing += 1 }
            if failed {
                s.failed += 1;
            }
            let take = match scope {
                Scope::Missing => !has,
                Scope::Failed => failed,
                Scope::All => true,
            };
            if take {
                s.todo.push(i);
                if has {
                    s.overwrite += 1;
                }
            }
        }
        s
    }

    pub fn note(&mut self, level: Level, text: impl Into<String>) {
        let text = text.into();
        if let Some(f) = self.log_file.as_mut() {
            let _ = writeln!(f, "{text}");
        }
        if let Some(e) = self.echo.as_mut() {
            e.push(text.clone());
        }
        self.log.push_back(LogLine { time: now_local(), level, text });
        while self.log.len() > 500 {
            self.log.pop_front();
        }
    }

    /// Starts a run over the selection as a new run (`name`, empty = from filter and scope) in the target set;
    /// `nodes`: the connected nodes that take part (cluster.rs)
    pub fn start(&mut self, sel: &Selection, args_line: &str, filter: &str, scope: Scope, name: &str, nodes: Vec<String>) -> Result<()> {
        let work = &self.cfg.work;
        let mut log_file = OpenOptions::new().create(true).append(true).open(work.join("render.log"))?;
        writeln!(log_file, "=== {} packshot {}", chrono::Local::now().to_rfc3339(), args_line)?;
        self.log_file = Some(log_file);
        let mut blender_log = OpenOptions::new().create(true).append(true).open(work.join("blender.log"))?;
        writeln!(blender_log, "=== {}", chrono::Local::now().to_rfc3339())?;
        self.blender_log = Some(blender_log);
        self.errors.clear();

        let n = sel.todo.len();
        self.run = Some(Run {
            blocks: Vec::new(),
            pending: sel.todo.iter().copied().collect(),
            ready: VecDeque::new(),
            nodes,
            total: n,
            ok: 0,
            failed: 0,
            exported: 0,
            started: Instant::now(),
            finished: None,
            aborted: false,
            done_at: Vec::new(),
            phase_sum: [0.0; 5],
            phase_n: 0,
            logged_end: false,
        });
        // The run: folder with start time and name, run.json with the origin, at the end of the chain in the target set
        let name = if name.trim().is_empty() { default_run_name(filter, scope) } else { name.trim().to_string() };
        let run_id = self.store.new_run_id(&name);
        fs::create_dir_all(self.store.run_dir(&run_id))?;
        let slots = self.total_slots();
        let meta = self.run_meta(&run_id, args_line, filter, scope, n, n.div_ceil(self.block_size().max(1)), self.block_size());
        let record = RunInfo {
            id: run_id.clone(),
            name,
            set: self.set.name.clone(),
            node: self.me.name.clone(),
            started: chrono::Local::now().to_rfc3339(),
            origin: meta.clone(),
            ..Default::default()
        };
        self.store.save_run(&record)?;
        self.record = Some(record);
        self.set.runs.push(run_id.clone());
        self.store.save_set(&self.set)?;
        let nodes = self.run.as_ref().map(|r| r.nodes.join(", ")).unwrap_or_default();
        self.note(
            Level::Info,
            format!(
                "Run {run_id} on set {}: {n} entities, {} export, {} Blender here{}, {slots} Blender in all",
                self.set.name,
                self.max_exporters,
                self.max_renderers,
                if nodes.is_empty() { String::new() } else { format!(" + nodes {nodes}") }
            ),
        );
        match EventLog::create(&self.store.run_dir(&run_id).join("events.jsonl")) {
            Ok(mut log) => {
                log.emit("run_start", meta);
                self.note(Level::Info, format!("Event log: {}", log.path.display()));
                self.events = Some(log);
            }
            Err(e) => self.note(Level::Error, format!("Event log not created: {e}")),
        }
        self.gpu = GpuProbe::start();
        self.last_sample = Instant::now();
        self.paused = false;
        Ok(())
    }

    /// Blenders in the cluster: the own plus the slots of the participating nodes with a matching version
    pub fn total_slots(&self) -> usize {
        self.max_renderers + self.usable_nodes().iter().map(|(_, slots)| slots).sum::<usize>()
    }

    /// Next block size: remainder / (3 × Blenders in the cluster), at least 10, at most --chunk; for small remainders
    /// such that every Blender gets something
    pub fn block_size(&self) -> usize {
        let rem = self.run.as_ref().map(|r| r.pending.len()).unwrap_or(0).max(1);
        let total = self.total_slots().max(1);
        rem.div_ceil(3 * total).max(10).min(self.cfg.chunk.max(1)).min(rem.div_ceil(total)).max(1)
    }

    /// Make another set the target set (Sets view, Enter); its folder is checked against its chain
    pub fn switch_set(&mut self, name: &str) -> Result<()> {
        let mut set = self.store.load_set(name)?;
        self.store.sync(&mut set)?;
        self.resolved = self.store.resolve(&set)?;
        self.set = set;
        Ok(())
    }

    /// Re-read the target set after store operations (adopt, delete); falls back to live if it is gone
    pub fn reload_set(&mut self) -> Result<()> {
        let name = if self.store.sets()?.contains(&self.set.name) { self.set.name.clone() } else { crate::store::LIVE.to_string() };
        self.switch_set(&name)
    }

    pub fn running(&self) -> bool {
        self.run.as_ref().is_some_and(|r| r.finished.is_none())
    }

    /// Aborts: end child processes, save state; what is missing stays for the next run
    pub fn abort(&mut self) {
        for w in &mut self.workers {
            if let Some(c) = w.child.as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
            if w.node.is_some() {
                if let Some(h) = self.hub.as_ref() {
                    h.send(w.conn, crate::net::Msg::Cancel { id: w.remote }, crate::net::Payload::None);
                }
            }
        }
        self.workers.clear();
        if let Some(r) = self.run.as_mut() {
            if r.finished.is_none() {
                r.finished = Some(Instant::now());
                r.aborted = true;
            }
        }
        if self.run.as_ref().is_some_and(|r| r.aborted) {
            self.note(Level::Info, "Run aborted");
            self.emit_run_end();
            self.close_record(true);
        }
    }

    /// Save run.json and set.json (after every block and at the end)
    pub(crate) fn persist(&mut self) {
        let res = match self.record.as_ref() {
            Some(rec) => self.store.save_run(rec).and_then(|_| self.store.save_set(&self.set)),
            None => Ok(()),
        };
        if let Err(e) = res {
            self.note(Level::Error, format!("Run/set not saved: {e:#}"));
        }
    }

    /// Finish the run: end in run.json, immutable afterwards. Without a single result it gets thrown out again
    fn close_record(&mut self, aborted: bool) {
        let Some(rec) = self.record.as_mut() else { return };
        if rec.finished.is_some() {
            return;
        }
        rec.finished = Some(chrono::Local::now().to_rfc3339());
        rec.aborted = aborted;
        if rec.entities.is_empty() {
            let id = rec.id.clone();
            self.record = None;
            self.events = None;
            self.set.runs.retain(|r| *r != id);
            let res = self.store.save_set(&self.set).and_then(|_| self.store.delete_run(&id));
            match res {
                Ok(_) => self.note(Level::Info, format!("Run {id} removed again: no results")),
                Err(e) => self.note(Level::Error, format!("Run {id} not removed: {e:#}")),
            }
            return;
        }
        self.persist();
    }

    fn spawn(&mut self, kind: Kind, block: usize, mut cmd: Command, order: Vec<usize>, out_map: HashMap<String, usize>) -> Result<()> {
        let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
        let id = self.next_id;
        self.next_id += 1;
        for (stream, stderr) in [(child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), false), (child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), true)] {
            let Some(stream) = stream else { continue };
            let tx = self.tx.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stream);
                let mut buf = Vec::new();
                while reader.read_until(b'\n', &mut buf).unwrap_or(0) > 0 {
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    buf.clear();
                    if tx.send(Ev::Line { id, line, stderr }).is_err() {
                        return;
                    }
                }
                let _ = tx.send(Ev::Eof { id });
            });
        }
        self.push_worker(id, kind, block, Some(child), None, 0, 0, order, out_map);
        Ok(())
    }

    /// Register a worker; the slot number counts per machine (local or per node)
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn push_worker(&mut self, id: u64, kind: Kind, block: usize, child: Option<Child>, node: Option<String>, conn: u64, remote: u64, order: Vec<usize>, out_map: HashMap<String, usize>) {
        let used: HashSet<usize> = self.workers.iter().filter(|w| w.kind == kind && w.node == node).map(|w| w.slot).collect();
        let slot = (1..).find(|s| !used.contains(s)).unwrap_or(1);
        let now = Instant::now();
        let host = node.clone().unwrap_or_else(|| self.me.name.clone());
        self.workers.push(Worker {
            id,
            kind,
            slot,
            block,
            child,
            host,
            package: false,
            node,
            conn,
            remote,
            order,
            reported: HashSet::new(),
            since: now,
            started: now,
            item_secs: 0.0,
            eof: 0,
            stderr_tail: String::new(),
            out_map,
        });
    }

    pub(crate) fn new_worker_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id - 1
    }

    fn start_export(&mut self, b: usize) {
        let run = self.run.as_ref().unwrap();
        let block = &run.blocks[b];
        let root = block.root.clone();
        let items = block.items.clone();
        let _ = fs::remove_dir_all(&root);
        let jobs: Vec<_> = items.iter().map(|&t| json!({ "name": self.targets[t].entity, "output": root, "worn": self.targets[t].worn })).collect();
        let jobs_file = root.join("jobs.json");
        let res = fs::create_dir_all(&root).and_then(|_| fs::write(&jobs_file, serde_json::to_vec(&jobs).unwrap_or_default())).map_err(anyhow::Error::from).and_then(|_| {
            let mut cmd = Command::new(&self.cfg.starbreaker);
            // --variant-tags: paint variants with their SubGeometry; --icon-files: without animations and diagnostics
            cmd.arg("entity").arg("export-batch").arg(&jobs_file).arg("--p4k").arg(&self.cfg.p4k).args(["--kind", "decomposed", "--variant-tags", "--icon-files"]);
            self.spawn(Kind::Export, b, cmd, items.clone(), HashMap::new())
        });
        match res {
            Ok(()) => {
                let worker = self.workers.last().map(Worker::label).unwrap_or_default();
                self.emit("export_start", json!({ "block": b, "worker": worker, "items": items.len() }));
            }
            Err(e) => {
                for t in items {
                    self.record(t, false, Some(format!("export-batch does not start: {e}")), 0.0, "export", "");
                }
                self.finish_block(b);
            }
        }
    }

    fn start_render(&mut self, b: usize) {
        let run = self.run.as_ref().unwrap();
        let block = &run.blocks[b];
        let mut order = Vec::new();
        let mut jobs = Vec::new();
        let mut out_map = HashMap::new();
        let mut problems = Vec::new();
        for &t in &block.items {
            let Some(pkg) = block.packages.get(&t) else { continue };
            match self.pose_rig(t) {
                Ok((pose, rig)) => {
                    let out = self.render_png(t);
                    out_map.insert(out.to_string_lossy().to_lowercase(), t);
                    jobs.push(json!({ "src": pkg.join("scene.blend"), "out": out, "pose": pose, "rig": rig, "size": self.cfg.size }));
                    order.push(t);
                }
                Err(e) => problems.push((t, e.to_string())),
            }
        }
        for (t, e) in problems {
            self.record(t, false, Some(e), 0.0, "render", "");
        }
        if jobs.is_empty() {
            self.finish_block(b);
            return;
        }
        let jobs_file = self.cfg.work.join(format!("render-jobs-b{b}.json"));
        let res = fs::write(&jobs_file, serde_json::to_vec(&jobs).unwrap_or_default()).map_err(anyhow::Error::from).and_then(|_| {
            let mut cmd = Command::new(&self.cfg.blender);
            // Vulkan: under OpenGL the render phase (shader compilation) grew with 8 Blenders from 0.21 to 0.86 s,
            // under Vulkan it stayed at 0.30 s; the images differ by 0.04/255 on average (2026-11-02)
            cmd.arg("-b").arg("--gpu-backend").arg("vulkan").arg("--python").arg(&self.cfg.render_script).arg("--").arg("--jobs").arg(&jobs_file);
            self.spawn(Kind::Render, b, cmd, order.clone(), out_map)
        });
        match res {
            Ok(()) => {
                let worker = self.workers.last().map(Worker::label).unwrap_or_default();
                let wait = self.run.as_ref().and_then(|r| r.blocks[b].ready_at).map(|t| round3(t.elapsed().as_secs_f64()));
                self.emit("render_start", json!({ "block": b, "worker": worker, "items": order.len(), "queue_wait": wait }));
            }
            Err(e) => {
                for t in order {
                    self.record(t, false, Some(format!("Blender does not start: {e}")), 0.0, "render", "");
                }
                self.finish_block(b);
            }
        }
    }

    /// Result of an item (export failure or render result)
    pub(crate) fn record(&mut self, t: usize, ok: bool, error: Option<String>, seconds: f64, what: &str, detail: &str) {
        let entity = self.targets[t].entity.clone();
        // A success is already in the run (place_icons), a failure goes in here
        if !ok {
            if let Some(rec) = self.record.as_mut() {
                let r = EntityResult { ok: false, error: error.clone(), files: Vec::new() };
                self.resolved.apply(&rec.id, &entity, &r);
                rec.entities.insert(entity.clone(), r);
            }
        }
        let Some(run) = self.run.as_mut() else { return };
        let i = run.done() + 1;
        let total = run.total;
        let w = total.to_string().len();
        if ok {
            run.ok += 1;
            run.done_at.push(Instant::now());
            self.history.push_back(t);
            while self.history.len() > 50 {
                self.history.pop_front();
            }
            self.note(Level::Ok, format!("[{i:>w$}/{total}] {what:<6} {entity}  {seconds:.1} s{detail}"));
        } else {
            run.failed += 1;
            run.done_at.push(Instant::now());
            let e = error.unwrap_or_default();
            self.note(Level::Error, format!("[{i:>w$}/{total}] {what:<6} {entity}  FAILED {e}{detail}"));
            self.emit("failure", json!({ "entity": entity, "stage": what, "error": e }));
            self.errors.push((t, e));
            if let Some(b) = self.run.as_mut().and_then(|r| r.blocks.iter_mut().find(|b| b.items.contains(&t))) {
                b.failed = true;
            }
        }
    }

    /// The finished image into the run (one file per UUID) and as hardlinks into the target set; the entity's old ones go
    fn place_icons(&mut self, t: usize) -> Result<()> {
        let tg = &self.targets[t];
        let files: Vec<String> = (0..tg.uuids.len()).map(|k| icon_file(tg, k)).collect();
        let entity = tg.entity.clone();
        let run_id = self.record.as_ref().map(|r| r.id.clone()).context("no run")?;
        self.store.put_image(&run_id, &self.render_png(t), &files)?;
        let old = self.resolved.image.get(&entity).map(|(_, f)| f.clone()).unwrap_or_default();
        self.store.link_entity(&mut self.set, &old, &run_id, &files)?;
        let r = EntityResult { ok: true, error: None, files };
        self.resolved.apply(&run_id, &entity, &r);
        if let Some(rec) = self.record.as_mut() {
            rec.entities.insert(entity, r);
        }
        Ok(())
    }

    pub(crate) fn finish_block(&mut self, b: usize) {
        self.persist();
        let Some(run) = self.run.as_mut() else { return };
        let block = &run.blocks[b];
        // Export gone after the render (the full set would be gigabytes); with failures it stays for diagnosis
        if !block.failed {
            let _ = fs::remove_dir_all(&block.root);
        }
        let _ = fs::remove_file(self.cfg.work.join(format!("render-jobs-b{b}.json")));
    }

    fn on_line(&mut self, idx: usize, line: String, stderr: bool) {
        let kind = self.workers[idx].kind;
        if kind == Kind::Render {
            let label = self.workers[idx].label();
            if let Some(f) = self.blender_log.as_mut() {
                let _ = writeln!(f, "[{label}] {line}");
            }
            if stderr {
                return;
            }
            // render.py: "icon: <png> <info>" / "failed: <png> <error>"
            let (ok, rest) = if let Some(r) = line.trim().strip_prefix("icon: ") {
                (true, r)
            } else if let Some(r) = line.trim().strip_prefix("failed: ") {
                (false, r)
            } else {
                return;
            };
            let Some(end) = rest.to_lowercase().find(".png") else { return };
            let path = rest[..end + 4].to_lowercase();
            let info = rest[end + 4..].trim().to_string();
            let Some(&t) = self.workers[idx].out_map.get(&path) else { return };
            self.render_result(idx, t, ok, info);
            return;
        }
        self.export_line(idx, line, stderr);
    }

    /// Result of a render (locally from the icon: line, from the node via the item message; the PNG is then already
    /// at render_png)
    pub(crate) fn render_result(&mut self, idx: usize, t: usize, ok: bool, info: String) {
        let w = &mut self.workers[idx];
        if !w.reported.insert(t) {
            return;
        }
        let seconds = w.since.elapsed().as_secs_f64();
        w.since = Instant::now();
        let (block, worker) = (w.block, w.label());
        let timing = parse_timing(&info);
        let phases: serde_json::Map<String, serde_json::Value> = timing.map(|ph| PHASES.iter().zip(ph).map(|(k, v)| (k.to_string(), json!(v))).collect()).unwrap_or_default();
        self.emit("render_item", json!({
            "entity": self.targets[t].entity, "block": block, "worker": worker, "wall": round3(seconds), "ok": ok,
            "phases": if timing.is_some() { serde_json::Value::Object(phases) } else { serde_json::Value::Null },
            "error": if ok { serde_json::Value::Null } else { json!(info) },
        }));
        if ok {
            if let Err(e) = self.place_icons(t) {
                self.record(t, false, Some(format!("image not stored: {e:#}")), seconds, "render", &format!("  {worker}"));
                return;
            }
            let mut detail = format!("  {worker}");
            if let Some(ph) = timing {
                if let Some(run) = self.run.as_mut() {
                    run.phase_n += 1;
                    for (s, v) in run.phase_sum.iter_mut().zip(ph) {
                        *s += v;
                    }
                }
                let parts: Vec<String> = PHASES.iter().zip(ph).map(|(k, v)| format!("{k} {v:.2}")).collect();
                detail = format!("  {worker}  ({})", parts.join(" · "));
            }
            self.record(t, true, None, seconds, "render", &detail);
        } else {
            self.record(t, false, Some(if info.is_empty() { "render failed".into() } else { info }), seconds, "render", &format!("  {worker}"));
        }
    }

    fn export_line(&mut self, idx: usize, line: String, stderr: bool) {
        if stderr {
            let w = &mut self.workers[idx];
            w.stderr_tail.push_str(&line);
            w.stderr_tail.push('\n');
            keep_tail(&mut w.stderr_tail, 4000);
            return;
        }
        // export-batch: one JSON line per job {name, ok, package, worn, seconds, error}
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { return };
        let name = v["name"].as_str().unwrap_or_default().to_lowercase();
        let w = &self.workers[idx];
        let Some(&t) = w.order.iter().find(|&&t| self.targets[t].entity.to_lowercase() == name) else { return };
        let b = w.block;
        let worker = w.label();
        let secs = v["seconds"].as_f64().unwrap_or(0.0);
        self.workers[idx].reported.insert(t);
        self.workers[idx].since = Instant::now();
        self.workers[idx].item_secs += secs;
        self.emit("export_item", json!({
            "entity": self.targets[t].entity, "block": b, "worker": worker, "seconds": round3(secs),
            "ok": v["ok"].as_bool() == Some(true), "worn": v["worn"], "error": v["error"],
        }));
        if v["ok"].as_bool() == Some(true) {
            if let Some(pkg) = v["package"].as_str() {
                if let Some(run) = self.run.as_mut() {
                    run.blocks[b].packages.insert(t, PathBuf::from(pkg));
                    run.exported += 1;
                }
            }
        } else {
            let e = v["error"].as_str().unwrap_or("export failed").to_string();
            self.record(t, false, Some(e), v["seconds"].as_f64().unwrap_or(0.0), "export", "");
        }
    }

    pub(crate) fn on_exit(&mut self, idx: usize) {
        let mut w = self.workers.remove(idx);
        let status = w.child.as_mut().and_then(|c| c.wait().ok());
        let b = w.block;
        let missing: Vec<usize> = w.order.iter().copied().filter(|t| !w.reported.contains(t)).collect();
        let wall = round3(w.started.elapsed().as_secs_f64());
        let exit = status.and_then(|s| s.code());
        let (worker, items) = (w.label(), w.order.len());
        match w.kind {
            Kind::Export => {
                let long = if cfg!(windows) { self.run.as_ref().map(|r| too_long(&r.blocks[b].root, 259).0).unwrap_or(0) } else { 0 };
                self.emit("export_end", json!({
                    "block": b, "worker": worker, "items": items, "missing": missing.len(), "wall": wall,
                    "item_seconds": round3(w.item_secs), "exit": exit, "long_paths": long,
                }));
            }
            Kind::Render => {
                self.emit("render_end", json!({ "block": b, "worker": worker, "items": items, "missing": missing.len(), "wall": wall, "exit": exit }));
            }
        }
        match w.kind {
            Kind::Export => {
                let code_ok = status.is_some_and(|s| s.success());
                for t in missing {
                    let tail = w.stderr_tail.trim().lines().last().unwrap_or("").to_string();
                    self.record(t, false, Some(format!("export-batch aborted {tail}").trim().to_string()), 0.0, "export", "");
                }
                if !code_ok && !w.stderr_tail.trim().is_empty() {
                    let tail = w.stderr_tail.trim().to_string();
                    self.note(Level::Error, format!("    {tail}"));
                }
                let Some(run) = self.run.as_mut() else { return };
                let root = run.blocks[b].root.clone();
                let has_packages = !run.blocks[b].packages.is_empty();
                // On Windows Blender cannot read paths over 259 characters: missing textures silently render white
                if cfg!(windows) {
                    let (n, first) = too_long(&root, 259);
                    if n > 0 {
                        self.note(Level::Error, format!("Block {}: {n} paths over 259 characters ({}), put --work in a shorter folder", b + 1, first.map(|p| p.display().to_string()).unwrap_or_default()));
                    }
                }
                if has_packages {
                    let run = self.run.as_mut().unwrap();
                    run.blocks[b].ready_at = Some(Instant::now());
                    run.ready.push_back(b);
                } else {
                    self.finish_block(b);
                }
            }
            Kind::Render => {
                for t in missing {
                    let error = match &w.node {
                        // the node sends Blender's last line (it keeps the block for diagnosis)
                        Some(n) => format!("no image from {n} (Blender aborted?) {}", w.stderr_tail.trim()).trim().to_string(),
                        None if self.render_png(t).exists() => "no result reported (Blender aborted?)".into(),
                        None => "no image (Blender aborted?)".into(),
                    };
                    self.record(t, false, Some(error), 0.0, "render", "");
                }
                self.finish_block(b);
            }
        }
        w.order.clear();
    }

    /// One tick: process lines of the child processes, finish ended ones, start new ones
    pub fn tick(&mut self) {
        let deadline = Instant::now() + Duration::from_millis(30);
        while let Ok(ev) = self.rx.try_recv() {
            match ev {
                Ev::Line { id, line, stderr } => {
                    if let Some(idx) = self.workers.iter().position(|w| w.id == id) {
                        self.on_line(idx, line, stderr);
                    }
                }
                Ev::Eof { id } => {
                    if let Some(w) = self.workers.iter_mut().find(|w| w.id == id) {
                        w.eof += 1;
                    }
                }
            }
            if Instant::now() > deadline {
                break;
            }
        }
        // Both streams closed: the process is done (the last lines are already processed)
        while let Some(idx) = self.workers.iter().position(|w| w.eof >= 2) {
            self.on_exit(idx);
        }
        self.poll_net();
        self.schedule();
        self.sample();
    }

    fn schedule(&mut self) {
        let Some(run) = self.run.as_ref() else { return };
        if run.finished.is_some() {
            return;
        }
        if !self.paused {
            let slots = self.total_slots();
            loop {
                let run = self.run.as_ref().unwrap();
                let exporting = self.workers.iter().filter(|w| w.kind == Kind::Export).count();
                // exports only as far ahead as the Blenders in the cluster can take them (disk space)
                if exporting >= self.max_exporters || run.pending.is_empty() || exporting + run.ready.len() > slots {
                    break;
                }
                // cut the block only now: smaller towards the end of the run
                let size = self.block_size();
                let run = self.run.as_mut().unwrap();
                let items: Vec<usize> = (0..size).filter_map(|_| run.pending.pop_front()).collect();
                let b = run.blocks.len();
                let root = self.cfg.work.join("export").join(format!("b{b}"));
                run.blocks.push(Block { items, root, packages: HashMap::new(), failed: false, ready_at: None, package: false });
                self.start_export(b);
            }
            // the other coordinators (same state: same Data.p4k and StarBreaker) export and render packages of their own
            loop {
                if self.run.as_ref().unwrap().pending.is_empty() {
                    break;
                }
                let Some(conn) = self.free_exporter() else { break };
                let size = self.block_size();
                let run = self.run.as_mut().unwrap();
                let items: Vec<usize> = (0..size).filter_map(|_| run.pending.pop_front()).collect();
                let b = run.blocks.len();
                let root = self.cfg.work.join("export").join(format!("p{b}"));
                run.blocks.push(Block { items, root, packages: HashMap::new(), failed: false, ready_at: None, package: true });
                self.start_package(b, conn);
            }
            // exported blocks go to free boxes first, so this box keeps its CPU for exporting; the rest renders here
            loop {
                if self.run.as_ref().unwrap().ready.is_empty() {
                    break;
                }
                let Some(conn) = self.free_node() else { break };
                let b = self.run.as_mut().unwrap().ready.pop_front().unwrap();
                self.start_remote(b, conn);
            }
            loop {
                let rendering = self.workers.iter().filter(|w| w.kind == Kind::Render && w.node.is_none()).count();
                if rendering >= self.max_renderers {
                    break;
                }
                let Some(b) = self.run.as_mut().unwrap().ready.pop_front() else { break };
                self.start_render(b);
            }
        }
        let run = self.run.as_ref().unwrap();
        if self.workers.is_empty() && run.ready.is_empty() && run.pending.is_empty() {
            let r = self.run.as_mut().unwrap();
            r.finished = Some(Instant::now());
            let (ok, failed, mins) = (r.ok, r.failed, r.started.elapsed().as_secs_f64() / 60.0);
            let dir = self.run_dir().map(|d| d.display().to_string()).unwrap_or_default();
            self.note(Level::Info, format!("Done: {ok} rendered, {failed} failed, {mins:.1} min -> {dir}, set {}", self.set.name));
            self.emit_run_end();
            self.close_record(false);
        }
    }

    /// Renders per minute over the last `window` seconds
    pub fn rate(&self, window: f64) -> f64 {
        let Some(run) = self.run.as_ref() else { return 0.0 };
        let end = run.finished.unwrap_or_else(Instant::now);
        let span = window.min(end.duration_since(run.started).as_secs_f64()).max(1.0);
        let n = run.done_at.iter().filter(|t| end.duration_since(**t).as_secs_f64() <= span).count();
        n as f64 * 60.0 / span
    }
}
