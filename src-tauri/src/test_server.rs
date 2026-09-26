//! A local HTTP server for tests: canned responses, one per connection.
//!
//! Shared by the probe and fetch tests, which used to carry a copy each.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

/// Serve `responses` in order, one per connection, at `path` on a free local
/// port. Each request received is sent back on the channel for inspection.
pub fn serve(responses: Vec<Vec<u8>>, path: &str) -> (reqwest::Url, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let read = stream.read(&mut request).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&request[..read]).into_owned());
            let _ = stream.write_all(&response);
        }
    });
    let url = reqwest::Url::parse(&format!("http://127.0.0.1:{port}{path}")).unwrap();
    (url, rx)
}

/// A local URL on a port nothing is listening on.
pub fn refused_url() -> reqwest::Url {
    // Bind and drop: the port is now almost certainly closed.
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    reqwest::Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap()
}
