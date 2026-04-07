mod ai;
mod commands;
mod hotkey_capture;
mod logger;
mod paste;
mod prompt_config;

use commands::{
    accessibility, runtime_info, settings_window,
    widget::{self, WIDGET_HEIGHT, WIDGET_WIDTH},
};
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            logger::log_info("INIT", "Application starting...");
            let _ = widget::ensure_widget_notice_window(app.handle());

            if let Some(win) = app.get_webview_window("widget") {
                #[cfg(target_os = "macos")]
                {
                    unsafe {
                        let ns_win: &objc2_app_kit::NSWindow =
                            &*win.ns_window().map_err(|e| e.to_string())?.cast();
                        ns_win.setAcceptsMouseMovedEvents(true);
                    }
                }

                if let Ok(Some(monitor)) = win.primary_monitor() {
                    if let Err(err) = win.set_size(tauri::Size::Logical(tauri::LogicalSize {
                        width: WIDGET_WIDTH,
                        height: WIDGET_HEIGHT,
                    })) {
                        logger::log_error(
                            "WINDOW",
                            &format!("Failed to size widget window during setup: {}", err),
                        );
                    }

                    let position = widget::calculate_default_widget_position(
                        &monitor,
                        WIDGET_WIDTH,
                        WIDGET_HEIGHT,
                    );
                    if let Err(err) = win.set_position(tauri::Position::Physical(position)) {
                        logger::log_error(
                            "WINDOW",
                            &format!("Failed to position widget window during setup: {}", err),
                        );
                    }
                }
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let _ = settings_window::open_settings(handle).await;
            });

            // ── Deep link handling ──────────────────────────
            // Check if app was launched via deep link
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in &urls {
                    logger::log_info("DEEP_LINK", &format!("Startup deep link: {}", url));
                    if let Some(token) = extract_auth_token(url.as_str()) {
                        let _ = app.emit("deep-link-auth", token);
                    }
                }
            }

            // Listen for deep links while running
            let handle_for_dl = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    logger::log_info("DEEP_LINK", &format!("Runtime deep link: {}", url));
                    if let Some(token) = extract_auth_token(url.as_str()) {
                        let _ = handle_for_dl.emit("deep-link-auth", token.clone());
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_window::open_settings,
            settings_window::open_settings_tab,
            widget::widget_resize,
            widget::show_widget_notice,
            widget::hide_widget_notice,
            paste::paste_text,
            ai::transcribe_and_clean,
            ai::test_api_connection,
            logger::log_event,
            logger::get_log_path_cmd,
            logger::clear_logs,
            accessibility::open_accessibility_settings,
            accessibility::reset_accessibility_permission,
            accessibility::check_accessibility_permission,
            runtime_info::get_app_runtime_info,
            get_cleanup_prompt_preview,
            start_native_hotkey_capture,
            stop_native_hotkey_capture,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Talkis");
}

#[tauri::command]
fn get_cleanup_prompt_preview(
    language: String,
    style: String,
) -> Result<prompt_config::PromptPreview, String> {
    prompt_config::build_cleanup_prompt_preview(&language, &style)
}

#[tauri::command]
fn start_native_hotkey_capture(window: tauri::WebviewWindow) -> Result<(), String> {
    hotkey_capture::start_capture(&window)
}

#[tauri::command]
fn stop_native_hotkey_capture(window: tauri::WebviewWindow) -> Result<(), String> {
    hotkey_capture::stop_capture(&window)
}

/// Extract token from `talkis://auth?token=<jwt>` URLs.
fn extract_auth_token(url_str: &str) -> Option<String> {
    // Parse talkis://auth?token=xxx or talkis://auth/callback?token=xxx
    if let Ok(url) = url::Url::parse(url_str) {
        for (key, value) in url.query_pairs() {
            if key == "token" && !value.is_empty() {
                return Some(value.into_owned());
            }
        }
    }
    None
}
