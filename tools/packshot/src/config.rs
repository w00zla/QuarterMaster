// Cluster configuration: <store>/packshot.json (in the bundle next to the exe). Without a token there is no network:
// packshot then renders locally only. A coordinator (TUI) listens on `listen` and connects to the other coordinators
// in the list; a node (`packshot --node`) connects to all coordinators in the list and renders what they send it.
// Every box is known by its host name, which comes with the handshake; the list holds addresses only.
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

pub const DEFAULT_PORT: u16 = 47800;

#[derive(Deserialize, Clone, Default)]
pub struct NetConfig {
    /// this box's host name (not from the file)
    #[serde(skip)]
    pub name: String,
    /// shared secret of all machines; empty = no network
    #[serde(default)]
    pub token: String,
    /// what a coordinator listens on (default 0.0.0.0:47800)
    #[serde(default)]
    pub listen: String,
    /// the coordinators this machine connects to, host:port
    #[serde(default)]
    pub coordinators: Vec<String>,
}

impl NetConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let mut cfg: NetConfig = match fs::read(path) {
            Ok(b) => serde_json::from_slice(&b).with_context(|| path.display().to_string())?,
            Err(_) => NetConfig::default(),
        };
        cfg.name = sysinfo::System::host_name().ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "packshot".into());
        if cfg.listen.trim().is_empty() {
            cfg.listen = format!("0.0.0.0:{DEFAULT_PORT}");
        }
        Ok(cfg)
    }

    pub fn enabled(&self) -> bool {
        !self.token.trim().is_empty()
    }
}
