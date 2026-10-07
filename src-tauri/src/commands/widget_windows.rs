use std::sync::Mutex;

use tauri::WebviewWindow;
use windows_sys::Win32::Foundation::{GetLastError, SetLastError, HWND};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, IsIconic, IsWindowVisible, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOPMOST,
};

use crate::logger;

#[derive(Debug, PartialEq, Eq)]
struct Presentation {
    handle: usize,
    visible: bool,
    minimized: bool,
    topmost: bool,
    cloaked: Option<u32>,
}

static LAST_PRESENTATION: Mutex<Option<Presentation>> = Mutex::new(None);

fn native_topmost(hwnd: HWND) -> Result<bool, String> {
    // Tao's is_always_on_top reads its cached configuration, not the HWND.
    unsafe {
        SetLastError(0);
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if style == 0 && GetLastError() != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }

        Ok(style & WS_EX_TOPMOST as isize != 0)
    }
}

fn restore_native_topmost(hwnd: HWND, force_front: bool) -> Result<bool, String> {
    let was_topmost = native_topmost(hwnd)?;
    if !was_topmost || force_front {
        let success = unsafe {
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )
        };
        if success == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }

    Ok(!was_topmost)
}

/// Observe actual Windows presentation without logging every watchdog tick.
pub(super) fn log_presentation(win: &WebviewWindow, reason: &str) -> Result<(), String> {
    let hwnd = win.hwnd().map_err(|error| error.to_string())?.0 as HWND;
    let mut cloaked = 0_u32;
    let cloak_result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    };
    let state = Presentation {
        handle: hwnd as usize,
        visible: unsafe { IsWindowVisible(hwnd) } != 0,
        minimized: unsafe { IsIconic(hwnd) } != 0,
        topmost: native_topmost(hwnd)?,
        cloaked: (cloak_result >= 0).then_some(cloaked),
    };
    let mut previous = LAST_PRESENTATION
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if previous.as_ref() != Some(&state) {
        logger::log_info(
            "WIDGET_PRESENTATION",
            &format!("reason={reason}, {state:?}"),
        );
        *previous = Some(state);
    }

    Ok(())
}

pub(super) fn ensure_topmost(win: &WebviewWindow, force_front: bool) -> Result<bool, String> {
    let hwnd = win.hwnd().map_err(|error| error.to_string())?.0 as HWND;
    restore_native_topmost(hwnd, force_front)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetForegroundWindow, GetWindowRect, HWND_NOTOPMOST,
        WS_EX_TOPMOST, WS_POPUP,
    };

    #[test]
    fn repairs_actual_topmost_loss_without_showing_moving_or_focusing_the_window() {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST,
                class.as_ptr(),
                class.as_ptr(),
                WS_POPUP,
                100,
                100,
                129,
                54,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null(), "{}", std::io::Error::last_os_error());
        struct TestWindow(HWND);
        impl Drop for TestWindow {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        let _window = TestWindow(hwnd);
        let foreground = unsafe { GetForegroundWindow() };
        let mut before = windows_sys::Win32::Foundation::RECT::default();
        assert_ne!(unsafe { GetWindowRect(hwnd, &mut before) }, 0);
        assert!(native_topmost(hwnd).unwrap());
        assert_ne!(
            unsafe {
                SetWindowPos(
                    hwnd,
                    HWND_NOTOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                )
            },
            0
        );
        assert!(!native_topmost(hwnd).unwrap());
        assert!(restore_native_topmost(hwnd, false).unwrap());
        assert!(native_topmost(hwnd).unwrap());
        assert!(!restore_native_topmost(hwnd, false).unwrap());
        assert_eq!(unsafe { IsWindowVisible(hwnd) }, 0);
        assert_eq!(unsafe { GetForegroundWindow() }, foreground);
        let mut after = windows_sys::Win32::Foundation::RECT::default();
        assert_ne!(unsafe { GetWindowRect(hwnd, &mut after) }, 0);
        assert_eq!(
            (before.left, before.top, before.right, before.bottom),
            (after.left, after.top, after.right, after.bottom)
        );
    }
}
