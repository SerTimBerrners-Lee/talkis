mod ai;
mod hotkey_capture;
mod logger;
mod paste;
mod prompt_config;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

const NOTICE_WINDOW_LABEL: &str = "widget-notice";
const NOTICE_EVENT: &str = "widget-notice:update";
const SETTINGS_NAVIGATE_EVENT: &str = "settings-navigate";
const APP_BUNDLE_ID: &str = "com.trixter.talkflow";
const NOTICE_WIDTH: f64 = 212.0;
const NOTICE_HEIGHT: f64 = 52.0;
const NOTICE_GAP: f64 = 2.0;
const WIDGET_DEFAULT_BOTTOM_MARGIN: i32 = 16;
const WIDGET_WIDTH: f64 = 50.0;
const WIDGET_HEIGHT: f64 = 18.0;

#[derive(Clone, Serialize)]
struct WidgetNoticePayload {
    message: String,
    tone: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppRuntimeInfo {
    executable_path: String,
    bundle_path: String,
    launched_via_translocation: bool,
    launched_from_mounted_volume: bool,
    should_move_to_applications: bool,
}

fn ensure_widget_notice_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(win) = app.get_webview_window(NOTICE_WINDOW_LABEL) {
        return Ok(win);
    }

    let win = WebviewWindowBuilder::new(
        app,
        NOTICE_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=widget-notice".into()),
    )
    .title("Talk Flow Notice")
    .inner_size(NOTICE_WIDTH, NOTICE_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .accept_first_mouse(true)
    .focused(false)
    .visible(false)
    .shadow(false)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(win)
}

fn position_widget_notice_window(
    widget_window: &tauri::WebviewWindow,
    notice_window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let widget_position = widget_window.outer_position().map_err(|e| e.to_string())?;
    let widget_size = widget_window.outer_size().map_err(|e| e.to_string())?;
    let scale_factor = widget_window.scale_factor().map_err(|e| e.to_string())?;
    let notice_width = NOTICE_WIDTH * scale_factor;
    let notice_height = NOTICE_HEIGHT * scale_factor;
    let notice_gap = NOTICE_GAP * scale_factor;
    let x = widget_position.x as f64 + (widget_size.width as f64 - notice_width) / 2.0;
    let y = widget_position.y as f64 - notice_gap - notice_height;

    notice_window
        .set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: NOTICE_WIDTH,
            height: NOTICE_HEIGHT,
        }))
        .map_err(|e| e.to_string())?;

    notice_window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: x.round() as i32,
            y: y.round() as i32,
        }))
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn calculate_default_widget_position(
    monitor: &tauri::Monitor,
    width: f64,
    height: f64,
) -> tauri::PhysicalPosition<i32> {
    let work_area = monitor.work_area();
    let scale_factor = monitor.scale_factor();
    let width_px = (width * scale_factor).round() as i32;
    let height_px = (height * scale_factor).round() as i32;
    let bottom_margin_px = ((WIDGET_DEFAULT_BOTTOM_MARGIN as f64) * scale_factor).round() as i32;
    let x = work_area.position.x + ((work_area.size.width as i32 - width_px) / 2);
    let y = work_area.position.y + work_area.size.height as i32 - height_px - bottom_margin_px;

    tauri::PhysicalPosition { x, y }
}

#[tauri::command]
async fn show_widget_notice(app: AppHandle, message: String, tone: String, _anchor_state: String) -> Result<(), String> {
    let widget_window = app
        .get_webview_window("widget")
        .ok_or_else(|| "Widget window not found".to_string())?;
    let notice_window = ensure_widget_notice_window(&app)?;

    position_widget_notice_window(&widget_window, &notice_window)?;

    app.emit_to(
        NOTICE_WINDOW_LABEL,
        NOTICE_EVENT,
        WidgetNoticePayload { message, tone },
    )
    .map_err(|e| e.to_string())?;

    let _ = notice_window.set_ignore_cursor_events(false);
    notice_window.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn hide_widget_notice(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(NOTICE_WINDOW_LABEL) {
        win.hide().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> u8;
}

fn build_runtime_info() -> Result<AppRuntimeInfo, String> {
    let executable_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let executable_path_str = executable_path.to_string_lossy().to_string();
    let bundle_path = executable_path
        .ancestors()
        .find(|path| path.extension().map(|ext| ext == "app").unwrap_or(false))
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|| executable_path.clone());
    let bundle_path_str = bundle_path.to_string_lossy().to_string();
    let launched_via_translocation = executable_path_str.contains("/AppTranslocation/");
    let launched_from_mounted_volume = bundle_path_str.starts_with("/Volumes/");

    Ok(AppRuntimeInfo {
        executable_path: executable_path_str,
        bundle_path: bundle_path_str,
        launched_via_translocation,
        launched_from_mounted_volume,
        should_move_to_applications: launched_via_translocation || launched_from_mounted_volume,
    })
}

#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        if let Err(err) = win.show() {
            logger::log_error("WINDOW", &format!("Failed to show settings window: {}", err));
        }
        if let Err(err) = win.set_focus() {
            logger::log_error("WINDOW", &format!("Failed to focus settings window: {}", err));
        }
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App("index.html?window=settings".into()),
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

    if let Err(err) = win.show() {
        logger::log_error(
            "WINDOW",
            &format!("Failed to show new settings window: {}", err),
        );
    }
    if let Err(err) = win.set_focus() {
        logger::log_error(
            "WINDOW",
            &format!("Failed to focus new settings window: {}", err),
        );
    }

    Ok(())
}

#[tauri::command]
async fn open_settings_tab(app: AppHandle, tab: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        if let Err(err) = win.show() {
            logger::log_error("WINDOW", &format!("Failed to show settings window: {}", err));
        }
        if let Err(err) = win.set_focus() {
            logger::log_error("WINDOW", &format!("Failed to focus settings window: {}", err));
        }

        app.emit_to("settings", SETTINGS_NAVIGATE_EVENT, serde_json::json!({ "tab": tab }))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = format!("index.html?window=settings&tab={}", tab);

    let win = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url.into()))
        .title("Talk Flow - Settings")
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

    if let Err(err) = win.show() {
        logger::log_error(
            "WINDOW",
            &format!("Failed to show new settings window: {}", err),
        );
    }
    if let Err(err) = win.set_focus() {
        logger::log_error(
            "WINDOW",
            &format!("Failed to focus new settings window: {}", err),
        );
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn resize_widget_window(app: &AppHandle, width: f64, height: f64) -> Result<(), String> {
    use std::sync::mpsc;

    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let Some(win) = handle.get_webview_window("widget") else {
                return Ok(());
            };

            let scale_factor = win.scale_factor().unwrap_or(1.0);

            unsafe {
                let ns_win: &objc2_app_kit::NSWindow =
                    &*win.ns_window().map_err(|e| e.to_string())?.cast();
                let frame = ns_win.frame();
                let target_width = width * scale_factor;
                let target_height = height * scale_factor;
                let next_x = frame.origin.x + (frame.size.width - target_width) / 2.0;
                let next_y = frame.origin.y + frame.size.height - target_height;
                let next_frame = objc2_foundation::NSRect::new(
                    objc2_foundation::NSPoint::new(next_x, next_y),
                    objc2_foundation::NSSize::new(target_width, target_height),
                );

                ns_win.setFrame_display(next_frame, true);
            }

            Ok(())
        })();

        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;

    rx.recv()
        .map_err(|e| format!("Failed to receive resize result: {}", e))?
}

#[cfg(not(target_os = "macos"))]
fn resize_widget_window(app: &AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("widget") {
        let current_position = win.outer_position().ok();
        let current_size = win.outer_size().ok();
        let scale_factor = win.scale_factor().unwrap_or(1.0);

        if let Err(err) = win.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height })) {
            logger::log_error("WINDOW", &format!("Failed to resize widget window: {}", err));
        }

        if let (Some(position), Some(size)) = (current_position, current_size) {
            let target_width = width * scale_factor;
            let target_height = height * scale_factor;
            let x = position.x as f64 + (size.width as f64 - target_width) / 2.0;
            let y = position.y as f64 + size.height as f64 - target_height;

            if let Err(err) = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: x.round() as i32,
                y: y.round() as i32,
            })) {
                logger::log_error(
                    "WINDOW",
                    &format!("Failed to preserve widget position on resize: {}", err),
                );
            }
        } else if let Ok(Some(monitor)) = win.primary_monitor() {
            let position = calculate_default_widget_position(&monitor, width, height);
            if let Err(err) = win.set_position(tauri::Position::Physical(position)) {
                logger::log_error("WINDOW", &format!("Failed to reposition widget window: {}", err));
            }
        }
    }

    Ok(())
}

#[tauri::command]
async fn widget_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    resize_widget_window(&app, width, height)
}

#[tauri::command]
async fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map_err(|e| format!("Failed to open accessibility settings: {}", e))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        // On Windows/Linux, accessibility is usually not required for global shortcuts
    }
    Ok(())
}

#[tauri::command]
async fn reset_accessibility_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("tccutil")
            .arg("reset")
            .arg("Accessibility")
            .arg(APP_BUNDLE_ID)
            .status()
            .map_err(|e| format!("Failed to reset accessibility permission: {}", e))?;

        if !status.success() {
            return Err(format!(
                "tccutil reset Accessibility {} failed with status {}",
                APP_BUNDLE_ID, status
            ));
        }
    }

    Ok(())
}

#[tauri::command]
async fn check_accessibility_permission() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let trusted = unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) != 0 };
        if trusted {
            return Ok(true);
        }

        return Ok(unsafe { AXIsProcessTrusted() != 0 });
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

#[tauri::command]
fn get_app_runtime_info() -> Result<AppRuntimeInfo, String> {
    build_runtime_info()
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            logger::log_info("INIT", "Application starting...");
            let _ = ensure_widget_notice_window(app.handle());

            if let Some(win) = app.get_webview_window("widget") {
                #[cfg(target_os = "macos")]
                {
                    unsafe {
                        let ns_win: &objc2_app_kit::NSWindow =
                            &*win.ns_window().map_err(|e| e.to_string())?.cast();
                        ns_win.setAcceptsMouseMovedEvents(true);
                    }
                }
                let width = WIDGET_WIDTH;
                let height = WIDGET_HEIGHT;

                if let Ok(Some(monitor)) = win.primary_monitor() {
                    if let Err(err) = win.set_size(tauri::Size::Logical(tauri::LogicalSize {
                        width,
                        height,
                    })) {
                        logger::log_error(
                            "WINDOW",
                            &format!("Failed to size widget window during setup: {}", err),
                        );
                    }

                    let position = calculate_default_widget_position(&monitor, width, height);
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
                let _ = open_settings(handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_settings,
            open_settings_tab,
            widget_resize,
            show_widget_notice,
            hide_widget_notice,
            paste::paste_text,
            ai::transcribe_and_clean,
            logger::log_event,
            logger::get_log_path_cmd,
            logger::clear_logs,
            open_accessibility_settings,
            reset_accessibility_permission,
            check_accessibility_permission,
            get_app_runtime_info,
            get_cleanup_prompt_preview,
            start_native_hotkey_capture,
            stop_native_hotkey_capture,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Talk Flow");
}
