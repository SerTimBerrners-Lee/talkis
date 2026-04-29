use crate::logger;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(debug_assertions)]
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri_plugin_shell::ShellExt;

const MAX_TRANSCRIPTION_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Deserialize)]
pub struct PrepareMediaRequest {
    pub file_base64: String,
    pub file_name: String,
}

#[derive(Serialize)]
pub struct PrepareMediaResponse {
    pub audio_base64: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

fn file_extension(file_name: &str) -> &str {
    Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin")
}

fn unique_temp_path(prefix: &str, extension: &str) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let pid = std::process::id();
    env::temp_dir().join(format!(
        "talkis-{}-{}-{}.{}",
        prefix,
        pid,
        now,
        extension.trim_start_matches('.')
    ))
}

#[cfg(debug_assertions)]
fn ffmpeg_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(value) = env::var("FFMPEG_PATH") {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }

    candidates.push(PathBuf::from("ffmpeg"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/ffmpeg"));
    candidates.push(PathBuf::from("/usr/local/bin/ffmpeg"));
    candidates.push(PathBuf::from("/usr/bin/ffmpeg"));
    candidates
}

#[cfg(debug_assertions)]
fn resolve_ffmpeg() -> Result<PathBuf, String> {
    for candidate in ffmpeg_candidates() {
        if Command::new(&candidate)
            .arg("-version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
        {
            return Ok(candidate);
        }
    }

    Err("Системный ffmpeg не найден.".to_string())
}

async fn run_ffmpeg(app: &tauri::AppHandle, args: Vec<String>) -> Result<Vec<u8>, String> {
    match app.shell().sidecar("ffmpeg") {
        Ok(command) => {
            logger::log_info("MEDIA", "Running bundled ffmpeg sidecar");
            let output = command
                .args(args.clone())
                .output()
                .await
                .map_err(|err| format!("Не удалось запустить встроенный ffmpeg: {}", err))?;

            if output.status.success() {
                return Ok(output.stderr);
            }

            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Err(err) => {
            logger::log_error("MEDIA", &format!("Bundled ffmpeg sidecar unavailable: {}", err));
        }
    }

    #[cfg(debug_assertions)]
    {
        let ffmpeg = resolve_ffmpeg()?;
        logger::log_info("MEDIA", &format!("Running system ffmpeg fallback: {:?}", ffmpeg));
        let output = Command::new(&ffmpeg)
            .args(&args)
            .output()
            .map_err(|err| format!("Не удалось запустить системный ffmpeg: {}", err))?;

        if output.status.success() {
            return Ok(output.stderr);
        }

        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    #[cfg(not(debug_assertions))]
    {
        Err("Встроенный медиаконвертер недоступен. Переустановите приложение или обратитесь в поддержку Talkis.".to_string())
    }
}

#[tauri::command]
pub async fn prepare_media_for_transcription(
    app: tauri::AppHandle,
    req: PrepareMediaRequest,
) -> Result<PrepareMediaResponse, String> {
    logger::log_info(
        "MEDIA",
        &format!("Preparing media file for transcription: {}", req.file_name),
    );

    let input_bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.file_base64)
        .map_err(|err| format!("Не удалось прочитать файл: {}", err))?;
    let input_ext = file_extension(&req.file_name);
    let input_path = unique_temp_path("input", input_ext);
    let output_path = unique_temp_path("output", "mp3");

    fs::write(&input_path, input_bytes)
        .map_err(|err| format!("Не удалось подготовить временный файл: {}", err))?;

    let ffmpeg_args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        input_path.to_string_lossy().to_string(),
        "-vn".to_string(),
        "-ac".to_string(),
        "1".to_string(),
        "-ar".to_string(),
        "16000".to_string(),
        "-b:a".to_string(),
        "32k".to_string(),
        output_path.to_string_lossy().to_string(),
    ];

    let ffmpeg_result = run_ffmpeg(&app, ffmpeg_args).await;

    let _ = fs::remove_file(&input_path);

    if let Err(message) = ffmpeg_result {
        let _ = fs::remove_file(&output_path);
        return Err(if message.is_empty() {
            "Не удалось извлечь аудио из файла.".to_string()
        } else {
            format!("Не удалось извлечь аудио из файла: {}", message)
        });
    }

    let metadata = fs::metadata(&output_path).map_err(|err| {
        let _ = fs::remove_file(&output_path);
        format!("Не удалось прочитать сжатый аудиофайл: {}", err)
    })?;

    if metadata.len() > MAX_TRANSCRIPTION_BYTES {
        let _ = fs::remove_file(&output_path);
        return Err(
            "После сжатия файл всё ещё больше 25 МБ. Выберите более короткий фрагмент.".to_string(),
        );
    }

    let output_bytes = fs::read(&output_path).map_err(|err| {
        let _ = fs::remove_file(&output_path);
        format!("Не удалось прочитать сжатый аудиофайл: {}", err)
    })?;
    let _ = fs::remove_file(&output_path);

    Ok(PrepareMediaResponse {
        audio_base64: base64::engine::general_purpose::STANDARD.encode(output_bytes),
        file_name: "talkis-transcription.mp3".to_string(),
        mime_type: "audio/mpeg".to_string(),
        size_bytes: metadata.len(),
    })
}
