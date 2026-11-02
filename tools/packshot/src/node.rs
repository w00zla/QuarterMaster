// Node mode (`packshot --node`): connects to the coordinators of the config, accepts blocks (export folder,
// rigs, render.py), renders them with its own Blender (one process per block, at most `slots` at a time) and
// sends back the PNG with the icon: line for each item. Needs neither Data.p4k nor StarBreaker. Outside
// its working folder it writes only the addon (portable/scripts/addons/starbreaker_addon) and the Blender config
// (portable/config), when a coordinator sends them.
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

use crate::events::tree_hash;
use crate::net::{HubEv, Hub, Msg, Payload, RemoteJob};

struct Queued {
    conn: u64,
    id: u64,
    dir: PathBuf,
    jobs: Vec<RemoteJob>,
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

pub fn config_dir(blender: &Path) -> PathBuf {
    blender.parent().unwrap_or(Path::new(".")).join("portable/config")
}

/// A link (symlink, junction) is never overwritten: on the development machine the addon points into the fork repo
fn is_link(p: &Path) -> bool {
    let Ok(m) = fs::symlink_metadata(p) else { return false };
    if m.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return m.file_attributes() & 0x400 != 0;
    }
    #[allow(unreachable_code)]
    false
}

/// Put folder `src` in the place of `dst` (via dst.new, then swap)
fn replace_dir(src: &Path, dst: &Path) -> Result<()> {
    if is_link(dst) {
        bail!("{} is a link, not overwritten", dst.display());
    }
    let staged = dst.with_extension("new");
    let _ = fs::remove_dir_all(&staged);
    if let Some(p) = staged.parent() {
        fs::create_dir_all(p)?;
    }
    fs::rename(src, &staged).with_context(|| format!("{} -> {}", src.display(), staged.display()))?;
    if dst.exists() {
        fs::remove_dir_all(dst).with_context(|| dst.display().to_string())?;
    }
    fs::rename(&staged, dst).with_context(|| dst.display().to_string())
}

pub struct NodeArgs {
    pub blender: PathBuf,
    pub work: PathBuf,
    pub slots: usize,
}

pub fn run(mut hub: Hub, args: NodeArgs) -> Result<()> {
    if !hub.cfg.enabled() {
        bail!("Node mode needs a token and coordinators in packshot.json");
    }
    if hub.cfg.coordinators.is_empty() {
        bail!("No coordinators in packshot.json");
    }
    let blocks_dir = args.work.join("node");
    let _ = fs::remove_dir_all(&blocks_dir);
    fs::create_dir_all(&blocks_dir)?;
    println!(
        "{} node {} · Blender {} · Addon {} · {} slots · coordinators: {}",
        now(),
        hub.me.name,
        hub.me.blender,
        hub.me.addon.as_deref().unwrap_or("?"),
        args.slots,
        hub.cfg.coordinators.join(", ")
    );
    let (tx, rx): (Sender<Line>, Receiver<Line>) = channel();
    let mut queue: VecDeque<Queued> = VecDeque::new();
    let mut running: HashMap<u64, Running> = HashMap::new();
    let mut next_key = 1u64;
    let mut last_errors = String::new();
    loop {
        for ev in hub.poll() {
            match ev {
                HubEv::Up { conn } => {
                    if let Some(p) = hub.peer(conn) {
                        println!("{} connected to {} ({})", now(), p.hello.name, p.addr);
                    }
                }
                HubEv::Down { conn, name, error } => {
                    println!("{} {name} disconnected: {error}", now());
                    queue.retain(|q| {
                        let keep = q.conn != conn;
                        if !keep {
                            let _ = fs::remove_dir_all(&q.dir);
                        }
                        keep
                    });
                    for r in running.values_mut().filter(|r| r.conn == conn) {
                        let _ = r.child.kill();
                    }
                }
                HubEv::Msg { conn, msg, dir, .. } => match msg {
                    Msg::Block { id, jobs, .. } => {
                        let Some(dir) = dir else { continue };
                        let from = hub.peer(conn).map(|p| p.hello.name.clone()).unwrap_or_default();
                        println!("{} block {id} from {from}: {} items", now(), jobs.len());
                        queue.push_back(Queued { conn, id, dir, jobs });
                    }
                    Msg::Cancel { id } => {
                        queue.retain(|q| !(q.conn == conn && q.id == id));
                        for r in running.values_mut().filter(|r| r.conn == conn && r.id == id) {
                            let _ = r.child.kill();
                        }
                    }
                    Msg::Addon { .. } => {
                        let Some(dir) = dir else { continue };
                        let res = (|| -> Result<()> {
                            if !running.is_empty() {
                                bail!("blocks are running");
                            }
                            if dir.join("addon").is_dir() {
                                replace_dir(&dir.join("addon"), &addon_dir(&args.blender))?;
                            }
                            if dir.join("config").is_dir() {
                                replace_dir(&dir.join("config"), &config_dir(&args.blender))?;
                            }
                            Ok(())
                        })();
                        let _ = fs::remove_dir_all(&dir);
                        match res {
                            Ok(()) => {
                                hub.me.addon = tree_hash(&addon_dir(&args.blender));
                                println!("{} add-on updated: {}", now(), hub.me.addon.as_deref().unwrap_or("?"));
                            }
                            Err(e) => {
                                println!("{} add-on not updated: {e:#}", now());
                                hub.send(conn, Msg::Error { what: format!("add-on not updated: {e:#}") }, Payload::None);
                            }
                        }
                        // new states to all coordinators
                        for p in &hub.peers {
                            p.send(Msg::Hello(hub.me.clone()), Payload::None);
                        }
                    }
                    Msg::Error { what } => println!("{} error from coordinator: {what}", now()),
                    _ => {}
                },
            }
        }
        // free slots: start the next block
        while running.len() < args.slots {
            let Some(q) = queue.pop_front() else { break };
            let key = next_key;
            next_key += 1;
            match start_block(&args, &q, key, &tx) {
                Ok(r) => {
                    running.insert(key, r);
                }
                Err(e) => {
                    let error = format!("{e:#}");
                    println!("{} block {} not started: {error}", now(), q.id);
                    hub.send(q.conn, Msg::BlockDone { id: q.id, exit: None, error }, Payload::None);
                    let _ = fs::remove_dir_all(&q.dir);
                }
            }
        }
        // lines of the Blenders
        let deadline = Instant::now() + Duration::from_millis(50);
        while let Ok(l) = rx.recv_timeout(Duration::from_millis(20)) {
            match l {
                Line::Out { key, line, stderr } => {
                    let Some(r) = running.get_mut(&key) else { continue };
                    // both streams: Blender reports some errors on stdout, render.py's tracebacks on stderr
                    r.stderr_tail.push_str(&line);
                    r.stderr_tail.push('\n');
                    crate::engine::keep_tail(&mut r.stderr_tail, 2000);
                    if stderr {
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
                    if let Some(r) = running.get_mut(&key) {
                        r.eof += 1;
                    }
                }
            }
            if Instant::now() > deadline {
                break;
            }
        }
        let done: Vec<u64> = running.iter().filter(|(_, r)| r.eof >= 2).map(|(k, _)| *k).collect();
        for key in done {
            let Some(mut r) = running.remove(&key) else { continue };
            let exit = r.child.wait().ok().and_then(|s| s.code());
            let error = if r.reported < r.total { r.stderr_tail.trim().lines().last().unwrap_or("").to_string() } else { String::new() };
            println!("{} block {} done: {}/{} in {:.1} s", now(), r.id, r.reported, r.total, r.started.elapsed().as_secs_f64());
            hub.send(r.conn, Msg::BlockDone { id: r.id, exit, error }, Payload::None);
            if r.reported < r.total {
                // keep the block for diagnosis, with Blender's last lines
                let tail: Vec<&str> = r.stderr_tail.trim().lines().rev().take(8).collect();
                println!("{}   exit {exit:?}, block kept in {}; Blender's last lines:", now(), r.dir.display());
                for l in tail.iter().rev() {
                    println!("    {l}");
                }
            } else {
                let _ = fs::remove_dir_all(&r.dir);
            }
        }
        let errors: String = hub.dial_errors.iter().map(|(n, e)| format!("{n}: {e}")).collect::<Vec<_>>().join(" · ");
        if errors != last_errors {
            if !errors.is_empty() {
                println!("{} not reachable: {errors}", now());
            }
            last_errors = errors;
        }
    }
}

fn start_block(args: &NodeArgs, q: &Queued, key: u64, tx: &Sender<Line>) -> Result<Running> {
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
    let mut child = Command::new(&args.blender)
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
        .with_context(|| args.blender.display().to_string())?;
    for (stream, stderr) in [(child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), false), (child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), true)] {
        let Some(stream) = stream else { continue };
        let tx = tx.clone();
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
    Ok(Running { conn: q.conn, id: q.id, dir: q.dir.clone(), child, outs, reported: 0, total: q.jobs.len(), eof: 0, stderr_tail: String::new(), started: Instant::now() })
}
