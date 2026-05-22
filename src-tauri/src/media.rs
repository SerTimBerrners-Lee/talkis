use crate::logger;
use base64::Engine;
use hound::{SampleFormat, WavReader};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
#[cfg(debug_assertions)]
use std::process::Command;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri_plugin_shell::ShellExt;

const MAX_TRANSCRIPTION_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_FILE_TRANSCRIPTION_INPUT_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const FILE_TRANSCRIPTION_SEGMENT_SECONDS: u32 = 600;

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

pub struct PreparedMediaChunk {
    pub path: PathBuf,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub start_offset_seconds: f64,
}

pub struct PreparedMediaChunks {
    pub temp_dir: PathBuf,
    pub chunks: Vec<PreparedMediaChunk>,
}

pub struct PreparedProxyMedia {
    pub temp_dir: PathBuf,
    pub path: PathBuf,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

pub struct PreparedDiarizationAudio {
    pub temp_dir: PathBuf,
    pub path: PathBuf,
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

fn is_local_stt_ready_wav(input_bytes: &[u8]) -> bool {
    let Ok(reader) = WavReader::new(Cursor::new(input_bytes)) else {
        return false;
    };
    let spec = reader.spec();

    spec.sample_rate == 16000
        && spec.channels == 1
        && spec.bits_per_sample == 16
        && spec.sample_format == SampleFormat::Int
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
    match app.shell().sidecar("talkis-ffmpeg") {
        Ok(command) => {
            logger::log_info("MEDIA", "Running bundled ffmpeg sidecar");
            let started_at = Instant::now();
            let output = command
                .args(args.clone())
                .output()
                .await
                .map_err(|err| format!("Не удалось запустить встроенный ffmpeg: {}", err))?;
            let elapsed_ms = started_at.elapsed().as_millis();

            if output.status.success() {
                logger::log_info(
                    "MEDIA",
                    &format!("Bundled ffmpeg sidecar finished in {}ms", elapsed_ms),
                );
                return Ok(output.stderr);
            }

            logger::log_error(
                "MEDIA",
                &format!("Bundled ffmpeg sidecar failed in {}ms", elapsed_ms),
            );
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Err(err) => {
            logger::log_error(
                "MEDIA",
                &format!("Bundled ffmpeg sidecar unavailable: {}", err),
            );
        }
    }

    #[cfg(debug_assertions)]
    {
        let ffmpeg = resolve_ffmpeg()?;
        logger::log_info(
            "MEDIA",
            &format!("Running system ffmpeg fallback: {:?}", ffmpeg),
        );
        let started_at = Instant::now();
        let output = Command::new(&ffmpeg)
            .args(&args)
            .output()
            .map_err(|err| format!("Не удалось запустить системный ffmpeg: {}", err))?;
        let elapsed_ms = started_at.elapsed().as_millis();

        if output.status.success() {
            logger::log_info(
                "MEDIA",
                &format!("System ffmpeg fallback finished in {}ms", elapsed_ms),
            );
            return Ok(output.stderr);
        }

        logger::log_error(
            "MEDIA",
            &format!("System ffmpeg fallback failed in {}ms", elapsed_ms),
        );
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    #[cfg(not(debug_assertions))]
    {
        Err("Встроенный медиаконвертер недоступен. Переустановите приложение или обратитесь в поддержку Talkis.".to_string())
    }
}

pub async fn convert_audio_to_local_stt_wav(
    app: &tauri::AppHandle,
    input_bytes: &[u8],
    file_name: &str,
) -> Result<Vec<u8>, String> {
    if is_local_stt_ready_wav(input_bytes) {
        logger::log_info(
            "MEDIA",
            &format!(
                "Skipping ffmpeg for local STT: input is already 16 kHz mono PCM WAV, size={} bytes",
                input_bytes.len()
            ),
        );
        return Ok(input_bytes.to_vec());
    }

    let input_ext = file_extension(file_name);
    let input_path = unique_temp_path("local-stt-input", input_ext);
    let output_path = unique_temp_path("local-stt-output", "wav");

    fs::write(&input_path, input_bytes)
        .map_err(|err| format!("Не удалось подготовить аудио для локального STT: {}", err))?;

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
        "-acodec".to_string(),
        "pcm_s16le".to_string(),
        output_path.to_string_lossy().to_string(),
    ];

    let ffmpeg_result = run_ffmpeg(app, ffmpeg_args).await;
    let _ = fs::remove_file(&input_path);

    if let Err(message) = ffmpeg_result {
        let _ = fs::remove_file(&output_path);
        return Err(if message.is_empty() {
            "Не удалось подготовить аудио для локального STT.".to_string()
        } else {
            format!(
                "Не удалось подготовить аудио для локального STT: {}",
                message
            )
        });
    }

    let output_bytes = fs::read(&output_path).map_err(|err| {
        let _ = fs::remove_file(&output_path);
        format!("Не удалось прочитать WAV для локального STT: {}", err)
    })?;
    let _ = fs::remove_file(&output_path);

    Ok(output_bytes)
}

pub async fn prepare_media_file_chunks_for_transcription(
    app: &tauri::AppHandle,
    input_path: &Path,
) -> Result<PreparedMediaChunks, String> {
    let metadata =
        fs::metadata(input_path).map_err(|err| format!("Не удалось прочитать файл: {}", err))?;

    if !metadata.is_file() {
        return Err("Выбранный путь не является файлом.".to_string());
    }

    if metadata.len() == 0 {
        return Err("Пустой файл нельзя транскрибировать.".to_string());
    }

    if metadata.len() > MAX_FILE_TRANSCRIPTION_INPUT_BYTES {
        return Err(
            "Файл слишком большой. Максимальный размер для локальной подготовки: 8 ГБ.".to_string(),
        );
    }

    if metadata.len() <= MAX_TRANSCRIPTION_BYTES {
        if let Ok(input_bytes) = fs::read(input_path) {
            if is_local_stt_ready_wav(&input_bytes) {
                logger::log_info(
                    "MEDIA",
                    &format!(
                        "Skipping ffmpeg for file transcription: input is already 16 kHz mono PCM WAV, size={} bytes",
                        metadata.len()
                    ),
                );
                return Ok(PreparedMediaChunks {
                    temp_dir: unique_temp_path("file-transcription-direct-wav", "dir"),
                    chunks: vec![PreparedMediaChunk {
                        path: input_path.to_path_buf(),
                        file_name: input_path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("talkis-transcription.wav")
                            .to_string(),
                        mime_type: "audio/wav".to_string(),
                        size_bytes: metadata.len(),
                        start_offset_seconds: 0.0,
                    }],
                });
            }
        }
    }

    let chunks_dir = unique_temp_path("file-transcription-chunks", "dir");
    fs::create_dir_all(&chunks_dir)
        .map_err(|err| format!("Не удалось подготовить временную папку: {}", err))?;

    let output_pattern = chunks_dir.join("chunk-%05d.mp3");
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
        "-f".to_string(),
        "segment".to_string(),
        "-segment_time".to_string(),
        FILE_TRANSCRIPTION_SEGMENT_SECONDS.to_string(),
        "-reset_timestamps".to_string(),
        "1".to_string(),
        output_pattern.to_string_lossy().to_string(),
    ];

    if let Err(message) = run_ffmpeg(app, ffmpeg_args).await {
        let _ = fs::remove_dir_all(&chunks_dir);
        return Err(if message.is_empty() {
            "Не удалось извлечь аудио из файла.".to_string()
        } else {
            format!("Не удалось извлечь аудио из файла: {}", message)
        });
    }

    let mut chunk_paths = fs::read_dir(&chunks_dir)
        .map_err(|err| {
            let _ = fs::remove_dir_all(&chunks_dir);
            format!("Не удалось прочитать подготовленные фрагменты: {}", err)
        })?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("mp3"))
        .collect::<Vec<_>>();
    chunk_paths.sort();

    if chunk_paths.is_empty() {
        let _ = fs::remove_dir_all(&chunks_dir);
        return Err("Не удалось извлечь аудио из файла.".to_string());
    }

    let mut chunks = Vec::with_capacity(chunk_paths.len());
    for path in chunk_paths {
        let metadata = fs::metadata(&path).map_err(|err| {
            let _ = fs::remove_dir_all(&chunks_dir);
            format!("Не удалось прочитать фрагмент аудио: {}", err)
        })?;

        if metadata.len() > MAX_TRANSCRIPTION_BYTES {
            let _ = fs::remove_dir_all(&chunks_dir);
            return Err(
                "Подготовленный фрагмент больше 25 МБ. Попробуйте более короткий файл.".to_string(),
            );
        }

        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("talkis-transcription-chunk.mp3")
            .to_string();

        chunks.push(PreparedMediaChunk {
            path,
            file_name,
            mime_type: "audio/mpeg".to_string(),
            size_bytes: metadata.len(),
            start_offset_seconds: chunks.len() as f64 * FILE_TRANSCRIPTION_SEGMENT_SECONDS as f64,
        });
    }

    Ok(PreparedMediaChunks {
        temp_dir: chunks_dir,
        chunks,
    })
}

pub async fn prepare_media_file_for_proxy_transcription(
    app: &tauri::AppHandle,
    input_path: &Path,
) -> Result<PreparedProxyMedia, String> {
    let metadata =
        fs::metadata(input_path).map_err(|err| format!("Не удалось прочитать файл: {}", err))?;

    if !metadata.is_file() {
        return Err("Выбранный путь не является файлом.".to_string());
    }

    if metadata.len() == 0 {
        return Err("Пустой файл нельзя транскрибировать.".to_string());
    }

    if metadata.len() > MAX_FILE_TRANSCRIPTION_INPUT_BYTES {
        return Err(
            "Файл слишком большой. Максимальный размер для локальной подготовки: 8 ГБ.".to_string(),
        );
    }

    let temp_dir = unique_temp_path("file-proxy-transcription", "dir");
    fs::create_dir_all(&temp_dir)
        .map_err(|err| format!("Не удалось подготовить временную папку: {}", err))?;
    let output_path = temp_dir.join("talkis-cloud-diarization.mp3");
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

    if let Err(message) = run_ffmpeg(app, ffmpeg_args).await {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(if message.is_empty() {
            "Не удалось извлечь аудио из файла.".to_string()
        } else {
            format!("Не удалось извлечь аудио из файла: {}", message)
        });
    }

    let output_metadata = fs::metadata(&output_path).map_err(|err| {
        let _ = fs::remove_dir_all(&temp_dir);
        format!("Не удалось прочитать сжатый аудиофайл: {}", err)
    })?;

    if output_metadata.len() > MAX_TRANSCRIPTION_BYTES {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err("После сжатия файл всё ещё больше 25 МБ. Для облачного разделения по говорящим выберите более короткий файл или используйте локальную разметку.".to_string());
    }

    Ok(PreparedProxyMedia {
        temp_dir,
        path: output_path,
        file_name: "talkis-cloud-diarization.mp3".to_string(),
        mime_type: "audio/mpeg".to_string(),
        size_bytes: output_metadata.len(),
    })
}

pub async fn prepare_media_file_for_diarization(
    app: &tauri::AppHandle,
    input_path: &Path,
) -> Result<PreparedDiarizationAudio, String> {
    let metadata =
        fs::metadata(input_path).map_err(|err| format!("Не удалось прочитать файл: {}", err))?;

    if !metadata.is_file() {
        return Err("Выбранный путь не является файлом.".to_string());
    }

    if metadata.len() == 0 {
        return Err("Пустой файл нельзя транскрибировать.".to_string());
    }

    if metadata.len() > MAX_FILE_TRANSCRIPTION_INPUT_BYTES {
        return Err(
            "Файл слишком большой. Максимальный размер для локальной подготовки: 8 ГБ.".to_string(),
        );
    }

    let temp_dir = unique_temp_path("file-diarization", "dir");
    fs::create_dir_all(&temp_dir)
        .map_err(|err| format!("Не удалось подготовить временную папку: {}", err))?;
    let output_path = temp_dir.join("talkis-diarization.wav");
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
        "-acodec".to_string(),
        "pcm_s16le".to_string(),
        output_path.to_string_lossy().to_string(),
    ];

    if let Err(message) = run_ffmpeg(app, ffmpeg_args).await {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(if message.is_empty() {
            "Не удалось подготовить аудио для разделения говорящих.".to_string()
        } else {
            format!(
                "Не удалось подготовить аудио для разделения говорящих: {}",
                message
            )
        });
    }

    Ok(PreparedDiarizationAudio {
        temp_dir,
        path: output_path,
    })
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
