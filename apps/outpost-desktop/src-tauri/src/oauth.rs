// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

const LOOPBACK_HOST: &str = "127.0.0.1";
const AUTH_TIMEOUT: Duration = Duration::from_secs(300);
/// Upper bound for reading the redirect request once a browser connected.
const REDIRECT_READ_TIMEOUT: Duration = Duration::from_secs(10);

pub struct LoopbackListener {
    listener: TcpListener,
}

impl LoopbackListener {
    pub fn bind() -> Result<Self, String> {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0))
            .map_err(|error| format!("Loopback-Listener konnte nicht gebunden werden: {error}"))?;
        listener.set_nonblocking(true).map_err(|error| {
            format!("Loopback-Listener konnte nicht konfiguriert werden: {error}")
        })?;
        Ok(Self { listener })
    }

    pub fn port(&self) -> Result<u16, String> {
        self.listener
            .local_addr()
            .map(|address| address.port())
            .map_err(|error| format!("Loopback-Port konnte nicht gelesen werden: {error}"))
    }

    pub fn wait_for_redirect(&self, timeout: Duration) -> Result<HashMap<String, String>, String> {
        let deadline = Instant::now() + timeout.min(AUTH_TIMEOUT);
        loop {
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    // On macOS and Windows an accepted socket inherits the
                    // listener's non-blocking mode, so the first read fails with
                    // WouldBlock whenever the request bytes are not there yet.
                    // Read the redirect in blocking mode, bounded by a timeout.
                    stream
                        .set_nonblocking(false)
                        .and_then(|()| stream.set_read_timeout(Some(REDIRECT_READ_TIMEOUT)))
                        .map_err(|error| {
                            format!("OAuth-Redirect konnte nicht gelesen werden: {error}")
                        })?;
                    return read_redirect(&mut stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err("OAuth-Loopback-Timeout".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(format!("Loopback-Request fehlgeschlagen: {error}")),
            }
        }
    }
}

pub fn open_browser(url: &str) -> Result<(), String> {
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .status()
    } else {
        std::process::Command::new("xdg-open").arg(url).status()
    };
    match result {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("Browser konnte nicht geoeffnet werden: {status}")),
        Err(error) => Err(format!("Browser konnte nicht geoeffnet werden: {error}")),
    }
}

fn read_redirect(stream: &mut TcpStream) -> Result<HashMap<String, String>, String> {
    let mut buffer = [0_u8; 8192];
    let size = stream
        .read(&mut buffer)
        .map_err(|error| format!("OAuth-Redirect konnte nicht gelesen werden: {error}"))?;
    let request = String::from_utf8_lossy(&buffer[..size]);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "Ungueltige OAuth-Redirect-Anfrage".to_string())?;
    let query = target.split_once('?').map(|(_, query)| query).unwrap_or("");
    let values = query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| (percent_decode(key), percent_decode(value)))
        .collect();
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nAutorisierung abgeschlossen. Sie koennen dieses Fenster schliessen.")
        .map_err(|error| format!("OAuth-Antwort konnte nicht gesendet werden: {error}"))?;
    Ok(values)
}

fn percent_decode(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(decoded) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                output.push(decoded as char);
                index += 3;
                continue;
            }
        }
        output.push(if bytes[index] == b'+' {
            ' '
        } else {
            bytes[index] as char
        });
        index += 1;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::LoopbackListener;
    use std::io::Write;
    use std::net::TcpStream;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn accepts_code_and_state_on_random_loopback_port() {
        let listener = LoopbackListener::bind().unwrap();
        let port = listener.port().unwrap();
        let worker =
            thread::spawn(move || listener.wait_for_redirect(Duration::from_secs(2)).unwrap());
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .write_all(
                b"GET /callback?code=abc%20123&state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
            .unwrap();
        let values = worker.join().unwrap();
        assert_eq!(values.get("code"), Some(&"abc 123".to_string()));
        assert_eq!(values.get("state"), Some(&"xyz".to_string()));
    }

    #[test]
    fn respects_a_short_timeout_without_accepting_network_input() {
        let listener = LoopbackListener::bind().unwrap();
        let result = listener.wait_for_redirect(Duration::from_millis(1));
        assert_eq!(result.unwrap_err(), "OAuth-Loopback-Timeout");
    }
}
