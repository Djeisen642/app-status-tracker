//! The connectivity probe: one plain-HTTP GET, reported as it came back.
//!
//! This side only makes the request. Whether the answer means "online",
//! "offline" or "a captive portal is in the way" is decided in
//! `src/lib/connectivity.ts`, where it can be unit tested.

use std::time::Duration;

use serde::Serialize;

/// Long enough for a slow hotel network, short enough that a dead link is
/// noticed within one check.
const TIMEOUT: Duration = Duration::from_secs(5);

/// The probes' expected bodies are a few bytes. A captive portal's login page
/// is not, and nothing past this is needed to tell the two apart.
const BODY_CAP: usize = 1024;

/// What one probe saw.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProbeOutcome {
    /// Something answered. Redirects are *not* followed: a redirect is how most
    /// captive portals answer, so it is reported, not chased.
    Response {
        status: u16,
        location: Option<String>,
        body: String,
    },
    /// Nothing answered: DNS failed, the connection was refused, or it timed out.
    Error { message: String },
}

/// Shared client, built once: no redirects, a hard timeout, no cookies.
pub struct ProbeClient(reqwest::Client);

impl ProbeClient {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self(client_builder().build()?))
    }
}

/// Everything about the client except the proxy, which tests have to bypass.
fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .user_agent(concat!("app-status-tracker/", env!("CARGO_PKG_VERSION")))
}

/// GET `url` once and report what came back.
#[tauri::command]
pub async fn http_probe(
    url: String,
    client: tauri::State<'_, ProbeClient>,
) -> Result<ProbeOutcome, String> {
    let url = parse_probe_url(&url)?;
    Ok(fetch(&client.0, url).await)
}

async fn fetch(client: &reqwest::Client, url: reqwest::Url) -> ProbeOutcome {
    let mut response = match client.get(url).send().await {
        Ok(response) => response,
        Err(err) => {
            return ProbeOutcome::Error {
                message: err.to_string(),
            }
        }
    };

    let status = response.status().as_u16();
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);

    let mut body = Vec::new();
    while body.len() < BODY_CAP {
        match response.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk),
            // A body cut off mid-read still carried a status, which is the
            // part that matters; keep what arrived.
            Ok(None) | Err(_) => break,
        }
    }
    body.truncate(BODY_CAP);

    ProbeOutcome::Response {
        status,
        location,
        body: String::from_utf8_lossy(&body).into_owned(),
    }
}

/// Only plain `http://` URLs are probed.
///
/// Not a security boundary so much as a statement of purpose: the probe exists
/// to see what the network does to an unencrypted request. Over https a captive
/// portal is indistinguishable from a dead link.
fn parse_probe_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = crate::web_url::parse_web_url(raw)?;
    if url.scheme() != "http" {
        return Err(format!(
            "Only http:// URLs can be probed, not {}://",
            url.scheme()
        ));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serve_once(response: Vec<u8>) -> reqwest::Url {
        crate::test_server::serve(vec![response], "/probe").0
    }

    fn probe(url: reqwest::Url) -> ProbeOutcome {
        // No proxy: a sandbox or CI proxy would otherwise swallow 127.0.0.1.
        let client = client_builder().no_proxy().build().unwrap();
        tauri::async_runtime::block_on(fetch(&client, url))
    }

    #[test]
    fn reports_a_204_as_it_came() {
        let url = serve_once(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_vec());
        assert_eq!(
            probe(url),
            ProbeOutcome::Response {
                status: 204,
                location: None,
                body: String::new()
            }
        );
    }

    #[test]
    fn reports_a_redirect_instead_of_following_it() {
        let url = serve_once(
            b"HTTP/1.1 302 Found\r\nLocation: http://portal.example/login\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
        );
        assert_eq!(
            probe(url),
            ProbeOutcome::Response {
                status: 302,
                location: Some("http://portal.example/login".to_owned()),
                body: String::new()
            }
        );
    }

    #[test]
    fn caps_a_portal_sized_body() {
        let page = "x".repeat(10 * BODY_CAP);
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            page.len()
        )
        .into_bytes();
        response.extend_from_slice(page.as_bytes());

        let ProbeOutcome::Response { status, body, .. } = probe(serve_once(response)) else {
            panic!("expected a response");
        };
        assert_eq!(status, 200);
        assert_eq!(body.len(), BODY_CAP);
    }

    #[test]
    fn reports_a_refused_connection_as_an_error() {
        let url = crate::test_server::refused_url();
        assert!(matches!(probe(url), ProbeOutcome::Error { .. }));
    }

    #[test]
    fn accepts_plain_http() {
        let url = parse_probe_url("http://connectivitycheck.gstatic.com/generate_204").unwrap();
        assert_eq!(url.host_str(), Some("connectivitycheck.gstatic.com"));
    }

    #[test]
    fn refuses_anything_but_http() {
        assert!(parse_probe_url("https://example.com/").is_err());
        assert!(parse_probe_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn refuses_garbage() {
        assert!(parse_probe_url("not a url").is_err());
    }

    #[test]
    fn serializes_with_a_kind_tag_the_frontend_can_switch_on() {
        let json = serde_json::to_string(&ProbeOutcome::Response {
            status: 204,
            location: None,
            body: String::new(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"kind":"response","status":204,"location":null,"body":""}"#
        );

        let json = serde_json::to_string(&ProbeOutcome::Error {
            message: "timed out".to_owned(),
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"error","message":"timed out"}"#);
    }
}
