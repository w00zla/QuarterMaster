//! The server as a child process: `node <nodeFlags> server.mjs` with stdin and stdout piped (docs/singleuser.md "The app
//! bundle", "The start protocol", "Stdin control"). The command line and the environment are plain data (`spec`), so the
//! tests check them without starting anything.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::bundle::BundleInfo;
use crate::protocol::{parse_line, Line};

/// What the shell's IPC needs in the web app's `connect-src` and nothing more: the origin Tauri's custom protocol has on
/// this platform (docs/app.md "IPC and the Content-Security-Policy").
pub const CSP_CONNECT: &str = if cfg!(any(windows, target_os = "android")) { "http://ipc.localhost" } else { "ipc:" };

/// The server's variables the shell hands on from its own environment when they are set (development, tests).
pub const PASSED_THROUGH: [&str; 6] = ["QM_DATA_DIR", "QM_PORT", "QM_PAIRING_FILE", "QM_GAME_DIR", "QM_AUTO_UPDATE", "QM_DATA_FEED"];

/// How long a stop waits for the server to end by itself before it is killed.
pub const STOP_WAIT: Duration = Duration::from_secs(10);

/// The child's command line and what changes in its environment (everything else is inherited).
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Variables set for the child.
    pub set: Vec<(String, String)>,
    /// Inherited variables the child must not see.
    pub remove: Vec<String>,
}

/// The node executable beside the app's own (Tauri puts an `externalBin` there, without the target triple).
pub fn node_path(app_exe: &Path) -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    app_exe.parent().unwrap_or(Path::new(".")).join(name)
}

/// `node <nodeFlags> server.mjs` in the bundle folder. Of the shell's own environment (`inherited`: the variable names)
/// the child gets no `QM_*` variable but the six of `PASSED_THROUGH`, and no `NODE_OPTIONS`.
pub fn spec(node: &Path, bundle: &Path, info: &BundleInfo, inherited: &[String]) -> Spec {
    let path = |p: PathBuf| p.to_string_lossy().into_owned();
    let mut args = info.node_flags.clone();
    args.push(path(bundle.join("server.mjs")));
    let set = vec![
        ("QM_MIGRATIONS_DIR".to_string(), path(bundle.join("drizzle"))),
        ("QM_DIST_DIR".to_string(), path(bundle.join("web"))),
        ("QM_STDIN_CONTROL".to_string(), "1".to_string()),
        ("QM_CSP_CONNECT".to_string(), CSP_CONNECT.to_string()),
    ];
    let remove = inherited
        .iter()
        .filter(|name| {
            let upper = name.to_ascii_uppercase();
            upper == "NODE_OPTIONS" || (upper.starts_with("QM_") && !PASSED_THROUGH.contains(&upper.as_str()) && !set.iter().any(|(k, _)| k == *name))
        })
        .cloned()
        .collect();
    Spec { program: node.to_path_buf(), args, cwd: bundle.to_path_buf(), set, remove }
}

/// The running server. One per app; `stop` is safe to call from every exit path, any number of times.
#[derive(Default)]
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    stopping: Arc<AtomicBool>,
}

impl Sidecar {
    /// Starts the child. `on_line` gets every protocol line of its stdout (in order, from a thread of its own);
    /// `on_end` is called once when stdout ends, with `true` when the shell asked for the stop. Everything else the child
    /// prints goes to the log.
    pub fn start(&self, spec: &Spec, on_line: impl Fn(Line) + Send + 'static, on_end: impl FnOnce(bool) + Send + 'static) -> Result<(), String> {
        let mut command = Command::new(&spec.program);
        command.args(&spec.args).current_dir(&spec.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for name in &spec.remove {
            command.env_remove(name);
        }
        for (name, value) in &spec.set {
            command.env(name, value);
        }
        #[cfg(windows)]
        {
            // node.exe is a console program: without this a console window would open beside the app
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|e| format!("{}: {e}", spec.program.display()))?;
        log::info!("server: started (process {})", child.id());
        let stdout = child.stdout.take().ok_or("server: no stdout")?;
        let stderr = child.stderr.take().ok_or("server: no stderr")?;
        *self.stdin.lock().unwrap() = child.stdin.take();
        *self.child.lock().unwrap() = Some(child);
        self.stopping.store(false, Ordering::SeqCst);

        std::thread::spawn(move || {
            for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
                log::warn!(target: "server", "{}", String::from_utf8_lossy(&line).trim_end());
            }
        });
        let stopping = self.stopping.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
                let text = String::from_utf8_lossy(&line);
                match parse_line(&text) {
                    Line::Log => log::info!(target: "server", "{}", text.trim_end()),
                    line => {
                        log::info!(target: "server", "{}", text.trim_end());
                        on_line(line);
                    }
                }
            }
            on_end(stopping.load(Ordering::SeqCst));
        });
        Ok(())
    }

    /// The clean stop: the line `stop` on stdin, then up to `wait` for the process to end, then it is killed. Returns
    /// when the process is gone. Nothing to do when none runs.
    pub fn stop(&self, wait: Duration) {
        self.stopping.store(true, Ordering::SeqCst);
        let Some(mut child) = self.child.lock().unwrap().take() else { return };
        if let Some(mut stdin) = self.stdin.lock().unwrap().take() {
            // A failing write means the process is already going; dropping stdin closes it, which stops the server too
            let _ = stdin.write_all(b"stop\n").and_then(|()| stdin.flush());
        }
        let deadline = Instant::now() + wait;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    log::info!("server: ended ({status})");
                    return;
                }
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
                _ => break,
            }
        }
        log::warn!("server: did not end within {} s, killing it", wait.as_secs());
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::parse_bundle_info;

    fn info() -> BundleInfo {
        parse_bundle_info(
            r#"{ "app": { "version": "0.1.0" }, "node": { "version": "26.13.0" },
                 "nodeFlags": ["--max-semi-space-size=1", "--max-old-space-size=192"],
                 "startTexts": { "de": { "starting": "a", "languagePack": "b" }, "en": { "starting": "c", "languagePack": "d" } } }"#,
        )
        .unwrap()
    }

    #[test]
    fn the_command_line_is_node_flags_server() {
        let bundle = Path::new("res").join("server");
        let got = spec(Path::new("bin/node.exe"), &bundle, &info(), &[]);
        assert_eq!(got.program, Path::new("bin/node.exe"));
        assert_eq!(got.args, ["--max-semi-space-size=1".to_string(), "--max-old-space-size=192".to_string(), bundle.join("server.mjs").to_string_lossy().into_owned()]);
        assert_eq!(got.cwd, bundle);
    }

    #[test]
    fn the_environment_is_the_contracts() {
        let bundle = Path::new("res").join("server");
        let got = spec(Path::new("node"), &bundle, &info(), &[]);
        let value = |name: &str| got.set.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
        assert_eq!(value("QM_MIGRATIONS_DIR"), Some(bundle.join("drizzle").to_string_lossy().into_owned()));
        assert_eq!(value("QM_DIST_DIR"), Some(bundle.join("web").to_string_lossy().into_owned()));
        assert_eq!(value("QM_STDIN_CONTROL").as_deref(), Some("1"));
        assert_eq!(value("QM_CSP_CONNECT").as_deref(), Some(CSP_CONNECT));
        assert_eq!(got.set.len(), 4, "nothing else is set");
        assert!(got.remove.is_empty());
        // One plain source expression, as the server's check wants it
        assert!(CSP_CONNECT.chars().all(|c| c.is_ascii_alphanumeric() || ":/.".contains(c)));
    }

    #[test]
    fn only_the_six_development_variables_pass_through() {
        let inherited: Vec<String> = [
            "PATH", "LOCALAPPDATA", "QM_DATA_DIR", "QM_PORT", "QM_PAIRING_FILE", "QM_GAME_DIR", "QM_AUTO_UPDATE", "QM_DATA_FEED",
            "QM_UEX_KEY", "QM_THUMBS_DIR", "qm_csp_connect", "QM_CSP_CONNECT", "QM_APP_FEED", "QM_APP_BUNDLE", "NODE_OPTIONS", "Node_Options",
        ]
        .map(String::from)
        .to_vec();
        let got = spec(Path::new("node"), Path::new("b"), &info(), &inherited);
        // QM_CSP_CONNECT is set anyway (the shell's value replaces an inherited one); a differently cased name is removed
        assert_eq!(got.remove, ["QM_UEX_KEY", "QM_THUMBS_DIR", "qm_csp_connect", "QM_APP_FEED", "QM_APP_BUNDLE", "NODE_OPTIONS", "Node_Options"]);
    }

    #[test]
    fn node_sits_beside_the_app() {
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        assert_eq!(node_path(&Path::new("dir").join("quartermaster.exe")), Path::new("dir").join(name));
    }
}
