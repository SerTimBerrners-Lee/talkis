#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::ptr;
    use std::rc::Rc;
    use std::sync::mpsc;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use serde::Serialize;
    use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

    const HOTKEY_CAPTURE_EVENT: &str = "native-hotkey-capture";

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct NativeHotkeyCapturePayload {
        status: String,
        hotkey: Option<String>,
        message: Option<String>,
    }

    struct CaptureRuntime {
        app: AppHandle,
        window_label: String,
        active: bool,
        candidate: Option<String>,
        last_preview: Option<String>,
    }

    struct NativeHotkeyCaptureMonitor {
        monitor: Retained<AnyObject>,
        _block: RcBlock<dyn Fn(std::ptr::NonNull<NSEvent>) -> *mut NSEvent>,
        _runtime: Rc<RefCell<CaptureRuntime>>,
    }

    thread_local! {
        static HOTKEY_CAPTURE_MONITOR: RefCell<Option<NativeHotkeyCaptureMonitor>> = const { RefCell::new(None) };
    }

    fn emit_capture_event(
        app: &AppHandle,
        window_label: &str,
        status: &str,
        hotkey: Option<String>,
        message: Option<String>,
    ) {
        let _ = app.emit_to(
            window_label,
            HOTKEY_CAPTURE_EVENT,
            NativeHotkeyCapturePayload {
                status: status.to_string(),
                hotkey,
                message,
            },
        );
    }

    fn with_runtime_context(runtime: &Rc<RefCell<CaptureRuntime>>) -> (AppHandle, String) {
        let runtime_ref = runtime.borrow();
        (runtime_ref.app.clone(), runtime_ref.window_label.clone())
    }

    fn build_hotkey_string(flags: NSEventModifierFlags, main_key: Option<&str>) -> String {
        let mut parts: Vec<&str> = Vec::new();
        let normalized_flags = flags & NSEventModifierFlags::DeviceIndependentFlagsMask;

        if normalized_flags.contains(NSEventModifierFlags::Control) {
            parts.push("Control");
        }
        if normalized_flags.contains(NSEventModifierFlags::Option) {
            parts.push("Alt");
        }
        if normalized_flags.contains(NSEventModifierFlags::Shift) {
            parts.push("Shift");
        }
        if normalized_flags.contains(NSEventModifierFlags::Command) {
            parts.push("Command");
        }
        if let Some(main_key) = main_key {
            parts.push(main_key);
        }

        parts.join("+")
    }

    fn has_any_supported_modifier(flags: NSEventModifierFlags) -> bool {
        let normalized_flags = flags & NSEventModifierFlags::DeviceIndependentFlagsMask;
        normalized_flags.intersects(
            NSEventModifierFlags::Control
                | NSEventModifierFlags::Option
                | NSEventModifierFlags::Shift
                | NSEventModifierFlags::Command,
        )
    }

    fn main_key_from_key_code(key_code: u16) -> Option<&'static str> {
        match key_code {
            0x00 => Some("A"),
            0x0b => Some("B"),
            0x08 => Some("C"),
            0x02 => Some("D"),
            0x0e => Some("E"),
            0x03 => Some("F"),
            0x05 => Some("G"),
            0x04 => Some("H"),
            0x22 => Some("I"),
            0x26 => Some("J"),
            0x28 => Some("K"),
            0x25 => Some("L"),
            0x2e => Some("M"),
            0x2d => Some("N"),
            0x1f => Some("O"),
            0x23 => Some("P"),
            0x0c => Some("Q"),
            0x0f => Some("R"),
            0x01 => Some("S"),
            0x11 => Some("T"),
            0x20 => Some("U"),
            0x09 => Some("V"),
            0x0d => Some("W"),
            0x07 => Some("X"),
            0x10 => Some("Y"),
            0x06 => Some("Z"),
            0x1d => Some("0"),
            0x12 => Some("1"),
            0x13 => Some("2"),
            0x14 => Some("3"),
            0x15 => Some("4"),
            0x17 => Some("5"),
            0x16 => Some("6"),
            0x1a => Some("7"),
            0x1c => Some("8"),
            0x19 => Some("9"),
            0x24 => Some("Enter"),
            0x30 => Some("Tab"),
            0x31 => Some("Space"),
            0x33 => Some("Backspace"),
            0x35 => Some("Escape"),
            0x60 => Some("F5"),
            0x61 => Some("F6"),
            0x62 => Some("F7"),
            0x63 => Some("F3"),
            0x64 => Some("F8"),
            0x65 => Some("F9"),
            0x67 => Some("F11"),
            0x6d => Some("F10"),
            0x6f => Some("F12"),
            0x72 => Some("Insert"),
            0x73 => Some("Home"),
            0x74 => Some("PageUp"),
            0x75 => Some("Delete"),
            0x76 => Some("F4"),
            0x77 => Some("End"),
            0x78 => Some("F2"),
            0x79 => Some("PageDown"),
            0x7a => Some("F1"),
            0x7b => Some("Left"),
            0x7c => Some("Right"),
            0x7d => Some("Down"),
            0x7e => Some("Up"),
            _ => None,
        }
    }

    fn stop_capture_on_main_thread() {
        HOTKEY_CAPTURE_MONITOR.with(|slot| {
            if let Some(existing) = slot.borrow_mut().take() {
                unsafe {
                    NSEvent::removeMonitor(&existing.monitor);
                }
            }
        });
    }

    fn handle_capture_event(
        event_ptr: std::ptr::NonNull<NSEvent>,
        runtime: &Rc<RefCell<CaptureRuntime>>,
    ) -> *mut NSEvent {
        let event = unsafe { event_ptr.as_ref() };
        let event_type = event.r#type();
        let flags = event.modifierFlags();
        let key_code = event.keyCode();
        let main_key = main_key_from_key_code(key_code);

        let (app, window_label, active, candidate, last_preview) = {
            let runtime_ref = runtime.borrow();
            (
                runtime_ref.app.clone(),
                runtime_ref.window_label.clone(),
                runtime_ref.active,
                runtime_ref.candidate.clone(),
                runtime_ref.last_preview.clone(),
            )
        };

        if !active {
            return event_ptr.as_ptr();
        }

        if event_type == NSEventType::KeyDown {
            if key_code == 0x35 && !has_any_supported_modifier(flags) {
                {
                    let mut runtime_ref = runtime.borrow_mut();
                    runtime_ref.active = false;
                    runtime_ref.candidate = None;
                    runtime_ref.last_preview = None;
                }
                emit_capture_event(
                    &app,
                    &window_label,
                    "cancelled",
                    None,
                    Some("Ввод отменен.".to_string()),
                );
                return ptr::null_mut();
            }

            if let Some(main_key) = main_key {
                let candidate = build_hotkey_string(flags, Some(main_key));
                {
                    let mut runtime_ref = runtime.borrow_mut();
                    runtime_ref.candidate = Some(candidate.clone());
                    runtime_ref.last_preview = Some(candidate.clone());
                }
                emit_capture_event(
                    &app,
                    &window_label,
                    "preview",
                    Some(candidate),
                    Some("Отпустите комбинацию, чтобы применить.".to_string()),
                );
                return ptr::null_mut();
            }

            return ptr::null_mut();
        }

        if event_type == NSEventType::FlagsChanged {
            if has_any_supported_modifier(flags) {
                let preview = build_hotkey_string(flags, None);
                if Some(preview.clone()) != last_preview {
                    {
                        let mut runtime_ref = runtime.borrow_mut();
                        runtime_ref.last_preview = Some(preview.clone());
                    }
                    emit_capture_event(
                        &app,
                        &window_label,
                        "preview",
                        Some(preview),
                        Some("Добавьте основную клавишу.".to_string()),
                    );
                }
                return ptr::null_mut();
            }

            if let Some(candidate) = candidate {
                {
                    let mut runtime_ref = runtime.borrow_mut();
                    runtime_ref.active = false;
                    runtime_ref.last_preview = Some(candidate.clone());
                }
                emit_capture_event(&app, &window_label, "completed", Some(candidate), None);
                return ptr::null_mut();
            }

            {
                let mut runtime_ref = runtime.borrow_mut();
                runtime_ref.last_preview = None;
            }
            return ptr::null_mut();
        }

        if event_type == NSEventType::KeyUp {
            if !has_any_supported_modifier(flags) {
                if let Some(main_key) = main_key {
                    let fallback_candidate = build_hotkey_string(flags, Some(main_key));
                    let completed_candidate = candidate.unwrap_or(fallback_candidate);
                    {
                        let mut runtime_ref = runtime.borrow_mut();
                        runtime_ref.active = false;
                        runtime_ref.last_preview = Some(completed_candidate.clone());
                    }
                    emit_capture_event(
                        &app,
                        &window_label,
                        "completed",
                        Some(completed_candidate),
                        None,
                    );
                }
            }

            return ptr::null_mut();
        }

        event_ptr.as_ptr()
    }

    pub fn start_capture(window: &WebviewWindow) -> Result<(), String> {
        let app = window.app_handle().clone();
        let window_label = window.label().to_string();
        let (tx, rx) = mpsc::channel();
        let app_for_main_thread = app.clone();

        app_for_main_thread
            .run_on_main_thread(move || {
                let result = (|| -> Result<(), String> {
                    stop_capture_on_main_thread();

                    let runtime = Rc::new(RefCell::new(CaptureRuntime {
                        app: app.clone(),
                        window_label: window_label.clone(),
                        active: true,
                        candidate: None,
                        last_preview: None,
                    }));
                    let runtime_for_block = runtime.clone();
                    let block: RcBlock<dyn Fn(std::ptr::NonNull<NSEvent>) -> *mut NSEvent> =
                        RcBlock::new(move |event| handle_capture_event(event, &runtime_for_block));
                    let monitor = unsafe {
                        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                            NSEventMask::KeyDown | NSEventMask::KeyUp | NSEventMask::FlagsChanged,
                            &block,
                        )
                    }
                    .ok_or_else(|| "Failed to start native hotkey capture".to_string())?;

                    HOTKEY_CAPTURE_MONITOR.with(|slot| {
                        *slot.borrow_mut() = Some(NativeHotkeyCaptureMonitor {
                            monitor,
                            _block: block,
                            _runtime: runtime,
                        });
                    });

                    let (app, window_label) =
                        with_runtime_context(&HOTKEY_CAPTURE_MONITOR.with(|slot| {
                            slot.borrow()
                                .as_ref()
                                .expect("capture monitor just inserted")
                                ._runtime
                                .clone()
                        }));
                    emit_capture_event(
                        &app,
                        &window_label,
                        "listening",
                        None,
                        Some("Нажмите новую комбинацию.".to_string()),
                    );

                    Ok(())
                })();

                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;

        rx.recv()
            .map_err(|e| format!("Failed to receive hotkey capture start result: {}", e))?
    }

    pub fn stop_capture(window: &WebviewWindow) -> Result<(), String> {
        let app = window.app_handle().clone();
        let window_label = window.label().to_string();
        let (tx, rx) = mpsc::channel();
        let app_for_main_thread = app.clone();

        app_for_main_thread
            .run_on_main_thread(move || {
                stop_capture_on_main_thread();
                emit_capture_event(&app, &window_label, "stopped", None, None);
                let _ = tx.send(Ok(()));
            })
            .map_err(|e| e.to_string())?;

        rx.recv()
            .map_err(|e| format!("Failed to receive hotkey capture stop result: {}", e))?
    }
}

#[cfg(target_os = "macos")]
pub use macos::{start_capture, stop_capture};

#[cfg(not(target_os = "macos"))]
pub fn start_capture(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Err("Native hotkey capture is only available on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn stop_capture(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}
