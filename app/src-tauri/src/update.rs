//! App updates (docs/app.md "Updates and channels"): the channels, the feed per channel, the check, the download and
//! install with the state the web app's dialog shows (`UpdateState`, event `update-changed`). The updater plugin's own
//! IPC commands are not used: only this side picks the endpoint per check.
//!
//! `channels.json` on the repository's `channels` branch holds, for the product `app`, the stable tag and the channels:
//! `{ "app": { "stable": "app-v1.0.0", "channels": [{ "id": "beta", "tag": "app-v1.1.0-beta.1" }] } }`. A check reads
//! it, takes the tag of the channel in effect and asks that release's `latest.json` (Tauri's updater format). No file,
//! no `app` entry or no tag for the channel is "no update", never an error. No channel chosen = the running build's own
//! channel (a build of `1.1.0-beta.1` follows `beta`), else stable. Only a newer version is offered, except right after
//! the user switched channels: then any other version is, so leaving a channel for a lower stable works.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::texts::Lang;

pub const STABLE: &str = "stable";
/// The event the web app listens to; its payload is the `UpdateState`.
pub const UPDATE_EVENT: &str = "update-changed";
/// Tests and development: `http://127.0.0.1:<port>[/path]` serving `channels.json` and `<tag>/latest.json` instead of GitHub.
pub const FEED_ENV: &str = "QM_APP_FEED";
/// The one place the feed's addresses come from.
const GITHUB_REPO: &str = "w00zla/quartermaster";
const PRODUCT: &str = "app";
const TAG_PREFIX: &str = "app-v";
/// One request of a check (channels.json, latest.json).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// The whole download of an update.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// Where `channels.json` and the releases' files are read.
#[derive(Debug, Clone, PartialEq)]
pub struct Feed {
    channels: String,
    releases: String,
}

impl Feed {
    pub fn github() -> Feed {
        Feed {
            channels: format!("https://raw.githubusercontent.com/{GITHUB_REPO}/channels/channels.json"),
            releases: format!("https://github.com/{GITHUB_REPO}/releases/download"),
        }
    }

    /// GitHub, or the override: only plain `http://127.0.0.1:<port>` (with an optional path) is taken, so the variable
    /// can never send a check to another machine or downgrade the real feed to http.
    pub fn from_env(value: Option<&str>) -> Result<Feed, String> {
        let Some(value) = value.filter(|v| !v.is_empty()) else { return Ok(Feed::github()) };
        let refuse = || format!("{FEED_ENV}: {value:?} is not http://127.0.0.1:<port>");
        let url = reqwest::Url::parse(value).map_err(|_| refuse())?;
        if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() || url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() {
            return Err(refuse());
        }
        let base = value.trim_end_matches('/');
        Ok(Feed { channels: format!("{base}/channels.json"), releases: base.to_string() })
    }

    pub fn channels_url(&self) -> &str {
        &self.channels
    }

    /// The `latest.json` of a release.
    pub fn latest(&self, tag: &str) -> String {
        format!("{}/{tag}/latest.json", self.releases)
    }
}

/// A channel the dialog offers.
#[derive(Debug, Clone, PartialEq)]
pub struct Channel {
    pub id: String,
    /// The tag of the channel's newest release; `None`: nothing published for it (stable before the first release).
    pub tag: Option<String>,
}

/// A channel id: what a semver pre-release identifier takes, and nothing that needs escaping in a URL.
pub fn valid_channel_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 32 && id != STABLE && chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The channel a version belongs to: `1.1.0-beta.2` -> `beta`; `None` for a stable version or anything that is not
/// `x.y.z-<id>.<n>`.
pub fn channel_of(version: &str) -> Option<String> {
    let v = semver::Version::parse(version).ok()?;
    let (id, n) = v.pre.as_str().rsplit_once('.')?;
    (valid_channel_id(id) && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && v.build.is_empty()).then(|| id.to_string())
}

/// The version of an app tag (`app-v1.2.3`, `app-v1.2.3-beta.1`); `None` for anything else, another product's tag included.
fn tag_version(tag: &str) -> Option<semver::Version> {
    semver::Version::parse(tag.strip_prefix(TAG_PREFIX)?).ok().filter(|v| v.build.is_empty())
}

/// The channels of a `channels.json`, stable first (always there, with its tag if the file names a valid one). A channel
/// whose id is not a channel id or whose tag is not `app-v<x.y.z>-<id>.<n>` is dropped (logged); a repeated id keeps its
/// first entry. A file without the `app` product gives stable alone, without a tag.
pub fn parse_channels(json: &serde_json::Value) -> Vec<Channel> {
    let product = json.get(PRODUCT);
    let stable = product.and_then(|p| p.get("stable")).and_then(|v| v.as_str());
    let stable_tag = stable.filter(|tag| tag_version(tag).is_some_and(|v| v.pre.is_empty()));
    if stable.is_some() && stable_tag.is_none() {
        log::warn!("channels.json: stable tag {stable:?} skipped (not {TAG_PREFIX}<x.y.z>)");
    }
    let mut out = vec![Channel { id: STABLE.into(), tag: stable_tag.map(String::from) }];
    for entry in product.and_then(|p| p.get("channels")).and_then(|c| c.as_array()).into_iter().flatten() {
        let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let tag = entry.get("tag").and_then(|v| v.as_str()).unwrap_or_default();
        let version = tag_version(tag).map(|v| v.to_string()).unwrap_or_default();
        if !valid_channel_id(id) || channel_of(&version).as_deref() != Some(id) {
            log::warn!("channels.json: entry {entry} skipped (id or tag invalid)");
            continue;
        }
        if out.iter().any(|c| c.id == id) {
            continue;
        }
        out.push(Channel { id: id.into(), tag: Some(tag.into()) });
    }
    out
}

/// The channel a check reads: the chosen one while `channels.json` lists it, else the running build's own channel if
/// listed, else stable (a channel that vanished sends its users back to stable).
pub fn resolve<'a>(chosen: &str, channels: &'a [Channel], build: Option<&str>) -> &'a Channel {
    let find = |id: &str| channels.iter().find(|c| c.id == id);
    find(chosen).or_else(|| build.and_then(find)).or_else(|| find(STABLE)).unwrap_or(&channels[0])
}

/// Whether the feed's version is offered: a newer one, or right after a channel switch any other one.
pub fn is_offered(feed: &semver::Version, current: &semver::Version, switched: bool) -> bool {
    if switched {
        feed != current
    } else {
        feed > current
    }
}

/// What `update_state` answers and `update-changed` carries (webapp/src/shellLogic.ts `UpdateState`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UpdateState {
    pub state: Phase,
    pub current: String,
    pub available: Option<String>,
    pub notes: Option<String>,
    pub progress: Option<f64>,
    pub error: Option<String>,
    pub channel: String,
    pub channels: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Installing,
    Error,
}

impl Phase {
    fn busy(self) -> bool {
        matches!(self, Phase::Checking | Phase::Downloading | Phase::Installing)
    }
}

/// The state before anything was asked: no request was made, so only stable and the channel in effect are known.
pub fn initial_state(current: &str, chosen: &str) -> UpdateState {
    let build = channel_of(current);
    let channel = if chosen == STABLE {
        STABLE.to_string()
    } else if valid_channel_id(chosen) {
        chosen.to_string()
    } else {
        build.unwrap_or_else(|| STABLE.to_string())
    };
    let mut channels = vec![STABLE.to_string()];
    if channel != STABLE {
        channels.push(channel.clone());
    }
    UpdateState { state: Phase::Idle, current: current.into(), available: None, notes: None, progress: None, error: None, channel, channels }
}

/// The updater: the state, the update the last check found (kept for the install) and the chosen channel.
pub struct Updater {
    feed: Result<Feed, String>,
    lang: Lang,
    inner: Mutex<Inner>,
}

struct Inner {
    state: UpdateState,
    found: Option<Update>,
    /// The channel the user chose; empty: none (the build's own channel, else stable).
    chosen: String,
}

impl Updater {
    pub fn new(current: &str, chosen: String, feed: Result<Feed, String>, lang: Lang) -> Updater {
        Updater { feed, lang, inner: Mutex::new(Inner { state: initial_state(current, &chosen), found: None, chosen }) }
    }

    pub fn state(&self) -> UpdateState {
        self.inner.lock().unwrap().state.clone()
    }

    /// Changes the state and tells the web app.
    fn set(&self, app: &AppHandle, change: impl FnOnce(&mut UpdateState)) {
        let state = {
            let mut inner = self.inner.lock().unwrap();
            change(&mut inner.state);
            inner.state.clone()
        };
        let _ = app.emit(UPDATE_EVENT, state);
    }

    fn fail(&self, app: &AppHandle, error: String) {
        log::warn!("update: {error}");
        self.set(app, |s| {
            s.state = Phase::Error;
            s.progress = None;
            s.error = Some(error);
        });
    }

    /// Takes the busy slot for a check; false when a check, a download or an install runs.
    fn begin(&self, app: &AppHandle, phase: Phase) -> bool {
        if self.inner.lock().unwrap().state.state.busy() {
            return false;
        }
        self.set(app, |s| {
            s.state = phase;
            s.error = None;
            s.progress = None;
        });
        true
    }
}

/// Whether this installation updates itself: only the Windows installer's and the Linux AppImage's (the bundler stamps
/// the executable it packs). A bare executable or a distribution's package only compares versions.
pub fn updater_available() -> bool {
    use tauri::utils::config::BundleType;
    matches!(tauri::utils::platform::bundle_type(), Some(BundleType::Nsis | BundleType::AppImage))
}

/// GET a JSON document; `Ok(None)` for 404 (the file does not exist: not an error for `channels.json`).
async fn get_json(url: &str) -> Result<Option<serde_json::Value>, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("Quartermaster/", env!("CARGO_PKG_VERSION")))
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let text = response.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
}

/// Checks the feed of the channel in effect. `switched`: the user just picked another channel. Returns whether a
/// version waits to be installed. Does nothing (false) while another operation runs.
pub async fn check(app: &AppHandle, switched: bool) -> bool {
    let updater = app.state::<Updater>();
    if !updater.begin(app, Phase::Checking) {
        return false;
    }
    match run_check(app, &updater, switched).await {
        Ok(Some(update)) => {
            log::info!("update check: {} available", update.version);
            updater.inner.lock().unwrap().found = Some(update.clone());
            updater.set(app, |s| {
                s.state = Phase::Available;
                s.available = Some(update.version.clone());
                s.notes = update.body.clone().map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
            });
            true
        }
        Ok(None) => {
            log::info!("update check: nothing newer");
            updater.inner.lock().unwrap().found = None;
            updater.set(app, |s| {
                s.state = Phase::Current;
                s.available = None;
                s.notes = None;
            });
            false
        }
        Err(e) => {
            updater.inner.lock().unwrap().found = None;
            updater.fail(app, e);
            false
        }
    }
}

async fn run_check(app: &AppHandle, updater: &Updater, switched: bool) -> Result<Option<Update>, String> {
    let feed = updater.feed.clone()?;
    let current = env!("CARGO_PKG_VERSION");
    let chosen = updater.inner.lock().unwrap().chosen.clone();
    // No file yet: stable alone, without a release
    let channels = match get_json(feed.channels_url()).await.map_err(|e| format!("channel list: {e}"))? {
        Some(json) => parse_channels(&json),
        None => parse_channels(&serde_json::Value::Null),
    };
    let channel = resolve(&chosen, &channels, channel_of(current).as_deref()).clone();
    updater.set(app, |s| {
        s.channel = channel.id.clone();
        s.channels = channels.iter().map(|c| c.id.clone()).collect();
    });
    let Some(tag) = channel.tag else { return Ok(None) };
    let url = feed.latest(&tag);
    log::info!("update check: channel {}, {url}", channel.id);

    if !updater_available() {
        // Nothing here can install it: compare by hand and say so
        let latest = get_json(&url).await?.ok_or("the release has no latest.json")?;
        let version = latest.get("version").and_then(|v| v.as_str()).and_then(|v| semver::Version::parse(v.trim_start_matches('v')).ok()).ok_or("latest.json without a version")?;
        let running = semver::Version::parse(current).map_err(|e| e.to_string())?;
        return if is_offered(&version, &running, switched) { Err(updater.lang.cannot_update(&version.to_string())) } else { Ok(None) };
    }
    let sidecar_app = app.clone();
    let plugin = app
        .updater_builder()
        .endpoints(vec![url.parse().map_err(|e| format!("{url}: {e}"))?])
        .map_err(|e| e.to_string())?
        .version_comparator(move |current, remote| is_offered(&remote.version, &current, switched))
        .timeout(REQUEST_TIMEOUT)
        // Windows: the installer is about to run and the app to exit; the server must be gone before node.exe is replaced
        .on_before_exit(move || crate::stop_server(&sidecar_app))
        .build()
        .map_err(|e| e.to_string())?;
    let mut found = plugin.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = found.as_mut() {
        // The check's limit must not cut the download
        update.timeout = Some(DOWNLOAD_TIMEOUT);
    }
    Ok(found)
}

/// Downloads and installs the version the last check found, then restarts into it. Returns only when it failed (the
/// state is `error` then) or when there was nothing to install.
pub async fn install(app: &AppHandle) {
    let updater = app.state::<Updater>();
    let Some(update) = updater.inner.lock().unwrap().found.clone() else {
        updater.fail(app, "no update was found yet".into());
        return;
    };
    if !updater.begin(app, Phase::Downloading) {
        return;
    }
    log::info!("update {}: downloading", update.version);
    let mut downloaded: u64 = 0;
    let mut shown: i64 = -1;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                // One event per percent, not one per chunk
                let Some(total) = total.filter(|t| *t > 0) else { return };
                let share = (downloaded as f64 / total as f64).min(1.0);
                let percent = (share * 100.0) as i64;
                if percent != shown {
                    shown = percent;
                    updater.set(app, |s| s.progress = Some(share));
                }
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(e) => return updater.fail(app, e.to_string()),
    };
    log::info!("update {}: installing", update.version);
    updater.set(app, |s| {
        s.state = Phase::Installing;
        s.progress = None;
    });
    // Windows: runs the installer and exits the process (the server is stopped in `on_before_exit`)
    if let Err(e) = update.install(bytes) {
        return updater.fail(app, e.to_string());
    }
    crate::stop_server(app);
    app.restart();
}

/// Saves the chosen channel; the caller checks it at once (with `switched`: any other version than the running one is
/// offered). Refused while a check, a download or an install runs.
pub fn choose_channel(app: &AppHandle, id: &str) -> Result<(), String> {
    if id != STABLE && !valid_channel_id(id) {
        return Err(format!("{id:?} is not a channel"));
    }
    let updater = app.state::<Updater>();
    if updater.inner.lock().unwrap().state.state.busy() {
        return Err("an update operation is running".into());
    }
    crate::config::save_channel(&crate::config::config_file(app), id)?;
    {
        let mut inner = updater.inner.lock().unwrap();
        inner.chosen = id.to_string();
        inner.found = None;
    }
    updater.set(app, |s| {
        s.channel = id.to_string();
        if !s.channels.iter().any(|c| c == id) {
            s.channels.push(id.to_string());
        }
        s.available = None;
        s.notes = None;
    });
    Ok(())
}

/// A check that was given up (the time limit at start): the state is as before any check, so a later one can run.
pub fn abandon(app: &AppHandle) {
    let updater = app.state::<Updater>();
    updater.set(app, |s| {
        if s.state == Phase::Checking {
            s.state = Phase::Idle;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(text: &str) -> semver::Version {
        semver::Version::parse(text).unwrap()
    }

    #[test]
    fn the_feed_is_github_or_a_local_server() {
        let github = Feed::from_env(None).unwrap();
        assert_eq!(github.channels_url(), "https://raw.githubusercontent.com/w00zla/quartermaster/channels/channels.json");
        assert_eq!(github.latest("app-v1.0.0"), "https://github.com/w00zla/quartermaster/releases/download/app-v1.0.0/latest.json");
        assert_eq!(Feed::from_env(Some("")).unwrap(), github);

        let local = Feed::from_env(Some("http://127.0.0.1:4010/feed/")).unwrap();
        assert_eq!(local.channels_url(), "http://127.0.0.1:4010/feed/channels.json");
        assert_eq!(local.latest("app-v1.1.0-beta.1"), "http://127.0.0.1:4010/feed/app-v1.1.0-beta.1/latest.json");
        assert_eq!(Feed::from_env(Some("http://127.0.0.1:4010")).unwrap().channels_url(), "http://127.0.0.1:4010/channels.json");

        for bad in ["https://127.0.0.1:4010", "http://example.com:4010", "http://localhost:4010", "http://127.0.0.1", "http://127.0.0.1:4010/?x=1", "http://u@127.0.0.1:4010", "C:/feed", "nonsense"] {
            assert!(Feed::from_env(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn channel_ids_and_versions() {
        assert!(valid_channel_id("beta"));
        assert!(valid_channel_id("new-finder2"));
        for bad in ["", "stable", "Beta", "1st", "a/b", "a.b", "a_b", &"x".repeat(33)] {
            assert!(!valid_channel_id(bad), "{bad}");
        }
        assert_eq!(channel_of("1.1.0-beta.2").as_deref(), Some("beta"));
        assert_eq!(channel_of("1.1.0-new-finder.12").as_deref(), Some("new-finder"));
        for none in ["1.0.0", "1.1.0-beta", "1.1.0-beta.x", "1.1.0-Beta.1", "1.1.0-beta.1+b", "v1.1.0-beta.1", "nope"] {
            assert_eq!(channel_of(none), None, "{none}");
        }
    }

    #[test]
    fn channels_json_is_read_for_the_app_product() {
        let json = json!({
            "app": { "stable": "app-v1.0.0", "channels": [
                { "id": "beta", "tag": "app-v1.1.0-beta.1" },
                { "id": "finder", "tag": "app-v1.2.0-finder.3" },
                { "id": "beta", "tag": "app-v1.1.0-beta.9" },
                { "id": "stable", "tag": "app-v1.1.0-stable.1" },
                { "id": "evil", "tag": "app-v1.1.0-other.1" },
                { "id": "evil", "tag": "../../x" },
                { "id": "comp", "tag": "companion-v2.2.0-comp.1" },
                { "id": "bare", "tag": "v1.1.0-bare.1" },
                { "id": "notag" },
                "junk"
            ] },
            "companion": { "stable": "companion-v2.1.0", "channels": [{ "id": "other", "tag": "companion-v2.2.0-other.1" }] },
            "data": { "stable": "data-4.10.2.12913470-2" }
        });
        let got = parse_channels(&json);
        assert_eq!(got, [
            Channel { id: "stable".into(), tag: Some("app-v1.0.0".into()) },
            Channel { id: "beta".into(), tag: Some("app-v1.1.0-beta.1".into()) },
            Channel { id: "finder".into(), tag: Some("app-v1.2.0-finder.3".into()) },
        ]);
    }

    #[test]
    fn a_missing_file_or_entry_is_no_update() {
        let stable_alone = [Channel { id: "stable".into(), tag: None }];
        // No file at all (404), a file without the product, a product without a stable tag, a stable tag that is not one
        assert_eq!(parse_channels(&serde_json::Value::Null), stable_alone);
        assert_eq!(parse_channels(&json!({ "data": { "stable": "data-4.10.2.12913470-2" } })), stable_alone);
        assert_eq!(parse_channels(&json!({ "app": {} })), stable_alone);
        assert_eq!(parse_channels(&json!({ "app": { "stable": "data-4.10.2.12913470-2" } })), stable_alone);
        assert_eq!(parse_channels(&json!({ "app": { "stable": "app-v1.1.0-beta.1" } })), stable_alone);
        assert_eq!(parse_channels(&json!([1, 2])), stable_alone);
        // The channel in effect has no tag: nothing to ask
        assert_eq!(resolve("", &stable_alone, None).tag, None);
        // Channels without a stable release still work
        let got = parse_channels(&json!({ "app": { "channels": [{ "id": "beta", "tag": "app-v1.1.0-beta.1" }] } }));
        assert_eq!(got[0], stable_alone[0]);
        assert_eq!(resolve("beta", &got, None).tag.as_deref(), Some("app-v1.1.0-beta.1"));
    }

    #[test]
    fn resolve_prefers_choice_then_build_then_stable() {
        let list = parse_channels(&json!({ "app": { "stable": "app-v1.0.0", "channels": [{ "id": "beta", "tag": "app-v1.1.0-beta.2" }] } }));
        assert_eq!(resolve("beta", &list, None).id, "beta");
        assert_eq!(resolve("stable", &list, Some("beta")).id, "stable");
        // Nothing chosen: the build's own channel, else stable
        assert_eq!(resolve("", &list, Some("beta")).id, "beta");
        assert_eq!(resolve("", &list, None).id, "stable");
        // A channel that vanished: back to stable (or to the build's own, if that is still listed)
        assert_eq!(resolve("gone", &list, None).id, "stable");
        assert_eq!(resolve("gone", &list, Some("gone")).id, "stable");
        assert_eq!(resolve("gone", &list, Some("beta")).id, "beta");
    }

    #[test]
    fn offered_versions() {
        assert!(is_offered(&v("1.1.0"), &v("1.0.0"), false));
        assert!(!is_offered(&v("1.0.0"), &v("1.0.0"), false));
        assert!(!is_offered(&v("0.9.2"), &v("1.0.0"), false));
        // A channel version is below its final, and above the stable line it builds on
        assert!(is_offered(&v("1.1.0"), &v("1.1.0-beta.2"), false));
        assert!(is_offered(&v("1.1.0-beta.3"), &v("1.1.0-beta.2"), false));
        assert!(!is_offered(&v("1.0.4"), &v("1.1.0-beta.2"), false));
        // Right after a switch any other version, never the same one
        assert!(is_offered(&v("1.0.4"), &v("1.1.0-beta.2"), true));
        assert!(!is_offered(&v("1.0.4"), &v("1.0.4"), true));
    }

    #[test]
    fn the_state_before_any_request() {
        let stable = initial_state("1.0.0", "");
        assert_eq!((stable.state, stable.channel.as_str(), stable.channels.clone()), (Phase::Idle, "stable", vec!["stable".to_string()]));
        assert_eq!((stable.available, stable.notes, stable.progress, stable.error), (None, None, None, None));
        assert_eq!(stable.current, "1.0.0");
        // A channel build follows its channel; a choice wins over it
        let build = initial_state("1.1.0-beta.1", "");
        assert_eq!((build.channel.as_str(), build.channels), ("beta", vec!["stable".to_string(), "beta".to_string()]));
        assert_eq!(initial_state("1.1.0-beta.1", "stable").channel, "stable");
        assert_eq!(initial_state("1.0.0", "finder").channels, ["stable", "finder"]);
        assert_eq!(initial_state("1.0.0", "Not A Channel").channel, "stable");
    }

    #[test]
    fn the_state_serializes_as_the_contract_says() {
        let mut state = initial_state("1.0.0", "");
        state.state = Phase::Downloading;
        state.available = Some("1.1.0".into());
        state.progress = Some(0.5);
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json, json!({
            "state": "downloading", "current": "1.0.0", "available": "1.1.0", "notes": null, "progress": 0.5, "error": null,
            "channel": "stable", "channels": ["stable"]
        }));
        for (phase, text) in [(Phase::Idle, "idle"), (Phase::Checking, "checking"), (Phase::Current, "current"), (Phase::Available, "available"), (Phase::Installing, "installing"), (Phase::Error, "error")] {
            assert_eq!(serde_json::to_value(phase).unwrap(), text);
        }
    }

    #[test]
    fn the_app_version_is_the_packages() {
        // One version for the whole app: the shell's (Cargo.toml) is the root package.json's, which the server bundle carries
        let package: serde_json::Value = serde_json::from_str(include_str!("../../../package.json")).unwrap();
        assert_eq!(package["version"], env!("CARGO_PKG_VERSION"));
    }
}
