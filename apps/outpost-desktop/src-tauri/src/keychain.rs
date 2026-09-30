// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

use crate::oauth::{open_browser, LoopbackListener};

const SERVICE: &str = "me.abillify.atf-outpost";

#[derive(Debug, Deserialize)]
#[serde(tag = "op")]
pub enum BridgeRequest {
    #[serde(rename = "get")]
    Get { id: u64, key: String },
    #[serde(rename = "set")]
    Set { id: u64, key: String, value: String },
    #[serde(rename = "delete")]
    Delete { id: u64, key: String },
    #[serde(rename = "loopback.open")]
    LoopbackOpen { id: u64 },
    #[serde(rename = "browser.open")]
    BrowserOpen { id: u64, url: String },
    #[serde(rename = "loopback.result")]
    LoopbackResult { id: u64 },
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BridgeResponse {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn ok(id: u64, value: Option<String>) -> BridgeResponse {
    BridgeResponse {
        id,
        ok: true,
        value,
        port: None,
        query: None,
        error: None,
    }
}

fn error(id: u64, message: impl Into<String>) -> BridgeResponse {
    BridgeResponse {
        id,
        ok: false,
        value: None,
        port: None,
        query: None,
        error: Some(message.into()),
    }
}

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|error| format!("keychain entry fehlgeschlagen: {error}"))
}

pub struct BridgeHost {
    loopback: Mutex<Option<LoopbackListener>>,
}

impl Default for BridgeHost {
    fn default() -> Self {
        Self {
            loopback: Mutex::new(None),
        }
    }
}

impl BridgeHost {
    pub fn handle(&self, request: BridgeRequest) -> BridgeResponse {
        match request {
            BridgeRequest::Get { id, key } => match entry(&key)
                .and_then(|item| item.get_password().map_err(|error| error.to_string()))
            {
                Ok(value) => ok(id, Some(value)),
                Err(error) if error.to_lowercase().contains("no password") => ok(id, None),
                Err(error_text) => error(id, error_text),
            },
            BridgeRequest::Set { id, key, value } => match entry(&key)
                .and_then(|item| item.set_password(&value).map_err(|error| error.to_string()))
            {
                Ok(()) => ok(id, None),
                Err(error_text) => error(id, error_text),
            },
            BridgeRequest::Delete { id, key } => match entry(&key)
                .and_then(|item| item.delete_credential().map_err(|error| error.to_string()))
            {
                Ok(()) => ok(id, None),
                Err(error) if error.to_lowercase().contains("no password") => ok(id, None),
                Err(error_text) => error(id, error_text),
            },
            BridgeRequest::LoopbackOpen { id } => match LoopbackListener::bind()
                .and_then(|listener| listener.port().map(|port| (listener, port)))
            {
                Ok((listener, port)) => match self.loopback.lock() {
                    Ok(mut state) => {
                        *state = Some(listener);
                        let mut response = ok(id, None);
                        response.port = Some(port);
                        response
                    }
                    Err(_) => error(id, "loopback state gesperrt"),
                },
                Err(message) => error(id, message),
            },
            BridgeRequest::BrowserOpen { id, url } => {
                open_browser(&url).map_or_else(|message| error(id, message), |_| ok(id, None))
            }
            BridgeRequest::LoopbackResult { id } => {
                let listener = self.loopback.lock().ok().and_then(|mut state| state.take());
                match listener {
                    Some(listener) => {
                        match listener.wait_for_redirect(std::time::Duration::from_secs(300)) {
                            Ok(query) => {
                                let mut response = ok(id, None);
                                response.query = Some(query);
                                response
                            }
                            Err(message) => error(id, message),
                        }
                    }
                    None => error(id, "loopback host noch nicht gestartet"),
                }
            }
        }
    }

    pub fn handle_line(&self, line: &str) -> Result<String, String> {
        let request: BridgeRequest =
            serde_json::from_str(line).map_err(|_| "ungueltige Bridge-Anfrage".to_string())?;
        serde_json::to_string(&self.handle(request))
            .map_err(|error| format!("Bridge-Antwort konnte nicht serialisiert werden: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{BridgeHost, BridgeResponse};
    use std::io::Write;
    use std::net::TcpStream;
    use std::sync::Arc;
    use std::thread;

    fn call(line: &str) -> BridgeResponse {
        let host = BridgeHost::default();
        serde_json::from_str(&host.handle_line(line).unwrap()).unwrap()
    }

    #[test]
    fn rejects_malformed_requests_without_secret_data() {
        let host = BridgeHost::default();
        assert_eq!(
            host.handle_line("not-json").unwrap_err(),
            "ungueltige Bridge-Anfrage"
        );
        let response = call(r#"{"id":7,"op":"loopback.result"}"#);
        assert!(!response.ok);
        assert_eq!(response.id, 7);
    }

    #[test]
    fn loopback_open_returns_port_and_result_forwards_query() {
        let host = Arc::new(BridgeHost::default());
        let opened = host.handle(super::BridgeRequest::LoopbackOpen { id: 1 });
        assert!(opened.ok, "loopback.open: {:?}", opened.error);
        let port = opened.port.expect("loopback.open liefert einen Port");
        assert!(port > 0);

        // Simuliert den Systembrowser: Redirect mit code/state auf den Loopback.
        // handle() blockiert in loopback.result, bis der Redirect eintrifft.
        let worker_host = Arc::clone(&host);
        let worker = thread::spawn(move || {
            worker_host.handle(super::BridgeRequest::LoopbackResult { id: 2 })
        });
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(b"GET /callback?code=c%201&state=s%202 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();
        let result = worker.join().unwrap();
        assert!(result.ok, "loopback.result: {:?}", result.error);
        let query = result.query.expect("Query wird weitergereicht");
        assert_eq!(query.get("code"), Some(&"c 1".to_string()));
        assert_eq!(query.get("state"), Some(&"s 2".to_string()));
    }

    #[test]
    fn loopback_result_without_open_fails() {
        let host = BridgeHost::default();
        let response = host.handle(super::BridgeRequest::LoopbackResult { id: 3 });
        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("loopback host noch nicht gestartet")
        );
    }

    #[test]
    fn loopback_result_is_consumed_once() {
        let host = Arc::new(BridgeHost::default());
        let opened = host.handle(super::BridgeRequest::LoopbackOpen { id: 1 });
        let port = opened.port.expect("Port");
        let worker_host = Arc::clone(&host);
        let worker = thread::spawn(move || {
            worker_host.handle(super::BridgeRequest::LoopbackResult { id: 2 })
        });
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(b"GET /callback?code=c&state=s HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();
        let first = worker.join().unwrap();
        assert!(first.ok);
        // Der Listener wird mit dem ersten Ergebnis verbraucht; ein zweiter
        // Aufruf scheitert, statt auf einen neuen Redirect zu warten.
        let second = host.handle(super::BridgeRequest::LoopbackResult { id: 3 });
        assert!(!second.ok);
        assert_eq!(
            second.error.as_deref(),
            Some("loopback host noch nicht gestartet")
        );
    }
}
