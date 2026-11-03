// The cluster from a coordinator's point of view (part of the engine): send blocks to nodes and take over their
// results, back into the queue on failure; fetch runs of other coordinators (key h, they attach to live),
// fetch their live manifest (m, for "missing"). All connected boxes must have the same state (packshot build,
// Blender, add-on; coordinators also Data.p4k and StarBreaker), else no run starts and the TUI says what differs.
// Requests from other coordinators (runs, run files, manifest) are answered by each coordinator itself.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::json;

use crate::engine::{Engine, Kind, Level, Manifest, blender_version};
use crate::events::round3;
use crate::net::{Hello, HubEv, ItemJob, Msg, Payload, RemoteJob, Role, RunSummary, collect_files};
use crate::node::addon_dir;
use crate::store::{LIVE, RunInfo, slug};

pub fn load_manifest(store_root: &Path) -> Option<Manifest> {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(store_root.join("manifests"))
        .ok()?
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort();
    let (_, path) = files.pop()?;
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// StarBreaker commit from the COMMIT file next to the binary
pub fn starbreaker_commit(starbreaker: &Path) -> Option<String> {
    let text = fs::read_to_string(starbreaker.parent()?.join("COMMIT")).ok()?;
    text.split_whitespace().next().map(String::from)
}

/// Fingerprint of Data.p4k: FNV-1a over its size and its first and last 4 MB. The end holds the archive's
/// directory, which changes with every patch; a full hash over ~160 GB would take minutes at every start
pub fn p4k_id(p4k: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const CHUNK: u64 = 4 << 20;
    let mut f = fs::File::open(p4k).ok()?;
    let len = f.metadata().ok()?.len();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    feed(&len.to_le_bytes());
    let mut buf = vec![0u8; CHUNK.min(len) as usize];
    f.read_exact(&mut buf).ok()?;
    feed(&buf);
    f.seek(SeekFrom::Start(len.saturating_sub(CHUNK))).ok()?;
    f.read_exact(&mut buf).ok()?;
    feed(&buf);
    Some(format!("{h:016x}"))
}

/// Game version from build_manifest.id next to Data.p4k: "4.10.2 (4.10.197.2878)" from Branch and Version
pub fn p4k_version(p4k: &Path) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(&fs::read(p4k.parent()?.join("build_manifest.id")).ok()?).ok()?;
    let data = &v["Data"];
    let branch = data["Branch"].as_str().unwrap_or("").rsplit('-').next().unwrap_or("").to_string();
    let version = data["Version"].as_str().unwrap_or("");
    match (branch.is_empty(), version.is_empty()) {
        (true, true) => None,
        (false, false) => Some(format!("{branch} ({version})")),
        _ => Some(format!("{branch}{version}")),
    }
}

/// GPUs from nvidia-smi as "RTX 5080 VRAM 16 GB" (vendor prefixes dropped), several joined with +; None without one
pub fn gpu_info() -> Option<String> {
    let out = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let gpus: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let (name, mib) = l.split_once(',')?;
            let name = name.trim().trim_start_matches("NVIDIA ").trim_start_matches("GeForce ");
            let gb = mib.trim().parse::<f64>().ok().map(|m| format!(" VRAM {:.0} GB", m / 1024.0)).unwrap_or_default();
            Some(format!("{name}{gb}"))
        })
        .collect();
    (!gpus.is_empty()).then(|| gpus.join(" + "))
}

/// CPU name and total RAM in bytes
pub fn host_info() -> (Option<String>, Option<u64>) {
    let Ok(mut s) = sysinfo::System::new() else { return (None, None) };
    s.refresh_cpu_all();
    s.refresh_memory();
    // "AMD Ryzen 7 9800X3D 8-Core Processor" -> "AMD Ryzen 7 9800X3D" (the core count is shown on its own)
    let cpu = s
        .cpus()
        .first()
        .map(|c| {
            c.brand()
                .replace("(R)", "")
                .replace("(TM)", "")
                .split_whitespace()
                .filter(|w| *w != "Processor" && *w != "CPU" && !w.ends_with("-Core"))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|b| !b.is_empty());
    let ram = Some(s.total_memory()).filter(|m| *m > 0);
    (cpu, ram)
}

/// Own versions for the handshake; `export`: Data.p4k and StarBreaker of a coordinator
pub fn own_hello(name: &str, role: Role, blender: &Path, slots: usize, exporters: usize, cores: usize, export: Option<(&Path, &Path)>) -> Hello {
    let (cpu, ram) = host_info();
    Hello {
        token: String::new(),
        role: Some(role),
        name: name.to_string(),
        // the build id hashes the source (build.rs), so different builds are told apart
        version: format!("{}+{}", env!("CARGO_PKG_VERSION"), env!("PACKSHOT_BUILD")),
        os: std::env::consts::OS.to_string(),
        blender: blender_version(blender),
        addon: crate::events::tree_hash(&addon_dir(blender)),
        slots,
        exporters,
        cores,
        p4k_bytes: export.and_then(|(p, _)| fs::metadata(p).ok()).map(|m| m.len()),
        p4k_id: export.and_then(|(p, _)| p4k_id(p)),
        p4k_version: export.and_then(|(p, _)| p4k_version(p)),
        starbreaker: export.and_then(|(_, s)| starbreaker_commit(s)),
        gpu: gpu_info(),
        cpu,
        ram,
        running: false,
    }
}

impl Engine {
    /// What differs from this box's state: packshot build, Blender, add-on; between coordinators also Data.p4k and
    /// StarBreaker. Empty = same state
    pub fn differences(&self, h: &Hello) -> Vec<String> {
        let mut out = Vec::new();
        let mut cmp = |what: &str, there: Option<&str>, here: Option<&str>| {
            if there != here {
                out.push(format!("{what} {} (here {})", there.unwrap_or("?"), here.unwrap_or("?")));
            }
        };
        cmp("packshot", Some(&h.version), Some(&self.me.version));
        cmp("Blender", Some(&h.blender), Some(&self.me.blender));
        cmp("add-on", h.addon.as_deref(), self.me.addon.as_deref());
        if h.role == Some(Role::Coordinator) && self.me.role == Some(Role::Coordinator) {
            cmp("Data.p4k", h.p4k_id.as_deref(), self.me.p4k_id.as_deref());
            cmp("StarBreaker", h.starbreaker.as_deref(), self.me.starbreaker.as_deref());
        }
        out
    }

    /// Connected boxes with another state, each with what differs; no run starts while there is one
    pub fn state_problems(&self) -> Vec<(String, Vec<String>)> {
        self.connected_nodes().into_iter().map(|(_, h)| (h.name.clone(), self.differences(&h))).filter(|(_, d)| !d.is_empty()).collect()
    }

    /// Connected boxes that can render for this one: nodes and the other coordinators (these offer their Blender
    /// while they have no run of their own, else 0 slots): (connection, versions)
    pub fn connected_nodes(&self) -> Vec<(u64, Hello)> {
        let Some(hub) = self.hub.as_ref() else { return Vec::new() };
        hub.peers.iter().map(|p| (p.conn, p.hello.clone())).collect()
    }

    /// Boxes that get blocks: connected, same version, free slots offered and (during a run) present at its start
    pub(crate) fn usable_nodes(&self) -> Vec<(u64, usize)> {
        let running = self.running();
        self.connected_nodes()
            .into_iter()
            .filter(|(_, h)| self.differences(h).is_empty() && h.slots > 0 && !h.running)
            .filter(|(_, h)| !running || self.run.as_ref().is_some_and(|r| r.nodes.contains(&h.name)))
            .map(|(c, h)| (c, h.slots))
            .collect()
    }

    /// A coordinator exports packages itself (same Data.p4k and StarBreaker: part of the same state)
    pub fn can_export(&self, h: &Hello) -> bool {
        h.role == Some(Role::Coordinator)
    }

    /// Coordinator with room for another package: as many as it has export and Blender slots together, so its exports
    /// run ahead while it renders
    pub(crate) fn free_exporter(&self) -> Option<u64> {
        let peers: Vec<(u64, Hello)> = self.connected_nodes();
        self.usable_nodes()
            .into_iter()
            .filter_map(|(c, slots)| peers.iter().find(|(pc, h)| *pc == c && self.can_export(h)).map(|(_, h)| (c, slots + h.exporters.max(1))))
            .map(|(c, room)| (c, room.saturating_sub(self.workers.iter().filter(|w| w.conn == c && w.node.is_some()).count())))
            .filter(|(_, free)| *free > 0)
            .max_by_key(|(_, free)| *free)
            .map(|(c, _)| c)
    }

    /// Item package to a coordinator: entities with pose and rig name plus render.py; it exports and renders itself
    pub(crate) fn start_package(&mut self, b: usize, conn: u64) {
        let Some(name) = self.hub.as_ref().and_then(|h| h.peer(conn)).map(|p| p.hello.name.clone()) else {
            self.requeue_items(b);
            return;
        };
        let items = self.run.as_ref().unwrap().blocks[b].items.clone();
        let mut jobs = Vec::new();
        let mut order = Vec::new();
        for &t in &items {
            match self.pose_rig(t) {
                Ok((pose, rig)) => {
                    let tg = &self.targets[t];
                    let rig = rig.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    jobs.push(ItemJob { item: t, entity: tg.entity.clone(), worn: tg.worn, pose, rig, size: self.cfg.size });
                    order.push(t);
                }
                Err(e) => self.record(t, false, Some(e.to_string()), 0.0, "render", ""),
            }
        }
        if jobs.is_empty() {
            self.finish_block(b);
            return;
        }
        let script = match fs::metadata(&self.cfg.render_script) {
            Ok(m) => crate::net::FileEntry { path: "render.py".into(), size: m.len() },
            Err(e) => {
                for t in order {
                    self.record(t, false, Some(format!("render.py: {e}")), 0.0, "render", "");
                }
                self.finish_block(b);
                return;
            }
        };
        let id = self.next_remote;
        self.next_remote += 1;
        if let Some(h) = self.hub.as_ref() {
            h.send(conn, Msg::Items { id, jobs, files: vec![script] }, Payload::Files(vec![self.cfg.render_script.clone()]));
        }
        let wid = self.new_worker_id();
        let n = order.len();
        self.push_worker(wid, Kind::Render, b, None, Some(name), conn, id, order, HashMap::new());
        if let Some(w) = self.workers.last_mut() {
            w.package = true;
        }
        let worker = self.workers.last().map(|w| w.label()).unwrap_or_default();
        self.emit("package_start", json!({ "block": b, "worker": worker, "items": n }));
    }

    /// Items of a package back to the front of the queue (its coordinator dropped out)
    fn requeue_items(&mut self, b: usize) {
        if let Some(run) = self.run.as_mut() {
            let items = run.blocks[b].items.clone();
            for t in items.into_iter().rev() {
                run.pending.push_front(t);
            }
        }
    }

    /// Tell the others this box's Blender count and whether a run is going here
    pub(crate) fn announce(&mut self, slots: usize, exporters: usize, running: bool) {
        self.me.slots = slots;
        self.me.exporters = exporters;
        self.me.running = running;
        if let Some(h) = self.hub.as_mut() {
            h.me.slots = slots;
            h.me.exporters = exporters;
            h.me.running = running;
            for p in &h.peers {
                p.send(Msg::Hello(h.me.clone()), Payload::None);
            }
        }
    }

    /// Node with a free slot (most free slots first); exported blocks go to nodes only, the other coordinators get
    /// packages to export themselves
    pub(crate) fn free_node(&self) -> Option<u64> {
        let peers: Vec<(u64, Hello)> = self.connected_nodes();
        self.usable_nodes()
            .into_iter()
            .filter(|(c, _)| !peers.iter().any(|(pc, h)| pc == c && self.can_export(h)))
            .map(|(c, slots)| (c, slots.saturating_sub(self.workers.iter().filter(|w| w.conn == c && w.node.is_some()).count())))
            .filter(|(_, free)| *free > 0)
            .max_by_key(|(_, free)| *free)
            .map(|(c, _)| c)
    }

    /// Block to a node: export folder, the required rigs and render.py, paths relative to the block
    pub(crate) fn start_remote(&mut self, b: usize, conn: u64) {
        let Some(name) = self.hub.as_ref().and_then(|h| h.peer(conn)).map(|p| p.hello.name.clone()) else {
            self.run.as_mut().unwrap().ready.push_front(b);
            return;
        };
        let run = self.run.as_ref().unwrap();
        let block = &run.blocks[b];
        let root = block.root.clone();
        let mut jobs = Vec::new();
        let mut order = Vec::new();
        let mut rigs = BTreeSet::new();
        let mut problems = Vec::new();
        for &t in &block.items {
            let Some(pkg) = block.packages.get(&t) else { continue };
            match self.pose_rig(t) {
                Ok((pose, rig)) => {
                    let scene = pkg.join("scene.blend");
                    let src = scene
                        .strip_prefix(&root)
                        .map(|r| r.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_else(|_| format!("Packages/{}/scene.blend", pkg.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
                    let rig_name = rig.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    rigs.insert(rig);
                    jobs.push(RemoteJob { item: t, src, pose, rig: format!("rigs/{rig_name}"), size: self.cfg.size });
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
        let files = (|| -> Result<(Vec<crate::net::FileEntry>, Vec<PathBuf>)> {
            let (mut entries, mut paths) = collect_files(&root, "")?;
            for rig in &rigs {
                let name = rig.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                entries.push(crate::net::FileEntry { path: format!("rigs/{name}"), size: fs::metadata(rig)?.len() });
                paths.push(rig.clone());
            }
            entries.push(crate::net::FileEntry { path: "render.py".into(), size: fs::metadata(&self.cfg.render_script)?.len() });
            paths.push(self.cfg.render_script.clone());
            Ok((entries, paths))
        })();
        let (entries, paths) = match files {
            Ok(f) => f,
            Err(e) => {
                for t in order {
                    self.record(t, false, Some(format!("block not sent: {e:#}")), 0.0, "render", "");
                }
                self.finish_block(b);
                return;
            }
        };
        let bytes: u64 = entries.iter().map(|e| e.size).sum();
        let id = self.next_remote;
        self.next_remote += 1;
        if let Some(h) = self.hub.as_ref() {
            h.send(conn, Msg::Block { id, jobs, files: entries }, Payload::Files(paths));
        }
        let wid = self.new_worker_id();
        let n = order.len();
        self.push_worker(wid, Kind::Render, b, None, Some(name), conn, id, order, HashMap::new());
        let worker = self.workers.last().map(|w| w.label()).unwrap_or_default();
        let wait = self.run.as_ref().and_then(|r| r.blocks[b].ready_at).map(|t| round3(t.elapsed().as_secs_f64()));
        self.emit("render_start", json!({ "block": b, "worker": worker, "items": n, "queue_wait": wait, "bytes": bytes }));
        self.transferred += bytes;
    }

    /// Collect and process the cluster's messages (from tick)
    pub(crate) fn poll_net(&mut self) {
        let Some(hub) = self.hub.as_mut() else { return };
        for ev in hub.poll() {
            match ev {
                HubEv::Up { conn } => {
                    let Some(h) = self.hub.as_ref().and_then(|h| h.peer(conn)).map(|p| p.hello.clone()) else { continue };
                    let role = if h.role == Some(Role::Node) { "node" } else { "coordinator" };
                    self.note(Level::Info, format!("{} connected ({role}, {} Blender, Blender {}, add-on {})", h.name, h.slots, h.blender, h.addon.as_deref().unwrap_or("?")));
                    let diff = self.differences(&h);
                    if !diff.is_empty() {
                        self.note(Level::Error, format!("{} has another state, no run starts until all match: {}", h.name, diff.join(", ")));
                    }
                    if h.role == Some(Role::Coordinator) {
                        if let Some(hub) = self.hub.as_ref() {
                            hub.send(conn, Msg::ListRuns, Payload::None);
                        }
                    }
                }
                HubEv::Down { conn, name, error } => {
                    self.note(Level::Info, format!("{name} disconnected: {error}"));
                    self.peer_runs.remove(&name);
                    self.requeue(conn);
                    if let Some(s) = self.serve.as_mut() {
                        s.on_down(conn);
                    }
                }
                HubEv::Msg { conn, msg, data, dir } => {
                    // blocks of another coordinator: rendered here like on a node
                    if matches!(msg, Msg::Block { .. } | Msg::Items { .. } | Msg::Cancel { .. }) {
                        let mut lines = Vec::new();
                        if let (Some(s), Some(h)) = (self.serve.as_mut(), self.hub.as_mut()) {
                            s.on_msg(h, conn, &msg, dir, &mut |l| lines.push(l));
                            self.me.addon = h.me.addon.clone();
                        }
                        for l in lines {
                            self.note(Level::Info, l);
                        }
                        continue;
                    }
                    self.on_msg(conn, msg, data, dir);
                }
            }
        }
        // render what other coordinators sent, with this box's Blender count
        let mut lines = Vec::new();
        if let (Some(s), Some(h)) = (self.serve.as_mut(), self.hub.as_ref()) {
            s.slots = self.max_renderers;
            s.export_slots = self.max_exporters;
            s.tick(h, std::time::Duration::ZERO, &mut |l| lines.push(l));
        }
        for l in lines {
            self.note(Level::Info, l);
        }
        // the others see this box's Blender and export counts (also after + / - and < / >) and whether a run is
        // going here; a node exports nothing
        let running = self.running();
        let exporters = if self.me.role == Some(Role::Node) { 0 } else { self.max_exporters };
        if self.max_renderers != self.me.slots || exporters != self.me.exporters || running != self.me.running {
            self.announce(self.max_renderers, exporters, running);
        }
    }

    /// The coordinator that has a run going, if another one does: the boxes work on one run at a time, so no run
    /// starts here meanwhile
    pub fn running_elsewhere(&self) -> Option<String> {
        self.connected_nodes().into_iter().find(|(_, h)| h.running).map(|(_, h)| h.name)
    }

    /// Blocks of a node that dropped out: what it has not reported goes back into the queue
    fn requeue(&mut self, conn: u64) {
        while let Some(idx) = self.workers.iter().position(|w| w.node.is_some() && w.conn == conn) {
            let w = self.workers.remove(idx);
            let open: Vec<usize> = w.order.iter().copied().filter(|t| !w.reported.contains(t)).collect();
            let Some(run) = self.run.as_mut() else { continue };
            if open.is_empty() || run.finished.is_some() {
                self.finish_block(w.block);
                continue;
            }
            // a package: its open items are exported again, here or elsewhere
            if run.blocks[w.block].package {
                for t in open.iter().rev() {
                    run.pending.push_front(*t);
                }
                self.note(Level::Info, format!("Package {} back in the queue: {} items open", w.block + 1, open.len()));
                continue;
            }
            run.blocks[w.block].packages.retain(|t, _| open.contains(t));
            run.ready.push_front(w.block);
            self.note(Level::Info, format!("Block {} back in the queue: {} items open", w.block + 1, open.len()));
        }
    }

    fn reply(&self, conn: u64, msg: Msg, payload: Payload) {
        if let Some(h) = self.hub.as_ref() {
            h.send(conn, msg, payload);
        }
    }

    fn peer_name(&self, conn: u64) -> String {
        self.hub.as_ref().and_then(|h| h.peer(conn)).map(|p| p.hello.name.clone()).unwrap_or_default()
    }

    fn on_msg(&mut self, conn: u64, msg: Msg, data: Vec<u8>, dir: Option<PathBuf>) {
        match msg {
            Msg::Item { block, item, ok, info } => {
                let Some(idx) = self.workers.iter().position(|w| w.node.is_some() && w.conn == conn && w.remote == block) else { return };
                if !self.workers[idx].order.contains(&item) {
                    return;
                }
                let (ok, info) = if ok {
                    match fs::write(self.render_png(item), &data) {
                        Ok(()) => (true, info),
                        Err(e) => (false, format!("image from the node not written: {e}")),
                    }
                } else {
                    (false, info)
                };
                self.render_result(idx, item, ok, info);
            }
            Msg::BlockDone { id, error, .. } => {
                if let Some(w) = self.workers.iter_mut().find(|w| w.node.is_some() && w.conn == conn && w.remote == id) {
                    w.stderr_tail = error;
                    w.eof = 2;
                }
            }
            Msg::Hello(_) => {}
            Msg::ListRuns => {
                let runs = self.store.summaries();
                self.reply(conn, Msg::Runs { runs }, Payload::None);
            }
            Msg::Runs { runs } => {
                let name = self.peer_name(conn);
                self.peer_runs.insert(name, runs);
            }
            Msg::GetRun { id } => {
                let dir = self.store.run_dir(&id);
                let finished = self.store.run(&id).is_ok_and(|r| r.finished.is_some());
                match collect_files(&dir, "") {
                    Ok((files, paths)) if finished => self.reply(conn, Msg::RunFiles { id, files }, Payload::Files(paths)),
                    _ => self.reply(conn, Msg::Error { what: format!("run {id} not available") }, Payload::None),
                }
            }
            Msg::RunFiles { id, .. } => {
                let Some(dir) = dir else { return };
                let from = self.peer_name(conn);
                self.fetching.remove(&id);
                match self.import_run(&id, &dir) {
                    Ok(Some((new_id, images))) => self.note(Level::Ok, format!("Run {new_id} fetched from {from}: {images} images, appended to live")),
                    Ok(None) => self.note(Level::Info, format!("Run {id} is here already")),
                    Err(e) => self.note(Level::Error, format!("Run {id} from {from} not taken: {e:#}")),
                }
                let _ = fs::remove_dir_all(&dir);
            }
            Msg::GetManifest { set } => match self.manifest_of(&set) {
                Ok(entities) => {
                    let from = self.me.name.clone();
                    self.reply(conn, Msg::Manifest { set, from, entities }, Payload::None);
                }
                Err(e) => self.reply(conn, Msg::Error { what: format!("manifest {set}: {e:#}") }, Payload::None),
            },
            Msg::Manifest { set, from, entities } => {
                let m = Manifest { from: from.clone(), set: set.clone(), at: chrono::Local::now().to_rfc3339(), entities };
                let path = self.store.root.join("manifests").join(format!("{}.json", slug(&from)));
                let res = fs::create_dir_all(self.store.root.join("manifests")).map_err(anyhow::Error::from).and_then(|_| Ok(fs::write(&path, serde_json::to_vec(&m)?)?));
                let present = m.entities.values().filter(|v| **v).count();
                self.manifest = Some(m);
                match res {
                    Ok(()) => self.note(Level::Ok, format!("Manifest of {set} from {from}: {present} entities with an image (counts for “missing” on live)")),
                    Err(e) => self.note(Level::Error, format!("Manifest not saved: {e:#}")),
                }
            }
            Msg::Error { what } => {
                let from = self.peer_name(conn);
                self.note(Level::Error, format!("{from}: {what}"));
            }
            _ => {
                if let Some(d) = dir {
                    let _ = fs::remove_dir_all(d);
                }
            }
        }
    }

    /// Entity -> has an image (false: only failed) for a set
    fn manifest_of(&mut self, set: &str) -> Result<BTreeMap<String, bool>> {
        let s = self.store.load_set(set)?;
        let r = self.store.resolve(&s)?;
        let mut out: BTreeMap<String, bool> = r.failed.into_iter().map(|e| (e, false)).collect();
        for e in r.image.into_keys() {
            out.insert(e, true);
        }
        Ok(out)
    }

    /// Take over a fetched run: folder to runs/ (with -<node> if the same id comes from another machine), images
    /// read-only, appended to live's chain. None: was already there
    fn import_run(&mut self, id: &str, dir: &Path) -> Result<Option<(String, usize)>> {
        if self.running() {
            bail!("a run is in progress");
        }
        let mut info: RunInfo = serde_json::from_slice(&fs::read(dir.join("run.json")).context("run.json missing")?).context("run.json")?;
        let mut new_id = id.to_string();
        if self.store.run_dir(&new_id).exists() {
            if self.store.run(&new_id).is_ok_and(|r| r.node == info.node) {
                return Ok(None);
            }
            new_id = format!("{id}-{}", slug(&info.node));
            if self.store.run_dir(&new_id).exists() {
                return Ok(None);
            }
        }
        let target = self.store.run_dir(&new_id);
        if fs::rename(dir, &target).is_err() {
            copy_tree(dir, &target)?;
        }
        info.id = new_id.clone();
        self.store.save_run(&info)?;
        for e in fs::read_dir(&target)?.flatten() {
            if e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("png")) {
                let mut p = fs::metadata(e.path())?.permissions();
                p.set_readonly(true);
                fs::set_permissions(e.path(), p)?;
            }
        }
        let mut live = self.store.load_set(LIVE)?;
        live.runs.push(new_id.clone());
        self.store.sync(&mut live)?;
        if self.set.name == LIVE {
            self.set = live;
            self.resolved = self.store.resolve(&self.set)?;
        }
        Ok(Some((new_id, info.entities.values().filter(|e| e.ok).count())))
    }

    /// Runs of another coordinator that are missing here: finished and rendered for its live
    pub fn fetchable(&self, peer: &str) -> Vec<RunSummary> {
        let Some(runs) = self.peer_runs.get(peer) else { return Vec::new() };
        runs.iter()
            .filter(|r| r.finished && r.set == LIVE && !self.fetching.contains(&r.id))
            .filter(|r| {
                let here = |id: &str| self.store.run_dir(id).join("run.json").exists();
                !(here(&r.id) && self.store.peek_node(&r.id).as_deref() == Some(r.node.as_str())) && !here(&format!("{}-{}", r.id, slug(&r.node)))
            })
            .cloned()
            .collect()
    }

    /// Key h: fetch the missing runs
    pub fn fetch_runs(&mut self, conn: u64) -> usize {
        let name = self.peer_name(conn);
        let runs = self.fetchable(&name);
        for r in &runs {
            self.fetching.insert(r.id.clone());
            self.reply(conn, Msg::GetRun { id: r.id.clone() }, Payload::None);
        }
        if !runs.is_empty() {
            self.note(Level::Info, format!("Fetching {} runs from {name}", runs.len()));
        }
        runs.len()
    }

    /// Key m: fetch the other coordinator's live manifest
    pub fn fetch_manifest(&mut self, conn: u64) {
        let name = self.peer_name(conn);
        self.reply(conn, Msg::GetManifest { set: LIVE.into() }, Payload::None);
        self.note(Level::Info, format!("Asking {name} for its live manifest"));
    }

    /// Request a coordinator's run list again
    pub fn refresh_runs(&mut self, conn: u64) {
        self.reply(conn, Msg::ListRuns, Payload::None);
    }
}

fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)?.flatten() {
        let p = e.path();
        let t = dst.join(e.file_name());
        if p.is_dir() {
            copy_tree(&p, &t)?;
        } else {
            fs::copy(&p, &t).with_context(|| p.display().to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NetConfig;
    use crate::engine::Config;
    use crate::net::Hub;
    use crate::store::{EntityResult, Store};
    use crate::tables::Tables;
    use std::time::{Duration, Instant};

    fn engine(root: &Path, cfg: NetConfig, role: Role) -> Engine {
        let store = Store::open(&root.join("store")).unwrap();
        let set = store.load_set(LIVE).unwrap();
        let me = Hello { name: cfg.name.clone(), role: Some(role), version: "t".into(), blender: "5.2.3".into(), addon: Some("a".into()), slots: 1, ..Default::default() };
        let hub = Hub::new(cfg, me.clone(), root.join("inbox"), true);
        let x = root.join("x");
        let config = Config { p4k: x.clone(), starbreaker: x.clone(), blender: x.clone(), render_script: x, work: root.join("work"), size: 256, chunk: 50 };
        Engine::new(config, Vec::new(), Tables::default(), store, set, Some(hub), me).unwrap()
    }

    /// Same state or no run: packshot, Blender and add-on for every box, Data.p4k and StarBreaker between coordinators
    #[test]
    fn state_differences() {
        let root = std::env::temp_dir().join(format!("packshot-state-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mut e = engine(&root, NetConfig { name: "a".into(), token: String::new(), listen: String::new(), coordinators: Vec::new() }, Role::Coordinator);
        e.me.p4k_id = Some("1a2b3c4d5e6f7081".into());
        e.me.starbreaker = Some("cc0c3c91".into());
        let same = Hello { p4k_id: e.me.p4k_id.clone(), starbreaker: e.me.starbreaker.clone(), ..e.me.clone() };
        assert!(e.differences(&same).is_empty());
        let addon = Hello { addon: Some("other".into()), ..same.clone() };
        assert_eq!(e.differences(&addon), vec!["add-on other (here a)".to_string()]);
        let p4k = Hello { p4k_id: Some("ffff".into()), ..same.clone() };
        assert_eq!(e.differences(&p4k).len(), 1, "coordinators compare Data.p4k");
        let node = Hello { role: Some(Role::Node), p4k_id: None, starbreaker: None, ..same.clone() };
        assert!(e.differences(&node).is_empty(), "a node has no p4k to compare");
        let _ = crate::store::remove_tree(&root);
    }

    /// Two coordinators: b lists a's runs, fetches the missing one (h) and a's live manifest (m)
    #[test]
    fn fetch_runs_and_manifest() {
        let root = std::env::temp_dir().join(format!("packshot-cluster-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let port = 47900 + (std::process::id() % 50) as u16;
        let cfg_a = NetConfig { name: "a".into(), token: "t".into(), listen: format!("127.0.0.1:{port}"), coordinators: Vec::new() };
        let cfg_b = NetConfig { name: "b".into(), token: "t".into(), listen: "127.0.0.1:0".into(), coordinators: vec![format!("127.0.0.1:{port}")] };
        let mut a = engine(&root.join("a"), cfg_a, Role::Coordinator);
        let mut b = engine(&root.join("b"), cfg_b, Role::Coordinator);

        // a finished run on a's live with one image
        let id = "2026-11-03_10-00_x_missing";
        fs::create_dir_all(a.store.run_dir(id)).unwrap();
        let src = root.join("a").join("r.png");
        fs::write(&src, "png").unwrap();
        let files = vec!["X (x) 0000.png".to_string()];
        a.store.put_image(id, &src, &files).unwrap();
        let mut info = RunInfo { id: id.into(), name: "x".into(), set: LIVE.into(), node: "a".into(), finished: Some("now".into()), ..Default::default() };
        info.entities.insert("x".into(), EntityResult { ok: true, error: None, files: files.clone() });
        a.store.save_run(&info).unwrap();
        let mut live = a.store.load_set(LIVE).unwrap();
        live.runs.push(id.into());
        a.store.sync(&mut live).unwrap();

        let until = |a: &mut Engine, b: &mut Engine, done: &dyn Fn(&Engine) -> bool| {
            let t0 = Instant::now();
            while !done(b) {
                assert!(t0.elapsed() < Duration::from_secs(15), "timeout");
                a.tick();
                b.tick();
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        until(&mut a, &mut b, &|b| b.fetchable("a").len() == 1);
        let conn = b.hub.as_ref().unwrap().peers[0].conn;
        assert_eq!(b.fetch_runs(conn), 1);
        until(&mut a, &mut b, &|b| b.store.run_dir(id).join("run.json").exists() && b.fetching.is_empty());
        assert_eq!(fs::read_to_string(b.store.set_dir(LIVE).join(&files[0])).unwrap(), "png");
        assert_eq!(b.set.runs, vec![id.to_string()]);
        assert!(b.fetchable("a").is_empty());

        b.fetch_manifest(conn);
        until(&mut a, &mut b, &|b| b.manifest.is_some());
        assert_eq!(b.manifest.as_ref().unwrap().entities.get("x"), Some(&true));
        for e in [&mut a, &mut b] {
            e.hub.as_mut().unwrap().close_all();
        }
        let _ = crate::store::remove_tree(&root);
    }
}

#[cfg(test)]
mod package_tests {
    use super::*;
    use crate::config::NetConfig;
    use crate::engine::{Config, Scope, Target};
    use crate::net::Hub;
    use crate::node::{ExportTools, Renderer};
    use crate::store::Store;
    use crate::tables::Tables;
    use std::time::{Duration, Instant};

    /// The starting coordinator with no export and no Blender of its own hands the whole run as item packages to a
    /// second coordinator of the same state, which exports and renders them (real tools, SC_DATA_P4K must be set):
    /// cargo test --release -- --ignored run_by_packages
    #[test]
    #[ignore]
    fn run_by_packages() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let p4k = PathBuf::from(std::env::var("SC_DATA_P4K").expect("SC_DATA_P4K"));
        let starbreaker = repo.join("local/starbreaker-qm/starbreaker.exe");
        let blender = fs::read_dir(repo.join("local/blender")).unwrap().flatten().map(|e| e.path().join("blender.exe")).find(|p| p.exists()).unwrap();
        let tables_work = repo.join("local/packshot/work");
        let targets: Vec<Target> = serde_json::from_slice(&fs::read(repo.join("local/packshot/targets.json")).unwrap()).unwrap();
        let root = std::env::temp_dir().join(format!("packshot-run-pkg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let port = 47990 + (std::process::id() % 9) as u16;
        let mk = |name: &str, listen: String, coordinators: Vec<String>, serve: bool| {
            let dir = root.join(name);
            let store = Store::open(&dir.join("store")).unwrap();
            let set = store.load_set(LIVE).unwrap();
            let mut me = own_hello(name, Role::Coordinator, &blender, 2, 2, 8, Some((&p4k, &starbreaker)));
            me.name = name.into();
            let hub = Hub::new(NetConfig { name: name.into(), token: "t".into(), listen, coordinators }, me.clone(), dir.join("inbox"), true);
            let tables = Tables::load(&starbreaker, &p4k, &tables_work, false, |_| {}).unwrap();
            let cfg = Config { p4k: p4k.clone(), starbreaker: starbreaker.clone(), blender: blender.clone(), render_script: repo.join("src/icons/render.py"), work: dir.join("work"), size: 128, chunk: 50 };
            let mut e = Engine::new(cfg, targets.clone(), tables, store, set, Some(hub), me).unwrap();
            if serve {
                let mut r = Renderer::new(blender.clone(), 2);
                r.tools = Some(ExportTools { starbreaker: starbreaker.clone(), p4k: p4k.clone(), rigs: tables_work.join("dcb/rigs") });
                e.serve = Some(r);
            }
            e
        };
        let mut a = mk("a", format!("127.0.0.1:{port}"), Vec::new(), false);
        let mut b = mk("b", "127.0.0.1:0".into(), vec![format!("127.0.0.1:{port}")], true);
        // a renders nothing itself: everything goes to b as packages
        a.max_exporters = 0;
        a.max_renderers = 0;
        b.max_renderers = 2;
        let t0 = Instant::now();
        while a.usable_nodes().is_empty() {
            assert!(t0.elapsed() < Duration::from_secs(15), "b not usable");
            a.tick();
            b.tick();
            std::thread::sleep(Duration::from_millis(20));
        }
        let b_hello = a.connected_nodes()[0].1.clone();
        assert!(a.can_export(&b_hello) && a.differences(&b_hello).is_empty(), "same state");
        let sel = a.select("rock_gold rock_aluminum klwe_pistol_energy_01_tan01", Scope::All);
        assert_eq!(sel.todo.len(), 3);
        a.start(&sel, "test", "", Scope::All, "pkg", vec!["b".into()]).unwrap();
        while a.running() {
            assert!(t0.elapsed() < Duration::from_secs(180), "timeout");
            a.tick();
            b.tick();
            std::thread::sleep(Duration::from_millis(20));
        }
        let run = a.run.as_ref().unwrap();
        for l in &a.log {
            println!("{}", l.text);
        }
        assert_eq!((run.ok, run.failed), (3, 0));
        assert!(a.history.iter().all(|t| a.image(*t).is_some()), "images in a's set");
        for e in [&mut a, &mut b] {
            e.hub.as_mut().unwrap().close_all();
        }
        let _ = crate::store::remove_tree(&root);
    }
}

#[cfg(test)]
mod p4k_tests {
    /// Fingerprint and version of the real Data.p4k (SC_DATA_P4K): cargo test --release -- --ignored p4k_fingerprint --nocapture
    #[test]
    #[ignore]
    fn p4k_fingerprint() {
        let p4k = std::path::PathBuf::from(std::env::var("SC_DATA_P4K").expect("SC_DATA_P4K"));
        let t0 = std::time::Instant::now();
        let id = super::p4k_id(&p4k).expect("id");
        println!("id {id} in {:.0} ms, version {:?}", t0.elapsed().as_secs_f64() * 1000.0, super::p4k_version(&p4k));
        assert_eq!(super::p4k_id(&p4k).unwrap(), id, "stable");
    }
}

#[cfg(test)]
mod host_tests {
    #[test]
    fn host_and_gpu() {
        let (cpu, ram) = super::host_info();
        println!("cpu {cpu:?}, ram {ram:?}, gpu {:?}", super::gpu_info());
        assert!(cpu.is_some() && ram.is_some());
    }
}
