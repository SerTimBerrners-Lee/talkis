use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{logger, media_permissions};

const SETTINGS_NAVIGATE_EVENT: &str = "settings-navigate";
const APP_UPDATE_CHECK_REQUEST_EVENT: &str = "app-update-check-request";
#[cfg(debug_assertions)]
const DEV_ONBOARDING_REQUEST_EVENT: &str = "dev-onboarding-request";

fn show_and_focus_window(win: &tauri::WebviewWindow) {
    if let Err(err) = win.show() {
        logger::log_error(
            "WINDOW",
            &format!("Failed to show settings window: {}", err),
        );
    }
    if let Err(err) = win.unminimize() {
        logger::log_error(
            "WINDOW",
            &format!("Failed to restore settings window: {}", err),
        );
    }
    if let Err(err) = win.set_focus() {
        logger::log_error(
            "WINDOW",
            &format!("Failed to focus settings window: {}", err),
        );
    }
}

fn create_settings_window(
    app: &AppHandle,
    url: &str,
    visible: bool,
) -> Result<tauri::WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(url.into()))
        .title("Talkis")
        .visible(visible)
        .focused(visible)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .inner_size(920.0, 680.0)
        .min_inner_size(820.0, 560.0)
        .center();

    // macOS keeps the custom decoration-less, transparent, rounded shell with the
    // in-app traffic-light title bar.
    #[cfg(target_os = "macos")]
    {
        builder = builder.decorations(false).transparent(true);
    }

    // Windows & Linux use a standard rectangular window with the native title bar
    // and system minimize / maximize / close controls (the custom rounded shell
    // showed lit square corners on those platforms).
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(true).transparent(false);
    }

    let win = builder.build().map_err(|e| e.to_string())?;
    media_permissions::allow_microphone_requests(&win);

    #[cfg(windows)]
    {
        let initial_theme = match win.theme() {
            Ok(tauri::Theme::Dark) => crate::windows_titlebar::TitlebarTheme::Dark,
            _ => crate::windows_titlebar::TitlebarTheme::Light,
        };
        if let Err(error) = crate::windows_titlebar::apply(&win, initial_theme) {
            logger::log_error("WINDOW_TITLEBAR", &error);
        }
    }

    if visible {
        show_and_focus_window(&win);
    }
    Ok(win)
}

/// Keep the settings WebView running for onboarding/auth/update handling, but
/// let its startup checks decide whether the window needs to be shown.
pub async fn prepare_settings_at_startup(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window("settings").is_none() {
        create_settings_window(&app, "index.html?window=settings&startup=1", false)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn reveal_startup_settings(app: AppHandle) -> Result<(), String> {
    // Never recreate a window that the user closed while startup was pending.
    if let Some(win) = app.get_webview_window("settings") {
        show_and_focus_window(&win);
    }

    Ok(())
}

#[tauri::command]
pub async fn set_settings_titlebar_theme(app: AppHandle, theme: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let window = app
            .get_webview_window("settings")
            .ok_or_else(|| "Settings window is not available".to_string())?;
        let theme = crate::windows_titlebar::TitlebarTheme::parse(&theme)?;
        crate::windows_titlebar::apply(&window, theme)?;
    }

    #[cfg(not(windows))]
    let _ = (app, theme);

    Ok(())
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        show_and_focus_window(&win);
        return Ok(());
    }

    create_settings_window(&app, "index.html?window=settings", true)?;
    Ok(())
}

#[tauri::command]
pub async fn open_settings_tab(
    app: AppHandle,
    tab: String,
    result_id: Option<String>,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        show_and_focus_window(&win);
        app.emit_to(
            "settings",
            SETTINGS_NAVIGATE_EVENT,
            serde_json::json!({ "tab": tab, "resultId": result_id }),
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = match result_id {
        Some(result_id) if !result_id.is_empty() => {
            format!(
                "index.html?window=settings&tab={}&resultId={}",
                tab, result_id
            )
        }
        _ => format!("index.html?window=settings&tab={}", tab),
    };
    create_settings_window(&app, &url, true)?;
    Ok(())
}

pub async fn open_update_check(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        show_and_focus_window(&win);
        app.emit_to("settings", APP_UPDATE_CHECK_REQUEST_EVENT, ())
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    create_settings_window(
        &app,
        "index.html?window=settings&tab=settings&checkUpdate=1",
        true,
    )?;
    Ok(())
}

#[cfg(debug_assertions)]
pub async fn open_dev_onboarding(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        show_and_focus_window(&win);
        app.emit_to("settings", DEV_ONBOARDING_REQUEST_EVENT, ())
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    create_settings_window(&app, "index.html?window=settings&onboarding=1", true)?;
    Ok(())
}
