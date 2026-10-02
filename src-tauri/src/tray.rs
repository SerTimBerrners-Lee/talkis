use crate::{
    commands::{settings_window, widget},
    logger, shutdown,
};
use std::future::Future;
use tauri::{
    menu::{AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    App, AppHandle, Manager,
};
use tauri_plugin_opener::OpenerExt;

const TRAY_ID: &str = "talkis-main-tray";
const TRAY_OPEN_ID: &str = "talkis-tray-open";
const TRAY_HISTORY_ID: &str = "talkis-tray-history";
const TRAY_FILE_ID: &str = "talkis-tray-file";
const TRAY_CHAT_ID: &str = "talkis-tray-chat";
const TRAY_MODELS_ID: &str = "talkis-tray-models";
const TRAY_TRANSLATOR_ID: &str = "talkis-tray-translator";
const TRAY_PROMPTS_ID: &str = "talkis-tray-prompts";
const TRAY_SETTINGS_ID: &str = "talkis-tray-settings";
#[cfg(debug_assertions)]
const TRAY_ONBOARDING_ID: &str = "talkis-tray-onboarding";
const TRAY_SUPPORT_ID: &str = "talkis-tray-support";
const TRAY_GITHUB_ID: &str = "talkis-tray-github";
const TRAY_PRIVACY_ID: &str = "talkis-tray-privacy";
const TRAY_UPDATE_ID: &str = "talkis-tray-update";
const TRAY_QUIT_ID: &str = "talkis-tray-quit";
const TALKIS_WEBSITE_URL: &str = "https://talkis.ru";
const TALKIS_GITHUB_URL: &str = "https://github.com/SerTimBerrners-Lee/talkis";
const TALKIS_PRIVACY_URL: &str = "https://github.com/SerTimBerrners-Lee/talkis#privacy";
const TALKIS_SUPPORT_URL: &str = "mailto:david.perov60@gmail.com?subject=Talkis%20support";

struct TrayState {
    _tray: TrayIcon,
}

#[derive(Debug, PartialEq, Eq)]
enum TrayAction {
    Open,
    History,
    FileTranscription,
    Chat,
    Models,
    Translator,
    Prompts,
    Settings,
    #[cfg(debug_assertions)]
    Onboarding,
    Support,
    Github,
    Privacy,
    CheckUpdates,
    Quit,
}

fn tray_action(menu_id: &str) -> Option<TrayAction> {
    match menu_id {
        TRAY_OPEN_ID => Some(TrayAction::Open),
        TRAY_HISTORY_ID => Some(TrayAction::History),
        TRAY_FILE_ID => Some(TrayAction::FileTranscription),
        TRAY_CHAT_ID => Some(TrayAction::Chat),
        TRAY_MODELS_ID => Some(TrayAction::Models),
        TRAY_TRANSLATOR_ID => Some(TrayAction::Translator),
        TRAY_PROMPTS_ID => Some(TrayAction::Prompts),
        TRAY_SETTINGS_ID => Some(TrayAction::Settings),
        #[cfg(debug_assertions)]
        TRAY_ONBOARDING_ID => Some(TrayAction::Onboarding),
        TRAY_SUPPORT_ID => Some(TrayAction::Support),
        TRAY_GITHUB_ID => Some(TrayAction::Github),
        TRAY_PRIVACY_ID => Some(TrayAction::Privacy),
        TRAY_UPDATE_ID => Some(TrayAction::CheckUpdates),
        TRAY_QUIT_ID => Some(TrayAction::Quit),
        _ => None,
    }
}

fn run_settings_action<F>(action_name: &'static str, action: F)
where
    F: Future<Output = Result<(), String>> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        if let Err(err) = action.await {
            logger::log_error(
                "TRAY",
                &format!("Failed to run {action_name} from tray: {err}"),
            );
        }
    });
}

fn open_settings(app: &AppHandle) {
    run_settings_action("open settings", settings_window::open_settings(app.clone()));
}

fn open_talkis(app: &AppHandle) {
    widget::schedule_widget_restore(app, "tray-open");
    open_settings(app);
}

fn open_settings_tab(app: &AppHandle, tab: &'static str) {
    run_settings_action(
        "open settings tab",
        settings_window::open_settings_tab(app.clone(), tab.to_owned(), None),
    );
}

fn open_update_check(app: &AppHandle) {
    run_settings_action(
        "check updates",
        settings_window::open_update_check(app.clone()),
    );
}

fn open_external_url(app: &AppHandle, url: &str, action_name: &str) {
    if let Err(err) = app.opener().open_url(url, None::<&str>) {
        logger::log_error(
            "TRAY",
            &format!("Failed to run {action_name} from tray: {err}"),
        );
    }
}

pub fn setup(app: &App) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, TRAY_OPEN_ID, "Открыть Talkis", true, None::<&str>)?;
    let navigation_separator = PredefinedMenuItem::separator(app)?;
    let history_item = MenuItem::with_id(app, TRAY_HISTORY_ID, "История", true, None::<&str>)?;
    let file_item =
        MenuItem::with_id(app, TRAY_FILE_ID, "Транскрибация файла", true, None::<&str>)?;
    let chat_item = MenuItem::with_id(app, TRAY_CHAT_ID, "Чат", true, None::<&str>)?;
    let models_item =
        MenuItem::with_id(app, TRAY_MODELS_ID, "Диктовка и модели", true, None::<&str>)?;
    let translator_item =
        MenuItem::with_id(app, TRAY_TRANSLATOR_ID, "Переводчик", true, None::<&str>)?;
    let prompts_item =
        MenuItem::with_id(app, TRAY_PROMPTS_ID, "Стиль и промпты", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(
        app,
        TRAY_SETTINGS_ID,
        "Настройки и горячие клавиши",
        true,
        None::<&str>,
    )?;
    #[cfg(debug_assertions)]
    let onboarding_item = MenuItem::with_id(
        app,
        TRAY_ONBOARDING_ID,
        "Онбординг (DEV)",
        true,
        None::<&str>,
    )?;
    let help_separator = PredefinedMenuItem::separator(app)?;
    let support_item = MenuItem::with_id(
        app,
        TRAY_SUPPORT_ID,
        "Написать в поддержку",
        true,
        None::<&str>,
    )?;
    let github_item = MenuItem::with_id(app, TRAY_GITHUB_ID, "GitHub", true, None::<&str>)?;
    let privacy_item = MenuItem::with_id(
        app,
        TRAY_PRIVACY_ID,
        "Конфиденциальность",
        true,
        None::<&str>,
    )?;
    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("Talkis"))
        .version(Some(app.package_info().version.to_string()))
        .comments(Some("Голос в текст, транскрибация и перевод."))
        .website(Some(TALKIS_WEBSITE_URL))
        .website_label(Some("talkis.ru"))
        .build();
    let about_item = PredefinedMenuItem::about(app, Some("О Talkis"), Some(about_metadata))?;
    let update_item = MenuItem::with_id(
        app,
        TRAY_UPDATE_ID,
        "Проверить обновления...",
        true,
        None::<&str>,
    )?;
    let quit_separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, "Выйти из Talkis", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open_item,
            &navigation_separator,
            &history_item,
            &file_item,
            &chat_item,
            &models_item,
            &translator_item,
            &prompts_item,
            &settings_item,
            #[cfg(debug_assertions)]
            &onboarding_item,
            &help_separator,
            &support_item,
            &github_item,
            &privacy_item,
            &about_item,
            &update_item,
            &quit_separator,
            &quit_item,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Talkis")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match tray_action(event.id().as_ref()) {
            Some(TrayAction::Open) => open_talkis(app),
            Some(TrayAction::History) => open_settings_tab(app, "main"),
            Some(TrayAction::FileTranscription) => open_settings_tab(app, "file"),
            Some(TrayAction::Chat) => open_settings_tab(app, "chat"),
            Some(TrayAction::Models) => open_settings_tab(app, "model"),
            Some(TrayAction::Translator) => open_settings_tab(app, "interpreter"),
            Some(TrayAction::Prompts) => open_settings_tab(app, "style"),
            Some(TrayAction::Settings) => open_settings_tab(app, "settings"),
            #[cfg(debug_assertions)]
            Some(TrayAction::Onboarding) => run_settings_action(
                "open onboarding",
                settings_window::open_dev_onboarding(app.clone()),
            ),
            Some(TrayAction::Support) => open_external_url(app, TALKIS_SUPPORT_URL, "open support"),
            Some(TrayAction::Github) => open_external_url(app, TALKIS_GITHUB_URL, "open GitHub"),
            Some(TrayAction::Privacy) => open_external_url(app, TALKIS_PRIVACY_URL, "open privacy"),
            Some(TrayAction::CheckUpdates) => open_update_check(app),
            Some(TrayAction::Quit) => shutdown::quit(app),
            None => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let tray = builder.build(app)?;
    app.manage(TrayState { _tray: tray });
    logger::log_info("TRAY", "System tray initialized");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_supported_tray_menu_actions() {
        assert_eq!(tray_action(TRAY_OPEN_ID), Some(TrayAction::Open));
        assert_eq!(tray_action(TRAY_HISTORY_ID), Some(TrayAction::History));
        assert_eq!(
            tray_action(TRAY_FILE_ID),
            Some(TrayAction::FileTranscription)
        );
        assert_eq!(tray_action(TRAY_CHAT_ID), Some(TrayAction::Chat));
        assert_eq!(tray_action(TRAY_MODELS_ID), Some(TrayAction::Models));
        assert_eq!(
            tray_action(TRAY_TRANSLATOR_ID),
            Some(TrayAction::Translator)
        );
        assert_eq!(tray_action(TRAY_PROMPTS_ID), Some(TrayAction::Prompts));
        assert_eq!(tray_action(TRAY_SETTINGS_ID), Some(TrayAction::Settings));
        #[cfg(debug_assertions)]
        assert_eq!(
            tray_action(TRAY_ONBOARDING_ID),
            Some(TrayAction::Onboarding)
        );
        assert_eq!(tray_action(TRAY_SUPPORT_ID), Some(TrayAction::Support));
        assert_eq!(tray_action(TRAY_GITHUB_ID), Some(TrayAction::Github));
        assert_eq!(tray_action(TRAY_PRIVACY_ID), Some(TrayAction::Privacy));
        assert_eq!(tray_action(TRAY_UPDATE_ID), Some(TrayAction::CheckUpdates));
        assert_eq!(tray_action(TRAY_QUIT_ID), Some(TrayAction::Quit));
        assert_eq!(tray_action("unknown"), None);
    }
}
