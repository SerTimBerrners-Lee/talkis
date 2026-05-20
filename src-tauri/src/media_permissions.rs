#[cfg(target_os = "linux")]
pub fn allow_microphone_requests(window: &tauri::WebviewWindow) {
    use webkit2gtk::glib::prelude::*;
    use webkit2gtk::{
        PermissionRequestExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt,
    };

    let label = window.label().to_string();
    if let Err(err) = window.with_webview(move |webview| {
        webview
            .inner()
            .connect_permission_request(move |_webview, request| {
                if let Some(user_media_request) =
                    request.dynamic_cast_ref::<UserMediaPermissionRequest>()
                {
                    if !user_media_request.is_for_audio_device()
                        || user_media_request.is_for_video_device()
                    {
                        request.deny();
                        crate::logger::log_info(
                            "PERMISSIONS",
                            &format!(
                                "Denied non-microphone user media request for window {}",
                                label
                            ),
                        );
                        return true;
                    }

                    request.allow();
                    crate::logger::log_info(
                        "PERMISSIONS",
                        &format!("Allowed Linux microphone request for window {}", label),
                    );
                    return true;
                }

                false
            });
    }) {
        crate::logger::log_error(
            "PERMISSIONS",
            &format!(
                "Failed to attach Linux microphone permission handler for window {}: {}",
                window.label(),
                err
            ),
        );
    }
}

#[cfg(not(target_os = "linux"))]
pub fn allow_microphone_requests(_window: &tauri::WebviewWindow) {}
