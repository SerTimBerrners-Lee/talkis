use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

use crate::logger;

const SETTINGS_NAVIGATE_EVENT: &str = "settings-navigate";

fn show_and_focus_window(win: &tauri::WebviewWindow) {
    if let Err(err) = win.show() {
        logger::log_error("WINDOW", &format!("Failed to show settings window: {}", err));
    }
    if let Err(err) = win.set_focus() {
        logger::log_error("WINDOW", &format!("Failed to focus settings window: {}", err));
    }
}

fn create_settings_window(app: &AppHandle, url: &str) -> Result<tauri::WebviewWindow, String> {
    let win = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App(url.into()),
    )
    .title("Talk Flow — Settings")
    .inner_size(920.0, 680.0)
    .min_inner_size(820.0, 560.0)
    .decorations(false)
    .transparent(true)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    if let Err(err) = apply_vibrancy(&win, NSVisualEffectMaterial::HudWindow, None, None) {
        logger::log_error(
            "WINDOW",
            &format!("Failed to apply vibrancy to settings window: {}", err),
        );
    }

    show_and_focus_window(&win);
    Ok(win)
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        show_and_focus_window(&win);
        return Ok(());
    }

    create_settings_window(&app, "index.html?window=settings")?;
    Ok(())
}

#[tauri::command]
pub async fn open_settings_tab(app: AppHandle, tab: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        show_and_focus_window(&win);
        app.emit_to("settings", SETTINGS_NAVIGATE_EVENT, serde_json::json!({ "tab": tab }))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = format!("index.html?window=settings&tab={}", tab);
    create_settings_window(&app, &url)?;
    Ok(())
}
