// The cluster from a coordinator's point of view (part of the engine): send blocks to nodes and take over their
// results, back into the queue on failure; fetch runs of other coordinators (key h, they attach to live),
// fetch their live manifest (m, for "missing"), send the own addon to nodes (s and at start). Requests
// from other coordinators (runs, run files, manifest) are answered by each coordinator itself.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde_json::json;

use crate::engine::{Engine, Kind, Level, Manifest, blender_version};
use crate::events::round3;
use crate::net::{Hello, HubEv, Msg, Payload, RemoteJob, Role, RunSummary, collect_files};
use crate::node::{addon_dir, config_dir};
use crate::store::{LIVE, RunInfo, slug};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NodeState {
    Ready,
    /// different addon: can be synced with s (or at start)
    Outdated,
    /// different packshot or Blender version: does not take part
    Incompatible,
}

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

/// Own versions for the handshake
pub fn own_hello(name: &str, role: Role, blender: &Path, slots: usize, cores: usize, p4k: Option<&Path>) -> Hello {
    Hello {
        token: String::new(),
        role: Some(role),
        name: name.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        blender: blender_version(blender),
        addon: crate::events::tree_hash(&addon_dir(blender)),
        slots,
        cores,
        p4k_bytes: p4k.and_then(|p| fs::metadata(p).ok()).map(|m| m.len()),
    }
}

impl Engine {
    pub fn node_state(&self, h: &Hello) -> NodeState {
        if h.version != self.me.version || h.blender != self.me.blender {
            NodeState::Incompatible
        } else if h.addon != self.me.addon {
            NodeState::Outdated
        } else {
            NodeState::Ready
        }
    }

    /// Connected nodes: (connection, versions)
    pub fn connected_nodes(&self) -> Vec<(u64, Hello)> {
        let Some(hub) = self.hub.as_ref() else { return Vec::new() };
        hub.peers.iter().filter(|p| p.hello.role == Some(Role::Node)).map(|p| (p.conn, p.hello.clone())).collect()
    }

    /// Nodes that get blocks: connected, same version and (during a run) present at its start
    pub(crate) fn usable_nodes(&self) -> Vec<(u64, usize)> {
        let running = self.running();
        self.connected_nodes()
            .into_iter()
            .filter(|(_, h)| self.node_state(h) == NodeState::Ready)
            .filter(|(_, h)| !running || self.run.as_ref().is_some_and(|r| r.nodes.contains(&h.name)))
            .map(|(c, h)| (c, h.slots.max(1)))
            .collect()
    }

    /// Node with a free slot (most free slots first)
    pub(crate) fn free_node(&self) -> Option<u64> {
        self.usable_nodes()
            .into_iter()
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
                }
                HubEv::Msg { conn, msg, data, dir } => self.on_msg(conn, msg, data, dir),
            }
        }
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
            Msg::Hello(h) => {
                let state = self.node_state(&h);
                self.note(Level::Info, format!("{}: add-on {} ({state:?})", h.name, h.addon.as_deref().unwrap_or("?")));
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

    /// Key s (and at start): own addon and Blender config to a node
    pub fn send_addon(&mut self, conn: u64) -> Result<()> {
        let (mut entries, mut paths) = collect_files(&addon_dir(&self.cfg.blender), "addon/")?;
        let config = config_dir(&self.cfg.blender);
        if config.is_dir() {
            let (e, p) = collect_files(&config, "config/")?;
            entries.extend(e);
            paths.extend(p);
        }
        let name = self.peer_name(conn);
        let bytes: u64 = entries.iter().map(|e| e.size).sum();
        self.reply(conn, Msg::Addon { files: entries }, Payload::Files(paths));
        self.note(Level::Info, format!("Add-on and Blender config sent to {name} ({:.1} MB)", bytes as f64 / 1e6));
        Ok(())
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
