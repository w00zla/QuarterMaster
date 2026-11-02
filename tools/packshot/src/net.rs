// Network in the cluster: TCP, one frame per message made of u32 JSON length, JSON, u64 payload length and payload (LE).
// Files (export blocks, addon, runs) go one after another as the payload, their paths and sizes are in the JSON;
// the reader thread writes them straight into an inbox folder, the main thread only gets the folder. Every
// connection starts with Hello (token, role, versions); the accepting side checks the token and answers with Welcome.
// Afterwards both sides can send requests. The hub holds the connections of a process: listen
// (coordinator), dial (the coordinators of the config), ping, resolve duplicate connections.
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

use crate::config::{DEFAULT_PORT, NetConfig};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Node,
    Coordinator,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Hello {
    #[serde(default)]
    pub token: String,
    pub role: Option<Role>,
    pub name: String,
    pub version: String,
    pub os: String,
    /// Blender version (from the folder name), empty without Blender
    pub blender: String,
    /// Hash of the StarBreaker addon (events::tree_hash)
    pub addon: Option<String>,
    /// Blender processes the node runs at the same time
    pub slots: usize,
    pub cores: usize,
    /// Size of Data.p4k (coordinators only)
    #[serde(default)]
    pub p4k_bytes: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
}

/// A render job in the block, paths relative to the block folder
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RemoteJob {
    pub item: usize,
    pub src: String,
    pub pose: [f64; 3],
    pub rig: String,
    pub size: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RunSummary {
    pub id: String,
    pub name: String,
    pub set: String,
    pub node: String,
    pub finished: bool,
    pub images: usize,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Msg {
    Hello(Hello),
    Welcome(Hello),
    Reject { reason: String },
    Ping,
    /// Coordinator -> node: export folder, rigs and render.py as files, plus the jobs
    Block { id: u64, jobs: Vec<RemoteJob>, files: Vec<FileEntry> },
    Cancel { id: u64 },
    /// Coordinator -> node: addon (addon/…) and Blender config (config/…)
    Addon { files: Vec<FileEntry> },
    /// Node -> coordinator: an item done (payload: the PNG) or failed
    Item { block: u64, item: usize, ok: bool, info: String },
    BlockDone { id: u64, exit: Option<i32>, error: String },
    /// Coordinator <-> coordinator
    ListRuns,
    Runs { runs: Vec<RunSummary> },
    GetRun { id: String },
    RunFiles { id: String, files: Vec<FileEntry> },
    GetManifest { set: String },
    Manifest { set: String, from: String, entities: BTreeMap<String, bool> },
    Error { what: String },
}

pub enum Payload {
    None,
    Bytes(Vec<u8>),
    /// Files in the order of the FileEntry list
    Files(Vec<PathBuf>),
}

pub struct Out {
    pub msg: Msg,
    pub payload: Payload,
}

/// What the hub reports to the main thread
pub enum HubEv {
    Up { conn: u64 },
    Down { conn: u64, name: String, error: String },
    Msg { conn: u64, msg: Msg, data: Vec<u8>, dir: Option<PathBuf> },
}

enum NetEv {
    Up { conn: u64, hello: Hello, outbound: bool, addr: String, tx: Sender<Out>, stream: TcpStream },
    Msg { conn: u64, msg: Msg, data: Vec<u8>, dir: Option<PathBuf> },
    Down { conn: u64, error: String },
    DialFailed { addr: String, error: String },
}

/// Relative path from the network: normal components only, no drive, no ..
pub fn safe_rel(p: &str) -> Option<PathBuf> {
    let path = Path::new(p);
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

fn write_frame(w: &mut impl Write, msg: &Msg, payload: &Payload) -> io::Result<()> {
    let json = serde_json::to_vec(msg).map_err(io::Error::other)?;
    w.write_all(&(json.len() as u32).to_le_bytes())?;
    w.write_all(&json)?;
    match payload {
        Payload::None => w.write_all(&0u64.to_le_bytes())?,
        Payload::Bytes(b) => {
            w.write_all(&(b.len() as u64).to_le_bytes())?;
            w.write_all(b)?;
        }
        Payload::Files(files) => {
            let mut total = 0u64;
            let mut sizes = Vec::new();
            for f in files {
                let n = fs::metadata(f)?.len();
                sizes.push(n);
                total += n;
            }
            w.write_all(&total.to_le_bytes())?;
            for (f, n) in files.iter().zip(sizes) {
                let copied = io::copy(&mut File::open(f)?.take(n), w)?;
                if copied != n {
                    return Err(io::Error::other(format!("{} changed while sending", f.display())));
                }
            }
        }
    }
    w.flush()
}

/// Reads a frame; file lists land under `inbox`/<n>/, otherwise the payload comes back as bytes
fn read_frame(r: &mut impl Read, inbox: &Path, seq: &mut u64) -> Result<(Msg, Vec<u8>, Option<PathBuf>)> {
    let mut b4 = [0u8; 4];
    r.read_exact(&mut b4)?;
    let len = u32::from_le_bytes(b4) as usize;
    if len > 64 << 20 {
        bail!("frame too large ({len} bytes)");
    }
    let mut json = vec![0u8; len];
    r.read_exact(&mut json)?;
    let msg: Msg = serde_json::from_slice(&json).context("message")?;
    let mut b8 = [0u8; 8];
    r.read_exact(&mut b8)?;
    let total = u64::from_le_bytes(b8);
    let files = match &msg {
        Msg::Block { files, .. } | Msg::Addon { files } | Msg::RunFiles { files, .. } => Some(files.clone()),
        _ => None,
    };
    let Some(files) = files else {
        if total > 256 << 20 {
            bail!("payload too large ({total} bytes)");
        }
        let mut data = vec![0u8; total as usize];
        r.read_exact(&mut data)?;
        return Ok((msg, data, None));
    };
    if files.iter().map(|f| f.size).sum::<u64>() != total {
        bail!("payload size does not match the file list");
    }
    *seq += 1;
    let dir = inbox.join(format!("{}-{}", std::process::id(), seq));
    let _ = fs::remove_dir_all(&dir);
    for f in &files {
        let rel = safe_rel(&f.path).ok_or_else(|| anyhow!("unsafe path {}", f.path))?;
        let path = dir.join(rel);
        if let Some(p) = path.parent() {
            fs::create_dir_all(p)?;
        }
        let mut out = BufWriter::new(File::create(&path).with_context(|| path.display().to_string())?);
        let n = io::copy(&mut r.take(f.size), &mut out)?;
        out.flush()?;
        if n != f.size {
            bail!("connection closed during {}", f.path);
        }
    }
    Ok((msg, Vec::new(), Some(dir)))
}

/// Files of a folder as a list (paths with /) plus the source paths, without __pycache__
pub fn collect_files(root: &Path, prefix: &str) -> Result<(Vec<FileEntry>, Vec<PathBuf>)> {
    let mut entries = Vec::new();
    let mut paths = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).with_context(|| dir.display().to_string())?.flatten() {
            let p = e.path();
            if p.is_dir() {
                if e.file_name() != "__pycache__" {
                    stack.push(p);
                }
                continue;
            }
            let rel = p.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
            entries.push(FileEntry { path: format!("{prefix}{rel}"), size: fs::metadata(&p)?.len() });
            paths.push(p);
        }
    }
    Ok((entries, paths))
}

pub struct PeerConn {
    pub conn: u64,
    pub hello: Hello,
    pub outbound: bool,
    pub addr: String,
    tx: Sender<Out>,
    stream: TcpStream,
}

impl PeerConn {
    pub fn send(&self, msg: Msg, payload: Payload) {
        let _ = self.tx.send(Out { msg, payload });
    }
    pub fn close(&self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

pub struct Hub {
    pub cfg: NetConfig,
    pub me: Hello,
    pub peers: Vec<PeerConn>,
    /// Coordinators of the config (by address): last error while dialing
    pub dial_errors: BTreeMap<String, String>,
    /// address of the config -> host name of the box that answered there
    pub addr_names: BTreeMap<String, String>,
    /// addresses of the config where this process answered itself
    self_addrs: HashSet<String>,
    pub listen_error: Option<String>,
    tx: Sender<NetEv>,
    rx: Receiver<NetEv>,
    inbox: PathBuf,
    next_conn: u64,
    /// addresses being dialed
    dialing: HashSet<String>,
    last_dial: Option<Instant>,
    last_ping: Instant,
}

/// Set up a connection: reader and writer thread, Up to the main thread
fn run_conn(stream: TcpStream, conn: u64, hello: Hello, outbound: bool, addr: String, inbox: PathBuf, ev: Sender<NetEv>) {
    let (tx, rx) = channel::<Out>();
    let Ok(wstream) = stream.try_clone() else { return };
    let Ok(ctl) = stream.try_clone() else { return };
    thread::spawn(move || {
        let mut w = BufWriter::with_capacity(1 << 20, wstream);
        for out in rx {
            if write_frame(&mut w, &out.msg, &out.payload).is_err() {
                let _ = w.get_ref().shutdown(Shutdown::Both);
                return;
            }
        }
    });
    if ev.send(NetEv::Up { conn, hello, outbound, addr, tx, stream: ctl }).is_err() {
        return;
    }
    let mut r = BufReader::with_capacity(1 << 20, stream);
    let mut seq = conn * 1_000_000;
    loop {
        match read_frame(&mut r, &inbox, &mut seq) {
            Ok((msg, data, dir)) => {
                if ev.send(NetEv::Msg { conn, msg, data, dir }).is_err() {
                    return;
                }
            }
            Err(e) => {
                let _ = ev.send(NetEv::Down { conn, error: format!("{e:#}") });
                return;
            }
        }
    }
}

impl Hub {
    /// `listen`: accept connections as a coordinator
    pub fn new(cfg: NetConfig, me: Hello, inbox: PathBuf, listen: bool) -> Self {
        let (tx, rx) = channel();
        let _ = fs::create_dir_all(&inbox);
        let mut hub = Self {
            cfg,
            me,
            peers: Vec::new(),
            dial_errors: BTreeMap::new(),
            addr_names: BTreeMap::new(),
            self_addrs: HashSet::new(),
            listen_error: None,
            tx,
            rx,
            inbox,
            next_conn: 1,
            dialing: HashSet::new(),
            last_dial: None,
            last_ping: Instant::now(),
        };
        if listen && hub.cfg.enabled() {
            hub.listen();
        }
        hub
    }

    fn listen(&mut self) {
        let addr = self.cfg.listen.clone();
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => l,
            Err(e) => {
                self.listen_error = Some(format!("listen on {addr}: {e}"));
                return;
            }
        };
        let (ev, token, me, inbox) = (self.tx.clone(), self.cfg.token.clone(), self.me.clone(), self.inbox.clone());
        // connection numbers of the accepted connections: upper range, so they do not collide with the dialed ones
        thread::spawn(move || {
            let mut next = 1u64 << 32;
            for stream in listener.incoming().flatten() {
                next += 1;
                let (ev, token, me, inbox) = (ev.clone(), token.clone(), me.clone(), inbox.clone());
                let conn = next;
                thread::spawn(move || {
                    let addr = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(45)));
                    let _ = stream.set_nodelay(true);
                    let mut r = BufReader::new(match stream.try_clone() {
                        Ok(s) => s,
                        Err(_) => return,
                    });
                    let mut w = match stream.try_clone() {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                    let mut seq = 0;
                    let hello = match read_frame(&mut r, &inbox, &mut seq) {
                        Ok((Msg::Hello(h), _, _)) if h.token == token => h,
                        Ok((Msg::Hello(_), _, _)) => {
                            let _ = write_frame(&mut w, &Msg::Reject { reason: "wrong token".into() }, &Payload::None);
                            return;
                        }
                        _ => return,
                    };
                    let mut welcome = me.clone();
                    welcome.token.clear();
                    if write_frame(&mut w, &Msg::Welcome(welcome), &Payload::None).is_err() {
                        return;
                    }
                    run_conn(stream, conn, hello, false, addr, inbox, ev);
                });
            }
        });
    }

    /// Dial the coordinators of the config that are not connected (every 3 s)
    fn dial(&mut self) {
        if !self.cfg.enabled() || self.last_dial.is_some_and(|t| t.elapsed() < Duration::from_secs(3)) {
            return;
        }
        self.last_dial = Some(Instant::now());
        for addr in self.cfg.coordinators.clone() {
            // known box behind the address: this one itself, or already connected (in either direction)
            let known = self.self_addrs.contains(&addr) || self.addr_names.get(&addr).is_some_and(|n| self.peers.iter().any(|p| p.hello.name == *n));
            if known || self.dialing.contains(&addr) || self.peers.iter().any(|p| p.outbound && p.addr == addr) {
                continue;
            }
            self.dialing.insert(addr.clone());
            let conn = self.next_conn;
            self.next_conn += 1;
            let (ev, inbox) = (self.tx.clone(), self.inbox.clone());
            let mut me = self.me.clone();
            me.token = self.cfg.token.clone();
            thread::spawn(move || {
                let res = (|| -> Result<(TcpStream, Hello)> {
                    // host name or IP, the port is optional
                    let target = if addr.rsplit_once(':').is_some_and(|(_, p)| p.parse::<u16>().is_ok()) { addr.clone() } else { format!("{addr}:{DEFAULT_PORT}") };
                    // every resolved address in turn: names often resolve to IPv6 first while the coordinator
                    // listens on IPv4
                    let mut last = anyhow!("no address for {addr}");
                    let mut connected = None;
                    for sa in target.to_socket_addrs()? {
                        match TcpStream::connect_timeout(&sa, Duration::from_secs(3)) {
                            Ok(s) => {
                                connected = Some(s);
                                break;
                            }
                            Err(e) => last = e.into(),
                        }
                    }
                    let stream = connected.ok_or(last)?;
                    stream.set_read_timeout(Some(Duration::from_secs(45)))?;
                    let _ = stream.set_nodelay(true);
                    let mut w = stream.try_clone()?;
                    write_frame(&mut w, &Msg::Hello(me), &Payload::None)?;
                    let mut r = BufReader::new(stream.try_clone()?);
                    let mut seq = 0;
                    match read_frame(&mut r, &inbox, &mut seq)? {
                        (Msg::Welcome(h), _, _) => Ok((stream, h)),
                        (Msg::Reject { reason }, _, _) => bail!("rejected: {reason}"),
                        _ => bail!("unexpected answer"),
                    }
                })();
                match res {
                    Ok((stream, hello)) => run_conn(stream, conn, hello, true, addr, inbox, ev),
                    Err(e) => {
                        let _ = ev.send(NetEv::DialFailed { addr, error: format!("{e:#}") });
                    }
                }
            });
        }
    }

    /// One tick: dial, ping, collect events. The hub manages the connections itself
    pub fn poll(&mut self) -> Vec<HubEv> {
        self.dial();
        if self.last_ping.elapsed() > Duration::from_secs(10) {
            self.last_ping = Instant::now();
            for p in &self.peers {
                p.send(Msg::Ping, Payload::None);
            }
        }
        let mut out = Vec::new();
        while let Ok(ev) = self.rx.try_recv() {
            match ev {
                NetEv::Up { conn, mut hello, outbound, addr, tx, stream } => {
                    hello.token.clear();
                    if outbound {
                        self.dialing.remove(&addr);
                        self.dial_errors.remove(&addr);
                        self.addr_names.insert(addr.clone(), hello.name.clone());
                    }
                    // the list may hold this box itself: same host name and role = this process (a node on the coordinator's box is another one)
                    if hello.name == self.me.name && hello.role == self.me.role {
                        if outbound {
                            self.self_addrs.insert(addr.clone());
                        }
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    // duplicate connection: if both sides dialed, the one set up by the smaller name stays;
                    // otherwise the new one (the old one is then usually dead)
                    if let Some(i) = self.peers.iter().position(|p| p.hello.name == hello.name && p.hello.role == hello.role) {
                        let initiator = |ob: bool| if ob { self.me.name.clone() } else { hello.name.clone() };
                        let (new_init, old_init) = (initiator(outbound), initiator(self.peers[i].outbound));
                        let keep_new = new_init == old_init || new_init == self.me.name.clone().min(hello.name.clone());
                        if keep_new {
                            let old = self.peers.remove(i);
                            old.close();
                            out.push(HubEv::Down { conn: old.conn, name: old.hello.name, error: "replaced".into() });
                        } else {
                            let _ = stream.shutdown(Shutdown::Both);
                            continue;
                        }
                    }
                    self.peers.push(PeerConn { conn, hello, outbound, addr, tx, stream });
                    out.push(HubEv::Up { conn });
                }
                NetEv::Down { conn, error } => {
                    if let Some(i) = self.peers.iter().position(|p| p.conn == conn) {
                        let p = self.peers.remove(i);
                        p.close();
                        out.push(HubEv::Down { conn, name: p.hello.name, error });
                    }
                }
                NetEv::DialFailed { addr, error } => {
                    self.dialing.remove(&addr);
                    self.dial_errors.insert(addr, error);
                }
                NetEv::Msg { msg: Msg::Ping, .. } => {}
                NetEv::Msg { conn, msg, data, dir } => {
                    // repeated Hello (node after the addon update): take over the versions
                    if let Msg::Hello(h) = &msg {
                        if let Some(p) = self.peers.iter_mut().find(|p| p.conn == conn) {
                            p.hello = Hello { token: String::new(), ..h.clone() };
                        }
                    }
                    if self.peers.iter().any(|p| p.conn == conn) {
                        out.push(HubEv::Msg { conn, msg, data, dir });
                    } else if let Some(d) = dir {
                        let _ = fs::remove_dir_all(d);
                    }
                }
            }
        }
        out
    }

    pub fn close_all(&mut self) {
        for p in self.peers.drain(..) {
            p.close();
        }
    }

    pub fn peer(&self, conn: u64) -> Option<&PeerConn> {
        self.peers.iter().find(|p| p.conn == conn)
    }

    pub fn send(&self, conn: u64, msg: Msg, payload: Payload) {
        if let Some(p) = self.peer(conn) {
            p.send(msg, payload);
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_paths() {
        assert_eq!(safe_rel("a/b.png"), Some(PathBuf::from("a").join("b.png")));
        assert_eq!(safe_rel("../x"), None);
        assert_eq!(safe_rel("/etc/passwd"), None);
        assert_eq!(safe_rel("C:/x"), None);
        assert_eq!(safe_rel(""), None);
    }

    #[test]
    fn frames_roundtrip() {
        let dir = std::env::temp_dir().join(format!("packshot-net-{}", std::process::id()));
        let src = dir.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), "hallo").unwrap();
        fs::write(src.join("sub").join("b.bin"), vec![7u8; 100_000]).unwrap();
        let (files, paths) = collect_files(&src, "x/").unwrap();
        let mut buf = Vec::new();
        write_frame(&mut buf, &Msg::Block { id: 3, jobs: Vec::new(), files: files.clone() }, &Payload::Files(paths)).unwrap();
        write_frame(&mut buf, &Msg::Item { block: 3, item: 1, ok: true, info: "i".into() }, &Payload::Bytes(vec![1, 2, 3])).unwrap();
        let mut r = io::Cursor::new(buf);
        let mut seq = 0;
        let (msg, _, d) = read_frame(&mut r, &dir.join("in"), &mut seq).unwrap();
        assert!(matches!(msg, Msg::Block { id: 3, .. }));
        let d = d.unwrap();
        assert_eq!(fs::read_to_string(d.join("x").join("a.txt")).unwrap(), "hallo");
        assert_eq!(fs::read(d.join("x").join("sub").join("b.bin")).unwrap().len(), 100_000);
        let (msg, data, d) = read_frame(&mut r, &dir.join("in"), &mut seq).unwrap();
        assert!(matches!(msg, Msg::Item { item: 1, .. }) && data == vec![1, 2, 3] && d.is_none());
        fs::remove_dir_all(&dir).unwrap();
    }
}
