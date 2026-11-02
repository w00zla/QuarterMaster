// Der Lauf: Auswahl, Blöcke, Export-Pool (StarBreaker `entity export-batch`, ein Prozess je Block) und
// Blender-Pool (render.py --jobs, ein Prozess je Block), Platzieren der PNGs, Protokoll und Zustand.
// Alles läuft im Hauptthread; die Kindprozesse melden ihre Zeilen über einen Kanal (je Strom ein Lesethread).
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

use crate::events::{EventLog, GpuProbe, file_hash, round3, tree_hash};
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
    pub out: PathBuf,
    pub work: PathBuf,
    pub size: u32,
    pub chunk: usize,
}

/// Was aus der Filter-Auswahl gerendert wird
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// nur ohne Render
    Missing,
    /// die beim letzten Versuch gescheiterten, auch wenn ein altes Bild existiert
    Failed,
    /// alles im Filter neu, überschreibt vorhandene
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
}

/// Letztes Ergebnis je Entity, über Läufe hinweg (<work>/render-state.json)
#[derive(Serialize, Deserialize, Clone)]
pub struct Outcome {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub at: String,
}

pub struct Selection {
    /// Treffer des Filters
    pub matched: usize,
    /// davon mit Render, ohne Render, zuletzt gescheitert
    pub existing: usize,
    pub missing: usize,
    pub failed: usize,
    /// was gerendert würde (Indizes in targets, Plan-Reihenfolge)
    pub todo: Vec<usize>,
    /// davon mit vorhandenem Render, das überschrieben wird
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
    child: Child,
    /// Jobs in der Reihenfolge, in der der Prozess sie abarbeitet
    pub order: Vec<usize>,
    pub reported: HashSet<usize>,
    pub since: Instant,
    started: Instant,
    /// Summe der Sekunden, die export-batch je Item meldet (der Rest der Prozesszeit ist Laden und Schreiben)
    item_secs: f64,
    eof: u8,
    stderr_tail: String,
    out_map: HashMap<String, usize>,
}

impl Worker {
    pub fn label(&self) -> String {
        format!("{}{}", if self.kind == Kind::Export { 'E' } else { 'B' }, self.slot)
    }
    /// Das Item, an dem der Prozess gerade arbeitet (beide Werkzeuge arbeiten ihre Liste der Reihe nach ab)
    pub fn current(&self) -> Option<usize> {
        self.order.iter().copied().find(|t| !self.reported.contains(t))
    }
}

struct Block {
    items: Vec<usize>,
    root: PathBuf,
    packages: HashMap<usize, PathBuf>,
    failed: bool,
    /// fertig exportiert, wartet auf einen Blender
    ready_at: Option<Instant>,
}

pub struct Run {
    blocks: Vec<Block>,
    next_export: usize,
    ready: VecDeque<usize>,
    pub total: usize,
    pub ok: usize,
    pub failed: usize,
    pub exported: usize,
    pub started: Instant,
    pub finished: Option<Instant>,
    pub aborted: bool,
    /// Zeitpunkte fertiger Renders (Durchsatz, ETA)
    pub done_at: Vec<Instant>,
    /// Summe der Phasen aus render.py (PHASES) über `phase_n` Renders
    pub phase_sum: [f64; 5],
    pub phase_n: usize,
    /// run_end steht schon im Ereignis-Log
    logged_end: bool,
}

/// Phasen je Render, wie render.py sie an die icon:-Zeile hängt ("timing load=… prep=… render=… glass=… post=…")
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
    /// Mittel je Phase über die bisherigen Renders
    pub fn phase_avg(&self) -> Option<[f64; 5]> {
        (self.phase_n > 0).then(|| self.phase_sum.map(|s| s / self.phase_n as f64))
    }
    pub fn waiting_blocks(&self) -> (usize, usize) {
        (self.blocks.len() - self.next_export, self.ready.len())
    }
}

enum Ev {
    Line { id: u64, line: String, stderr: bool },
    Eof { id: u64 },
}

pub struct Engine {
    pub cfg: Config,
    pub targets: Vec<Target>,
    tables: Tables,
    pub has_render: Vec<bool>,
    pub outcomes: HashMap<String, Outcome>,
    pub run: Option<Run>,
    pub workers: Vec<Worker>,
    pub max_exporters: usize,
    pub max_renderers: usize,
    /// physische Kerne (Grundlage der Prozesszahlen, Anzeige)
    pub cores: usize,
    pub paused: bool,
    pub log: VecDeque<LogLine>,
    pub errors: Vec<(usize, String)>,
    /// zuletzt gerenderte Items, neuestes hinten
    pub history: VecDeque<usize>,
    /// Logzeilen für den Konsolenmodus (--plain), werden dort abgeholt
    pub echo: Option<Vec<String>>,
    haystack: Vec<String>,
    tx: Sender<Ev>,
    rx: Receiver<Ev>,
    next_id: u64,
    log_file: Option<File>,
    blender_log: Option<File>,
    existing_icons: HashMap<String, Vec<String>>,
    /// Ereignis-Log des laufenden bzw. letzten Laufs (<work>/logs/<lauf>.jsonl)
    pub events: Option<EventLog>,
    gpu: Option<GpuProbe>,
    sys: Option<sysinfo::System>,
    last_sample: Instant,
}

fn now_local() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

fn sanitize(name: &str) -> String {
    let s: String = name.chars().filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') && (*c as u32) >= 0x20).collect();
    s.trim().chars().take(80).collect()
}

/// Dateiname eines Icons wie in cli.ts: "Klarname (Klassenname) <uuid>.png"
fn icon_file(t: &Target, k: usize) -> String {
    let name = sanitize(t.names.as_ref().and_then(|n| n.get(k)).map(String::as_str).unwrap_or(""));
    let prefix = if name.is_empty() { String::new() } else { format!("{name} ") };
    format!("{prefix}({}) {}.png", t.entity, t.uuids[k])
}

fn uuid_of(file: &str) -> Option<String> {
    let stem = file.strip_suffix(".png").or_else(|| file.strip_suffix(".PNG"))?;
    let uuid = stem.get(stem.len().checked_sub(36)?..)?;
    let ok = uuid.char_indices().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() });
    ok.then(|| uuid.to_lowercase())
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
    pub fn new(cfg: Config, targets: Vec<Target>, tables: Tables) -> Result<Self> {
        for d in [&cfg.out, &cfg.work.join("export"), &cfg.work.join("render")] {
            fs::create_dir_all(d).with_context(|| d.display().to_string())?;
        }
        let render_dir = cfg.work.join("render");
        let has_render = targets.iter().map(|t| render_dir.join(format!("{}.png", t.entity)).exists()).collect();
        let outcomes = fs::read(cfg.work.join("render-state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let haystack = targets
            .iter()
            .map(|t| format!("{}\n{}\n{}/{}", t.entity, t.names.as_ref().map(|n| n.join("\n")).unwrap_or_default(), t.kind, t.sub_type).to_lowercase())
            .collect();
        let mut existing_icons: HashMap<String, Vec<String>> = HashMap::new();
        for e in fs::read_dir(&cfg.out)?.flatten() {
            let f = e.file_name().to_string_lossy().to_string();
            if let Some(u) = uuid_of(&f) {
                existing_icons.entry(u).or_default().push(f);
            }
        }
        let (tx, rx) = channel();
        Ok(Self {
            cfg,
            targets,
            tables,
            has_render,
            outcomes,
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
            existing_icons,
            events: None,
            gpu: None,
            sys: sysinfo::System::new().ok(),
            last_sample: Instant::now(),
        })
    }

    fn emit(&mut self, ev: &str, fields: serde_json::Value) {
        if let Some(l) = self.events.as_mut() {
            l.emit(ev, fields);
        }
    }

    /// Herkunft des Laufs für run_start: Kiste, Prozesse, Stände von render.py, Addon, StarBreaker und p4k
    fn run_meta(&self, run_id: &str, args_line: &str, filter: &str, scope: Scope, total: usize, blocks: usize, size: usize) -> serde_json::Value {
        let blender_dir = self.cfg.blender.parent().map(Path::to_path_buf).unwrap_or_default();
        let version = blender_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let version = version.split('-').find(|p| p.chars().next().is_some_and(|c| c.is_ascii_digit())).unwrap_or(&version).to_string();
        let commit = self.cfg.starbreaker.parent().and_then(|d| fs::read_to_string(d.join("COMMIT")).ok()).map(|s| s.split_whitespace().next().unwrap_or("").to_string());
        let p4k = fs::metadata(&self.cfg.p4k).ok();
        json!({
            "run": run_id,
            "host": sysinfo::System::host_name().unwrap_or_default(),
            "os": std::env::consts::OS,
            "args": args_line,
            "filter": filter,
            "scope": match scope { Scope::Missing => "missing", Scope::Failed => "failed", Scope::All => "all" },
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
            "addon": tree_hash(&blender_dir.join("portable/scripts/addons/starbreaker_addon")),
            "starbreaker": commit,
            "p4k": self.cfg.p4k,
            "p4k_bytes": p4k.as_ref().map(|m| m.len()),
            "p4k_mtime": p4k.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()),
            "size": self.cfg.size,
        })
    }

    /// Messpunkt alle 2 s während eines Laufs: CPU, GPU, laufende Prozesse, Queue
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
        let (pending, ready, done) = self.run.as_ref().map(|r| (r.blocks.len() - r.next_export, r.ready.len(), r.done())).unwrap_or_default();
        let (max_renderers, max_exporters, paused) = (self.max_renderers, self.max_exporters, self.paused);
        self.emit("sample", json!({
            "cpu": cpu, "gpu": gpu, "exporting": exporting, "rendering": rendering, "pending": pending, "ready": ready,
            "done": done, "max_renderers": max_renderers, "max_exporters": max_exporters, "paused": paused,
        }));
    }

    /// Abschluss im Ereignis-Log (fertig oder abgebrochen)
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

    pub fn render_png(&self, t: usize) -> PathBuf {
        self.cfg.work.join("render").join(format!("{}.png", self.targets[t].entity))
    }

    pub fn failed_last(&self, t: usize) -> bool {
        self.outcomes.get(&self.targets[t].entity).is_some_and(|o| !o.ok)
    }

    pub fn pose_rig(&self, t: usize) -> Result<([f64; 3], PathBuf)> {
        let tg = &self.targets[t];
        Ok((self.tables.pose(&tg.kind, &tg.sub_type), self.tables.rig(&tg.kind, &tg.sub_type)?.clone()))
    }

    /// Filter: Begriffe durch Leerzeichen oder Komma getrennt, ein Treffer in Klassenname, Klarname oder
    /// Typ/SubTyp reicht (ODER), ohne Groß-/Kleinschreibung. Leer = alle.
    pub fn select(&self, filter: &str, scope: Scope) -> Selection {
        let terms: Vec<String> = filter.split([' ', ',']).filter(|s| !s.is_empty()).map(str::to_lowercase).collect();
        let mut s = Selection { matched: 0, existing: 0, missing: 0, failed: 0, todo: Vec::new(), overwrite: 0 };
        for (i, h) in self.haystack.iter().enumerate() {
            if !terms.is_empty() && !terms.iter().any(|t| h.contains(t.as_str())) {
                continue;
            }
            s.matched += 1;
            let has = self.has_render[i];
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

    /// Startet einen Lauf über die Auswahl; schon gerenderte Items im Filter bekommen ihre Icons nachgelegt
    pub fn start(&mut self, sel: &Selection, args_line: &str, filter: &str, scope: Scope) -> Result<()> {
        let work = &self.cfg.work;
        let mut log_file = OpenOptions::new().create(true).append(true).open(work.join("render.log"))?;
        writeln!(log_file, "=== {} packshot {}", chrono::Local::now().to_rfc3339(), args_line)?;
        self.log_file = Some(log_file);
        let mut blender_log = OpenOptions::new().create(true).append(true).open(work.join("blender.log"))?;
        writeln!(blender_log, "=== {}", chrono::Local::now().to_rfc3339())?;
        self.blender_log = Some(blender_log);
        self.errors.clear();

        // Blockgröße: bei kleinen Reruns auf alle Blender verteilt, sonst --chunk
        let n = sel.todo.len();
        let size = n.div_ceil(self.max_renderers.max(1)).clamp(1, self.cfg.chunk.max(1));
        let blocks: Vec<Block> = sel
            .todo
            .chunks(size)
            .enumerate()
            .map(|(k, items)| Block { items: items.to_vec(), root: work.join("export").join(format!("b{k}")), packages: HashMap::new(), failed: false, ready_at: None })
            .collect();
        self.note(Level::Info, format!("Run: {n} entities in {} blocks of {size}, {} export, {} Blender", blocks.len(), self.max_exporters, self.max_renderers));
        // Ereignis-Log je Lauf: Name aus Startzeit und Kiste, sortiert sich nach Zeit
        let host: String = sysinfo::System::host_name().unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        let run_id = format!("{}_{}", chrono::Local::now().format("%Y-%m-%d_%H-%M-%S"), if host.is_empty() { "host" } else { &host });
        let meta = self.run_meta(&run_id, args_line, filter, scope, n, blocks.len(), size);
        match EventLog::create(&self.cfg.work.join("logs"), &run_id) {
            Ok(mut log) => {
                log.emit("run_start", meta);
                self.note(Level::Info, format!("Event log: {}", log.path.display()));
                self.events = Some(log);
            }
            Err(e) => self.note(Level::Error, format!("Event log not created: {e}")),
        }
        self.gpu = GpuProbe::start();
        self.last_sample = Instant::now();
        self.run = Some(Run {
            blocks,
            next_export: 0,
            ready: VecDeque::new(),
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
        self.paused = false;
        Ok(())
    }

    pub fn running(&self) -> bool {
        self.run.as_ref().is_some_and(|r| r.finished.is_none())
    }

    /// Bricht ab: Kindprozesse beenden, Zustand sichern; was fehlt, bleibt für den nächsten Lauf
    pub fn abort(&mut self) {
        for w in &mut self.workers {
            let _ = w.child.kill();
            let _ = w.child.wait();
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
        }
        self.save_state();
    }

    fn save_state(&self) {
        let path = self.cfg.work.join("render-state.json");
        let tmp = path.with_extension("json.tmp");
        if let Ok(data) = serde_json::to_vec(&self.outcomes) {
            if fs::write(&tmp, data).is_ok() {
                let _ = fs::rename(&tmp, &path);
            }
        }
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
        let used: HashSet<usize> = self.workers.iter().filter(|w| w.kind == kind).map(|w| w.slot).collect();
        let slot = (1..).find(|s| !used.contains(s)).unwrap_or(1);
        let now = Instant::now();
        self.workers.push(Worker { id, kind, slot, block, child, order, reported: HashSet::new(), since: now, started: now, item_secs: 0.0, eof: 0, stderr_tail: String::new(), out_map });
        Ok(())
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
            // --variant-tags: Lackvarianten mit ihrer SubGeometry; --icon-files: ohne Animationen und Diagnose
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
            // Vulkan: unter OpenGL wuchs die Render-Phase (Shader-Kompilierung) mit 8 Blender von 0,21 auf 0,86 s,
            // unter Vulkan blieb sie bei 0,30 s; die Bilder weichen im Mittel um 0,04/255 ab (2026-11-02)
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

    /// Ergebnis eines Items (Export-Fehler oder Render-Ergebnis)
    fn record(&mut self, t: usize, ok: bool, error: Option<String>, seconds: f64, what: &str, detail: &str) {
        let entity = self.targets[t].entity.clone();
        self.outcomes.insert(entity.clone(), Outcome { ok, error: error.clone(), at: chrono::Local::now().to_rfc3339() });
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
            self.note(Level::Error, format!("[{i:>w$}/{total}] {what:<6} {entity}  FAILED {e}"));
            self.emit("failure", json!({ "entity": entity, "stage": what, "error": e }));
            self.errors.push((t, e));
            if let Some(b) = self.run.as_mut().and_then(|r| r.blocks.iter_mut().find(|b| b.items.contains(&t))) {
                b.failed = true;
            }
        }
    }

    fn place_icons(&mut self, t: usize) {
        let png = self.render_png(t);
        let tg = self.targets[t].clone();
        for (k, uuid) in tg.uuids.iter().enumerate() {
            let file = icon_file(&tg, k);
            let key = uuid.to_lowercase();
            for old in self.existing_icons.get(&key).cloned().unwrap_or_default() {
                if old != file {
                    let _ = fs::remove_file(self.cfg.out.join(&old));
                }
            }
            self.existing_icons.insert(key, vec![file.clone()]);
            let _ = fs::copy(&png, self.cfg.out.join(&file));
        }
    }

    /// Icons für schon gerenderte Items im Filter nachlegen, wenn sie in <out> fehlen (wie cli.ts)
    pub fn place_missing_icons(&mut self, filter: &str) {
        let sel = self.select(filter, Scope::All);
        for t in sel.todo {
            if !self.has_render[t] {
                continue;
            }
            let tg = &self.targets[t];
            let missing = (0..tg.uuids.len()).any(|k| !self.cfg.out.join(icon_file(tg, k)).exists());
            if missing {
                self.place_icons(t);
            }
        }
    }

    fn finish_block(&mut self, b: usize) {
        let Some(run) = self.run.as_mut() else { return };
        let block = &run.blocks[b];
        // Export nach dem Render weg (der volle Satz wären Gigabytes); mit Fehlschlägen bleibt er zur Diagnose
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
            // render.py: "icon: <png> <info>" / "failed: <png> <fehler>"
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
            let w = &mut self.workers[idx];
            let Some(&t) = w.out_map.get(&path) else { return };
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
                self.has_render[t] = true;
                self.place_icons(t);
                let mut detail = String::new();
                if let Some(ph) = timing {
                    if let Some(run) = self.run.as_mut() {
                        run.phase_n += 1;
                        for (s, v) in run.phase_sum.iter_mut().zip(ph) {
                            *s += v;
                        }
                    }
                    let parts: Vec<String> = PHASES.iter().zip(ph).map(|(k, v)| format!("{k} {v:.2}")).collect();
                    detail = format!("  ({})", parts.join(" · "));
                }
                self.record(t, true, None, seconds, "render", &detail);
            } else {
                self.record(t, false, Some(if info.is_empty() { "render failed".into() } else { info }), seconds, "render", "");
            }
            return;
        }
        if stderr {
            let w = &mut self.workers[idx];
            w.stderr_tail.push_str(&line);
            w.stderr_tail.push('\n');
            if w.stderr_tail.len() > 4000 {
                w.stderr_tail = w.stderr_tail[w.stderr_tail.len() - 4000..].to_string();
            }
            return;
        }
        // export-batch: eine JSON-Zeile je Job {name, ok, package, worn, seconds, error}
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

    fn on_exit(&mut self, idx: usize) {
        let mut w = self.workers.remove(idx);
        let status = w.child.wait().ok();
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
                // Blender liest unter Windows keine Pfade über 259 Zeichen: fehlende Texturen rendern still weiß
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
                    let error = if self.render_png(t).exists() { "no result reported (Blender aborted?)" } else { "no image (Blender aborted?)" };
                    self.record(t, false, Some(error.into()), 0.0, "render", "");
                }
                self.finish_block(b);
            }
        }
        w.order.clear();
    }

    /// Ein Takt: Zeilen der Kindprozesse verarbeiten, Beendete abschließen, Neues starten
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
        // Beide Ströme zu: der Prozess ist fertig (die letzten Zeilen sind schon verarbeitet)
        while let Some(idx) = self.workers.iter().position(|w| w.eof >= 2) {
            self.on_exit(idx);
        }
        self.schedule();
        self.sample();
    }

    fn schedule(&mut self) {
        let Some(run) = self.run.as_ref() else { return };
        if run.finished.is_some() {
            return;
        }
        if !self.paused {
            loop {
                let run = self.run.as_ref().unwrap();
                let exporting = self.workers.iter().filter(|w| w.kind == Kind::Export).count();
                // Exporte nur so weit voraus, wie Blender sie abnimmt (Plattenplatz)
                if exporting >= self.max_exporters || run.next_export >= run.blocks.len() || exporting + run.ready.len() > self.max_renderers {
                    break;
                }
                let b = run.next_export;
                self.run.as_mut().unwrap().next_export += 1;
                self.start_export(b);
            }
            loop {
                let rendering = self.workers.iter().filter(|w| w.kind == Kind::Render).count();
                if rendering >= self.max_renderers {
                    break;
                }
                let Some(b) = self.run.as_mut().unwrap().ready.pop_front() else { break };
                self.start_render(b);
            }
        }
        let run = self.run.as_ref().unwrap();
        if self.workers.is_empty() && run.ready.is_empty() && run.next_export >= run.blocks.len() {
            let r = self.run.as_mut().unwrap();
            r.finished = Some(Instant::now());
            let (ok, failed, mins) = (r.ok, r.failed, r.started.elapsed().as_secs_f64() / 60.0);
            self.note(Level::Info, format!("Done: {ok} rendered, {failed} failed, {mins:.1} min -> {}", self.cfg.out.display()));
            self.emit_run_end();
            self.save_state();
        }
    }

    /// Renders je Minute über die letzten `window` Sekunden
    pub fn rate(&self, window: f64) -> f64 {
        let Some(run) = self.run.as_ref() else { return 0.0 };
        let end = run.finished.unwrap_or_else(Instant::now);
        let span = window.min(end.duration_since(run.started).as_secs_f64()).max(1.0);
        let n = run.done_at.iter().filter(|t| end.duration_since(**t).as_secs_f64() <= span).count();
        n as f64 * 60.0 / span
    }
}
