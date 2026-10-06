//! The Quartermaster web app's JSON API, called with the user's API token
//! (`Authorization: Bearer`, the "Access Key" from the web app). Every call
//! says the app's version (`X-QM-Companion`); an outdated app gets 426 with
//! the new release's links, which the frontend shows instead of working. Errors are
//! short codes the frontend translates (`noToken`, `invalidToken`,
//! `invalidServer`, …) or a message for anything else.

use std::time::Duration;

use reqwest::{Client, Method, StatusCode, Url};
use serde::Serialize;
use serde_json::Value;

/// The HTTP client, shared by all commands.
pub fn client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(30))
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
}

/// One call to the web app's `/api/…` as the token's user.
pub async fn api(client: &Client, origin: &str, token: &str, method: &str, path: &str, body: Option<Value>) -> Result<ApiResponse, String> {
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
    let res = req.send().await.map_err(|e| {
        log::warn!("request failed: {e}");
        "network".to_string()
    })?;
    let status = res.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err("invalidToken".into());
    }
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    Ok(ApiResponse { status: status.as_u16(), body })
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
}
