//! The Quartermaster web app's JSON API, called with the user's API token
//! (`Authorization: Bearer`, the "Access Key" from the web app). Every call
//! says the app's version (`X-QM-Companion`); an outdated app gets 426 with
//! the new release's links, which the frontend shows instead of working. Errors are
//! short codes the frontend translates (`noToken`, `invalidToken`,
//! `invalidServer`, …) or a message for anything else. Item thumbnails come from the server's public
//! `/thumbs/…` and are kept in the app's cache (`thumb`).

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine;
use reqwest::header::{ETAG, IF_NONE_MATCH};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The HTTP client, shared by all commands; it asks for gzip and unpacks it (the server gzips the catalog:
/// ~340 KB instead of ~2.5 MB per language). No total timeout: on a thin line the catalog takes longer than
/// any fixed limit; the connection must come up within 10 s and the answer may stall for 30 s at most.
pub fn client() -> Client {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .user_agent(concat!("QuartermasterCompanion/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("HTTP client")
}

/// The server's origin (`https://host[:port]`, no path, no trailing slash).
/// Plain http only for this machine, like the web app's own rule.
pub fn origin(server: &str) -> Result<String, String> {
    let url = Url::parse(server.trim()).map_err(|_| "invalidServer")?;
    let host = url.host_str().ok_or("invalidServer")?;
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        "http" => return Err("insecureServer".into()),
        _ => return Err("invalidServer".into()),
    }
    Ok(url.origin().ascii_serialization())
}

/// An API answer as received: the frontend reads `error` codes from the body.
#[derive(Debug, Serialize)]
pub struct ApiResponse {
    pub status: u16,
    pub body: Value,
    /// The answer's ETag, if it has one
    #[serde(skip)]
    pub etag: Option<String>,
}

/// One call to the web app's `/api/…` as the token's user; `if_none_match` = the ETag of a kept answer
/// (an unchanged one comes back as 304 without a body).
pub async fn api(client: &Client, origin: &str, token: &str, method: &str, path: &str, body: Option<Value>, if_none_match: Option<&str>) -> Result<ApiResponse, String> {
    if !path.starts_with("/api/") || path.contains("..") {
        return Err("invalidPath".into());
    }
    let method = match method {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => return Err("invalidMethod".into()),
    };
    if token.is_empty() {
        return Err("noToken".into());
    }
    let mut req = client
        .request(method, format!("{origin}{path}"))
        .bearer_auth(token)
        .header("X-QM-Companion", env!("CARGO_PKG_VERSION"));
    if let Some(body) = body {
        req = req.json(&body);
    }
    if let Some(tag) = if_none_match {
        req = req.header(IF_NONE_MATCH, tag);
    }
    let res = req.send().await.map_err(|e| {
        log::warn!("request failed: {e}");
        "network".to_string()
    })?;
    let status = res.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err("invalidToken".into());
    }
    let etag = res.headers().get(ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    Ok(ApiResponse { status: status.as_u16(), body, etag })
}

/// A GET answer kept on disk with its ETag.
#[derive(Serialize, Deserialize)]
struct Kept {
    etag: String,
    body: Value,
}

/// The file an API path's answer is kept in below `dir` (one per path and query).
fn kept_file(dir: &Path, path: &str) -> PathBuf {
    let name: String = path.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    dir.join(format!("{name}.json"))
}

/// The file an API path's answer is kept in and its ETag (the debug window); None for the ETag
/// without a readable file.
pub fn kept_etag(dir: &Path, path: &str) -> (PathBuf, Option<String>) {
    #[derive(Deserialize)]
    struct Etag {
        etag: String,
    }
    let file = kept_file(dir, path);
    let etag = std::fs::read(&file).ok().and_then(|bytes| serde_json::from_slice::<Etag>(&bytes).ok()).map(|k| k.etag);
    (file, etag)
}

/// A GET whose answer is kept in `dir` with its ETag (the catalog: ~2.5 MB per language, ~340 KB gzipped on the line): sent with
/// `If-None-Match`, a 304 answers the kept body as 200. The ETag hashes the content, so another server or
/// user can never get a wrong kept answer. A broken or unwritable file only costs the transfer.
pub async fn cached_api(client: &Client, origin: &str, token: &str, path: &str, dir: &Path) -> Result<ApiResponse, String> {
    let file = kept_file(dir, path);
    let kept: Option<Kept> = std::fs::read(&file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let mut res = api(client, origin, token, "GET", path, None, kept.as_ref().map(|k| k.etag.as_str())).await?;
    match (res.status, kept) {
        (304, Some(kept)) => {
            res.status = 200;
            res.body = kept.body;
        }
        (200, _) => {
            if let Some(etag) = res.etag.clone() {
                let bytes = serde_json::to_vec(&Kept { etag, body: res.body.clone() }).map_err(|e| e.to_string())?;
                if let Err(e) = std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&file, bytes)) {
                    log::warn!("{}: {e}", file.display());
                }
            }
        }
        _ => {}
    }
    Ok(res)
}

/// Downloads an update file of the server (`url` below its `/downloads/`)
/// with the token to `dest`: written to `<dest>.part` first, renamed when
/// complete (removed on failure). `progress(done, total)` gets the bytes so far.
/// The file is left as downloaded (no permission changes).
pub async fn download(
    client: &Client,
    origin: &str,
    token: &str,
    url: &str,
    dest: &Path,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<(), String> {
    if !url.starts_with(&format!("{origin}/downloads/")) {
        return Err("invalidServer".into());
    }
    if token.is_empty() {
        return Err("noToken".into());
    }
    // A large file on a slow line: far beyond the client's API timeout
    let mut res = client.get(url).bearer_auth(token).timeout(Duration::from_secs(30 * 60)).send().await.map_err(|e| {
        log::warn!("download failed: {e}");
        "network".to_string()
    })?;
    match res.status() {
        StatusCode::OK => {}
        StatusCode::UNAUTHORIZED => return Err("invalidToken".into()),
        status => return Err(format!("HTTP {}", status.as_u16())),
    }
    let total = res.content_length();
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let result = async {
        let mut file = File::create(&part).map_err(|e| format!("{}: {e}", part.display()))?;
        let mut done = 0;
        while let Some(chunk) = res.chunk().await.map_err(|e| {
            log::warn!("download failed: {e}");
            "network".to_string()
        })? {
            file.write_all(&chunk).map_err(|e| format!("{}: {e}", part.display()))?;
            done += chunk.len() as u64;
            progress(done, total);
        }
        file.flush().map_err(|e| format!("{}: {e}", part.display()))?;
        drop(file);
        std::fs::rename(&part, dest).map_err(|e| format!("{}: {e}", dest.display()))
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

// --- item thumbnails ---------------------------------------------------------------------------

/// The path of a thumbnail below the server's `/thumbs/` and the cache dir (`<size>/<uuid>.<hash>.avif`,
/// as `src/thumbs.ts` names it); None for anything but a size s|m|l, a catalog UUID and an 8-hex hash.
fn thumb_file(size: &str, uuid: &str, hash: &str) -> Option<String> {
    let uuid = uuid.to_ascii_lowercase();
    let hex = |s: &str| s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let groups: Vec<&str> = uuid.split('-').collect();
    let uuid_ok = groups.len() == 5 && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && hex(g));
    let hash_ok = hash.len() == 8 && hex(hash);
    (matches!(size, "s" | "m" | "l") && uuid_ok && hash_ok).then(|| format!("{size}/{uuid}.{hash}.avif"))
}

// Temp files of downloads running side by side (main window and overlay may ask for the same one)
static THUMB_PART: AtomicU64 = AtomicU64::new(0);

/// An item thumbnail as a `data:` URL (the webview's CSP allows those, not the server): from `dir` (the
/// app's cache) or, missing there, from the server's public `/thumbs/…` (no token: the web app serves
/// them to everyone), then kept in `dir` for good (a URL's content never changes; written to a temp file
/// first, renamed when complete).
pub async fn thumb(client: &Client, origin: &str, size: &str, uuid: &str, hash: &str, dir: &Path) -> Result<String, String> {
    let rel = thumb_file(size, uuid, hash).ok_or("invalidThumb")?;
    let file = dir.join(&rel);
    let bytes = match std::fs::read(&file) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => {
            let res = client.get(format!("{origin}/thumbs/{rel}")).send().await.map_err(|e| {
                log::debug!("thumbnail {rel}: {e}");
                "network".to_string()
            })?;
            if res.status() != StatusCode::OK {
                return Err(format!("HTTP {}", res.status().as_u16()));
            }
            let bytes = res.bytes().await.map_err(|_| "network".to_string())?.to_vec();
            if bytes.is_empty() {
                return Err("emptyThumb".into());
            }
            let part = file.with_extension(format!("{}.part", THUMB_PART.fetch_add(1, Ordering::Relaxed)));
            let kept = file
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| std::fs::write(&part, &bytes))
                .and_then(|()| std::fs::rename(&part, &file));
            if let Err(e) = kept {
                // Shown all the same; only fetched again next time
                log::warn!("{}: {e}", file.display());
                let _ = std::fs::remove_file(&part);
            }
            bytes
        }
    };
    Ok(format!("data:image/avif;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        assert_eq!(origin("https://qm.example.com/some/path/").unwrap(), "https://qm.example.com");
        assert_eq!(origin(" https://qm.example.com:8443 ").unwrap(), "https://qm.example.com:8443");
        assert_eq!(origin("http://localhost:5174").unwrap(), "http://localhost:5174");
        assert_eq!(origin("http://127.0.0.1:3002").unwrap(), "http://127.0.0.1:3002");
        assert_eq!(origin("http://qm.example.com").unwrap_err(), "insecureServer");
        assert_eq!(origin("ftp://qm.example.com").unwrap_err(), "invalidServer");
        assert_eq!(origin("qm.example.com").unwrap_err(), "invalidServer");
        assert_eq!(origin("").unwrap_err(), "invalidServer");
    }

    #[test]
    fn kept_files_per_path_and_query() {
        let dir = Path::new("cache");
        assert_eq!(kept_file(dir, "/api/catalog?lang=de"), dir.join("_api_catalog_lang_de.json"));
        assert_ne!(kept_file(dir, "/api/catalog?lang=de"), kept_file(dir, "/api/catalog?lang=en"));
    }

    #[test]
    fn thumb_files_only_for_valid_parts() {
        let uuid = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
        assert_eq!(thumb_file("s", uuid, "deadbeef").unwrap(), format!("s/{uuid}.deadbeef.avif"));
        assert_eq!(thumb_file("l", &uuid.to_uppercase(), "00ff00ff").unwrap(), format!("l/{uuid}.00ff00ff.avif"));
        for (size, uuid, hash) in [
            ("x", uuid, "deadbeef"),
            ("m", "../../etc", "deadbeef"),
            ("m", "0a1b2c3d-4e5f-6789-abcd-ef012345678", "deadbeef"),
            ("m", "0a1b2c3d4e5f-6789-abcd-ef0123456789-", "deadbeef"),
            ("m", uuid, "DEADBEEF"),
            ("m", uuid, "deadbee"),
            ("m", uuid, "deadbee/"),
        ] {
            assert_eq!(thumb_file(size, uuid, hash), None, "{size} {uuid} {hash}");
        }
    }
}
