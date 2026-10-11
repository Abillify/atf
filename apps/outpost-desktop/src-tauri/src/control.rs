// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

//! Minimal HTTP client for the sidecar's Control API (127.0.0.1) and
//! derivation of the tray state from `GET /status` (Requirements 6.18, 11.6,
//! 11.7, 13.6). The host holds no credentials, only status information.

use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// Aggregated status of all sources for the tray and notifications.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Snapshot {
    pub paused: bool,
    pub needs_authorization: bool,
    pub error: bool,
    pub syncing: bool,
    pub failed: u64,
}

/// State shown by the tray icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    Idle,
    Syncing,
    Error,
    Paused,
    NeedsAuthorization,
    Unreachable,
}

/// HTTP/1.1 request with a bearer token against the Control API (Connection: close).
pub fn request(port: u16, token: &str, method: &str, path: &str) -> Result<(u16, String), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("Control-API nicht erreichbar: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| format!("Timeout konnte nicht gesetzt werden: {error}"))?;
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Anfrage fehlgeschlagen: {error}"))?;
    stream.flush().map_err(|e| format!("{e}"))?;
    let mut buffer = Vec::new();
    stream
        .read_to_end(&mut buffer)
        .map_err(|error| format!("Antwort konnte nicht gelesen werden: {error}"))?;
    split_response(&String::from_utf8_lossy(&buffer))
}

/// Splits the status line and body of an HTTP response (without chunk encoding;
/// the Control API answers with Content-Length or Connection: close).
fn split_response(raw: &str) -> Result<(u16, String), String> {
    let (head, body) = raw
        .split_once("\r\n\r\n")
        .ok_or_else(|| "unvollstaendige HTTP-Antwort".to_string())?;
    let status_line = head
        .lines()
        .next()
        .ok_or_else(|| "HTTP-Antwort ohne Statuszeile".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "HTTP-Antwort ohne Statuscode".to_string())?;
    Ok((status, body.to_string()))
}

/// Parses the response of `GET /status` into a `Snapshot`.
pub fn parse_snapshot(body: &str) -> Result<Snapshot, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|_| "Status-Antwort ist kein JSON".to_string())?;
    let mut snapshot = Snapshot {
        paused: value
            .get("paused")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        ..Snapshot::default()
    };
    if let Some(sources) = value.get("sources").and_then(Value::as_array) {
        for source in sources {
            match source.get("status").and_then(Value::as_str) {
                Some("running") => snapshot.syncing = true,
                Some("needs-authorization") => snapshot.needs_authorization = true,
                Some("error") => snapshot.error = true,
                _ => {}
            }
            if let Some(failed) = source
                .get("lastRun")
                .and_then(|run| run.get("counters"))
                .and_then(|counters| counters.get("failed"))
                .and_then(Value::as_u64)
            {
                snapshot.failed += failed;
            }
        }
    }
    Ok(snapshot)
}

pub fn fetch_snapshot(port: u16, token: &str) -> Result<Snapshot, String> {
    let (status, body) = request(port, token, "GET", "/status")?;
    if status != 200 {
        return Err(format!("GET /status lieferte {status}"));
    }
    parse_snapshot(&body)
}

/// Triggers all sources through the Control API (tray "Sync now").
pub fn sync_all(port: u16, token: &str) -> Result<(), String> {
    let (status, body) = request(port, token, "GET", "/status")?;
    if status != 200 {
        return Err(format!("GET /status lieferte {status}"));
    }
    let value: Value =
        serde_json::from_str(&body).map_err(|_| "Status-Antwort ist kein JSON".to_string())?;
    let sources = value
        .get("sources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut first_error: Option<String> = None;
    for source in sources {
        let Some(source_id) = source.get("sourceId").and_then(Value::as_str) else {
            continue;
        };
        let path = format!("/sources/{source_id}/sync");
        if let Err(error) = request(port, token, "POST", &path) {
            first_error.get_or_insert(error);
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Pause/resume depending on the current `paused` switch.
pub fn toggle_pause(port: u16, token: &str) -> Result<(), String> {
    let snapshot = fetch_snapshot(port, token)?;
    let path = if snapshot.paused { "/resume" } else { "/pause" };
    request(port, token, "POST", path).map(|_| ())
}

/// Priority: unreachable > re-authorize > error > paused >
/// running > ready.
pub fn tray_state(snapshot: Option<&Snapshot>) -> TrayState {
    match snapshot {
        None => TrayState::Unreachable,
        Some(snapshot) if snapshot.needs_authorization => TrayState::NeedsAuthorization,
        Some(snapshot) if snapshot.error => TrayState::Error,
        Some(snapshot) if snapshot.paused => TrayState::Paused,
        Some(snapshot) if snapshot.syncing => TrayState::Syncing,
        Some(_) => TrayState::Idle,
    }
}

/// Notice only on degradation: the error count rose from 0 or a smaller
/// value to a larger value (no repetition per poll).
pub fn failed_alert(prev_failed: u64, current: u64) -> bool {
    current > prev_failed && current > 0
}

/// "Re-authorize" notice on the transition to needs-authorization.
pub fn reauth_alert(prev: Option<&Snapshot>, current: Option<&Snapshot>) -> bool {
    match (prev, current) {
        (Some(previous), Some(now)) => now.needs_authorization && !previous.needs_authorization,
        (None, Some(now)) => now.needs_authorization,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        failed_alert, parse_snapshot, reauth_alert, split_response, tray_state, Snapshot, TrayState,
    };

    #[test]
    fn splits_status_line_and_body() {
        let (status, body) =
            split_response("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"a\":1}")
                .unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, "{\"a\":1}");
        assert!(split_response("HTTP/1.1 200 OK\r\n").is_err());
    }

    #[test]
    fn aggregates_source_states_and_failures() {
        let snapshot = parse_snapshot(
            r#"{"paused":false,"sources":[
                {"sourceId":"a","status":"running"},
                {"sourceId":"b","status":"needs-authorization",
                 "lastRun":{"counters":{"failed":2}}},
                {"sourceId":"c","status":"idle","lastRun":{"counters":{"failed":3}}}
            ]}"#,
        )
        .unwrap();
        assert!(snapshot.syncing);
        assert!(snapshot.needs_authorization);
        assert!(!snapshot.error);
        assert_eq!(snapshot.failed, 5);
        assert_eq!(
            tray_state(Some(&snapshot)),
            TrayState::NeedsAuthorization,
            "needs-authorization hat Vorrang"
        );
    }

    #[test]
    fn tray_state_priority() {
        assert_eq!(tray_state(None), TrayState::Unreachable);
        let error = Snapshot {
            error: true,
            paused: true,
            syncing: true,
            ..Snapshot::default()
        };
        assert_eq!(tray_state(Some(&error)), TrayState::Error);
        let paused = Snapshot {
            paused: true,
            syncing: true,
            ..Snapshot::default()
        };
        assert_eq!(tray_state(Some(&paused)), TrayState::Paused);
        let running = Snapshot {
            syncing: true,
            ..Snapshot::default()
        };
        assert_eq!(tray_state(Some(&running)), TrayState::Syncing);
        assert_eq!(tray_state(Some(&Snapshot::default())), TrayState::Idle);
    }

    #[test]
    fn alerts_fire_only_on_transitions() {
        assert!(failed_alert(0, 1));
        assert!(failed_alert(2, 3));
        assert!(!failed_alert(3, 3), "kein Alarm ohne Verslechterung");
        assert!(!failed_alert(5, 2), "Besserung alarmiert nicht");
        assert!(!failed_alert(0, 0));

        let needs = Snapshot {
            needs_authorization: true,
            ..Snapshot::default()
        };
        let idle = Snapshot::default();
        assert!(reauth_alert(None, Some(&needs)));
        assert!(reauth_alert(Some(&idle), Some(&needs)));
        assert!(!reauth_alert(Some(&needs), Some(&needs)));
        assert!(!reauth_alert(Some(&needs), Some(&idle)));
        assert!(!reauth_alert(Some(&idle), Some(&idle)));
    }
}
