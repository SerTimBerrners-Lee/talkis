use std::sync::mpsc;
use std::time::Duration;

use crate::logger;

#[cfg(target_os = "linux")]
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "linux")]
static LINUX_PASTE_TARGET_WINDOW: OnceLock<Mutex<Option<LinuxPasteTarget>>> = OnceLock::new();

#[cfg(target_os = "linux")]
#[derive(Clone, Debug)]
struct LinuxPasteTarget {
    window: u32,
    wm_class: String,
    title: String,
}

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

#[cfg(target_os = "linux")]
fn paste_target_window() -> &'static Mutex<Option<LinuxPasteTarget>> {
    LINUX_PASTE_TARGET_WINDOW.get_or_init(|| Mutex::new(None))
}

#[cfg(target_os = "linux")]
fn read_linux_window_property(
    conn: &impl x11rb::connection::Connection,
    window: u32,
    property: &[u8],
    type_atom: x11rb::protocol::xproto::AtomEnum,
) -> Result<String, String> {
    use x11rb::protocol::xproto::ConnectionExt;

    let property_atom = conn
        .intern_atom(false, property)
        .map_err(|err| format!("Failed to request X11 atom {:?}: {}", property, err))?
        .reply()
        .map_err(|err| format!("Failed to resolve X11 atom {:?}: {}", property, err))?
        .atom;
    let reply = conn
        .get_property(false, window, property_atom, type_atom, 0, 1024)
        .map_err(|err| format!("Failed to request X11 property {:?}: {}", property, err))?
        .reply()
        .map_err(|err| format!("Failed to read X11 property {:?}: {}", property, err))?;
    let text = String::from_utf8_lossy(&reply.value)
        .replace('\0', " ")
        .trim()
        .to_string();

    Ok(text)
}

#[cfg(target_os = "linux")]
fn get_linux_active_window() -> Result<Option<LinuxPasteTarget>, String> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};

    let (conn, screen_num) = x11rb::connect(None)
        .map_err(|err| format!("Failed to connect to X11: {}", err))?;
    let screen = &conn.setup().roots[screen_num];
    let active_window_atom = conn
        .intern_atom(false, b"_NET_ACTIVE_WINDOW")
        .map_err(|err| format!("Failed to request _NET_ACTIVE_WINDOW atom: {}", err))?
        .reply()
        .map_err(|err| format!("Failed to resolve _NET_ACTIVE_WINDOW atom: {}", err))?
        .atom;
    let reply = conn
        .get_property(
            false,
            screen.root,
            active_window_atom,
            AtomEnum::WINDOW,
            0,
            1,
        )
        .map_err(|err| format!("Failed to request active X11 window: {}", err))?
        .reply()
        .map_err(|err| format!("Failed to read active X11 window: {}", err))?;

    let Some(window) = reply.value32().and_then(|mut values| values.next()) else {
        return Ok(None);
    };

    if window == 0 {
        return Ok(None);
    }

    let wm_class = read_linux_window_property(&conn, window, b"WM_CLASS", AtomEnum::STRING)
        .unwrap_or_default();
    let title = read_linux_window_property(&conn, window, b"_NET_WM_NAME", AtomEnum::STRING)
        .or_else(|_| read_linux_window_property(&conn, window, b"WM_NAME", AtomEnum::STRING))
        .unwrap_or_default();

    Ok(Some(LinuxPasteTarget {
        window,
        wm_class,
        title,
    }))
}

#[cfg(target_os = "linux")]
fn is_linux_terminal_target(target: &LinuxPasteTarget) -> bool {
    let wm_class = target.wm_class.to_ascii_lowercase();
    [
        "warp",
        "gnome-terminal",
        "org.gnome.terminal",
        "konsole",
        "xterm",
        "kitty",
        "alacritty",
        "wezterm",
        "tilix",
        "foot",
    ]
    .iter()
    .any(|needle| wm_class.contains(needle))
}

#[cfg(target_os = "linux")]
fn is_warp_target(target: &LinuxPasteTarget) -> bool {
    target.wm_class.to_ascii_lowercase().contains("warp")
}

#[cfg(target_os = "linux")]
fn is_talkis_window(target: &LinuxPasteTarget) -> bool {
    target.wm_class.to_ascii_lowercase().contains("talkis")
}

#[cfg(target_os = "linux")]
pub fn remember_linux_paste_target_window() {
    match get_linux_active_window() {
        Ok(Some(target)) => {
            if is_talkis_window(&target) {
                logger::log_info(
                    "PASTE",
                    &format!(
                        "Ignoring Talkis window as paste target: id={}, class=\"{}\", title=\"{}\"",
                        target.window, target.wm_class, target.title
                    ),
                );
                return;
            }

            if let Ok(mut saved_target) = paste_target_window().lock() {
                *saved_target = Some(target.clone());
            }
            logger::log_info(
                "PASTE",
                &format!(
                    "Remembered Linux paste target window: id={}, class=\"{}\", title=\"{}\"",
                    target.window, target.wm_class, target.title
                ),
            );
        }
        Ok(_) => {
            logger::log_info("PASTE", "No active Linux paste target window to remember");
        }
        Err(err) => {
            logger::log_error("PASTE", &format!("Failed to remember paste target: {}", err));
        }
    }
}

#[tauri::command]
pub fn remember_paste_target_window() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    remember_linux_paste_target_window();

    Ok(())
}

#[cfg(target_os = "linux")]
fn write_linux_xclip_selection(selection: &str, text: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new("xclip")
        .args(["-selection", selection])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|err| format!("Failed to start xclip for {}: {}", selection, err))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|err| format!("Failed to write {} text to xclip: {}", selection, err))?;
    }

    let status = child
        .wait()
        .map_err(|err| format!("Failed to wait for xclip {}: {}", selection, err))?;
    if !status.success() {
        return Err(format!("xclip {} exited with {}", selection, status));
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn write_linux_xclip_text(text: &str) {
    for selection in ["clipboard", "primary"] {
        match write_linux_xclip_selection(selection, text) {
            Ok(()) => logger::log_info(
                "PASTE",
                &format!("Wrote recognized text to X11 {} selection via xclip", selection),
            ),
            Err(err) => logger::log_error("PASTE", &err),
        }
    }
}

#[cfg(target_os = "linux")]
fn focus_remembered_linux_paste_target() {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        ClientMessageData, ClientMessageEvent, ConfigureWindowAux, ConnectionExt, EventMask,
        InputFocus, StackMode, CLIENT_MESSAGE_EVENT,
    };

    let Some(target) = paste_target_window()
        .lock()
        .ok()
        .and_then(|target| target.clone())
    else {
        return;
    };
    let window = target.window;

    let result = (|| -> Result<(), String> {
        let (conn, screen_num) = x11rb::connect(None)
            .map_err(|err| format!("Failed to connect to X11: {}", err))?;
        let screen = &conn.setup().roots[screen_num];
        let active_window_atom = conn
            .intern_atom(false, b"_NET_ACTIVE_WINDOW")
            .map_err(|err| format!("Failed to request _NET_ACTIVE_WINDOW atom: {}", err))?
            .reply()
            .map_err(|err| format!("Failed to resolve _NET_ACTIVE_WINDOW atom: {}", err))?
            .atom;
        let event = ClientMessageEvent {
            response_type: CLIENT_MESSAGE_EVENT,
            format: 32,
            sequence: 0,
            window,
            type_: active_window_atom,
            data: ClientMessageData::from([2, x11rb::CURRENT_TIME, 0, 0, 0]),
        };

        conn.send_event(
            false,
            screen.root,
            EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
            event,
        )
        .map_err(|err| format!("Failed to request WM activation for {}: {}", window, err))?;
        conn.configure_window(
            window,
            &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
        )
        .map_err(|err| format!("Failed to raise remembered window {}: {}", window, err))?;
        conn.set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME)
            .map_err(|err| format!("Failed to focus remembered window {}: {}", window, err))?;
        conn.flush()
            .map_err(|err| format!("Failed to flush X11 focus request: {}", err))?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            logger::log_info("PASTE", &format!("Focused remembered Linux paste target: {}", window));
            std::thread::sleep(Duration::from_millis(180));
        }
        Err(err) => logger::log_error("PASTE", &err),
    }
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

#[cfg(target_os = "linux")]
fn should_use_terminal_paste_shortcut() -> bool {
    paste_target_window()
        .lock()
        .ok()
        .and_then(|target| target.clone())
        .is_some_and(|target| is_linux_terminal_target(&target))
}

#[cfg(target_os = "linux")]
fn should_use_warp_paste_shortcut() -> bool {
    paste_target_window()
        .lock()
        .ok()
        .and_then(|target| target.clone())
        .is_some_and(|target| is_warp_target(&target))
}

#[cfg(target_os = "linux")]
fn simulate_cmd_v() -> Result<(), String> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{KEY_PRESS_EVENT, KEY_RELEASE_EVENT};
    use x11rb::protocol::xtest::ConnectionExt as XtestConnectionExt;

    const CONTROL_LEFT_KEYCODE: u8 = 37;
    const SHIFT_LEFT_KEYCODE: u8 = 50;
    const INSERT_KEYCODE: u8 = 118;
    const V_KEYCODE: u8 = 55;
    let warp_paste = should_use_warp_paste_shortcut();
    let terminal_paste = should_use_terminal_paste_shortcut();

    let (conn, screen_num) = x11rb::connect(None)
        .map_err(|err| format!("Failed to connect to X11: {}", err))?;
    let root = conn.setup().roots[screen_num].root;

    let events: &[(u8, u8)] = if warp_paste {
        &[
            (KEY_PRESS_EVENT, SHIFT_LEFT_KEYCODE),
            (KEY_PRESS_EVENT, INSERT_KEYCODE),
            (KEY_RELEASE_EVENT, INSERT_KEYCODE),
            (KEY_RELEASE_EVENT, SHIFT_LEFT_KEYCODE),
        ]
    } else if terminal_paste {
        &[
            (KEY_PRESS_EVENT, CONTROL_LEFT_KEYCODE),
            (KEY_PRESS_EVENT, SHIFT_LEFT_KEYCODE),
            (KEY_PRESS_EVENT, V_KEYCODE),
            (KEY_RELEASE_EVENT, V_KEYCODE),
            (KEY_RELEASE_EVENT, SHIFT_LEFT_KEYCODE),
            (KEY_RELEASE_EVENT, CONTROL_LEFT_KEYCODE),
        ]
    } else {
        &[
            (KEY_PRESS_EVENT, CONTROL_LEFT_KEYCODE),
            (KEY_PRESS_EVENT, V_KEYCODE),
            (KEY_RELEASE_EVENT, V_KEYCODE),
            (KEY_RELEASE_EVENT, CONTROL_LEFT_KEYCODE),
        ]
    };

    for &(event_type, keycode) in events {
        conn.xtest_fake_input(event_type, keycode, 0, root, 0, 0, 0)
            .map_err(|err| format!("XTest paste key event failed: {}", err))?;
        conn.flush()
            .map_err(|err| format!("Failed to flush XTest paste event: {}", err))?;
        std::thread::sleep(Duration::from_millis(45));
    }

    conn.flush()
        .map_err(|err| format!("Failed to flush XTest paste events: {}", err))?;
    Ok(())
}

#[cfg(all(not(target_os = "macos"), not(target_os = "linux")))]
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

#[cfg(target_os = "macos")]
fn paste_shortcut_label() -> &'static str {
    "Cmd+V via CGEvent"
}

#[cfg(target_os = "windows")]
fn paste_shortcut_label() -> &'static str {
    "Ctrl+V via input simulation"
}

#[cfg(target_os = "linux")]
fn paste_shortcut_label() -> &'static str {
    if should_use_warp_paste_shortcut() {
        "Shift+Insert via XTest"
    } else if should_use_terminal_paste_shortcut() {
        "Ctrl+Shift+V via XTest"
    } else {
        "Ctrl+V via XTest"
    }
}

#[cfg(target_os = "linux")]
fn should_restore_clipboard_after_paste() -> bool {
    false
}

#[cfg(not(target_os = "linux"))]
fn should_restore_clipboard_after_paste() -> bool {
    true
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
            #[cfg(target_os = "linux")]
            let linux_clipboard_text = text.clone();

            handle
                .clipboard()
                .write_text(text)
                .map_err(|e| format!("Clipboard write failed: {}", e))?;

            #[cfg(target_os = "linux")]
            write_linux_xclip_text(&linux_clipboard_text);

            std::thread::sleep(Duration::from_millis(100));

            #[cfg(target_os = "linux")]
            focus_remembered_linux_paste_target();

            logger::log_info("PASTE", &format!("Simulating {}", paste_shortcut_label()));
            simulate_cmd_v()?;

            std::thread::sleep(Duration::from_millis(500));

            if !should_restore_clipboard_after_paste() {
                logger::log_info(
                    "PASTE",
                    "Keeping recognized text in clipboard after paste on Linux",
                );
                return Ok(());
            }

            if let Some(previous_text) = previous_clipboard_text {
                logger::log_info("PASTE", "Restoring previous clipboard text after paste");
                handle
                    .clipboard()
                    .write_text(previous_text)
                    .map_err(|e| format!("Clipboard restore failed: {}", e))?;
            } else {
                logger::log_info(
                    "PASTE",
                    "Previous clipboard text unavailable, clearing clipboard",
                );
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
