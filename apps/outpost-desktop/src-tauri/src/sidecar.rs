// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const RESTART_WINDOW: Duration = Duration::from_secs(5 * 60);
const MAX_RESTARTS: usize = 3;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(30);

#[derive(Debug, serde::Deserialize)]
struct ReadyMessage {
    event: String,
    port: u16,
}

pub fn parse_ready_line(line: &str) -> Result<u16, String> {
    let ready: ReadyMessage = serde_json::from_str(line).map_err(|_| "ungueltige ready-Zeile")?;
    if ready.event != "ready" || ready.port == 0 {
        return Err("Sidecar meldet keinen gueltigen ready-Port".to_string());
    }
    Ok(ready.port)
}

pub fn create_ipc_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("IPC-Token konnte nicht erzeugt werden: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn default_sidecar_path() -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("App-Pfad konnte nicht gelesen werden: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "App-Verzeichnis fehlt".to_string())?;
    let triple = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        return Err("Kein Sidecar-Triple fuer diese Plattform".to_string());
    };
    let filename = if cfg!(target_os = "windows") {
        format!("atf-outpost-{triple}.exe")
    } else {
        format!("atf-outpost-{triple}")
    };
    let candidates = [
        directory.join(&filename),
        directory.join("../Resources").join(&filename),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(&filename),
    ];
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().into_owned())
        .ok_or_else(|| format!("Sidecar-Binary nicht gefunden: {filename}"))
}

#[derive(Debug, Default)]
pub struct RestartBudget {
    restarts: VecDeque<Instant>,
}

impl RestartBudget {
    pub fn allow(&mut self, now: Instant) -> bool {
        while self
            .restarts
            .front()
            .is_some_and(|started| now.duration_since(*started) >= RESTART_WINDOW)
        {
            self.restarts.pop_front();
        }
        if self.restarts.len() >= MAX_RESTARTS {
            return false;
        }
        self.restarts.push_back(now);
        true
    }

    pub fn len(&self) -> usize {
        self.restarts.len()
    }
}

pub struct SidecarSupervisor {
    executable: String,
    token: String,
    env: Vec<(String, String)>,
    child: Option<Child>,
    stdout: Option<BufReader<ChildStdout>>,
    bridge_thread: Option<JoinHandle<()>>,
    port: Option<u16>,
    budget: RestartBudget,
    bridge_handler: Option<Arc<dyn Fn(&str) -> Option<String> + Send + Sync>>,
    stop_requested: Arc<AtomicBool>,
}

impl SidecarSupervisor {
    pub fn new(executable: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            executable: executable.into(),
            token: token.into(),
            env: Vec::new(),
            child: None,
            stdout: None,
            bridge_thread: None,
            port: None,
            budget: RestartBudget::default(),
            bridge_handler: None,
            stop_requested: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Umgebungsvariablen fuer den Sidecar (z. B. `OUTPOST_CONFIG_FILE` auf
    /// `app_config_dir()`, `OUTPOST_DATA_DIR` auf `app_data_dir()`).
    pub fn set_env(&mut self, env: Vec<(String, String)>) {
        self.env = env;
    }

    /// Aktuell gebundener Control-API-Port (nach `start`, sonst `None`).
    pub fn port(&self) -> Option<u16> {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn start(&mut self) -> Result<u16, String> {
        self.stop_requested.store(false, Ordering::Release);
        let mut child = Command::new(&self.executable)
            .arg("sidecar")
            .envs(
                self.env
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str())),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("Sidecar konnte nicht gestartet werden: {error}"))?;

        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "Sidecar stdin fehlt".to_string())?;
        stdin
            .write_all(format!("{}\n", self.token).as_bytes())
            .map_err(|error| format!("IPC-Token konnte nicht uebergeben werden: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("Sidecar stdin konnte nicht geleert werden: {error}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Sidecar stdout fehlt".to_string())?;
        let mut stdout_reader = BufReader::new(stdout);
        let mut ready_line = String::new();
        let read = stdout_reader
            .read_line(&mut ready_line)
            .map_err(|error| format!("Sidecar ready-Zeile konnte nicht gelesen werden: {error}"))?;
        if read == 0 {
            return Err("Sidecar beendet sich vor der ready-Zeile".to_string());
        }
        let line = ready_line.trim_end_matches(['\r', '\n']);
        let port = parse_ready_line(line)?;
        self.stdout = Some(stdout_reader);
        self.port = Some(port);
        self.child = Some(child);
        Ok(port)
    }

    pub fn read_bridge_line(&mut self) -> Result<Option<String>, String> {
        let stdout = self
            .stdout
            .as_mut()
            .ok_or_else(|| "Sidecar ist nicht gestartet".to_string())?;
        let mut line = String::new();
        let read = stdout
            .read_line(&mut line)
            .map_err(|error| format!("Sidecar-Ausgabe konnte nicht gelesen werden: {error}"))?;
        if read == 0 {
            return Ok(None);
        }
        Ok(Some(line))
    }

    pub fn start_with_bridge<F>(&mut self, handler: F) -> Result<u16, String>
    where
        F: Fn(&str) -> Option<String> + Send + Sync + 'static,
    {
        self.bridge_handler = Some(Arc::new(handler));
        self.start_with_stored_bridge()
    }

    fn start_with_stored_bridge(&mut self) -> Result<u16, String> {
        let port = self.start()?;
        let mut stdout = self
            .stdout
            .take()
            .ok_or_else(|| "Sidecar stdout fehlt".to_string())?;
        let mut stdin = self
            .child
            .as_mut()
            .and_then(|child| child.stdin.take())
            .ok_or_else(|| "Sidecar stdin fehlt".to_string())?;
        let handler = self
            .bridge_handler
            .as_ref()
            .cloned()
            .ok_or_else(|| "Sidecar-Bridge-Handler fehlt".to_string())?;
        self.bridge_thread = Some(std::thread::spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match stdout.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if let Some(response) = handler(&line) {
                            if stdin.write_all(response.as_bytes()).is_err()
                                || stdin.write_all(b"\n").is_err()
                                || stdin.flush().is_err()
                            {
                                break;
                            }
                        }
                    }
                }
            }
        }));
        Ok(port)
    }

    pub fn shutdown(&mut self) -> Result<(), String> {
        self.stop_requested.store(true, Ordering::Release);
        if let Some(port) = self.port {
            let _ = post_shutdown(port, &self.token);
        }
        if let Some(mut child) = self.child.take() {
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(50))
                    }
                    Ok(None) => {
                        child.kill().map_err(|error| {
                            format!("Sidecar konnte nicht beendet werden: {error}")
                        })?;
                        let _ = child.wait();
                        break;
                    }
                    Err(error) => {
                        return Err(format!(
                            "Sidecar-Status konnte nicht gelesen werden: {error}"
                        ))
                    }
                }
            }
        }
        if let Some(thread) = self.bridge_thread.take() {
            let _ = thread.join();
        }
        self.stdout = None;
        self.port = None;
        Ok(())
    }
    pub fn can_restart(&mut self) -> bool {
        self.budget.allow(Instant::now())
    }

    pub fn restart_count(&self) -> usize {
        self.budget.len()
    }

    pub fn restart(&mut self) -> Result<u16, String> {
        if !self.can_restart() {
            return Err(
                "Sidecar wurde zu oft neu gestartet; Benutzeraktion erforderlich".to_string(),
            );
        }
        self.shutdown()?;
        if self.bridge_handler.is_some() {
            self.start_with_stored_bridge()
        } else {
            self.start()
        }
    }

    pub fn child_exited(&mut self) -> Result<bool, String> {
        match self.child.as_mut() {
            Some(child) => child
                .try_wait()
                .map(|status| status.is_some())
                .map_err(|error| format!("Sidecar-Status konnte nicht gelesen werden: {error}")),
            None => Ok(true),
        }
    }

    pub fn stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::Acquire)
    }
}

pub fn monitor<F>(supervisor: Arc<std::sync::Mutex<SidecarSupervisor>>, on_failure: F)
where
    F: Fn(String) + Send + Sync + 'static,
{
    let on_failure = Arc::new(on_failure);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let mut state = match supervisor.lock() {
            Ok(state) => state,
            Err(_) => break,
        };
        if state.stop_requested() {
            break;
        }
        match state.child_exited() {
            Ok(false) => continue,
            Ok(true) => match state.restart() {
                Ok(_) => {}
                Err(error) => {
                    on_failure(format!("ATF Outpost: Sidecar-Neustart beendet: {error}"));
                    break;
                }
            },
            Err(error) => {
                eprintln!("ATF Outpost: Sidecar-Ueberwachung fehlgeschlagen: {error}");
                break;
            }
        }
    });
}

fn post_shutdown(port: u16, token: &str) -> Result<(), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("Control-API nicht erreichbar: {error}"))?;
    let request = format!(
        "POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Shutdown-Anfrage fehlgeschlagen: {error}"))?;
    let _ = stream.shutdown(Shutdown::Both);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_ready_line, RestartBudget};
    use proptest::prop_assert;
    use std::time::{Duration, Instant};

    #[test]
    fn parses_only_ready_messages() {
        assert_eq!(
            parse_ready_line(r#"{"event":"ready","port":43123}"#).unwrap(),
            43123
        );
        assert!(parse_ready_line(r#"{"event":"other","port":43123}"#).is_err());
        assert!(parse_ready_line("not-json").is_err());
    }

    #[test]
    fn limits_restarts_to_three_within_the_window() {
        let mut budget = RestartBudget::default();
        let now = Instant::now();
        assert!(budget.allow(now));
        assert!(budget.allow(now + Duration::from_secs(1)));
        assert!(budget.allow(now + Duration::from_secs(2)));
        assert!(!budget.allow(now + Duration::from_secs(3)));
        assert!(budget.allow(now + Duration::from_secs(301)));
    }

    proptest::proptest! {
        #[test]
        fn property_never_allows_four_recent_restarts(offset in 0_u64..298) {
            let mut budget = RestartBudget::default();
            let now = Instant::now();
            prop_assert!(budget.allow(now));
            prop_assert!(budget.allow(now + Duration::from_secs(offset)));
            prop_assert!(budget.allow(now + Duration::from_secs(offset + 1)));
            prop_assert!(!budget.allow(now + Duration::from_secs(offset + 2)));
        }
    }
}
