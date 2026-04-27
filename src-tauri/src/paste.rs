use std::sync::mpsc;
use std::time::Duration;

use crate::logger;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

#[cfg(target_os = "macos")]
fn ensure_input_event_permission() -> Result<(), String> {
    let trusted = unsafe { AXIsProcessTrusted() != 0 };
    if trusted {
        return Ok(());
    }

    Err("Accessibility permission is required to paste text into other apps".into())
}

#[cfg(not(target_os = "macos"))]
fn ensure_input_event_permission() -> Result<(), String> {
    Ok(())
}

/// Simulate Cmd+V using CoreGraphics directly.
///
/// Unlike enigo (which sends separate Meta-press and V-click events that can
/// race), this creates key events with the Command flag baked into each event.
/// macOS always sees the V keystroke as "Cmd+V", eliminating the intermittent
/// bug where a bare "v" character is typed instead of paste.
#[cfg(target_os = "macos")]
fn simulate_cmd_v() -> Result<(), String> {
    use std::ffi::c_void;

    type CGEventRef = *mut c_void;
    type CGEventSourceRef = *mut c_void;

    // kCGEventSourceStateCombinedSessionState
    const COMBINED_SESSION_STATE: i32 = 1;
    // kCGHIDEventTap
    const HID_EVENT_TAP: i32 = 0;
    // NX_COMMANDMASK
    const COMMAND_FLAG: u64 = 0x0010_0000;

    extern "C" {
        fn CGEventSourceCreate(state_id: i32) -> CGEventSourceRef;
        fn CGEventCreateKeyboardEvent(
            source: CGEventSourceRef,
            keycode: u16,
            key_down: bool,
        ) -> CGEventRef;
        fn CGEventSetFlags(event: CGEventRef, flags: u64);
        fn CGEventPost(tap: i32, event: CGEventRef);
        fn CFRelease(cf: *const c_void);
    }

    unsafe {
        let source = CGEventSourceCreate(COMBINED_SESSION_STATE);
        if source.is_null() {
            return Err("CGEventSourceCreate returned null".into());
        }

        // V key down with Command flag
        let key_down = CGEventCreateKeyboardEvent(source, 0x09, true);
        if key_down.is_null() {
            CFRelease(source as *const c_void);
            return Err("CGEventCreateKeyboardEvent (down) returned null".into());
        }
        CGEventSetFlags(key_down, COMMAND_FLAG);
        CGEventPost(HID_EVENT_TAP, key_down);

        std::thread::sleep(Duration::from_millis(20));

        // V key up with Command flag
        let key_up = CGEventCreateKeyboardEvent(source, 0x09, false);
        if key_up.is_null() {
            CFRelease(key_down as *const c_void);
            CFRelease(source as *const c_void);
            return Err("CGEventCreateKeyboardEvent (up) returned null".into());
        }
        CGEventSetFlags(key_up, COMMAND_FLAG);
        CGEventPost(HID_EVENT_TAP, key_up);

        CFRelease(key_up as *const c_void);
        CFRelease(key_down as *const c_void);
        CFRelease(source as *const c_void);
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn simulate_cmd_v() -> Result<(), String> {
    use enigo::{Enigo, Key, Keyboard, Settings};

    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|e| format!("Input init failed: {}", e))?;
    enigo
        .key(Key::Control, enigo::Direction::Press)
        .map_err(|e| format!("Ctrl press failed: {}", e))?;
    enigo
        .key(Key::Unicode('v'), enigo::Direction::Click)
        .map_err(|e| format!("V click failed: {}", e))?;
    enigo
        .key(Key::Control, enigo::Direction::Release)
        .map_err(|e| format!("Ctrl release failed: {}", e))?;
    Ok(())
}

/// Paste text by writing to clipboard and simulating Cmd+V
#[tauri::command]
pub async fn paste_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    ensure_input_event_permission()?;

    let char_count = text.chars().count();
    let previous_clipboard_text = app.clipboard().read_text().ok();

    logger::log_info(
        "PASTE",
        &format!("Scheduling paste on main thread, chars={}", char_count),
    );

    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            logger::log_info(
                "PASTE",
                &format!("Writing text to clipboard, chars={}", char_count),
            );
            handle
                .clipboard()
                .write_text(text)
                .map_err(|e| format!("Clipboard write failed: {}", e))?;

            std::thread::sleep(Duration::from_millis(100));

            logger::log_info("PASTE", "Simulating Cmd+V via CGEvent");
            simulate_cmd_v()?;

            std::thread::sleep(Duration::from_millis(350));

            if let Some(previous_text) = previous_clipboard_text {
                logger::log_info("PASTE", "Restoring previous clipboard text after paste");
                handle
                    .clipboard()
                    .write_text(previous_text)
                    .map_err(|e| format!("Clipboard restore failed: {}", e))?;
            } else {
                logger::log_info("PASTE", "Previous clipboard text unavailable, clearing clipboard");
                handle
                    .clipboard()
                    .clear()
                    .map_err(|e| format!("Clipboard clear failed: {}", e))?;
            }

            Ok(())
        })();

        if let Err(err) = &result {
            logger::log_error("PASTE", err);
        } else {
            logger::log_info("PASTE", "Paste completed on main thread");
        }

        let _ = tx.send(result);
    })
    .map_err(|e| format!("Failed to schedule paste on main thread: {}", e))?;

    tokio::task::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| format!("Failed waiting for paste completion: {}", e))?
        .map_err(|e| format!("Failed receiving paste result: {}", e))??;

    Ok(())
}
