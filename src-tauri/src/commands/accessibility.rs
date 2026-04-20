const APP_BUNDLE_ID: &str = "com.trixter.talkis";

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> u8;
    static kAXTrustedCheckOptionPrompt: *const std::ffi::c_void;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFBooleanTrue: *const std::ffi::c_void;
    static kCFTypeDictionaryKeyCallBacks: std::ffi::c_void;
    static kCFTypeDictionaryValueCallBacks: std::ffi::c_void;
    fn CFDictionaryCreate(
        allocator: *const std::ffi::c_void,
        keys: *const *const std::ffi::c_void,
        values: *const *const std::ffi::c_void,
        num_values: isize,
        key_callbacks: *const std::ffi::c_void,
        value_callbacks: *const std::ffi::c_void,
    ) -> *const std::ffi::c_void;
    fn CFRelease(cf: *const std::ffi::c_void);
}

/// Calls AXIsProcessTrustedWithOptions with prompt=true.
/// This makes macOS auto-add the current binary to the Accessibility list
/// and show the native prompt dialog — works even for raw dev binaries
/// that aren't .app bundles.
#[tauri::command]
pub async fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let options = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks as *const _ as *const std::ffi::c_void,
                &kCFTypeDictionaryValueCallBacks as *const _ as *const std::ffi::c_void,
            );
            AXIsProcessTrustedWithOptions(options);
            CFRelease(options);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // On Windows/Linux, accessibility is usually not required for global shortcuts
    }
    Ok(())
}

#[tauri::command]
pub async fn reset_accessibility_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // In dev mode, there is no .app bundle so tccutil cannot find
        // the bundle identifier. Just skip the reset — it is only
        // useful for production builds where the user re-requests
        // permission after denial.
        if cfg!(dev) {
            return Ok(());
        }

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
pub async fn check_accessibility_permission() -> Result<bool, String> {
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

/// Called once at startup from `lib.rs`.  If the process does not yet
/// have Accessibility permission, trigger the native macOS prompt that
/// auto-registers the current binary in System Settings.
#[cfg(target_os = "macos")]
pub fn prompt_accessibility_if_needed() {
    let trusted = unsafe { AXIsProcessTrusted() != 0 };
    if trusted {
        crate::logger::log_info("ACCESSIBILITY", "Process is already trusted");
        return;
    }

    crate::logger::log_info("ACCESSIBILITY", "Process is NOT trusted — showing native prompt");
    unsafe {
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let options = CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks as *const _ as *const std::ffi::c_void,
            &kCFTypeDictionaryValueCallBacks as *const _ as *const std::ffi::c_void,
        );
        AXIsProcessTrustedWithOptions(options);
        CFRelease(options);
    }
}
