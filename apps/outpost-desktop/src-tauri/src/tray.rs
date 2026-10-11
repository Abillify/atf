// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

//! Tray with a status icon (idle/syncing/error/paused/re-authorize),
//! menu actions and window opening (Requirements 6.18, 11.6, 11.7, 13.6).
//! The status is derived from the sidecar's `GET /status` (`control.rs`);
//! the icons are generated as simple RGBA fields so the tray can tell the
//! states apart without graphic assets. The state is also shown in the
//! tooltip (not a color-only indicator).

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::control::{self, TrayState};
use crate::sidecar::SidecarSupervisor;

pub const TRAY_ID: &str = "outpost-tray";

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let sync = MenuItem::with_id(app, "sync", "Jetzt synchronisieren", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pausieren/Fortsetzen", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Nach Updates suchen", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Oeffnen", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .items(&[&sync, &pause, &update, &open, &quit])
        .build()?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("ATF Extract Outpost")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "sync" => {
                let _ = app.emit("outpost.sync_requested", ());
                control_action(app, control::sync_all);
            }
            "pause" => {
                let _ = app.emit("outpost.pause_toggled", ());
                control_action(app, control::toggle_pause);
            }
            "update" => crate::check_for_updates(app, true),
            "open" => {
                let _ = app.emit("outpost.open_requested", ());
                show_main_window(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    apply_state(&tray, TrayState::Unreachable);
    Ok(())
}

/// Sets the tray icon and tooltip to the aggregated state.
pub fn apply_state<R: Runtime>(tray: &TrayIcon<R>, state: TrayState) {
    let _ = tray.set_icon(Some(icon_for(state)));
    let _ = tray.set_tooltip(Some(tooltip_for(state)));
}

pub fn tooltip_for(state: TrayState) -> &'static str {
    match state {
        TrayState::Idle => "ATF Extract Outpost — bereit",
        TrayState::Syncing => "ATF Extract Outpost — synchronisiert",
        TrayState::Error => "ATF Extract Outpost — Fehler",
        TrayState::Paused => "ATF Extract Outpost — pausiert",
        TrayState::NeedsAuthorization => "ATF Extract Outpost — Erneut autorisieren",
        TrayState::Unreachable => "ATF Extract Outpost — nicht erreichbar",
    }
}

/// 16×16 RGBA field in the state color.
fn icon_for(state: TrayState) -> Image<'static> {
    let (red, green, blue) = match state {
        TrayState::Idle => (34_u8, 197, 94),
        TrayState::Syncing => (59, 130, 246),
        TrayState::Error => (239, 68, 68),
        TrayState::Paused => (234, 179, 8),
        TrayState::NeedsAuthorization => (249, 115, 22),
        TrayState::Unreachable => (107, 114, 128),
    };
    let size = 16_u32;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for index in 0..(size * size) {
        let edge = index % size < 2
            || index % size > size - 3
            || index / size < 2
            || index / size > size - 3;
        let pixel: [u8; 4] = if edge {
            [40, 40, 40, 255]
        } else {
            [red, green, blue, 255]
        };
        rgba.extend_from_slice(&pixel);
    }
    Image::new_owned(rgba, size, size)
}

/// Runs a Control API action against the current sidecar port.
fn control_action<R: Runtime>(app: &AppHandle<R>, action: fn(u16, &str) -> Result<(), String>) {
    let Some(supervisor) = app.try_state::<std::sync::Arc<std::sync::Mutex<SidecarSupervisor>>>()
    else {
        return;
    };
    let locked = match supervisor.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let (Some(port), token) = (locked.port(), locked.token().to_string()) else {
        return;
    };
    drop(locked);
    if let Err(error) = action(port, &token) {
        eprintln!("ATF Outpost: Tray-Aktion fehlgeschlagen: {error}");
    }
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
