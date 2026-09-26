//! Web addresses from outside the app: one check, used everywhere one is taken.
//!
//! Status pages, a captive portal's `Location`, the add form's input: all
//! untrusted, and all held to http(s) with a host before anything is fetched
//! or opened. This used to be three near-identical functions in three files.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Parse `raw` as a web address: http or https, with a host.
pub fn parse_web_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|err| format!("Not a URL: {err}"))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(url),
        "http" | "https" => Err("The URL has no host.".to_owned()),
        other => Err(format!(
            "Only web addresses can be used, not {other}:// URLs"
        )),
    }
}

/// Open a status page (or a captive portal's sign-in page) in the browser.
///
/// The URL came off the network, so this is where it is held to http(s): no
/// `file:`, no custom protocol handlers, nothing else the OS would launch. The
/// opener plugin is driven from here, not from JavaScript, so it needs no
/// capability scope at all.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let url = parse_web_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_web_pages() {
        assert!(parse_web_url("https://www.githubstatus.com/").is_ok());
        assert!(parse_web_url("http://login.hotel/start").is_ok());
        assert!(parse_web_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(parse_web_url("javascript:alert(1)").is_err());
        assert!(parse_web_url("ms-settings:network").is_err());
        assert!(parse_web_url("not a url").is_err());
    }
}
