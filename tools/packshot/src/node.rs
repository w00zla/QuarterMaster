// Rendering blocks for other boxes. The Renderer accepts blocks (export folder, rigs, render.py), renders them with
// its own Blender (one process per block, at most `slots` at a time) and sends back the PNG with the icon: line for
// each item. A coordinator (same state, so the same Data.p4k and StarBreaker) also accepts item packages: it exports them itself
// first (export-batch into the package folder), then renders them the same way, so no export travels. It runs in
// node mode (`packshot --node`: only Blender, neither Data.p4k nor StarBreaker) and inside every coordinator's TUI,
// which renders for the other coordinators while it has no run of its own. It writes only into its work folder.
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde_json::json;

use crate::net::{HubEv, Hub, ItemJob, Msg, Payload, RemoteJob};

struct Queued {
    conn: u64,
    id: u64,
    dir: PathBuf,
    jobs: Vec<RemoteJob>,
    /// an item package: export these first
    export: Option<Vec<ItemJob>>,
}

struct Running {
    conn: u64,
    id: u64,
    dir: PathBuf,
    child: Child,
    /// PNG path (lower case) -> item
    outs: HashMap<String, usize>,
    reported: usize,
    total: usize,
    eof: u8,
    stderr_tail: String,
    started: Instant,
    /// export stage of an item package: its jobs and the packages exported so far (item -> scene.blend, relative)
    export: Option<Vec<ItemJob>>,
    packages: HashMap<usize, String>,
}

/// A block in work, for the TUI
pub struct BlockView {
    pub conn: u64,
    pub id: u64,
    /// waiting, export (a package) or render
    pub stage: &'static str,
    pub done: usize,
    pub total: usize,
    pub secs: f64,
}

/// What a coordinator needs to export item packages itself
pub struct ExportTools {
    pub starbreaker: PathBuf,
    pub p4k: PathBuf,
    /// the rig files of its DataCore tables (<work>/dcb/rigs)
    pub rigs: PathBuf,
}

enum Line {
    Out { key: u64, line: String, stderr: bool },
    Eof { key: u64 },
}

fn now() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

pub fn addon_dir(blender: &Path) -> PathBuf {
    blender.parent().unwrap_or(Path::new(".")).join("portable/scripts/addons/starbreaker_addon")
}

/// Renders the blocks other coordinators send
pub struct Renderer {
    blender: PathBuf,
    pub slots: usize,
    /// export-batch processes at the same time (packages)
    pub export_slots: usize,
    /// set on coordinators: exports item packages
    pub tools: Option<ExportTools>,
    queue: VecDeque<Queued>,
    running: HashMap<u64, Running>,
    tx: Sender<Line>,
    rx: Receiver<Line>,
    next_key: u64,
}

impl Renderer {
    pub fn new(blender: PathBuf, slots: usize) -> Self {
        let (tx, rx) = channel();
        Self { blender, slots, export_slots: 1, tools: None, queue: VecDeque::new(), running: HashMap::new(), tx, rx, next_key: 1 }
    }

    /// The blocks in work for the TUI: rendering and exporting ones first, then the waiting ones
    pub fn blocks(&self) -> Vec<BlockView> {
        let mut out: Vec<BlockView> = self
            .running
            .values()
            .map(|r| BlockView { conn: r.conn, id: r.id, stage: if r.export.is_some() { "export" } else { "render" }, done: r.reported, total: r.total, secs: r.started.elapsed().as_secs_f64() })
            .collect();
        out.sort_by_key(|b| (b.conn, b.id));
        out.extend(self.queue.iter().map(|q| BlockView { conn: q.conn, id: q.id, stage: "waiting", done: 0, total: q.export.as_ref().map(|e| e.len()).unwrap_or(q.jobs.len()), secs: 0.0 }));
        out
    }

    /// A connection went away: drop its queued blocks, stop its Blenders
    pub fn on_down(&mut self, conn: u64) {
        self.queue.retain(|q| {
            let keep = q.conn != conn;
            if !keep {
                let _ = fs::remove_dir_all(&q.dir);
            }
            keep
        });
        for r in self.running.values_mut().filter(|r| r.conn == conn) {
            let _ = r.child.kill();
        }
    }

    /// Block, Items and Cancel messages; returns false for any other message
    pub fn on_msg(&mut self, hub: &mut Hub, conn: u64, msg: &Msg, dir: Option<PathBuf>, log: &mut dyn FnMut(String)) -> bool {
        match msg {
            Msg::Block { id, jobs, .. } => {
                let Some(dir) = dir else { return true };
                let from = hub.peer(conn).map(|p| p.hello.name.clone()).unwrap_or_default();
                log(format!("block {id} from {from}: {} items", jobs.len()));
                self.queue.push_back(Queued { conn, id: *id, dir, jobs: jobs.clone(), export: None });
            }
            Msg::Items { id, jobs, .. } => {
                let Some(dir) = dir else { return true };
                let from = hub.peer(conn).map(|p| p.hello.name.clone()).unwrap_or_default();
                if self.tools.is_none() {
                    hub.send(conn, Msg::BlockDone { id: *id, exit: None, error: "no Data.p4k here: exports nothing".into() }, Payload::None);
                    let _ = fs::remove_dir_all(&dir);
                    return true;
                }
                log(format!("package {id} from {from}: {} items to export and render", jobs.len()));
                self.queue.push_back(Queued { conn, id: *id, dir, jobs: Vec::new(), export: Some(jobs.clone()) });
            }
            Msg::Cancel { id } => {
                self.queue.retain(|q| !(q.conn == conn && q.id == *id));
                for r in self.running.values_mut().filter(|r| r.conn == conn && r.id == *id) {
                    let _ = r.child.kill();
                }
            }
            _ => return false,
        }
        true
    }

    /// One tick: start queued blocks on free slots, forward the Blenders' results, finish blocks. `wait`: how long
    /// to wait for lines (node mode); 0 inside the TUI
    pub fn tick(&mut self, hub: &Hub, wait: Duration, log: &mut dyn FnMut(String)) {
        // exports and renders have slots of their own; a package's render is queued first in line
        loop {
            let exporting = self.running.values().filter(|r| r.export.is_some()).count();
            let rendering = self.running.len() - exporting;
            let next = self.queue.iter().position(|q| if q.export.is_some() { exporting < self.export_slots.max(1) } else { rendering < self.slots.max(1) });
            let Some(q) = next.and_then(|i| self.queue.remove(i)) else { break };
            let key = self.next_key;
            self.next_key += 1;
            let started = if q.export.is_some() { self.start_export(&q, key) } else { self.start_block(&q, key) };
            match started {
                Ok(r) => {
                    self.running.insert(key, r);
                }
                Err(e) => {
                    let error = format!("{e:#}");
                    log(format!("block {} not started: {error}", q.id));
                    hub.send(q.conn, Msg::BlockDone { id: q.id, exit: None, error }, Payload::None);
                    let _ = fs::remove_dir_all(&q.dir);
                }
            }
        }
        let deadline = Instant::now() + Duration::from_millis(50);
        loop {
            let l = if wait.is_zero() { self.rx.try_recv().ok() } else { self.rx.recv_timeout(wait).ok() };
            let Some(l) = l else { break };
            match l {
                Line::Out { key, line, stderr } => {
                    let Some(r) = self.running.get_mut(&key) else { continue };
                    // both streams: Blender reports some errors on stdout, render.py's tracebacks on stderr
                    r.stderr_tail.push_str(&line);
                    r.stderr_tail.push('\n');
                    crate::engine::keep_tail(&mut r.stderr_tail, 2000);
                    if stderr {
                        continue;
                    }
                    // export stage: one JSON line per job {name, ok, package, error}
                    if let Some(jobs) = r.export.as_ref() {
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
                        let name = v["name"].as_str().unwrap_or_default().to_lowercase();
                        let Some(j) = jobs.iter().find(|j| j.entity.to_lowercase() == name) else { continue };
                        let item = j.item;
                        match (v["ok"].as_bool() == Some(true), v["package"].as_str()) {
                            (true, Some(pkg)) => {
                                let scene = Path::new(pkg).join("scene.blend");
                                let rel = match scene.strip_prefix(&r.dir) {
                                    Ok(p) => p.to_string_lossy().replace('\\', "/"),
                                    Err(_) => format!("Packages/{}/scene.blend", Path::new(pkg).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
                                };
                                r.packages.insert(item, rel);
                            }
                            _ => {
                                r.reported += 1;
                                let info = v["error"].as_str().unwrap_or("export failed").to_string();
                                hub.send(r.conn, Msg::Item { block: r.id, item, ok: false, info: format!("export: {info}") }, Payload::None);
                            }
                        }
                        continue;
                    }
                    let (ok, rest) = if let Some(x) = line.trim().strip_prefix("icon: ") {
                        (true, x)
                    } else if let Some(x) = line.trim().strip_prefix("failed: ") {
                        (false, x)
                    } else {
                        continue;
                    };
                    let Some(end) = rest.to_lowercase().find(".png") else { continue };
                    let path = rest[..end + 4].to_string();
                    let info = rest[end + 4..].trim().to_string();
                    let Some(&item) = r.outs.get(&path.to_lowercase()) else { continue };
                    r.reported += 1;
                    let data = if ok { fs::read(&path).ok() } else { None };
                    let ok = ok && data.is_some();
                    hub.send(r.conn, Msg::Item { block: r.id, item, ok, info }, data.map(Payload::Bytes).unwrap_or(Payload::None));
                }
                Line::Eof { key } => {
                    if let Some(r) = self.running.get_mut(&key) {
                        r.eof += 1;
                    }
                }
            }
            if Instant::now() > deadline {
                break;
            }
        }
        let done: Vec<u64> = self.running.iter().filter(|(_, r)| r.eof >= 2).map(|(k, _)| *k).collect();
        for key in done {
            let Some(mut r) = self.running.remove(&key) else { continue };
            let exit = r.child.wait().ok().and_then(|s| s.code());
            if let Some(jobs) = r.export.take() {
                self.after_export(hub, r, jobs, exit, log);
                continue;
            }
            let error = if r.reported < r.total { r.stderr_tail.trim().lines().last().unwrap_or("").to_string() } else { String::new() };
            log(format!("block {} done: {}/{} in {:.1} s", r.id, r.reported, r.total, r.started.elapsed().as_secs_f64()));
            hub.send(r.conn, Msg::BlockDone { id: r.id, exit, error }, Payload::None);
            if r.reported < r.total {
                // keep the block for diagnosis, with Blender's last lines
                let tail: Vec<&str> = r.stderr_tail.trim().lines().rev().take(8).collect();
                log(format!("  exit {exit:?}, block kept in {}; Blender's last lines:", r.dir.display()));
                for l in tail.iter().rev() {
                    log(format!("    {l}"));
                }
            } else {
                let _ = fs::remove_dir_all(&r.dir);
            }
        }
    }

    /// Export stage of an item package: export-batch into the package folder
    fn start_export(&self, q: &Queued, key: u64) -> Result<Running> {
        let tools = self.tools.as_ref().context("no Data.p4k here")?;
        let jobs = q.export.clone().unwrap_or_default();
        let list: Vec<_> = jobs.iter().map(|j| json!({ "name": j.entity, "output": q.dir, "worn": j.worn })).collect();
        let jobs_file = q.dir.join("jobs.json");
        fs::write(&jobs_file, serde_json::to_vec(&list)?)?;
        // --variant-tags: paint variants with their SubGeometry; --icon-files: without animations and diagnostics
        let mut child = Command::new(&tools.starbreaker)
            .arg("entity")
            .arg("export-batch")
            .arg(&jobs_file)
            .arg("--p4k")
            .arg(&tools.p4k)
            .args(["--kind", "decomposed", "--variant-tags", "--icon-files"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| tools.starbreaker.display().to_string())?;
        self.pipe(&mut child, key);
        Ok(Running {
            conn: q.conn,
            id: q.id,
            dir: q.dir.clone(),
            child,
            outs: HashMap::new(),
            reported: 0,
            total: jobs.len(),
            eof: 0,
            stderr_tail: String::new(),
            started: Instant::now(),
            export: Some(jobs),
            packages: HashMap::new(),
        })
    }

    /// Export done: items without a result line failed (export-batch ended early), the rest renders next, first in
    /// line, with its rigs copied into the package
    fn after_export(&mut self, hub: &Hub, r: Running, jobs: Vec<ItemJob>, exit: Option<i32>, log: &mut dyn FnMut(String)) {
        let tail = r.stderr_tail.trim().lines().last().unwrap_or("").to_string();
        log(format!("package {} exported: {} of {} in {:.1} s", r.id, r.packages.len(), jobs.len(), r.started.elapsed().as_secs_f64()));
        let mut render = Vec::new();
        for j in &jobs {
            let Some(src) = r.packages.get(&j.item) else { continue };
            let rig_src = self.tools.as_ref().map(|t| t.rigs.join(&j.rig)).unwrap_or_default();
            let copied = fs::create_dir_all(r.dir.join("rigs")).and_then(|_| fs::copy(&rig_src, r.dir.join("rigs").join(&j.rig)).map(|_| ()));
            match copied {
                Ok(()) => render.push(RemoteJob { item: j.item, src: src.clone(), pose: j.pose, rig: format!("rigs/{}", j.rig), size: j.size }),
                Err(e) => hub.send(r.conn, Msg::Item { block: r.id, item: j.item, ok: false, info: format!("rig {}: {e}", j.rig) }, Payload::None),
            }
        }
        // no line at all: export-batch ended early; the coordinator files these as failed with BlockDone's error
        let error = if r.reported + r.packages.len() < jobs.len() { format!("export-batch ended early (exit {exit:?}) {tail}") } else { String::new() };
        if render.is_empty() {
            hub.send(r.conn, Msg::BlockDone { id: r.id, exit, error }, Payload::None);
            let _ = fs::remove_dir_all(&r.dir);
            return;
        }
        if !error.is_empty() {
            log(format!("  {error}"));
        }
        self.queue.push_front(Queued { conn: r.conn, id: r.id, dir: r.dir, jobs: render, export: None });
    }

    /// Reader threads for a child's stdout and stderr
    fn pipe(&self, child: &mut Child, key: u64) {
        for (stream, stderr) in [(child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), false), (child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), true)] {
            let Some(stream) = stream else { continue };
            let tx = self.tx.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stream);
                let mut buf = Vec::new();
                while reader.read_until(b'\n', &mut buf).unwrap_or(0) > 0 {
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    buf.clear();
                    if tx.send(Line::Out { key, line, stderr }).is_err() {
                        return;
                    }
                }
                let _ = tx.send(Line::Eof { key });
            });
        }
    }

    /// Stop every Blender (on quit)
    pub fn stop(&mut self) {
        for r in self.running.values_mut() {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
        self.running.clear();
        self.queue.clear();
    }

    fn start_block(&self, q: &Queued, key: u64) -> Result<Running> {
        let out_dir = q.dir.join("out");
        fs::create_dir_all(&out_dir)?;
        let mut jobs = Vec::new();
        let mut outs = HashMap::new();
        for j in &q.jobs {
            let rel = |p: &str| crate::net::safe_rel(p).map(|r| q.dir.join(r)).with_context(|| format!("unsafe path {p}"));
            let out = out_dir.join(format!("{}.png", j.item));
            outs.insert(out.to_string_lossy().to_lowercase(), j.item);
            jobs.push(json!({ "src": rel(&j.src)?, "out": out, "pose": j.pose, "rig": rel(&j.rig)?, "size": j.size }));
        }
        let jobs_file = q.dir.join("render-jobs.json");
        fs::write(&jobs_file, serde_json::to_vec(&jobs)?)?;
        let mut child = Command::new(&self.blender)
            .arg("-b")
            .arg("--gpu-backend")
            .arg("vulkan")
            .arg("--python")
            .arg(q.dir.join("render.py"))
            .arg("--")
            .arg("--jobs")
            .arg(&jobs_file)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| self.blender.display().to_string())?;
        self.pipe(&mut child, key);
        Ok(Running {
            conn: q.conn,
            id: q.id,
            dir: q.dir.clone(),
            child,
            outs,
            reported: 0,
            total: q.jobs.len(),
            eof: 0,
            stderr_tail: String::new(),
            started: Instant::now(),
            export: None,
            packages: HashMap::new(),
        })
    }
}

pub struct NodeArgs {
    pub blender: PathBuf,

    pub slots: usize,
}

/// Node mode needs a token and at least one coordinator
pub fn check(cfg: &crate::config::NetConfig) -> Result<()> {
    if !cfg.enabled() {
        bail!("Node mode needs a token and coordinators in packshot.json");
    }
    if cfg.coordinators.is_empty() {
        bail!("No coordinators in packshot.json");
    }
    Ok(())
}

/// Node mode without the TUI (--plain): connect to the coordinators of the config and render their blocks until
/// Ctrl+C, one line per event
pub fn run(mut hub: Hub, args: NodeArgs) -> Result<()> {
    println!(
        "{} node {} · Blender {} · Addon {} · {} slots · coordinators: {}",
        now(),
        hub.me.name,
        hub.me.blender,
        hub.me.addon.as_deref().unwrap_or("?"),
        args.slots,
        hub.cfg.coordinators.join(", ")
    );
    let mut renderer = Renderer::new(args.blender, args.slots);
    let mut log = |s: String| println!("{} {s}", now());
    let mut last_errors = String::new();
    loop {
        for ev in hub.poll() {
            match ev {
                HubEv::Up { conn } => {
                    if let Some(p) = hub.peer(conn) {
                        log(format!("connected to {} ({})", p.hello.name, p.addr));
                    }
                }
                HubEv::Down { conn, name, error } => {
                    log(format!("{name} disconnected: {error}"));
                    renderer.on_down(conn);
                }
                HubEv::Msg { conn, msg, dir, .. } => {
                    if !renderer.on_msg(&mut hub, conn, &msg, dir, &mut log) {
                        if let Msg::Error { what } = msg {
                            log(format!("error from coordinator: {what}"));
                        }
                    }
                }
            }
        }
        renderer.tick(&hub, Duration::from_millis(20), &mut log);
        let errors: String = hub.dial_errors.iter().map(|(n, e)| format!("{n}: {e}")).collect::<Vec<_>>().join(" · ");
        if errors != last_errors {
            if !errors.is_empty() {
                log(format!("not reachable: {errors}"));
            }
            last_errors = errors;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NetConfig;
    use crate::net::{Hello, ItemJob, Role};

    /// A coordinator exports an item package itself and renders it (real StarBreaker, Data.p4k and Blender of the
    /// repo; SC_DATA_P4K must be set): cargo test --release -- --ignored package_export
    #[test]
    #[ignore]
    fn package_export_and_render() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let p4k = PathBuf::from(std::env::var("SC_DATA_P4K").expect("SC_DATA_P4K"));
        let blender = fs::read_dir(repo.join("local/blender")).unwrap().flatten().map(|e| e.path().join("blender.exe")).find(|p| p.exists()).unwrap();
        let rigs = repo.join("local/packshot/work/dcb/rigs");
        let root = std::env::temp_dir().join(format!("packshot-pkg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let port = 47950 + (std::process::id() % 40) as u16;
        let me = |name: &str| Hello { name: name.into(), role: Some(Role::Coordinator), version: "t".into(), slots: 1, ..Default::default() };
        // a: the starting coordinator (listens), b: the coordinator that exports and renders
        let mut a = Hub::new(NetConfig { name: "a".into(), token: "t".into(), listen: format!("127.0.0.1:{port}"), coordinators: Vec::new() }, me("a"), root.join("a"), true);
        let mut b = Hub::new(NetConfig { name: "b".into(), token: "t".into(), listen: String::new(), coordinators: vec![format!("127.0.0.1:{port}")] }, me("b"), root.join("b"), false);
        let mut r = Renderer::new(blender, 2);
        r.tools = Some(ExportTools { starbreaker: repo.join("local/starbreaker-qm/starbreaker.exe"), p4k, rigs });
        let t0 = Instant::now();
        let conn_a = loop {
            b.poll();
            if let Some(HubEv::Up { conn }) = a.poll().into_iter().find(|e| matches!(e, HubEv::Up { .. })) {
                break conn;
            }
            assert!(t0.elapsed() < Duration::from_secs(10), "no connection");
            thread::sleep(Duration::from_millis(20));
        };
        let script = repo.join("src/icons/render.py");
        let jobs = vec![
            ItemJob { item: 7, entity: "thumbnailentity_resource_rock_gold".into(), worn: false, pose: [90.0, 180.0, 0.0], rig: "inventorylightgroup_other.json".into(), size: 128 },
            ItemJob { item: 8, entity: "no_such_entity_xyz".into(), worn: false, pose: [90.0, 0.0, 0.0], rig: "inventorylightgroup_other.json".into(), size: 128 },
        ];
        let files = vec![crate::net::FileEntry { path: "render.py".into(), size: fs::metadata(&script).unwrap().len() }];
        a.send(conn_a, Msg::Items { id: 1, jobs, files }, Payload::Files(vec![script]));
        let mut items = Vec::new();
        let mut done = false;
        let mut log = |s: String| println!("{s}");
        while !done {
            assert!(t0.elapsed() < Duration::from_secs(120), "timeout");
            for ev in b.poll() {
                if let HubEv::Msg { conn, msg, dir, .. } = ev {
                    r.on_msg(&mut b, conn, &msg, dir, &mut log);
                }
            }
            r.tick(&b, Duration::from_millis(20), &mut log);
            for ev in a.poll() {
                match ev {
                    HubEv::Msg { msg: Msg::Item { item, ok, info, .. }, data, .. } => items.push((item, ok, data.len(), info)),
                    HubEv::Msg { msg: Msg::BlockDone { .. }, .. } => done = true,
                    _ => {}
                }
            }
        }
        items.sort_by_key(|i| i.0);
        println!("{items:?}");
        assert_eq!(items.len(), 2);
        assert!(items[0].0 == 7 && items[0].1 && items[0].2 > 1000, "rock rendered and sent");
        assert!(items[1].0 == 8 && !items[1].1 && items[1].3.starts_with("export"), "unknown entity fails in the export");
        a.close_all();
        b.close_all();
        let _ = fs::remove_dir_all(&root);
    }
}
