const APP_BUNDLE_ID: &str = "com.trixter.talkis";

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> u8;
}

#[tauri::command]
pub async fn open_accessibility_settings() -> Result<(), String> {
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
pub async fn reset_accessibility_permission() -> Result<(), String> {
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
