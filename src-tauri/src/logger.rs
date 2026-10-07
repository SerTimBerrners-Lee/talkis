use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri_plugin_opener::OpenerExt;

static LOG_MUTEX: Mutex<()> = Mutex::new(());

pub fn get_log_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".talkis")
}

pub fn get_log_path() -> PathBuf {
    get_log_dir().join("talkis.log")
}

pub fn log(level: &str, tag: &str, message: &str) {
    let _guard = LOG_MUTEX.lock().unwrap_or_else(|e| e.into_inner());

    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = crate::log_retention::bounded_line(format!(
        "[{}] [{}] [{}] {}\n",
        timestamp, level, tag, message
    ));

    if let Err(error) = crate::log_retention::append(
        &get_log_path(),
        line.as_bytes(),
        crate::log_retention::MAX_LOG_BYTES,
    ) {
        eprintln!("Could not write Talkis log: {error}");
    }

    println!("{}", line.trim());
}

pub fn log_info(tag: &str, message: &str) {
    log("INFO", tag, message);
}

pub fn log_error(tag: &str, message: &str) {
    log("ERROR", tag, message);
}

#[tauri::command]
pub fn log_event(level: String, tag: String, message: String) {
    log(&level, &tag, &message);
}

#[tauri::command]
pub fn get_log_path_cmd() -> String {
    get_log_path().to_string_lossy().to_string()
}

#[tauri::command]
pub fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    let directory = get_log_dir();
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    app.opener()
        .open_path(directory.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clear_logs() -> Result<(), String> {
    let _guard = LOG_MUTEX.lock().unwrap_or_else(|error| error.into_inner());
    let path = get_log_path();
    if path.exists() {
        // Keep the pre-opened crash diagnostics handle attached to this file.
        OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
