use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::{logger, media_permissions};

#[path = "widget_display.rs"]
mod widget_display;

#[path = "widget_visibility.rs"]
mod widget_visibility;
use widget_visibility::{recover_offscreen_position, PhysicalRect};

#[cfg(windows)]
#[path = "widget_windows.rs"]
mod widget_windows;

const NOTICE_WINDOW_LABEL: &str = "widget-notice";
const TEXT_WINDOW_LABEL: &str = "widget-text";
const NOTICE_EVENT: &str = "widget-notice:update";
const TEXT_EVENT: &str = "widget-text:update";
pub const NOTICE_WIDTH: f64 = 212.0;
pub const NOTICE_HEIGHT: f64 = 52.0;
pub const TEXT_OVERLAY_WIDTH: f64 = 324.0;
pub const TEXT_OVERLAY_STREAM_WIDTH: f64 = 480.0;
pub const TEXT_OVERLAY_HEIGHT: f64 = 118.1;
/// Must match NOTICE_WIDGET_GAP in src/windows/widget/widgetConstants.ts (logical pixels).
pub const NOTICE_GAP: f64 = 2.0;
const TEXT_OVERLAY_GAP: f64 = 8.0;
/// Must match widgetStackWidth(false)/widgetStackHeight(false) in
/// src/windows/widget/widgetConstants.ts.
pub const WIDGET_WIDTH: f64 = 129.0;
pub const WIDGET_HEIGHT: f64 = 54.0;
const WIDGET_EXPANDED_OFFSET_RATIO: f64 = 0.20;

fn centered_resize_offset(current: f64, target: f64, expanded_offset_ratio: f64) -> f64 {
    let centered = (current - target) / 2.0;

    if target > current {
        centered - (target - current) * expanded_offset_ratio
    } else {
        centered
    }
}

pub fn configure_main_widget_window(win: &WebviewWindow) -> Result<(), String> {
    win.set_resizable(false).map_err(|e| e.to_string())?;
    win.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: WIDGET_WIDTH,
        height: WIDGET_HEIGHT,
    }))
    .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        let main_thread_window = win.clone();
        win.run_on_main_thread(move || unsafe {
            match main_thread_window.ns_window() {
                Ok(pointer) => {
                    let ns_win: &objc2_app_kit::NSWindow = &*pointer.cast();
                    ns_win.setAcceptsMouseMovedEvents(true);
                }
                Err(err) => logger::log_error(
                    "WINDOW",
                    &format!("Failed to configure widget mouse events: {err}"),
                ),
            }
        })
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn get_or_create_main_widget_window(app: &AppHandle) -> Result<(WebviewWindow, bool), String> {
    if let Some(win) = app.get_webview_window("widget") {
        return Ok((win, false));
    }

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "widget")
        .cloned()
        .ok_or_else(|| "Widget window configuration not found".to_string())?;
    let win = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| e.to_string())?
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    media_permissions::allow_microphone_requests(&win);
    configure_main_widget_window(&win)?;

    Ok((win, true))
}

fn keep_widget_on_available_monitor(win: &WebviewWindow) -> Result<bool, String> {
    let position = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let monitor_work_areas = win
        .available_monitors()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|monitor| {
            let work_area = monitor.work_area();
            PhysicalRect {
                x: i64::from(work_area.position.x),
                y: i64::from(work_area.position.y),
                width: i64::from(work_area.size.width),
                height: i64::from(work_area.size.height),
            }
        })
        .collect::<Vec<_>>();
    let window_rect = PhysicalRect {
        x: i64::from(position.x),
        y: i64::from(position.y),
        width: i64::from(size.width),
        height: i64::from(size.height),
    };

    let Some((x, y)) = recover_offscreen_position(window_rect, &monitor_work_areas) else {
        return Ok(false);
    };

    win.set_position(Position::Physical(PhysicalPosition { x, y }))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Restores the persistent widget without taking keyboard focus away from the
/// application in which the user is typing.
pub async fn restore_widget_window(
    app: &AppHandle,
    reason: &str,
    bring_to_front: bool,
) -> Result<bool, String> {
    // WebView2 creation must stay outside UI-thread event handlers on Windows.
    let (win, recreated) = get_or_create_main_widget_window(app)?;
    let handle = app.clone();
    let reason = reason.to_owned();
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.run_on_main_thread(move || {
        let _ = tx.send(restore_widget_on_main_thread(
            &handle,
            &win,
            recreated,
            &reason,
            bring_to_front,
        ));
    })
    .map_err(|e| e.to_string())?;

    rx.await
        .map_err(|e| format!("Widget restoration interrupted: {e}"))?
}

fn restore_widget_on_main_thread(
    app: &AppHandle,
    win: &WebviewWindow,
    recreated: bool,
    reason: &str,
    bring_to_front: bool,
) -> Result<bool, String> {
    #[cfg(windows)]
    widget_windows::log_presentation(win, reason)?;

    if !widget_display::is_visible(app) {
        if win.is_visible().map_err(|e| e.to_string())? {
            win.hide().map_err(|e| e.to_string())?;
        }

        return Ok(false);
    }

    let was_minimized = win.is_minimized().map_err(|e| e.to_string())?;
    let was_visible = win.is_visible().map_err(|e| e.to_string())?;

    if was_minimized {
        win.unminimize().map_err(|e| e.to_string())?;
    }
    if !was_visible {
        win.show().map_err(|e| e.to_string())?;
    }

    let repositioned = keep_widget_on_available_monitor(win)?;
    #[allow(unused_mut)]
    let mut restored = recreated || was_minimized || !was_visible || repositioned;
    if restored || bring_to_front {
        win.set_always_on_top(true).map_err(|e| e.to_string())?;
    }

    #[cfg(windows)]
    {
        if widget_windows::ensure_visible(win)? {
            logger::log_info(
                "WIDGET",
                &format!("Recovered native visibility: reason={reason}"),
            );
            restored = true;
        }
        let repaired_topmost = widget_windows::ensure_topmost(win, restored || bring_to_front)?;
        if repaired_topmost {
            logger::log_info(
                "WIDGET",
                &format!("Recovered native topmost flag: reason={reason}"),
            );
            restored = true;
        }
        widget_windows::log_presentation(win, reason)?;
    }

    #[cfg(target_os = "macos")]
    if bring_to_front {
        order_widget_window_front(app)?;
    }

    if restored {
        logger::log_info(
            "WIDGET",
            &format!(
                "Widget restored: reason={reason}, recreated={recreated}, was_visible={was_visible}, was_minimized={was_minimized}, repositioned={repositioned}"
            ),
        );
    }

    Ok(restored)
}

pub fn initialize_widget_visibility(app: &AppHandle) {
    widget_display::initialize(app);
    schedule_widget_restore(app, "startup");
}

pub fn schedule_widget_restore(app: &AppHandle, reason: &'static str) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = restore_widget_window(&handle, reason, false).await {
            logger::log_error(
                "WIDGET",
                &format!("Failed to restore widget ({reason}): {error}"),
            );
        }
    });
}

#[tauri::command]
pub async fn sync_widget_visibility(app: AppHandle) -> Result<(), String> {
    let visible = widget_display::read_saved_visibility(&app)?;
    let (win, recreated) = get_or_create_main_widget_window(&app)?;
    let handle = app.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.run_on_main_thread(move || {
        widget_display::set_visible(&handle, visible);
        let result =
            restore_widget_on_main_thread(&handle, &win, recreated, "settings", false).map(|_| ());
        logger::log_info("WIDGET", &format!("Widget visibility changed: {visible}"));
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;

    rx.await
        .map_err(|e| format!("Widget visibility update interrupted: {e}"))?
}

pub fn start_widget_watchdog(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let mut previous_error: Option<String> = None;

        loop {
            match restore_widget_window(&handle, "watchdog", false).await {
                Ok(_) => {
                    if previous_error.take().is_some() {
                        logger::log_info("WIDGET", "Widget watchdog recovered after an error");
                    }
                }
                Err(err) => {
                    if previous_error.as_deref() != Some(err.as_str()) {
                        logger::log_error(
                            "WIDGET",
                            &format!("Widget watchdog could not restore the window: {err}"),
                        );
                        previous_error = Some(err);
                    }
                }
            }

            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}

#[derive(Clone, Serialize)]
struct WidgetNoticePayload {
    message: String,
    tone: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetTextOverlayPayload {
    status: String,
    source_text: String,
    translated_text: String,
    target_language: String,
    request_id: Option<String>,
    message: Option<String>,
    live_segments: Option<Vec<serde_json::Value>>,
}

fn text_overlay_payload_store() -> &'static Mutex<Option<WidgetTextOverlayPayload>> {
    static STORE: OnceLock<Mutex<Option<WidgetTextOverlayPayload>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

fn text_overlay_open_request_store() -> &'static Mutex<Option<String>> {
    static STORE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

fn is_new_text_overlay_request(current: Option<&str>, next: Option<&str>) -> bool {
    let Some(next) = next
        .map(str::trim)
        .filter(|request_id| !request_id.is_empty())
    else {
        return true;
    };
    current != Some(next)
}

fn cached_text_overlay_payload() -> Result<Option<WidgetTextOverlayPayload>, String> {
    text_overlay_payload_store()
        .lock()
        .map_err(|e| format!("Text overlay state lock failed: {e}"))
        .map(|cached| cached.clone())
}

fn emit_cached_text_overlay_payload(app: &AppHandle) -> Result<(), String> {
    if let Some(payload) = cached_text_overlay_payload()? {
        app.emit_to(TEXT_WINDOW_LABEL, TEXT_EVENT, payload)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn should_ignore_text_overlay_payload(
    current: Option<&WidgetTextOverlayPayload>,
    next: &WidgetTextOverlayPayload,
) -> bool {
    let Some(current) = current else {
        return false;
    };

    let current_request_id = current.request_id.as_deref().unwrap_or_default();
    if current_request_id.is_empty() {
        return false;
    }

    if next.status == "copying" || next.status == "dictating" || next.status == "liveTranslation" {
        return false;
    }

    next.request_id.as_deref() != Some(current_request_id)
}

fn text_overlay_request_matches(
    current: Option<&WidgetTextOverlayPayload>,
    request_id: &str,
) -> bool {
    current.and_then(|payload| payload.request_id.as_deref()) == Some(request_id)
}

pub fn ensure_widget_notice_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(win) = app.get_webview_window(NOTICE_WINDOW_LABEL) {
        return Ok(win);
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        NOTICE_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=widget-notice".into()),
    )
    .title("Talkis Notice")
    .inner_size(NOTICE_WIDTH, NOTICE_HEIGHT)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .accept_first_mouse(true)
    .focused(false)
    .visible(false)
    .shadow(false);

    #[cfg(target_os = "linux")]
    {
        builder = builder.transparent(true).skip_taskbar(true);
    }

    #[cfg(not(target_os = "linux"))]
    {
        builder = builder.transparent(true).skip_taskbar(true);
    }

    let win = builder.build().map_err(|e| e.to_string())?;
    media_permissions::allow_microphone_requests(&win);

    Ok(win)
}

pub fn ensure_widget_text_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(win) = app.get_webview_window(TEXT_WINDOW_LABEL) {
        return Ok(win);
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        TEXT_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=widget-text".into()),
    )
    .title("Talkis Text")
    .inner_size(TEXT_OVERLAY_WIDTH, TEXT_OVERLAY_HEIGHT)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .accept_first_mouse(true)
    .focused(false)
    .visible(false)
    .shadow(false);

    #[cfg(target_os = "linux")]
    {
        builder = builder.transparent(true).skip_taskbar(true);
    }

    #[cfg(not(target_os = "linux"))]
    {
        builder = builder.transparent(true).skip_taskbar(true);
    }

    let win = builder.build().map_err(|e| e.to_string())?;
    media_permissions::allow_microphone_requests(&win);

    Ok(win)
}

/// Maximum expanded height for the notice bubble (logical px) — keeps a very long
/// hint from running off the top of the screen.
pub const NOTICE_MAX_HEIGHT: f64 = 360.0;

fn position_widget_notice_window(
    widget_window: &tauri::WebviewWindow,
    notice_window: &tauri::WebviewWindow,
    height: f64,
) -> Result<(), String> {
    let widget_position = widget_window.outer_position().map_err(|e| e.to_string())?;
    let widget_size = widget_window.outer_size().map_err(|e| e.to_string())?;
    let scale_factor = widget_window.scale_factor().map_err(|e| e.to_string())?;
    let notice_width = NOTICE_WIDTH * scale_factor;
    let notice_height = height * scale_factor;
    let notice_gap = NOTICE_GAP * scale_factor;
    let x = widget_position.x as f64 + (widget_size.width as f64 - notice_width) / 2.0;
    // Anchor the bubble's bottom edge just above the widget, so it grows upward.
    let y = widget_position.y as f64 - notice_gap - notice_height;

    notice_window
        .set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: NOTICE_WIDTH,
            height,
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

fn position_widget_text_window(
    widget_window: &tauri::WebviewWindow,
    text_window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let widget_position = widget_window.outer_position().map_err(|e| e.to_string())?;
    let widget_size = widget_window.outer_size().map_err(|e| e.to_string())?;
    let scale_factor = widget_window.scale_factor().map_err(|e| e.to_string())?;
    let text_width = width * scale_factor;
    let text_height = height * scale_factor;
    let gap = TEXT_OVERLAY_GAP * scale_factor;
    let centered_x = widget_position.x as f64 + (widget_size.width as f64 - text_width) / 2.0;
    let x = match widget_window.current_monitor().map_err(|e| e.to_string())? {
        Some(monitor) => {
            let margin = 8.0 * scale_factor;
            let minimum = monitor.position().x as f64 + margin;
            let maximum =
                monitor.position().x as f64 + monitor.size().width as f64 - text_width - margin;
            if maximum >= minimum {
                centered_x.clamp(minimum, maximum)
            } else {
                minimum
            }
        }
        None => centered_x,
    };
    let y = widget_position.y as f64 - gap - text_height;

    text_window
        .set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }))
        .map_err(|e| e.to_string())?;

    text_window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: x.round() as i32,
            y: y.round() as i32,
        }))
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn text_overlay_height(_payload: &WidgetTextOverlayPayload) -> f64 {
    TEXT_OVERLAY_HEIGHT
}

fn text_overlay_width(payload: &WidgetTextOverlayPayload) -> f64 {
    if payload.status == "dictating" || payload.status == "liveTranslation" {
        TEXT_OVERLAY_STREAM_WIDTH
    } else {
        TEXT_OVERLAY_WIDTH
    }
}

#[cfg(target_os = "macos")]
fn order_widget_window_front(app: &AppHandle) -> Result<(), String> {
    use objc2_app_kit::NSWindowCollectionBehavior;

    // The restore entry point already runs on the UI thread.
    let Some(win) = app.get_webview_window("widget") else {
        return Ok(());
    };

    unsafe {
        let ns_win: &objc2_app_kit::NSWindow = &*win.ns_window().map_err(|e| e.to_string())?.cast();
        ns_win.setCollectionBehavior(
            ns_win.collectionBehavior()
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary,
        );
        ns_win.orderFrontRegardless();
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn resize_widget_window(
    app: &AppHandle,
    width: f64,
    height: f64,
    expanded_offset_ratio: f64,
) -> Result<(), String> {
    use std::sync::mpsc;

    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let Some(win) = handle.get_webview_window("widget") else {
                return Ok(());
            };

            unsafe {
                let ns_win: &objc2_app_kit::NSWindow =
                    &*win.ns_window().map_err(|e| e.to_string())?.cast();
                let frame = ns_win.frame();
                // NSWindow frames are measured in macOS points, matching Tauri
                // logical sizes. Do not multiply by scale factor here, or the
                // resize anchor drifts away from the visible widget center.
                let target_width = width;
                let target_height = height;
                let next_x = frame.origin.x
                    + centered_resize_offset(frame.size.width, target_width, expanded_offset_ratio);
                let next_y = frame.origin.y
                    + centered_resize_offset(
                        frame.size.height,
                        target_height,
                        expanded_offset_ratio,
                    );
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
fn calculate_default_widget_position(
    monitor: &tauri::Monitor,
    width: f64,
    height: f64,
) -> tauri::PhysicalPosition<i32> {
    let scale_factor = monitor.scale_factor();
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let target_width = width * scale_factor;
    let target_height = height * scale_factor;
    let x = monitor_position.x as f64 + (monitor_size.width as f64 - target_width) / 2.0;
    let y = monitor_position.y as f64 + monitor_size.height as f64 - target_height;

    tauri::PhysicalPosition {
        x: x.round() as i32,
        y: y.round() as i32,
    }
}

#[cfg(not(target_os = "macos"))]
fn resize_widget_window(
    app: &AppHandle,
    width: f64,
    height: f64,
    expanded_offset_ratio: f64,
) -> Result<(), String> {
    use crate::logger;

    if let Some(win) = app.get_webview_window("widget") {
        let current_position = win.outer_position().ok();
        let current_size = win.outer_size().ok();
        let scale_factor = win.scale_factor().unwrap_or(1.0);

        if let Err(err) = win.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height })) {
            logger::log_error(
                "WINDOW",
                &format!("Failed to resize widget window: {}", err),
            );
        }

        if let (Some(position), Some(size)) = (current_position, current_size) {
            let target_width = width * scale_factor;
            let target_height = height * scale_factor;
            let x = position.x as f64
                + centered_resize_offset(size.width as f64, target_width, expanded_offset_ratio);
            let y = position.y as f64
                + centered_resize_offset(size.height as f64, target_height, expanded_offset_ratio);

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
                logger::log_error(
                    "WINDOW",
                    &format!("Failed to reposition widget window: {}", err),
                );
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn show_widget_notice(
    app: AppHandle,
    message: String,
    tone: String,
    _anchor_state: String,
) -> Result<(), String> {
    let widget_window = app
        .get_webview_window("widget")
        .ok_or_else(|| "Widget window not found".to_string())?;
    let notice_window = ensure_widget_notice_window(&app)?;

    // Always (re)show collapsed; the overlay expands on click.
    position_widget_notice_window(&widget_window, &notice_window, NOTICE_HEIGHT)?;

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
pub async fn show_widget_text_overlay(
    app: AppHandle,
    payload: WidgetTextOverlayPayload,
) -> Result<(), String> {
    let request_id = payload
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|request_id| !request_id.is_empty())
        .map(str::to_string);
    {
        let mut cached = text_overlay_payload_store()
            .lock()
            .map_err(|e| format!("Text overlay state lock failed: {e}"))?;
        if should_ignore_text_overlay_payload(cached.as_ref(), &payload) {
            return Ok(());
        }
        *cached = Some(payload.clone());
    }
    let opens_new_request = {
        let opened_request = text_overlay_open_request_store()
            .lock()
            .map_err(|e| format!("Text overlay request lock failed: {e}"))?;
        is_new_text_overlay_request(opened_request.as_deref(), request_id.as_deref())
    };

    let widget_window = app
        .get_webview_window("widget")
        .ok_or_else(|| "Widget window not found".to_string())?;
    let text_window = ensure_widget_text_window(&app)?;
    let was_visible = text_window.is_visible().unwrap_or(false);

    if opens_new_request {
        position_widget_text_window(
            &widget_window,
            &text_window,
            text_overlay_width(&payload),
            text_overlay_height(&payload),
        )?;
    }
    let _ = text_window.set_ignore_cursor_events(false);

    app.emit_to(TEXT_WINDOW_LABEL, TEXT_EVENT, payload)
        .map_err(|e| e.to_string())?;
    if opens_new_request && !was_visible {
        text_window.show().map_err(|e| e.to_string())?;
    }
    if opens_new_request {
        *text_overlay_open_request_store()
            .lock()
            .map_err(|e| format!("Text overlay request lock failed: {e}"))? = request_id;
    }
    Ok(())
}

#[tauri::command]
pub async fn widget_text_overlay_ready(app: AppHandle) -> Result<(), String> {
    emit_cached_text_overlay_payload(&app)
}

#[tauri::command]
pub async fn get_widget_text_overlay_payload() -> Result<Option<WidgetTextOverlayPayload>, String> {
    cached_text_overlay_payload()
}

#[tauri::command]
pub async fn hide_widget_text_overlay(app: AppHandle) -> Result<(), String> {
    hide_widget_text_overlay_inner(&app, None)
}

#[tauri::command]
pub async fn hide_widget_text_overlay_request(
    app: AppHandle,
    request_id: String,
) -> Result<(), String> {
    hide_widget_text_overlay_inner(&app, Some(request_id.trim()))
}

fn hide_widget_text_overlay_inner(
    app: &AppHandle,
    expected_request_id: Option<&str>,
) -> Result<(), String> {
    let mut cached = text_overlay_payload_store()
        .lock()
        .map_err(|e| format!("Text overlay state lock failed: {e}"))?;
    if let Some(request_id) = expected_request_id {
        if !text_overlay_request_matches(cached.as_ref(), request_id) {
            return Ok(());
        }
    }

    let mut opened_request = text_overlay_open_request_store()
        .lock()
        .map_err(|e| format!("Text overlay request lock failed: {e}"))?;
    *cached = None;
    *opened_request = None;

    if let Some(win) = app.get_webview_window(TEXT_WINDOW_LABEL) {
        let _ = app.emit_to(
            TEXT_WINDOW_LABEL,
            TEXT_EVENT,
            Option::<WidgetTextOverlayPayload>::None,
        );
        win.hide().map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Resize the notice bubble to fit its full text on click (or back to the
/// collapsed height). Re-anchors above the widget so it grows upward.
#[tauri::command]
pub async fn expand_widget_notice(app: AppHandle, height: f64) -> Result<(), String> {
    let widget_window = app
        .get_webview_window("widget")
        .ok_or_else(|| "Widget window not found".to_string())?;
    let notice_window = app
        .get_webview_window(NOTICE_WINDOW_LABEL)
        .ok_or_else(|| "Notice window not found".to_string())?;
    let clamped = height.clamp(NOTICE_HEIGHT, NOTICE_MAX_HEIGHT);
    position_widget_notice_window(&widget_window, &notice_window, clamped)
}

#[tauri::command]
pub async fn widget_resize(
    app: AppHandle,
    width: f64,
    height: f64,
    growth_offset_ratio: Option<f64>,
) -> Result<(), String> {
    let expanded_offset_ratio = growth_offset_ratio
        .unwrap_or(WIDGET_EXPANDED_OFFSET_RATIO)
        .clamp(0.0, 1.0);
    resize_widget_window(&app, width, height, expanded_offset_ratio)
}

#[tauri::command]
pub async fn activate_widget_for_hotkey(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    crate::paste::remember_linux_paste_target_window();

    restore_widget_window(&app, "hotkey", true).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        is_new_text_overlay_request, should_ignore_text_overlay_payload,
        text_overlay_request_matches, text_overlay_width, WidgetTextOverlayPayload,
        TEXT_OVERLAY_STREAM_WIDTH, TEXT_OVERLAY_WIDTH,
    };

    fn overlay_payload(status: &str, request_id: &str) -> WidgetTextOverlayPayload {
        WidgetTextOverlayPayload {
            status: status.to_string(),
            source_text: String::new(),
            translated_text: String::new(),
            target_language: String::new(),
            request_id: Some(request_id.to_string()),
            message: None,
            live_segments: None,
        }
    }

    #[test]
    fn text_overlay_opens_only_once_for_the_same_request() {
        assert!(is_new_text_overlay_request(None, Some("request-1")));
        assert!(!is_new_text_overlay_request(
            Some("request-1"),
            Some("request-1")
        ));
        assert!(is_new_text_overlay_request(
            Some("request-1"),
            Some("request-2")
        ));
        assert!(is_new_text_overlay_request(Some("request-1"), None));
    }

    #[test]
    fn selection_copy_replaces_visible_request_but_stale_progress_does_not() {
        let current = overlay_payload("done", "selection-1");
        let replacement = overlay_payload("copying", "selection-2");
        let stale_progress = overlay_payload("translating", "selection-1");

        assert!(!should_ignore_text_overlay_payload(
            Some(&current),
            &replacement
        ));
        assert!(should_ignore_text_overlay_payload(
            Some(&replacement),
            &stale_progress
        ));
    }

    #[test]
    fn request_scoped_hide_cannot_close_a_newer_overlay() {
        let current = overlay_payload("copying", "selection-2");

        assert!(!text_overlay_request_matches(Some(&current), "selection-1"));
        assert!(text_overlay_request_matches(Some(&current), "selection-2"));
    }

    #[test]
    fn streaming_overlays_use_the_wider_window() {
        assert_eq!(
            text_overlay_width(&overlay_payload("dictating", "dictation-1")),
            TEXT_OVERLAY_STREAM_WIDTH
        );
        assert_eq!(
            text_overlay_width(&overlay_payload("liveTranslation", "live-1")),
            TEXT_OVERLAY_STREAM_WIDTH
        );
        assert_eq!(
            text_overlay_width(&overlay_payload("done", "selection-1")),
            TEXT_OVERLAY_WIDTH
        );
    }
}
