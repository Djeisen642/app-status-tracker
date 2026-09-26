//! The status fetch: one GET of a status page's API, reported as it came back.
//!
//! This side only makes the request. Parsing, normalizing and deciding what
//! changed are TypeScript (`src/lib/`), where they can be unit tested against
//! real captured responses.

use std::time::Duration;

use serde::Serialize;

/// Status APIs answer in well under a second; ten is for a slow network.
const TIMEOUT: Duration = Duration::from_secs(10);

/// GitHub's `summary.json` is about 5 KB. Anything near this is not a status
/// summary, and reading it all would only cost memory in an app that runs all
/// day.
const BODY_CAP: usize = 2 * 1024 * 1024;

/// A status page may move once or twice (`status.github.com` →
/// `www.githubstatus.com`); a chain longer than this is a loop or a portal.
const MAX_REDIRECTS: usize = 5;

/// What one fetch saw.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FetchOutcome {
    /// Something answered. `304` means "unchanged since `etag`", with no body.
    Response {
        status: u16,
        etag: Option<String>,
        /// Where the request ended up after redirects.
        url: String,
        body: String,
    },
    /// Nothing answered, or the body was too large to be a status summary.
    Error { message: String },
}

/// Shared client, built once.
///
/// TLS is the OS's own (`native-tls`): SChannel on Windows, Security.framework
/// on macOS, OpenSSL on Linux. That means the OS certificate store, which is
/// what makes a corporate proxy that re-signs TLS with its own root CA work,
/// and no C toolchain to build on Windows.
pub struct FetchClient(reqwest::Client);

impl FetchClient {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self(client_builder().build()?))
    }
}

/// Everything about the client except the proxy, which tests have to bypass.
fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
        .timeout(TIMEOUT)
        .user_agent(concat!("app-status-tracker/", env!("CARGO_PKG_VERSION")))
}

/// GET `url`, sending `etag` as `If-None-Match` when there is one.
#[tauri::command]
pub async fn fetch_status(
    url: String,
    etag: Option<String>,
    client: tauri::State<'_, FetchClient>,
) -> Result<FetchOutcome, String> {
    let url = parse_status_url(&url)?;
    Ok(fetch(&client.0, url, etag.as_deref()).await)
}

async fn fetch(client: &reqwest::Client, url: reqwest::Url, etag: Option<&str>) -> FetchOutcome {
    let mut request = client.get(url);
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }

    let mut response = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            return FetchOutcome::Error {
                message: err.to_string(),
            }
        }
    };

    let status = response.status().as_u16();
    let final_url = response.url().to_string();
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);

    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > BODY_CAP {
                    // Truncated JSON would only fail to parse later, with a
                    // worse message. Say what actually happened.
                    return FetchOutcome::Error {
                        message: format!("The response was larger than {BODY_CAP} bytes."),
                    };
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(err) => {
                return FetchOutcome::Error {
                    message: err.to_string(),
                }
            }
        }
    }

    FetchOutcome::Response {
        status,
        etag,
        url: final_url,
        body: String::from_utf8_lossy(&body).into_owned(),
    }
}

/// Only web URLs are fetched: http(s), with a host.
fn parse_status_url(raw: &str) -> Result<reqwest::Url, String> {
    crate::web_url::parse_web_url(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serve(responses: Vec<Vec<u8>>) -> (reqwest::Url, std::sync::mpsc::Receiver<String>) {
        crate::test_server::serve(responses, "/api/v2/summary.json")
    }

    fn get(url: reqwest::Url, etag: Option<&str>) -> FetchOutcome {
        // No proxy: a sandbox or CI proxy would otherwise swallow 127.0.0.1.
        let client = client_builder().no_proxy().build().unwrap();
        tauri::async_runtime::block_on(fetch(&client, url, etag))
    }

    fn ok(body: &str, extra_headers: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n{extra_headers}Connection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn returns_the_body_and_etag() {
        let (url, _) = serve(vec![ok("{\"page\":{}}", "ETag: \"abc\"\r\n")]);
        let FetchOutcome::Response {
            status, etag, body, ..
        } = get(url, None)
        else {
            panic!("expected a response");
        };
        assert_eq!(status, 200);
        assert_eq!(etag.as_deref(), Some("\"abc\""));
        assert_eq!(body, "{\"page\":{}}");
    }

    #[test]
    fn sends_the_etag_back_as_if_none_match() {
        let (url, requests) = serve(vec![
            b"HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".to_vec(),
        ]);
        let outcome = get(url, Some("\"abc\""));
        let request = requests.recv().unwrap().to_ascii_lowercase();
        assert!(request.contains("if-none-match: \"abc\""), "{request}");
        assert!(matches!(
            outcome,
            FetchOutcome::Response { status: 304, .. }
        ));
    }

    #[test]
    fn follows_a_moved_status_page_and_reports_where_it_landed() {
        // Two responses from one server: a redirect to itself, then the page.
        let (url, _) = serve(vec![
            b"HTTP/1.1 301 Moved Permanently\r\nLocation: /moved.json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            ok("{}", ""),
        ]);
        let FetchOutcome::Response {
            status,
            url: landed,
            ..
        } = get(url, None)
        else {
            panic!("expected a response");
        };
        assert_eq!(status, 200);
        assert!(landed.ends_with("/moved.json"), "{landed}");
    }

    #[test]
    fn refuses_a_body_too_large_to_be_a_status_summary() {
        let (url, _) = serve(vec![ok(&"x".repeat(BODY_CAP + 1), "")]);
        assert!(matches!(get(url, None), FetchOutcome::Error { .. }));
    }

    #[test]
    fn reports_a_refused_connection_as_an_error() {
        let url = crate::test_server::refused_url();
        assert!(matches!(get(url, None), FetchOutcome::Error { .. }));
    }

    /// A real TLS handshake with the OS's TLS stack and the system proxy.
    /// Network-dependent, so opt-in: `cargo test -- --ignored`.
    #[test]
    #[ignore = "needs the network"]
    fn fetches_a_real_https_page() {
        let client = FetchClient::new().unwrap();
        let url = reqwest::Url::parse(
            &std::env::var("FETCH_SMOKE_URL")
                .unwrap_or_else(|_| "https://www.githubstatus.com/api/v2/summary.json".to_owned()),
        )
        .unwrap();
        let outcome = tauri::async_runtime::block_on(fetch(&client.0, url, None));
        assert!(
            matches!(outcome, FetchOutcome::Response { status: 200, .. }),
            "{outcome:?}"
        );
    }

    #[test]
    fn fetches_only_web_urls() {
        assert!(parse_status_url("https://www.githubstatus.com/api/v2/summary.json").is_ok());
        assert!(parse_status_url("file:///etc/passwd").is_err());
        assert!(parse_status_url("nonsense").is_err());
    }
}
