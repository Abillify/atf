// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

mod control;
mod keychain;
mod oauth;
mod sidecar;
mod tray;

use keychain::BridgeHost;
use sidecar::{create_ipc_token, default_sidecar_path, monitor, SidecarSupervisor};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

/// Poll interval for the status (tray/notifications).
const STATUS_POLL: Duration = Duration::from_secs(5);

/// Control API endpoint of the sidecar for the WebView. Port and token are
/// only known after the sidecar has started; the frontend polls this command
/// until it is ready (replacement for window.__ATF_CONTROL_URL__/__ATF_CONTROL_TOKEN__).
#[derive(serde::Serialize)]
struct ControlInfo {
    url: String,
    token: String,
}

#[tauri::command]
fn control_info(state: tauri::State<'_, Arc<Mutex<SidecarSupervisor>>>) -> Option<ControlInfo> {
    let supervisor = state.lock().ok()?;
    let port = supervisor.port()?;
    Some(ControlInfo {
        url: format!("http://127.0.0.1:{port}"),
        token: supervisor.token().to_string(),
    })
}

/// Determines the path of the sidecar program. The environment variable
/// `ATF_OUTPOST_EXECUTABLE` is only honored in debug builds
/// (Requirement 10.4): release builds only consider the bundled sidecar
/// path, so no environment-variable attack can slip in a foreign process
/// as the sidecar.
fn sidecar_executable(
    env_override: Option<String>,
    default: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    #[cfg(debug_assertions)]
    if let Some(path) = env_override {
        return Ok(path);
    }
    #[cfg(not(debug_assertions))]
    let _ = env_override;
    default()
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg("--hidden")
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            tray::install(&app.handle()).map_err(std::io::Error::other)?;
            let token = create_ipc_token().map_err(std::io::Error::other)?;
            let executable =
                sidecar_executable(std::env::var("ATF_OUTPOST_EXECUTABLE").ok(), || {
                    default_sidecar_path()
                })
                .map_err(std::io::Error::other)?;
            let mut supervisor = SidecarSupervisor::new(executable, token);
            // Einstellungen in `app_config_dir()`, State in `app_data_dir()` (13.9).
            let config_dir = app.path().app_config_dir().map_err(std::io::Error::other)?;
            let data_dir = app.path().app_data_dir().map_err(std::io::Error::other)?;
            std::fs::create_dir_all(&config_dir).map_err(std::io::Error::other)?;
            std::fs::create_dir_all(&data_dir).map_err(std::io::Error::other)?;
            supervisor.set_env(vec![
                (
                    "OUTPOST_CONFIG_FILE".to_string(),
                    config_dir
                        .join("outpost.yaml")
                        .to_string_lossy()
                        .into_owned(),
                ),
                (
                    "OUTPOST_DATA_DIR".to_string(),
                    data_dir.to_string_lossy().into_owned(),
                ),
            ]);
            let bridge_host = Arc::new(BridgeHost::default());
            supervisor
                .start_with_bridge({
                    let bridge_host = Arc::clone(&bridge_host);
                    move |line| bridge_host.handle_line(line).ok()
                })
                .map_err(std::io::Error::other)?;
            let state = Arc::new(Mutex::new(supervisor));
            let handle = app.handle().clone();
            monitor(Arc::clone(&state), move |message| {
                handle
                    .dialog()
                    .message(message)
                    .title("ATF Extract Outpost")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            });
            start_status_monitor(app.handle().clone(), Arc::clone(&state));
            // Automatic update check at startup; same signature check as
            // the manual tray action (14.8, 14.10).
            check_for_updates(app.handle(), false);
            app.manage(state);
            app.manage(bridge_host);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![control_info])
        .build(tauri::generate_context!())
        .expect("error while building ATF Extract Outpost");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            if let Some(state) = app_handle.try_state::<Arc<Mutex<SidecarSupervisor>>>() {
                if let Ok(mut supervisor) = state.lock() {
                    let _ = supervisor.shutdown();
                }
            }
        }
    });
}

/// Polls `GET /status` and updates the tray icon/tooltip and
/// notifications: "re-authorize" on the transition to
/// needs-authorization, and a notice when `failed > 0` rises compared with
/// the previous value (Requirements 6.18, 11.6, 11.7).
fn start_status_monitor(app: AppHandle, supervisor: Arc<Mutex<SidecarSupervisor>>) {
    std::thread::spawn(move || {
        let mut previous: Option<control::Snapshot> = None;
        loop {
            std::thread::sleep(STATUS_POLL);
            let snapshot = {
                let locked = match supervisor.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                match (locked.port(), locked.stop_requested()) {
                    (_, true) => return,
                    (None, false) => None,
                    (Some(port), false) => control::fetch_snapshot(port, locked.token()).ok(),
                }
            };
            if let Some(tray) = app.tray_by_id(tray::TRAY_ID) {
                tray::apply_state(&tray, control::tray_state(snapshot.as_ref()));
            }
            if control::reauth_alert(previous.as_ref(), snapshot.as_ref()) {
                let _ = app
                    .notification()
                    .builder()
                    .title("ATF Extract Outpost")
                    .body("Erneut autorisieren: eine Quelle benoetigt eine neue Autorisierung.")
                    .show();
            }
            if let (Some(previous_snapshot), Some(current)) = (previous.as_ref(), snapshot.as_ref())
            {
                if control::failed_alert(previous_snapshot.failed, current.failed) {
                    let _ = app
                        .notification()
                        .builder()
                        .title("ATF Extract Outpost")
                        .body(format!(
                            "{} Datei(en) konnten nicht uebertragen werden.",
                            current.failed
                        ))
                        .show();
                }
            }
            previous = snapshot;
        }
    });
}

/// Checks the updater; the Minisign signature check happens in the plugin
/// (`download_and_install`). With an invalid signature the plugin aborts,
/// the update is discarded and shown as an error message (14.8, 14.10).
/// The automatic check at startup and the manual tray action use the same
/// path.
pub fn check_for_updates<R: tauri::Runtime>(app: &AppHandle<R>, manual: bool) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_updater::UpdaterExt;
        match app_clone.updater() {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => {
                    match update
                        .download_and_install(|_chunk, _total| {}, || {})
                        .await
                    {
                        Ok(()) => {
                            app_clone
                                .dialog()
                                .message("Update installiert. Bitte starten Sie die App neu.")
                                .title("ATF Extract Outpost")
                                .show(|_| {});
                        }
                        Err(error) => {
                            app_clone
                                .dialog()
                                .message(format!("Update fehlgeschlagen und verworfen: {error}"))
                                .title("ATF Extract Outpost")
                                .kind(MessageDialogKind::Error)
                                .blocking_show();
                        }
                    }
                }
                Ok(None) => {
                    if manual {
                        app_clone
                            .dialog()
                            .message("Sie verwenden die aktuelle Version.")
                            .title("ATF Extract Outpost")
                            .show(|_| {});
                    }
                }
                Err(error) if manual => {
                    app_clone
                        .dialog()
                        .message(format!("Updatesuche fehlgeschlagen: {error}"))
                        .title("ATF Extract Outpost")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                }
                Err(_) => {}
            },
            Err(error) if manual => {
                app_clone
                    .dialog()
                    .message(format!("Updater nicht verfuegbar: {error}"))
                    .title("ATF Extract Outpost")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
            Err(_) => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::sidecar_executable;
    #[test]
    fn uses_default_path_without_environment_override() {
        let executable = sidecar_executable(None, || Ok("/bundled/atf-outpost".to_string()))
            .expect("default path");
        assert_eq!(executable, "/bundled/atf-outpost");
    }
    #[test]
    fn propagates_default_path_errors() {
        let error = sidecar_executable(None, || Err("sidecar missing".to_string()))
            .expect_err("default error");
        assert_eq!(error, "sidecar missing");
    }
    /// Requirement 10.4: the override only takes effect in debug builds.
    #[cfg(debug_assertions)]
    #[test]
    fn debug_build_honours_environment_override() {
        let executable = sidecar_executable(Some("/dev/atf-outpost".to_string()), || {
            Err("default must not be called".to_string())
        })
        .expect("debug override");
        assert_eq!(executable, "/dev/atf-outpost");
    }
    /// Requirement 10.4: release builds ignore the environment variable.
    #[cfg(not(debug_assertions))]
    #[test]
    fn release_build_ignores_environment_override() {
        let executable = sidecar_executable(Some("/malicious/outpost".to_string()), || {
            Ok("/bundled/atf-outpost".to_string())
        })
        .expect("bundled path");
        assert_eq!(executable, "/bundled/atf-outpost");
    }
}
