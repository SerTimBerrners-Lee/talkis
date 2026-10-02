use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::logger;

struct WidgetDisplayPreference(AtomicBool);

fn saved_widget_visible(settings: Option<&Value>) -> bool {
    settings
        .and_then(|settings| settings.get("widgetVisible"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub(super) fn read_saved_visibility(app: &AppHandle) -> Result<bool, String> {
    let store = app.store("talkis.json").map_err(|e| e.to_string())?;

    Ok(saved_widget_visible(store.get("settings").as_ref()))
}

pub(super) fn initialize(app: &AppHandle) {
    let visible = read_saved_visibility(app).unwrap_or_else(|error| {
        logger::log_error(
            "WIDGET",
            &format!("Failed to load widget visibility, using default: {error}"),
        );

        true
    });
    app.manage(WidgetDisplayPreference(AtomicBool::new(visible)));
    logger::log_info("WIDGET", &format!("Widget visibility loaded: {visible}"));
}

pub(super) fn is_visible(app: &AppHandle) -> bool {
    app.state::<WidgetDisplayPreference>()
        .0
        .load(Ordering::SeqCst)
}

/// Apply on the UI thread, where widget show/hide operations are serialized.
pub(super) fn set_visible(app: &AppHandle, visible: bool) {
    app.state::<WidgetDisplayPreference>()
        .0
        .store(visible, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::saved_widget_visible;
    use serde_json::json;

    #[test]
    fn existing_installs_keep_the_widget_and_only_explicit_false_hides_it() {
        for settings in [
            None,
            Some(json!({})),
            Some(json!({"widgetVisible": "false"})),
        ] {
            assert!(saved_widget_visible(settings.as_ref()));
        }

        assert!(!saved_widget_visible(Some(
            &json!({"widgetVisible": false})
        )));
        assert!(saved_widget_visible(Some(&json!({"widgetVisible": true}))));
    }
}
