use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const NOTICE_WINDOW_LABEL: &str = "widget-notice";
const NOTICE_EVENT: &str = "widget-notice:update";
pub const NOTICE_WIDTH: f64 = 212.0;
pub const NOTICE_HEIGHT: f64 = 52.0;
/// Must match NOTICE_WIDGET_GAP in src/windows/widget/widgetConstants.ts (logical pixels).
pub const NOTICE_GAP: f64 = 2.0;
pub const WIDGET_WIDTH: f64 = 50.0;
pub const WIDGET_HEIGHT: f64 = 18.0;

#[derive(Clone, Serialize)]
struct WidgetNoticePayload {
    message: String,
    tone: String,
}

pub fn ensure_widget_notice_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(win) = app.get_webview_window(NOTICE_WINDOW_LABEL) {
        return Ok(win);
    }

    let win = WebviewWindowBuilder::new(
        app,
        NOTICE_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=widget-notice".into()),
    )
    .title("Talkis Notice")
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
    use crate::logger;

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
pub async fn show_widget_notice(app: AppHandle, message: String, tone: String, _anchor_state: String) -> Result<(), String> {
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
pub async fn hide_widget_notice(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(NOTICE_WINDOW_LABEL) {
        win.hide().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn widget_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    resize_widget_window(&app, width, height)
}
