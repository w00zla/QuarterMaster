//! The Quartermaster API, called on one of two servers (`Target`): the online web app with the user's API token
//! (`Authorization: Bearer`, the "Access Key" from the web app) or the Quartermaster app on this PC (no token, found
//! through its pairing file, `pairing.rs`). Every call says the app's version (`X-QM-Companion`, a label) and the API
//! contract number it was built for (`X-QM-Companion-Api`, handed in by the frontend: the one constant lives in
//! `src/webapp/api-types.ts`); a number outside the server's range gets 426 or 409, which the frontend shows instead
//! of working. Errors are short codes the frontend translates (`noToken`, `invalidToken`, `invalidServer`,
//! `noLocalApp`, …) or a message for anything else. Item thumbnails come from the server's public `/thumbs/…` and
//! are kept in the app's cache (`thumb`); the game's English texts from `/api/companion/locale` are kept there too
//! (`cached_text`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine;
use reqwest::header::{ETAG, IF_NONE_MATCH};
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode, Url};
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

/// The server the calls go to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// `https://host[:port]`, or the local app's `http://127.0.0.1:<port>`
    pub origin: String,
    /// The user's API token; None = the local app (its API takes none)
    pub token: Option<String>,
}

/// A request of the companion: both companion headers always, the token only for the online server.
fn request(client: &Client, target: &Target, api_number: u32, method: Method, path: &str) -> RequestBuilder {
    let req = client
        .request(method, format!("{}{path}", target.origin))
        .header("X-QM-Companion", env!("CARGO_PKG_VERSION"))
        .header("X-QM-Companion-Api", api_number);
    match &target.token {
        Some(token) => req.bearer_auth(token),
        None => req,
    }
}

/// Sends one call to the server's `/api/…`; `if_none_match` = the ETag of a kept answer (an unchanged one comes
/// back as 304 without a body). A local app that does not answer is `noLocalApp` (a stale pairing file after a
/// crash: connection refused).
async fn send(client: &Client, target: &Target, api_number: u32, method: &str, path: &str, body: Option<Value>, if_none_match: Option<&str>) -> Result<Response, String> {
    if !path.starts_with("/api/") || path.contains("..") {
        return Err("invalidPath".into());
    }
    let method = match method {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => return Err("invalidMethod".into()),
    };
    if target.token.as_deref() == Some("") {
        return Err("noToken".into());
    }
    let mut req = request(client, target, api_number, method, path);
    if let Some(body) = body {
        req = req.json(&body);
    }
    if let Some(tag) = if_none_match {
        req = req.header(IF_NONE_MATCH, tag);
    }
    let res = req.send().await.map_err(|e| {
        log::warn!("request failed: {e}");
        if target.token.is_none() { "noLocalApp" } else { "network" }.to_string()
    })?;
    if res.status() == StatusCode::UNAUTHORIZED {
        return Err("invalidToken".into());
    }
    Ok(res)
}

fn etag_of(res: &Response) -> Option<String> {
    res.headers().get(ETAG).and_then(|v| v.to_str().ok()).map(str::to_string)
}

/// One call to the server's `/api/…` (as the token's user online, as the local user in the app).
pub async fn api(client: &Client, target: &Target, api_number: u32, method: &str, path: &str, body: Option<Value>, if_none_match: Option<&str>) -> Result<ApiResponse, String> {
    let res = send(client, target, api_number, method, path, body, if_none_match).await?;
    let status = res.status();
    let etag = etag_of(&res);
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
pub async fn cached_api(client: &Client, target: &Target, api_number: u32, path: &str, dir: &Path) -> Result<ApiResponse, String> {
    let file = kept_file(dir, path);
    let kept: Option<Kept> = std::fs::read(&file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let mut res = api(client, target, api_number, "GET", path, None, kept.as_ref().map(|k| k.etag.as_str())).await?;
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

/// The route of the game's own English texts as `global.ini` lines (`docs/webapp.md` "Companion API").
pub const LOCALE_PATH: &str = "/api/companion/locale";

/// The file the game's English texts are kept in below `dir`: the readers' English table (`ocrwatch`), in the
/// server's `key=value` lines as received. It is there once a server delivered it.
pub fn locale_file(dir: &Path) -> PathBuf {
    kept_file(dir, LOCALE_PATH).with_extension("ini")
}

/// The file with the ETag of the kept English texts.
fn locale_etag_file(dir: &Path) -> PathBuf {
    kept_file(dir, LOCALE_PATH).with_extension("etag")
}

/// Keeps a text answer and its ETag: the text first (temp file, renamed when complete: a reader never sees half
/// a table), then the ETag (a crash in between only costs the next transfer).
fn keep_text(dir: &Path, text: &[u8], etag: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let file = locale_file(dir);
    let part = file.with_extension("ini.part");
    std::fs::write(&part, text)?;
    std::fs::rename(&part, &file)?;
    std::fs::write(locale_etag_file(dir), etag)
}

/// The ETag to revalidate the kept English texts with; None without both files (then the text is fetched).
fn kept_text_etag(dir: &Path) -> Option<String> {
    if !locale_file(dir).is_file() {
        return None;
    }
    std::fs::read_to_string(locale_etag_file(dir)).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// Fetches the game's English texts (`LOCALE_PATH`, plain text) into `dir`, revalidated by the kept ETag like
/// `cached_api`: 200 and 304 both answer as 200 without a body (the table is the file), anything else as received
/// with its JSON body (404 `noCatalog`, 426, 409: the kept file stays as it is).
pub async fn cached_text(client: &Client, target: &Target, api_number: u32, dir: &Path) -> Result<ApiResponse, String> {
    let kept = kept_text_etag(dir);
    let res = send(client, target, api_number, "GET", LOCALE_PATH, None, kept.as_deref()).await?;
    let status = res.status();
    let etag = etag_of(&res);
    match status.as_u16() {
        304 if kept.is_some() => Ok(ApiResponse { status: 200, body: Value::Null, etag }),
        200 => {
            let text = res.bytes().await.map_err(|e| {
                log::warn!("request failed: {e}");
                "network".to_string()
            })?;
            match &etag {
                Some(tag) => match keep_text(dir, &text, tag) {
                    Ok(()) => log::info!("English texts kept: {} bytes, ETag {tag}", text.len()),
                    Err(e) => log::warn!("{}: {e}", locale_file(dir).display()),
                },
                None => log::warn!("English texts without an ETag: not kept"),
            }
            Ok(ApiResponse { status: 200, body: Value::Null, etag })
        }
        code => Ok(ApiResponse { status: code, body: res.json::<Value>().await.unwrap_or(Value::Null), etag }),
    }
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

    /// A run against the real local app (`pnpm singleuser`) without the GUI, through this module as the app uses
    /// it; prints what it saw. Both processes need the same `QM_PAIRING_FILE` (never the real profile's file):
    /// `cargo test --release --manifest-path companion/src-tauri/Cargo.toml -- --ignored live_local_app --nocapture`.
    /// It adds one SCU of the catalog's first resource at its first location and removes it again.
    #[test]
    #[ignore = "needs the running local app and QM_PAIRING_FILE"]
    fn live_local_app() {
        let file = std::env::var("QM_PAIRING_FILE").expect("QM_PAIRING_FILE");
        let pairing = crate::pairing::read(Path::new(&file)).expect("a valid pairing file: is the app running?");
        println!("pairing: origin {}, game folder {:?}", pairing.origin, pairing.game_dir);
        let target = Target { origin: pairing.origin, token: None };
        let dir = std::env::temp_dir().join(format!("qm-companion-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let client = client();
        tauri::async_runtime::block_on(async {
            // The contract number comes from the server here (the app's comes from the frontend's COMPANION_API)
            let caps = api(&client, &target, 0, "GET", "/api/capabilities", None, None).await.unwrap();
            println!("capabilities: {} {}", caps.status, caps.body);
            assert_eq!((caps.status, caps.body["login"].as_str()), (200, Some("none")));
            let number = caps.body["companionApi"]["max"].as_u64().unwrap() as u32;

            // Outside the range: both refusals
            let low = api(&client, &target, 0, "GET", "/api/me", None, None).await.unwrap();
            let high = api(&client, &target, number + 1, "GET", "/api/me", None, None).await.unwrap();
            println!("number 0: {} {}; number {}: {} {}", low.status, low.body, number + 1, high.status, high.body);
            assert_eq!((low.status, low.body["error"].as_str()), (426, Some("companionOutdated")));
            assert_eq!((high.status, high.body["error"].as_str()), (409, Some("serverOutdated")));

            let me = api(&client, &target, number, "GET", "/api/me", None, None).await.unwrap();
            println!("me: {} name {} avatar {} orgs {}", me.status, me.body["name"], me.body["avatarUrl"], me.body["orgs"]);
            assert_eq!(me.status, 200);
            assert!(me.body["name"].is_null() && me.body["avatarUrl"].is_null());

            // The catalog: fetched, then answered from the kept copy (304 on the line)
            let path = "/api/companion/catalog?lang=en";
            let started = std::time::Instant::now();
            let catalog = cached_api(&client, &target, number, path, &dir).await.unwrap();
            let first_ms = started.elapsed().as_millis();
            let count = |key: &str| catalog.body[key].as_array().map_or(0, Vec::len);
            println!("catalog: {} in {first_ms} ms, {} materials, {} locations, {} blueprints, kept {} bytes", catalog.status, count("materials"), count("locations"), count("blueprints"), std::fs::metadata(kept_file(&dir, path)).unwrap().len());
            assert_eq!(catalog.status, 200);
            let (_, etag) = kept_etag(&dir, path);
            let again = api(&client, &target, number, "GET", path, None, etag.as_deref()).await.unwrap();
            println!("catalog again with its ETag: {}", again.status);
            assert_eq!(again.status, 304);
            assert_eq!(cached_api(&client, &target, number, path, &dir).await.unwrap().body, catalog.body);

            // The English texts: 200 with the table kept, then 304 with the kept ETag; the readers' parser takes it
            assert_eq!(cached_text(&client, &target, number, &dir).await.unwrap().status, 200);
            let bytes = std::fs::read(locale_file(&dir)).unwrap();
            let etag = kept_text_etag(&dir).expect("the ETag is kept");
            let table = sc_ohseearr_sc::LocTable::load(&locale_file(&dir)).unwrap();
            println!("locale: 200, {} bytes, {} keys, ETag {etag}", bytes.len(), table.len());
            assert!(table.len() > 10_000);
            let raw = send(&client, &target, number, "GET", LOCALE_PATH, None, Some(&etag)).await.unwrap();
            println!("locale again with its ETag: {}", raw.status().as_u16());
            assert_eq!(raw.status().as_u16(), 304);
            assert_eq!(cached_text(&client, &target, number, &dir).await.unwrap().status, 200);
            assert_eq!(std::fs::read(locale_file(&dir)).unwrap(), bytes);

            // One stock add, read back, marked as the companion's in the history, then removed again
            let material = catalog.body["materials"].as_array().unwrap().iter().find(|m| m["kind"] == "resource").expect("a resource");
            let location = &catalog.body["locations"][0];
            let quality = 987;
            let add = serde_json::json!({ "subjectUuid": material["uuid"], "locationUuid": location["uuid"], "quality": quality, "amount": "1" });
            let added = api(&client, &target, number, "POST", "/api/stock/add", Some(add), None).await.unwrap();
            println!("stock add ({} at {}): {} {}", material["name"], location["label"], added.status, added.body);
            assert_eq!(added.status, 200);
            let stock = api(&client, &target, number, "GET", "/api/stock?scope=personal&lang=en", None, None).await.unwrap();
            let batch = stock.body["batches"].as_array().unwrap().iter().find(|b| b["subjectUuid"] == material["uuid"] && b["locationUuid"] == location["uuid"] && b["quality"] == quality).expect("the added batch");
            println!("read back: batch {} {} {} at {}, quality {}", batch["id"], batch["quantity"], batch["unit"], batch["location"], batch["quality"]);
            let history = api(&client, &target, number, "GET", "/api/history?lang=en", None, None).await.unwrap();
            let entry = &history.body["entries"][0];
            println!("history: source {} {} {} {} {}", entry["source"], entry["category"], entry["action"], entry["target"], entry["amount"]);
            assert_eq!((entry["source"].as_str(), entry["action"].as_str(), entry["targetUuid"].as_str()), (Some("companion"), Some("add"), material["uuid"].as_str()));
            let remove = serde_json::json!({ "batchId": batch["id"], "amount": "1", "expected": batch["quantity"] });
            let removed = api(&client, &target, number, "POST", "/api/stock/remove", Some(remove), None).await.unwrap();
            println!("stock remove: {} {}", removed.status, removed.body);
            assert_eq!(removed.status, 200);
        });
        std::fs::remove_dir_all(&dir).unwrap();
    }

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
    fn both_companion_headers_always_the_token_only_online() {
        let client = client();
        let header = |req: &reqwest::Request, name: &str| req.headers().get(name).map(|v| v.to_str().unwrap().to_string());
        let online = Target { origin: "https://qm.example.com".into(), token: Some("qmt_x".into()) };
        let local = Target { origin: "http://127.0.0.1:28460".into(), token: None };
        for (target, auth) in [(&online, Some("Bearer qmt_x")), (&local, None)] {
            for method in [Method::GET, Method::POST] {
                let req = request(&client, target, 7, method, "/api/me").build().unwrap();
                assert_eq!(req.url().as_str(), format!("{}/api/me", target.origin));
                assert_eq!(header(&req, "X-QM-Companion").as_deref(), Some(env!("CARGO_PKG_VERSION")));
                assert_eq!(header(&req, "X-QM-Companion-Api").as_deref(), Some("7"));
                assert_eq!(header(&req, "Authorization").as_deref(), auth);
            }
        }
    }

    #[test]
    fn the_english_texts_are_kept_with_their_etag() {
        let dir = std::env::temp_dir().join(format!("qm-companion-locale-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(locale_file(&dir), dir.join("_api_companion_locale.ini"));
        // Nothing kept: nothing to revalidate
        assert_eq!(kept_text_etag(&dir), None);
        let table = b"a=Materials Yielded\nb=x\\ny\n";
        keep_text(&dir, table, "\"abc-gzip\"").unwrap();
        assert_eq!(std::fs::read(locale_file(&dir)).unwrap(), table);
        assert_eq!(kept_text_etag(&dir).as_deref(), Some("\"abc-gzip\""));
        assert!(!locale_file(&dir).with_extension("ini.part").exists());
        // A newer table replaces both
        keep_text(&dir, b"a=Yield\n", "\"def\"").unwrap();
        assert_eq!(std::fs::read(locale_file(&dir)).unwrap(), b"a=Yield\n");
        assert_eq!(kept_text_etag(&dir).as_deref(), Some("\"def\""));
        // The ETag without its table is not sent: the table is fetched again
        std::fs::remove_file(locale_file(&dir)).unwrap();
        assert_eq!(kept_text_etag(&dir), None);
        std::fs::remove_dir_all(&dir).unwrap();
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
