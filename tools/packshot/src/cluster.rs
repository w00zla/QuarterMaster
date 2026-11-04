// The cluster (part of the engine). There are no roles: every node starts with its capabilities (--render, --export)
// and can start a run, on itself or on another node, which then is that run's head node: it holds the run, its
// set and its images, hands item packages to the exporting nodes and exported blocks to the rendering ones, takes
// their results back (back into the queue on failure) and tells every node the run's status once a second; every
// node can abort it. Nodes fetch each other's runs (key h, they attach to live) and live manifests (m, for "missing").
// All connected nodes must have the same state, else no run starts and the TUI says what differs: the packshot
// build everywhere, Blender and add-on between the rendering nodes, Data.p4k and StarBreaker between the exporting
// ones (each compared with the first node of that capability, this one first, then by name).
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::json;

use crate::engine::{Engine, Kind, Level, Manifest, RemoteRun, RemoteSel, Scope, Target, blender_version};
use crate::events::round3;
use crate::net::{DiskInfo, Hello, HubEv, ItemJob, Msg, Payload, RemoteJob, RunStatus, RunSummary, WorkerStatus, collect_files};
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

/// Fingerprint of Data.p4k: FNV-1a over its size in bytes and Branch, Version and BuildId of build_manifest.id
/// next to it. Reads no archive data, so it is instant on every start
pub fn p4k_id(p4k: &Path) -> Option<String> {
    let len = fs::metadata(p4k).ok()?.len();
    let v: serde_json::Value = serde_json::from_slice(&fs::read(p4k.parent()?.join("build_manifest.id")).ok()?).ok()?;
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    feed(&len.to_le_bytes());
    for key in ["Branch", "Version", "BuildId"] {
        feed(v["Data"][key].as_str().unwrap_or("").as_bytes());
        feed(&[0]);
    }
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

/// GPUs from nvidia-smi as "RTX 5080 · VRAM 16 GB" (vendor prefixes dropped), several joined with +; None without one
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
            let gb = mib.trim().parse::<f64>().ok().map(|m| format!(" · VRAM {:.0} GB", m / 1024.0)).unwrap_or_default();
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

/// Free and total space of the disks holding these folders, one entry per disk (the mount point with the longest
/// matching prefix)
pub fn disk_info(paths: &[PathBuf]) -> Vec<DiskInfo> {
    let Ok(disks) = sysinfo::Disks::new_with_refreshed_list() else { return Vec::new() };
    let mut out: Vec<DiskInfo> = Vec::new();
    for p in paths {
        let full = fs::canonicalize(p).unwrap_or_else(|_| p.clone());
        // Windows: \\?\D:\... -> D:\...
        let text = full.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        let full = PathBuf::from(text);
        let best = disks.iter().filter(|d| full.starts_with(d.mount_point())).max_by_key(|d| d.mount_point().as_os_str().len());
        if let Some(d) = best {
            let mount = d.mount_point().to_string_lossy().to_string();
            if !out.iter().any(|o| o.mount == mount) {
                out.push(DiskInfo { mount, free: d.available_space(), total: d.total_space() });
            }
        }
    }
    out
}

/// What a node can do from the start (--render, --export) and the tools it has: every bundle carries Blender and
/// StarBreaker, so their versions are reported either way; Data.p4k only with --export
pub struct Caps<'a> {
    pub render: bool,
    pub export: bool,
    pub blender: Option<&'a Path>,
    pub starbreaker: Option<&'a Path>,
    pub p4k: Option<&'a Path>,
}

/// Own versions for the handshake
pub fn own_hello(name: &str, caps: Caps, slots: usize, exporters: usize, cores: usize, disks: Vec<DiskInfo>) -> Hello {
    let (cpu, ram) = host_info();
    let p4k = caps.p4k.filter(|_| caps.export);
    Hello {
        token: String::new(),
        name: name.to_string(),
        instance: crate::net::new_instance(),
        // the build id hashes the source (build.rs), so different builds are told apart
        version: format!("{}+{}", env!("CARGO_PKG_VERSION"), env!("PACKSHOT_BUILD")),
        os: std::env::consts::OS.to_string(),
        render: caps.render,
        export: caps.export,
        blender: caps.blender.map(blender_version).unwrap_or_default(),
        addon: caps.blender.and_then(|b| crate::events::tree_hash(&addon_dir(b))),
        slots,
        exporters,
        cores,
        p4k_bytes: p4k.and_then(|p| fs::metadata(p).ok()).map(|m| m.len()),
        p4k_id: p4k.and_then(p4k_id),
        p4k_version: p4k.and_then(p4k_version),
        starbreaker: caps.starbreaker.and_then(starbreaker_commit),
        gpu: gpu_info(),
        cpu,
        ram,
        running: false,
        disks,
    }
}

/// A node that gets item packages: it exports (and renders them itself, if it renders)
pub fn gets_packages(h: &Hello) -> bool {
    h.export && h.exporters > 0
}

impl Engine {
    /// The node whose state all others must match: the head node of the run going on (this one, or the one
    /// reporting its status), else the head node chosen for the next start (this one unless n chose another)
    pub fn state_head(&self) -> Hello {
        if self.running() {
            return self.me.clone();
        }
        let peer = |name: &str| self.connected_nodes().into_iter().find(|(_, h)| h.name == name).map(|(_, h)| h);
        if let Some(h) = self.remote_run.as_ref().filter(|r| !r.status.finished).and_then(|r| peer(&r.from)) {
            return h;
        }
        if let Some(h) = self.head.as_deref().and_then(peer) {
            return h;
        }
        self.me.clone()
    }

    /// What differs from the cluster's state (`state_head`). Empty = same state
    pub fn differences(&self, h: &Hello) -> Vec<String> {
        self.differences_to(h, &self.state_head())
    }

    /// What differs from `head`'s state: packshot build, Blender, add-on and StarBreaker (every bundle carries all of
    /// them), and Data.p4k among the exporting nodes (in sync with each other; the head node needs none)
    pub fn differences_to(&self, h: &Hello, head: &Hello) -> Vec<String> {
        let mut out = Vec::new();
        if h.name != head.name {
            let mut cmp = |what: &str, there: Option<&str>, want: Option<&str>| {
                if there != want {
                    out.push(format!("{what} {} (head {} {})", there.unwrap_or("?"), head.name, want.unwrap_or("?")));
                }
            };
            cmp("packshot", Some(&h.version), Some(&head.version));
            cmp("Blender", Some(&h.blender), Some(&head.blender));
            cmp("add-on", h.addon.as_deref(), head.addon.as_deref());
            cmp("StarBreaker", h.starbreaker.as_deref(), head.starbreaker.as_deref());
        }
        if h.export {
            let mut nodes = vec![self.me.clone()];
            nodes.extend(self.connected_nodes().into_iter().map(|(_, h)| h));
            let mut other: Vec<String> = nodes
                .iter()
                .filter(|n| n.export && n.name != h.name && n.p4k_id != h.p4k_id)
                .map(|n| format!("{} {}", n.name, n.p4k_version.as_deref().or(n.p4k_id.as_deref()).unwrap_or("?")))
                .collect();
            other.sort();
            if !other.is_empty() {
                out.push(format!("Data.p4k {} ({})", h.p4k_version.as_deref().or(h.p4k_id.as_deref()).unwrap_or("?"), other.join(", ")));
            }
        }
        out
    }

    /// Nodes with another state than the head node, each with what differs; no run starts while there is one
    pub fn state_problems(&self) -> Vec<(String, Vec<String>)> {
        self.state_problems_to(&self.state_head())
    }

    fn state_problems_to(&self, head: &Hello) -> Vec<(String, Vec<String>)> {
        let mut out: Vec<(String, Vec<String>)> = self.connected_nodes().into_iter().map(|(_, h)| (h.name.clone(), self.differences_to(&h, head))).collect();
        out.push((self.me.name.clone(), self.differences_to(&self.me, head)));
        out.retain(|(_, d)| !d.is_empty());
        out
    }

    /// All connected nodes: (connection, versions)
    pub fn connected_nodes(&self) -> Vec<(u64, Hello)> {
        let Some(hub) = self.hub.as_ref() else { return Vec::new() };
        hub.peers.iter().map(|p| (p.conn, p.hello.clone())).collect()
    }

    /// Nodes that get work: connected, same state, something offered, no run of their own and (during a run)
    /// present at its start: (connection, Blender slots)
    pub(crate) fn usable_nodes(&self) -> Vec<(u64, usize)> {
        let running = self.running();
        self.connected_nodes()
            .into_iter()
            // this node hands out the work, so it is the head node the others must match
            .filter(|(_, h)| self.differences_to(h, &self.me).is_empty() && (h.slots > 0 || gets_packages(h)) && !h.running)
            .filter(|(_, h)| !running || self.run.as_ref().is_some_and(|r| r.nodes.contains(&h.name)))
            .map(|(c, h)| (c, if h.render { h.slots } else { 0 }))
            .collect()
    }

    /// Why a run cannot start with this node as head node and these nodes, if it cannot: nobody exports or renders
    pub fn capacity_problem(&self) -> Option<String> {
        let peers = self.connected_nodes();
        let usable = self.usable_nodes();
        let peer = |c: u64| peers.iter().find(|(pc, _)| *pc == c).map(|(_, h)| h.clone());
        let exports = (self.me.export && self.exporters_now() > 0) || usable.iter().filter_map(|(c, _)| peer(*c)).any(|h| gets_packages(&h));
        let renders = (self.me.render && self.max_renderers > 0) || usable.iter().filter_map(|(c, _)| peer(*c)).any(|h| h.render && h.slots > 0);
        match (exports, renders) {
            (true, true) => None,
            (false, true) => Some("no node exports (--export)".into()),
            (true, false) => Some("no node renders (--render)".into()),
            (false, false) => Some("no node exports or renders (--export, --render)".into()),
        }
    }

    /// An exporting node with room for another package: fewer packages in their export stage there than it has
    /// export workers, and (if it renders) fewer exported ones waiting for or in its Blenders than it has Blenders, so
    /// a slow node never holds much of the run; an export-only node sends its blocks here, so not more ahead than
    /// the Blenders in the cluster can take. Most free export workers first
    pub(crate) fn free_exporter(&self) -> Option<u64> {
        let peers: Vec<(u64, Hello)> = self.connected_nodes();
        let backlog = self.run.as_ref().map(|r| r.ready.len()).unwrap_or(0);
        let slots = self.total_slots();
        self.usable_nodes()
            .into_iter()
            .filter_map(|(c, _)| peers.iter().find(|(pc, h)| *pc == c && gets_packages(h)).map(|(_, h)| (c, h.clone())))
            .filter(|(_, h)| h.render || backlog <= slots)
            .filter_map(|(c, h)| {
                let packages: Vec<_> = self.workers.iter().filter(|w| w.conn == c && w.package).collect();
                let exporting = packages.iter().filter(|w| w.exporting()).count();
                let rendering = packages.len() - exporting;
                let free = h.exporters.saturating_sub(exporting);
                (free > 0 && (!h.render || rendering < h.slots.max(1))).then_some((c, free))
            })
            .max_by_key(|(_, free)| *free)
            .map(|(c, _)| c)
    }

    /// Item package to an exporting node: entities with type and size plus render.py; it takes pose and rig from its
    /// own tables, exports, and renders itself or sends the exported block back
    pub(crate) fn start_package(&mut self, b: usize, conn: u64) {
        let Some(name) = self.hub.as_ref().and_then(|h| h.peer(conn)).map(|p| p.hello.name.clone()) else {
            self.requeue_items(b);
            return;
        };
        let items = self.run.as_ref().unwrap().blocks[b].items.clone();
        let jobs: Vec<ItemJob> = items
            .iter()
            .map(|&t| {
                let tg = &self.targets[t];
                ItemJob { item: t, entity: tg.entity.clone(), worn: tg.worn, kind: tg.kind.clone(), sub_type: tg.sub_type.clone(), size: self.cfg.size, pose: [0.0; 3], rig: String::new() }
            })
            .collect();
        let script = match fs::metadata(&self.cfg.render_script) {
            Ok(m) => crate::net::FileEntry { path: "render.py".into(), size: m.len() },
            Err(e) => {
                for t in items {
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
        let n = items.len();
        self.push_worker(wid, Kind::Render, b, None, Some(name), conn, id, items, HashMap::new());
        if let Some(w) = self.workers.last_mut() {
            w.package = true;
        }
        let worker = self.workers.last().map(|w| w.label()).unwrap_or_default();
        self.emit("package_start", json!({ "block": b, "worker": worker, "items": n }));
    }

    /// Items of a package back to the front of the queue (its node dropped out)
    fn requeue_items(&mut self, b: usize) {
        if let Some(run) = self.run.as_mut() {
            let items = run.blocks[b].items.clone();
            for t in items.into_iter().rev() {
                run.pending.push_front(t);
            }
        }
    }

    /// Tell the others this node's counts, whether a run is going here and its disks
    pub(crate) fn announce(&mut self) {
        if let Some(h) = self.hub.as_mut() {
            h.me.slots = self.me.slots;
            h.me.exporters = self.me.exporters;
            h.me.running = self.me.running;
            h.me.disks = self.me.disks.clone();
            for p in &h.peers {
                p.send(Msg::Hello(h.me.clone()), Payload::None);
            }
        }
    }

    /// Rendering node with a free slot (most free slots first); exported blocks go to nodes that render without
    /// getting packages, those export their own
    pub(crate) fn free_node(&self) -> Option<u64> {
        let peers: Vec<(u64, Hello)> = self.connected_nodes();
        self.usable_nodes()
            .into_iter()
            .filter(|(c, slots)| *slots > 0 && !peers.iter().any(|(pc, h)| pc == c && gets_packages(h)))
            .map(|(c, slots)| (c, slots.saturating_sub(self.workers.iter().filter(|w| w.conn == c && w.node.is_some()).count())))
            .filter(|(_, free)| *free > 0)
            .max_by_key(|(_, free)| *free)
            .map(|(c, _)| c)
    }

    /// Block to a rendering node: export folder, the required rigs and render.py, paths relative to the block
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
        // exported on another node: jobs and rigs came with the block
        if let Some(remote) = block.jobs.as_ref() {
            for j in remote {
                order.push(j.item);
                jobs.push(RemoteJob { entity: self.targets[j.item].entity.clone(), ..j.clone() });
            }
        }
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
                    jobs.push(RemoteJob { item: t, src, pose, rig: format!("rigs/{rig_name}"), size: self.cfg.size, entity: self.targets[t].entity.clone() });
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
                    self.note(Level::Info, format!("{} connected ({}, {} Blender, {} export)", h.name, h.caps(), h.slots, h.exporters));
                    let diff = self.differences(&h);
                    if !diff.is_empty() {
                        self.note(Level::Error, format!("{} has another state, no run starts until all match: {}", h.name, diff.join(", ")));
                    }
                    if let Some(hub) = self.hub.as_ref() {
                        hub.send(conn, Msg::ListRuns, Payload::None);
                    }
                    // the head node chosen for the next start came (back)
                    if self.head.as_deref() == Some(h.name.as_str()) {
                        self.request_state();
                    }
                }
                HubEv::Down { conn, name, error } => {
                    self.note(Level::Info, format!("{name} disconnected: {error}"));
                    self.peer_runs.remove(&name);
                    self.requeue(conn);
                    if let Some(s) = self.serve.as_mut() {
                        s.on_down(conn);
                    }
                    // the head node of the run shown here is gone: that run is over
                    if let Some(r) = self.remote_run.as_mut().filter(|r| r.from == name && !r.status.finished) {
                        r.status.finished = true;
                        r.status.aborted = true;
                        self.note(Level::Error, format!("{name} (head node) disconnected: its run is over here"));
                    }
                    if let Some(r) = self.remote.as_mut().filter(|r| r.node == name) {
                        r.loaded = false;
                    }
                }
                HubEv::Msg { conn, msg, data, dir } => {
                    // work for another node's run: exported and rendered here
                    if matches!(msg, Msg::Block { .. } | Msg::Items { .. } | Msg::Cancel { .. }) {
                        let msg = match msg {
                            Msg::Items { id, jobs, files } => match self.fill_items(conn, id, jobs) {
                                Some(jobs) => Msg::Items { id, jobs, files },
                                None => {
                                    if let Some(d) = dir {
                                        let _ = fs::remove_dir_all(d);
                                    }
                                    continue;
                                }
                            },
                            m => m,
                        };
                        let mut lines = Vec::new();
                        if let (Some(s), Some(h)) = (self.serve.as_mut(), self.hub.as_mut()) {
                            s.on_msg(h, conn, &msg, dir, &mut |l| lines.push(l));
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
        // export and render what other nodes' runs send, with this node's counts
        let mut lines = Vec::new();
        let export_slots = self.exporters_now();
        if let (Some(s), Some(h)) = (self.serve.as_mut(), self.hub.as_ref()) {
            s.slots = self.max_renderers;
            s.export_slots = export_slots;
            s.tick(h, std::time::Duration::ZERO, &mut |l| lines.push(l));
        }
        for l in lines {
            self.note(Level::Info, l);
        }
        // the others see this node's counts (also after + / - and < / >), whether a run is going here and its disks
        let running = self.running();
        let mut changed = self.max_renderers != self.me.slots || self.exporters_now() != self.me.exporters || running != self.me.running;
        if self.last_disk.elapsed() > std::time::Duration::from_secs(10) && !self.disk_paths.is_empty() {
            self.last_disk = std::time::Instant::now();
            let disks = disk_info(&self.disk_paths);
            let moved = disks.len() != self.me.disks.len() || disks.iter().zip(&self.me.disks).any(|(a, b)| a.free.abs_diff(b.free) > 1_000_000_000);
            if moved {
                self.me.disks = disks;
                changed = true;
            }
        }
        if changed {
            self.me.slots = self.max_renderers;
            self.me.exporters = self.exporters_now();
            self.me.running = running;
            self.announce();
        }
        self.send_status();
    }

    /// Item package from a head node: pose and rig from this node's tables; items without a rig fail right away.
    /// None: nothing left (the package is answered as done)
    fn fill_items(&mut self, conn: u64, id: u64, jobs: Vec<ItemJob>) -> Option<Vec<ItemJob>> {
        let mut out = Vec::new();
        for mut j in jobs {
            match self.tables.rig(&j.kind, &j.sub_type) {
                Ok(rig) => {
                    j.rig = rig.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    j.pose = self.tables.pose(&j.kind, &j.sub_type);
                    out.push(j);
                }
                Err(e) => self.reply(conn, Msg::Item { block: id, item: j.item, ok: false, info: format!("rig: {e}") }, Payload::None),
            }
        }
        if out.is_empty() {
            self.reply(conn, Msg::BlockDone { id, exit: None, error: String::new() }, Payload::None);
            return None;
        }
        Some(out)
    }

    /// The head node that has a run going, if another node is: the nodes work on one run at a time
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
            let block = &mut run.blocks[w.block];
            block.packages.retain(|t, _| open.contains(t));
            if let Some(jobs) = block.jobs.as_mut() {
                jobs.retain(|j| open.contains(&j.item));
            }
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

    /// Connection to a node by host name
    pub fn conn_of(&self, name: &str) -> Option<u64> {
        self.hub.as_ref()?.peers.iter().find(|p| p.hello.name == name).map(|p| p.conn)
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
            Msg::Exported { id, jobs, .. } => self.on_exported(conn, id, jobs, dir),
            Msg::ItemExported { block, item } => {
                let Some(w) = self.workers.iter_mut().find(|w| w.node.is_some() && w.conn == conn && w.remote == block) else { return };
                if w.order.contains(&item) && w.exported.insert(item) {
                    // the first render's time counts from the last export
                    w.since = std::time::Instant::now();
                    let (b, worker) = (w.block, w.label());
                    let entity = self.targets[item].entity.clone();
                    self.emit("export_item", json!({ "entity": entity, "block": b, "worker": worker, "ok": true, "remote": true }));
                }
            }
            Msg::Hello(_) => {}
            Msg::GetState { set } => {
                let reply = (|| -> Result<Msg> {
                    let sets = self.store.sets()?;
                    // a set that does not exist yet would branch off live
                    let s = self.store.load_set(if sets.contains(&set) { &set } else { LIVE })?;
                    let r = self.store.resolve(&s)?;
                    let targets = self.store.load_targets(&s)?;
                    let sets = self.store.set_summaries()?;
                    Ok(Msg::State { set: set.clone(), sets, images: r.image.into_keys().collect(), failed: r.failed.into_iter().collect(), targets, stats: self.stats.clone() })
                })();
                match reply {
                    Ok(m) => self.reply(conn, m, Payload::None),
                    Err(e) => self.reply(conn, Msg::Error { what: format!("state of {set}: {e:#}") }, Payload::None),
                }
            }
            Msg::State { set, sets, images, failed, targets, stats } => {
                let from = self.peer_name(conn);
                if let Some(r) = self.remote.as_mut().filter(|r| r.node == from && r.set == set) {
                    r.sets = sets.iter().map(|s| s.name.clone()).collect();
                    r.set_list = sets;
                    r.stats = stats;
                    r.images = images.into_iter().collect();
                    r.failed = failed.into_iter().collect();
                    r.loaded = true;
                    self.state_seq += 1;
                    // the selection runs over the target list of that set
                    self.use_targets(targets);
                }
            }
            Msg::StartRun { targets, set, name, filter, scope, line } => {
                let from = self.peer_name(conn);
                let me = self.me.name.clone();
                match self.start_for(&from, targets, &set, &name, &filter, &scope, &line) {
                    Ok(run) => self.reply(conn, Msg::Started { run }, Payload::None),
                    Err(e) => {
                        self.note(Level::Error, format!("No run for {from}: {e:#}"));
                        self.reply(conn, Msg::Error { what: format!("no run on {me}: {e:#}") }, Payload::None);
                    }
                }
            }
            Msg::Started { run } => {
                let from = self.peer_name(conn);
                self.note(Level::Ok, format!("Run {run} started on {from}"));
            }
            Msg::AbortRun => {
                let from = self.peer_name(conn);
                if self.running() {
                    self.note(Level::Info, format!("{from} aborts the run"));
                    self.abort();
                }
            }
            Msg::Status(status) => {
                let from = self.peer_name(conn);
                // the end of a run that was not known to be over here (a short run may only send its end)
                let ended = status.finished && !self.remote_run.as_ref().is_some_and(|r| r.from == from && r.status.run == status.run && r.status.finished);
                self.remote_run = Some(RemoteRun { from: from.clone(), status, at: std::time::Instant::now() });
                // the run there is over: the selection against that node changed
                if ended && self.remote_sel().is_some_and(|r| r.node == from) {
                    self.request_state();
                }
            }
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
                // the selection counts it: the TUI recomputes
                self.state_seq += 1;
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

    /// A package exported on a node without Blender came back as a block: what it did not export failed, the rest
    /// waits for a Blender here or on another node
    fn on_exported(&mut self, conn: u64, id: u64, jobs: Vec<RemoteJob>, dir: Option<PathBuf>) {
        let Some(dir) = dir else { return };
        let Some(idx) = self.workers.iter().position(|w| w.node.is_some() && w.conn == conn && w.remote == id) else {
            let _ = fs::remove_dir_all(&dir);
            return;
        };
        let w = self.workers.remove(idx);
        let b = w.block;
        let jobs: Vec<RemoteJob> = jobs.into_iter().filter(|j| w.order.contains(&j.item)).collect();
        for &t in &w.order {
            if !w.reported.contains(&t) && !jobs.iter().any(|j| j.item == t) {
                self.record(t, false, Some("not exported".into()), 0.0, "export", "");
            }
        }
        let open = self.run.as_ref().is_some_and(|r| r.finished.is_none());
        if jobs.is_empty() || !open {
            let _ = fs::remove_dir_all(&dir);
            self.finish_block(b);
            return;
        }
        let worker = w.label();
        let n = jobs.len();
        let run = self.run.as_mut().unwrap();
        run.exported += n;
        let block = &mut run.blocks[b];
        block.root = dir;
        block.jobs = Some(jobs);
        block.package = false;
        block.ready_at = Some(std::time::Instant::now());
        run.ready.push_back(b);
        self.emit("package_exported", json!({ "block": b, "worker": worker, "items": n }));
    }

    /// Start a run that another node asked for, with this node as head node: its targets appended, the set
    /// (created from live if missing) becomes the target set
    #[allow(clippy::too_many_arguments)]
    fn start_for(&mut self, starter: &str, targets: Vec<Target>, set: &str, name: &str, filter: &str, scope: &str, line: &str) -> Result<String> {
        if self.running() {
            bail!("a run is going here");
        }
        if targets.is_empty() {
            bail!("nothing to render");
        }
        if !self.store.sets()?.contains(&set.to_string()) {
            self.store.create_set(set, LIVE)?;
            self.note(Level::Info, format!("New set {set}, branched off live (for {starter})"));
        }
        if self.set.name != set {
            self.switch_set(set)?;
        }
        let todo = self.add_targets(targets);
        let scope = Scope::parse(scope).unwrap_or(Scope::Missing);
        self.start_local(&todo, line, filter, scope, name, starter)?;
        Ok(self.record.as_ref().map(|r| r.id.clone()).unwrap_or_default())
    }

    /// Start a run with this node as head node, with every connected node: only with the same state everywhere, no
    /// other run going, and someone to export and render
    pub fn start_local(&mut self, todo: &[usize], line: &str, filter: &str, scope: Scope, name: &str, starter: &str) -> Result<()> {
        if let Some(other) = self.running_elsewhere() {
            bail!("{other} has a run going: the nodes work on one run at a time");
        }
        let problems = self.state_problems_to(&self.me.clone());
        if !problems.is_empty() {
            let list: Vec<String> = problems.iter().map(|(n, d)| format!("{n}: {}", d.join(", "))).collect();
            bail!("not the same state: {}", list.join(" · "));
        }
        if let Some(p) = self.capacity_problem() {
            bail!("{p}");
        }
        let nodes: Vec<String> = self.connected_nodes().into_iter().map(|(_, h)| h.name).collect();
        self.start(todo, line, filter, scope, name, nodes, starter)
    }

    /// Ask another head node to start a run over `todo` into the chosen set there
    pub fn start_remote_run(&mut self, todo: &[usize], line: &str, filter: &str, scope: Scope, name: &str) -> Result<()> {
        let Some(r) = self.remote_sel() else { bail!("no head node chosen") };
        let (node, set) = (r.node.clone(), r.set.clone());
        if !r.loaded {
            bail!("no state of {node} yet");
        }
        let conn = self.conn_of(&node).with_context(|| format!("{node} is not connected"))?;
        let targets: Vec<Target> = todo.iter().map(|&t| self.targets[t].clone()).collect();
        let n = targets.len();
        self.reply(conn, Msg::StartRun { targets, set: set.clone(), name: name.to_string(), filter: filter.to_string(), scope: scope.key().to_string(), line: line.to_string() }, Payload::None);
        self.note(Level::Info, format!("Asking {node} to start a run over {n} entities into its set {set}"));
        Ok(())
    }

    /// Choose the head node for the next start (None = this node) and ask it for its state
    pub fn set_head(&mut self, node: Option<String>) {
        self.head = node.filter(|n| *n != self.me.name);
        match self.head.clone() {
            None => {
                self.remote = None;
                // back to this node's own target set and its list
                let name = self.set.name.clone();
                if let Err(e) = self.switch_set(&name) {
                    self.note(Level::Error, format!("Set {name} not reloaded: {e:#}"));
                }
            }
            Some(n) => {
                let set = self.remote.as_ref().filter(|r| r.node == n).map(|r| r.set.clone()).unwrap_or_else(|| LIVE.to_string());
                let sets = self.remote.as_ref().filter(|r| r.node == n).map(|r| r.sets.clone()).unwrap_or_default();
                let set_list = self.remote.as_ref().filter(|r| r.node == n).map(|r| r.set_list.clone()).unwrap_or_default();
                self.remote = Some(RemoteSel { node: n, set, sets, set_list, stats: None, images: Default::default(), failed: Default::default(), loaded: false });
                self.request_state();
            }
        }
    }

    /// Choose the target set on the remote head node and ask for its state
    pub fn set_remote_set(&mut self, set: &str) {
        if let Some(r) = self.remote.as_mut() {
            r.set = set.to_string();
            r.loaded = false;
        }
        self.request_state();
    }

    /// Ask the remote head node for its sets and the state of the chosen set
    pub fn request_state(&mut self) {
        let Some((node, set)) = self.remote_sel().map(|r| (r.node.clone(), r.set.clone())) else { return };
        if let Some(conn) = self.conn_of(&node) {
            self.reply(conn, Msg::GetState { set }, Payload::None);
            // its runs too, for the Sets view
            self.reply(conn, Msg::ListRuns, Payload::None);
        }
    }

    /// Abort the run going on: here, or ask its head node
    pub fn abort_any(&mut self) {
        if self.running() {
            self.abort();
            return;
        }
        let Some(from) = self.remote_run.as_ref().filter(|r| !r.status.finished).map(|r| r.from.clone()) else { return };
        if let Some(conn) = self.conn_of(&from) {
            self.reply(conn, Msg::AbortRun, Payload::None);
            self.note(Level::Info, format!("Asking {from} to abort its run"));
        }
    }

    /// The run's status to every other node: once a second while it runs, once more at its end
    fn send_status(&mut self) {
        let Some(run) = self.run.as_ref() else { return };
        let finished = run.finished.is_some();
        if (finished && run.status_sent) || (!finished && self.last_status.elapsed() < std::time::Duration::from_secs(1)) {
            return;
        }
        self.last_status = std::time::Instant::now();
        let workers = self
            .workers
            .iter()
            .map(|w| {
                let (phase, current, done, total) = w.progress();
                WorkerStatus { label: w.label(), phase: phase.into(), entity: current.map(|t| self.targets[t].entity.clone()).unwrap_or_default(), done, total, secs: w.since.elapsed().as_secs_f64() }
            })
            .collect();
        let errors = self.errors.iter().rev().take(50).rev().map(|(t, e)| (self.targets[*t].entity.clone(), e.clone())).collect();
        let status = RunStatus {
            run: self.record.as_ref().map(|r| r.id.clone()).unwrap_or_default(),
            head: self.me.name.clone(),
            starter: run.starter.clone(),
            set: self.set.name.clone(),
            filter: run.filter.clone(),
            scope: run.scope.label().to_string(),
            total: run.total,
            ok: run.ok,
            failed: run.failed,
            exported: run.exported,
            pending: run.pending.len(),
            ready: run.ready.len(),
            elapsed: run.finished.unwrap_or_else(std::time::Instant::now).duration_since(run.started).as_secs_f64(),
            rate: self.rate(120.0),
            slots: self.total_slots(),
            paused: self.paused,
            finished,
            aborted: run.aborted,
            workers,
            errors,
            phase_avg: run.phase_avg(),
        };
        if let Some(h) = self.hub.as_ref() {
            for p in &h.peers {
                p.send(Msg::Status(status.clone()), Payload::None);
            }
        }
        if let (true, Some(r)) = (finished, self.run.as_mut()) {
            r.status_sent = true;
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
        self.stats = self.store.last_stats();
        Ok(Some((new_id, info.entities.values().filter(|e| e.ok).count())))
    }

    /// Runs of another node that are missing here: finished and rendered for its live
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

    /// Key m on this node: drop the fetched manifest (its file too, else it comes back at the next start); "missing"
    /// counts only this node's live again
    pub fn drop_manifest(&mut self) {
        let Some(m) = self.manifest.take() else {
            self.note(Level::Info, "No manifest to drop");
            return;
        };
        let dir = self.store.root.join("manifests");
        let removed = fs::remove_dir_all(&dir).map_or_else(|e| e.kind() == std::io::ErrorKind::NotFound, |_| true);
        if removed {
            self.note(Level::Ok, format!("Manifest of {} dropped: \"missing\" counts only this node's live again", m.from));
        } else {
            self.note(Level::Error, format!("Manifest of {} dropped here, but {} not deleted", m.from, dir.display()));
        }
    }

    /// Key m: fetch the other node's live manifest
    pub fn fetch_manifest(&mut self, conn: u64) {
        let name = self.peer_name(conn);
        self.reply(conn, Msg::GetManifest { set: LIVE.into() }, Payload::None);
        self.note(Level::Info, format!("Asking {name} for its live manifest"));
    }

    /// Request a node's run list again
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
    use crate::engine::{Config, Scope, Target};
    use crate::net::Hub;
    use crate::store::{EntityResult, Store};
    use crate::tables::Tables;
    use std::time::{Duration, Instant};

    fn net(name: &str, listen: String, peers: Vec<String>) -> NetConfig {
        NetConfig { name: name.into(), token: "t".into(), listen, peers, discovery: false }
    }

    /// An engine with fake tools: `render`/`export` only as capabilities (the processes fail at once)
    fn engine(root: &Path, cfg: NetConfig, render: bool, export: bool) -> Engine {
        let store = Store::open(&root.join("store")).unwrap();
        let set = store.load_set(LIVE).unwrap();
        let me = Hello { name: cfg.name.clone(), version: "t".into(), render, export, blender: "5.2.3".into(), addon: Some("a".into()), slots: render as usize, exporters: export as usize, ..Default::default() };
        let hub = Hub::new(cfg, me.clone(), root.join("inbox"));
        let x = root.join("no-such-tool");
        let config = Config { p4k: x.clone(), starbreaker: x.clone(), blender: x.clone(), render_script: x, work: root.join("work"), size: 256, chunk: 50 };
        let mut e = Engine::new(config, Vec::new(), Tables::default(), store, set, Some(hub), me).unwrap();
        e.max_renderers = render as usize;
        e.max_exporters = export as usize;
        e
    }

    fn target(entity: &str) -> Target {
        Target { uuids: vec!["0000".into()], names: None, entity: entity.into(), kind: "WeaponPersonal".into(), sub_type: "Small".into(), worn: false }
    }

    fn until(nodes: &mut [&mut Engine], what: &str, done: &dyn Fn(&[&mut Engine]) -> bool) {
        let t0 = Instant::now();
        while !done(nodes) {
            assert!(t0.elapsed() < Duration::from_secs(20), "timeout: {what}");
            for b in nodes.iter_mut() {
                b.tick();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Same state or no run: packshot build, Blender, add-on and StarBreaker as on the head node (whatever the node
    /// does), Data.p4k in sync among the exporting nodes (the head node needs none)
    #[test]
    fn state_differences() {
        let root = std::env::temp_dir().join(format!("packshot-state-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        // a: the head node, without capabilities and without Data.p4k
        let mut e = engine(&root, NetConfig { name: "a".into(), ..Default::default() }, false, false);
        e.me.starbreaker = Some("655d5f68".into());
        let head = e.me.clone();
        let same = Hello { name: "b".into(), render: true, export: true, p4k_id: Some("1a2b".into()), ..head.clone() };
        assert!(e.differences_to(&same, &head).is_empty());
        let addon = Hello { addon: Some("other".into()), ..same.clone() };
        assert_eq!(e.differences_to(&addon, &head), vec!["add-on other (head a a)".to_string()]);
        let sb = Hello { render: false, export: false, starbreaker: Some("cc0c3c91".into()), ..same.clone() };
        assert_eq!(e.differences_to(&sb, &head).len(), 1, "StarBreaker counts even for a node without --export");
        let blender = Hello { render: false, export: false, blender: "5.2.2".into(), ..same.clone() };
        assert_eq!(e.differences_to(&blender, &head).len(), 1, "Blender counts even for a node without --render");
        // Data.p4k: only among the exporting nodes; here a single one, so nothing to compare
        assert!(e.differences_to(&Hello { p4k_id: Some("ffff".into()), ..same.clone() }, &head).is_empty());
        let _ = crate::store::remove_tree(&root);
    }

    /// Two exporting nodes with different Data.p4k: both are out of sync, whichever is the head node
    #[test]
    fn p4k_in_sync() {
        let root = std::env::temp_dir().join(format!("packshot-p4k-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let port = 48830 + (std::process::id() % 15) as u16;
        let mut a = engine(&root.join("a"), net("a", format!("127.0.0.1:{port}"), Vec::new()), true, true);
        let mut b = engine(&root.join("b"), net("b", "127.0.0.1:0".into(), vec![format!("127.0.0.1:{port}")]), true, true);
        a.me.p4k_version = Some("4.10.197".into());
        a.me.p4k_id = Some("aaaa".into());
        b.me.p4k_version = Some("4.10.196".into());
        b.me.p4k_id = Some("bbbb".into());
        for e in [&mut a, &mut b] {
            let me = e.me.clone();
            e.hub.as_mut().unwrap().me = Hello { instance: e.hub.as_ref().unwrap().me.instance, ..me };
        }
        until(&mut [&mut a, &mut b], "connected", &|e| !e[0].connected_nodes().is_empty() && !e[1].connected_nodes().is_empty());
        let problems = a.state_problems();
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(problems.iter().any(|(n, d)| n == "a" && d == &vec!["Data.p4k 4.10.197 (b 4.10.196)".to_string()]), "{problems:?}");
        let todo = a.add_targets(vec![target("gun_a")]);
        assert!(a.start_local(&todo, "t", "", Scope::All, "x", "a").is_err(), "no run while out of sync");
        for e in [&mut a, &mut b] {
            e.hub.as_mut().unwrap().close_all();
        }
        let _ = crate::store::remove_tree(&root);
    }

    /// Two nodes: b lists a's runs, fetches the missing one (h) and a's live manifest (m)
    #[test]
    fn fetch_runs_and_manifest() {
        let root = std::env::temp_dir().join(format!("packshot-cluster-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let port = 48900 + (std::process::id() % 20) as u16;
        let mut a = engine(&root.join("a"), net("a", format!("127.0.0.1:{port}"), Vec::new()), false, false);
        let mut b = engine(&root.join("b"), net("b", "127.0.0.1:0".into(), vec![format!("127.0.0.1:{port}")]), false, false);

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

        until(&mut [&mut a, &mut b], "runs listed", &|e| e[1].fetchable("a").len() == 1);
        let conn = b.hub.as_ref().unwrap().peers[0].conn;
        assert_eq!(b.fetch_runs(conn), 1);
        until(&mut [&mut a, &mut b], "run fetched", &|e| e[1].store.run_dir(id).join("run.json").exists() && e[1].fetching.is_empty());
        assert_eq!(fs::read_to_string(b.store.set_dir(LIVE).join(&files[0])).unwrap(), "png");
        assert_eq!(b.set.runs, vec![id.to_string()]);
        assert!(b.fetchable("a").is_empty());

        let seq = b.state_seq;
        b.fetch_manifest(conn);
        until(&mut [&mut a, &mut b], "manifest", &|e| e[1].manifest.is_some());
        assert!(b.state_seq > seq, "the TUI recomputes its selection");
        assert_eq!(b.manifest.as_ref().unwrap().entities.get("x"), Some(&true));
        assert!(load_manifest(&b.store.root).is_some(), "kept for the next start");
        // m on this node drops it, the file too
        b.drop_manifest();
        assert!(b.manifest.is_none() && load_manifest(&b.store.root).is_none());
        for e in [&mut a, &mut b] {
            e.hub.as_mut().unwrap().close_all();
        }
        let _ = crate::store::remove_tree(&root);
    }

    /// A node without capabilities chooses another node as head node: gets its sets and the state of its set, starts
    /// a run there (into a new set), follows its status to the end; the selection then sees the result there
    #[test]
    fn start_on_another_box() {
        let root = std::env::temp_dir().join(format!("packshot-remote-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let port = 48850 + (std::process::id() % 20) as u16;
        let mut m = engine(&root.join("m"), net("m", format!("127.0.0.1:{port}"), Vec::new()), true, true);
        let mut a = engine(&root.join("a"), net("a", "127.0.0.1:0".into(), vec![format!("127.0.0.1:{port}")]), false, false);
        // the target list lives in m's live; a has none of its own
        let file = root.join("targets.json");
        fs::write(&file, serde_json::to_vec(&vec![target("gun_a"), target("gun_b")]).unwrap()).unwrap();
        let mut live = m.store.load_set(LIVE).unwrap();
        m.store.set_targets(&mut live, &file).unwrap();
        assert_eq!(a.own_len, 0);
        until(&mut [&mut m, &mut a], "connected", &|e| !e[1].connected_nodes().is_empty());

        a.set_head(Some("m".into()));
        until(&mut [&mut m, &mut a], "state of m", &|e| e[1].remote_sel().is_some_and(|r| r.loaded));
        assert_eq!(a.remote_sel().unwrap().sets, vec![LIVE.to_string()]);
        assert_eq!(a.own_len, 2, "the target list of m's live came with its state");
        a.set_remote_set("exp");
        until(&mut [&mut m, &mut a], "state of exp", &|e| e[1].remote_sel().is_some_and(|r| r.loaded));
        let sel = a.select("", Scope::Missing);
        assert_eq!(sel.todo.len(), 2);
        a.start_remote_run(&sel.todo, "test", "", Scope::Missing, "remote").unwrap();
        // m runs it (its fake StarBreaker fails every export) and reports the end to a
        until(&mut [&mut m, &mut a], "run over on a", &|e| e[1].remote_run.as_ref().is_some_and(|r| r.status.finished));
        let st = &a.remote_run.as_ref().unwrap().status;
        assert_eq!((st.head.as_str(), st.starter.as_str(), st.set.as_str(), st.total, st.failed), ("m", "a", "exp", 2, 2));
        assert_eq!(st.errors.len(), 2);
        assert_eq!(m.set.name, "exp", "the set was created on m");
        assert_eq!(m.store.load_targets(&m.set).unwrap().len(), 2, "with live's target list");
        assert!(m.record.as_ref().is_some_and(|r| r.origin["starter"] == "a"));
        // the failures are part of m's set now: the selection on a sees them after the end
        until(&mut [&mut m, &mut a], "state after the run", &|e| e[1].remote_sel().is_some_and(|r| r.loaded && r.failed.len() == 2));
        assert_eq!(a.select("", Scope::Failed).todo.len(), 2);
        for e in [&mut m, &mut a] {
            e.hub.as_mut().unwrap().close_all();
        }
        let _ = crate::store::remove_tree(&root);
    }

    /// Every node may abort: a run going on m (paused, so nothing starts) is aborted from a
    #[test]
    fn abort_from_another_box() {
        let root = std::env::temp_dir().join(format!("packshot-abort-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let port = 48870 + (std::process::id() % 20) as u16;
        let mut m = engine(&root.join("m"), net("m", format!("127.0.0.1:{port}"), Vec::new()), true, true);
        let mut a = engine(&root.join("a"), net("a", "127.0.0.1:0".into(), vec![format!("127.0.0.1:{port}")]), false, false);
        until(&mut [&mut m, &mut a], "connected", &|e| !e[1].connected_nodes().is_empty());
        let todo = m.add_targets(vec![target("gun_a")]);
        m.start_local(&todo, "test", "", Scope::All, "abort", "m").unwrap();
        m.paused = true;
        until(&mut [&mut m, &mut a], "status on a", &|e| e[1].remote_run.as_ref().is_some_and(|r| !r.status.finished) && e[1].running_elsewhere().is_some());
        // a node with a run going elsewhere starts nothing itself
        assert_eq!(a.running_elsewhere().as_deref(), Some("m"));
        a.abort_any();
        until(&mut [&mut m, &mut a], "aborted", &|e| e[1].remote_run.as_ref().is_some_and(|r| r.status.finished && r.status.aborted));
        assert!(!m.running());
        for e in [&mut m, &mut a] {
            e.hub.as_mut().unwrap().close_all();
        }
        let _ = crate::store::remove_tree(&root);
    }

    /// Packages: at most PACKAGE_MAX items, as many at once as the node has export workers; an exported item moves
    /// the package's progress from export to render
    #[test]
    fn package_limits() {
        let root = std::env::temp_dir().join(format!("packshot-pkglimit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let port = 48810 + (std::process::id() % 15) as u16;
        let mut m = engine(&root.join("m"), net("m", format!("127.0.0.1:{port}"), Vec::new()), false, false);
        let mut n = engine(&root.join("n"), net("n", "127.0.0.1:0".into(), vec![format!("127.0.0.1:{port}")]), true, true);
        n.max_exporters = 2;
        n.max_renderers = 3;
        // packages carry render.py
        fs::write(root.join("render.py"), "# render").unwrap();
        m.cfg.render_script = root.join("render.py");
        until(&mut [&mut m, &mut n], "n offers its workers", &|e| e[0].connected_nodes().first().is_some_and(|(_, h)| h.exporters == 2 && h.slots == 3));
        let todo = m.add_targets((0..200).map(|k| target(&format!("gun_{k}"))).collect());
        m.start_local(&todo, "t", "", Scope::All, "x", "m").unwrap();
        // the first schedule: no messages from n yet
        m.tick();
        let packages: Vec<&crate::engine::Worker> = m.workers.iter().filter(|w| w.package).collect();
        assert_eq!(packages.len(), 2, "as many as n has export workers");
        assert!(packages.iter().all(|w| w.order.len() <= crate::engine::PACKAGE_MAX && w.progress().0 == "export"));
        assert!(packages.iter().all(|w| w.label().starts_with("n/P")), "packages are P workers");
        // n reports an item of the first package exported: its progress counts it
        let (conn, id, item) = (packages[0].conn, packages[0].remote, packages[0].order[0]);
        m.on_msg(conn, Msg::ItemExported { block: id, item }, Vec::new(), None);
        let w = m.workers.iter().find(|w| w.remote == id).unwrap();
        assert_eq!(w.progress(), ("export", Some(w.order[1]), 1, w.order.len()), "the next item in the package's order");
        m.abort();
        for e in [&mut m, &mut n] {
            e.hub.as_mut().unwrap().close_all();
        }
        let _ = crate::store::remove_tree(&root);
    }

    /// No run without someone to export and render
    #[test]
    fn capacity() {
        let root = std::env::temp_dir().join(format!("packshot-cap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mut e = engine(&root, NetConfig { name: "a".into(), ..Default::default() }, false, false);
        assert!(e.capacity_problem().is_some_and(|p| p.contains("exports or renders")));
        let todo = e.add_targets(vec![target("gun_a")]);
        assert!(e.start_local(&todo, "t", "", Scope::All, "x", "a").is_err());
        e.me.render = true;
        e.max_renderers = 1;
        assert!(e.capacity_problem().is_some_and(|p| p.contains("exports")));
        let _ = crate::store::remove_tree(&root);
    }

    /// The DataCore tables in the background: no export workers until they are there; failing leaves the node
    /// without export (here a StarBreaker that does not exist and an empty work folder)
    #[test]
    fn tables_in_background() {
        let root = std::env::temp_dir().join(format!("packshot-tables-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mut e = engine(&root, NetConfig { name: "a".into(), ..Default::default() }, true, true);
        e.max_exporters = 2;
        assert_eq!(e.exporters_now(), 2);
        e.load_tables(false);
        assert_eq!(e.exporters_now(), 0, "nothing offered while loading");
        assert!(e.tables_loading().is_some());
        let t0 = Instant::now();
        while e.tables_loading().is_some() {
            assert!(t0.elapsed() < Duration::from_secs(10), "loading does not end");
            e.tick();
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(e.exporters_now(), 0, "failed: still no export");
        assert!(e.log.iter().any(|l| l.text.starts_with("DataCore tables not loaded")), "the failure is in the log");
        assert!(e.capacity_problem().is_some_and(|p| p.contains("exports")));
        let _ = crate::store::remove_tree(&root);
    }

    #[test]
    fn disks() {
        let d = disk_info(&[std::env::temp_dir()]);
        assert_eq!(d.len(), 1, "{d:?}");
        assert!(d[0].total > 0 && d[0].free <= d[0].total);
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

    /// A node with real tools (SC_DATA_P4K must be set) and the given capabilities
    fn real(root: &Path, name: &str, listen: String, peers: Vec<String>, render: bool, export: bool) -> Engine {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let p4k = PathBuf::from(std::env::var("SC_DATA_P4K").expect("SC_DATA_P4K"));
        let starbreaker = repo.join("local/starbreaker-qm").join(crate::exe("starbreaker"));
        let blender = fs::read_dir(repo.join("local/blender")).unwrap().flatten().map(|e| e.path().join(crate::exe("blender"))).find(|p| p.exists()).unwrap();
        let tables_work = repo.join("local/packshot/work");
        let targets: Vec<Target> = serde_json::from_slice(&fs::read(repo.join("local/packshot/targets.json")).unwrap()).unwrap();
        let dir = root.join(name);
        let store = Store::open(&dir.join("store")).unwrap();
        let set = store.load_set(LIVE).unwrap();
        let caps = Caps { render, export, blender: Some(blender.as_path()), starbreaker: Some(starbreaker.as_path()), p4k: Some(p4k.as_path()) };
        let mut me = own_hello(name, caps, if render { 2 } else { 0 }, if export { 2 } else { 0 }, 8, Vec::new());
        me.name = name.into();
        let hub = Hub::new(NetConfig { name: name.into(), token: "t".into(), listen, peers, discovery: false }, me.clone(), dir.join("inbox"));
        let tables = if export { Tables::load(&starbreaker, &p4k, &tables_work, false, |_| {}).unwrap() } else { Tables::default() };
        let cfg = Config { p4k: p4k.clone(), starbreaker: starbreaker.clone(), blender: blender.clone(), render_script: repo.join("src/icons/render.py"), work: dir.join("work"), size: 128, chunk: 50 };
        let mut e = Engine::new(cfg, targets, tables, store, set, Some(hub), me).unwrap();
        let mut r = Renderer::new(blender, if render { 2 } else { 0 }, dir.join("work/preview.png"));
        if export {
            r.tools = Some(ExportTools { starbreaker, p4k, rigs: tables_work.join("dcb/rigs") });
        }
        e.serve = Some(r);
        e.max_renderers = if render { 2 } else { 0 };
        e.max_exporters = if export { 2 } else { 0 };
        e
    }

    fn run_with(nodes: &mut [Engine], filter: &str, expect: usize) {
        let t0 = Instant::now();
        let others = nodes.len() - 1;
        while nodes[0].usable_nodes().len() < others || nodes[0].capacity_problem().is_some() {
            assert!(t0.elapsed() < Duration::from_secs(15), "nodes not usable");
            for b in nodes.iter_mut() {
                b.tick();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(nodes[0].state_problems().is_empty(), "same state");
        let sel = nodes[0].select(filter, Scope::All);
        assert_eq!(sel.todo.len(), expect);
        let me = nodes[0].me.name.clone();
        nodes[0].start_local(&sel.todo, "test", "", Scope::All, "pkg", &me).unwrap();
        while nodes[0].running() {
            assert!(t0.elapsed() < Duration::from_secs(240), "timeout");
            for b in nodes.iter_mut() {
                b.tick();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let a = &nodes[0];
        for l in &a.log {
            println!("{}", l.text);
        }
        let run = a.run.as_ref().unwrap();
        assert_eq!((run.ok, run.failed), (expect, 0));
        assert!(a.history.iter().all(|t| a.image(*t).is_some()), "images in the head node's set");
        for b in nodes.iter_mut() {
            b.hub.as_mut().unwrap().close_all();
        }
    }

    /// The head node without capabilities hands the whole run as item packages to a node that exports and renders
    /// (real tools, SC_DATA_P4K must be set): cargo test --release -- --ignored run_by_packages
    #[test]
    #[ignore]
    fn run_by_packages() {
        let root = std::env::temp_dir().join(format!("packshot-run-pkg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let port = 48990 + (std::process::id() % 9) as u16;
        let a = real(&root, "a", format!("127.0.0.1:{port}"), Vec::new(), false, false);
        let b = real(&root, "b", "127.0.0.1:0".into(), vec![format!("127.0.0.1:{port}")], true, true);
        run_with(&mut [a, b], "rock_gold rock_aluminum klwe_pistol_energy_01_tan01", 3);
        let _ = crate::store::remove_tree(&root);
    }

    /// Export and render on different nodes: e exports without Blender and sends its blocks back to the head node,
    /// which hands them to r (real tools): cargo test --release -- --ignored export_only_relay
    #[test]
    #[ignore]
    fn export_only_relay() {
        let root = std::env::temp_dir().join(format!("packshot-relay-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let port = 48940 + (std::process::id() % 9) as u16;
        let head = real(&root, "head", format!("127.0.0.1:{port}"), Vec::new(), false, false);
        let e = real(&root, "e", "127.0.0.1:0".into(), vec![format!("127.0.0.1:{port}")], false, true);
        let r = real(&root, "r", "127.0.0.1:0".into(), vec![format!("127.0.0.1:{port}")], true, false);
        run_with(&mut [head, e, r], "rock_gold rock_aluminum klwe_pistol_energy_01_tan01", 3);
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
