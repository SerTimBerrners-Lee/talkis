use crate::logger;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tokio::io::AsyncWriteExt;
use tokio::process::Command as TokioCommand;

const WHISPER_RUNTIME_NAME: &str = "talkis-stt";
const NVIDIA_RUNTIME_NAME: &str = "talkis-stt-nvidia";
const QWEN_RUNTIME_NAME: &str = "talkis-stt-qwen";
const DEFAULT_RUNTIME_MANIFEST_URL: &str = "https://talkis.ru/downloads/talkis-stt/manifest.json";
pub const MODEL_DOWNLOAD_PROGRESS_EVENT: &str = "local-stt-model-download-progress";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalRuntimeKind {
    Whisper,
    Nvidia,
    Qwen,
}

impl LocalRuntimeKind {
    fn runtime_name(self) -> &'static str {
        match self {
            LocalRuntimeKind::Whisper => WHISPER_RUNTIME_NAME,
            LocalRuntimeKind::Nvidia => NVIDIA_RUNTIME_NAME,
            LocalRuntimeKind::Qwen => QWEN_RUNTIME_NAME,
        }
    }

    fn engine_name(self) -> &'static str {
        match self {
            LocalRuntimeKind::Whisper => "whisper.cpp",
            LocalRuntimeKind::Nvidia => "parakeet-mlx",
            LocalRuntimeKind::Qwen => "qwen-asr",
        }
    }

    fn default_port(self) -> u16 {
        match self {
            LocalRuntimeKind::Whisper => 8000,
            LocalRuntimeKind::Nvidia => 8001,
            LocalRuntimeKind::Qwen => 8002,
        }
    }

    fn label(self) -> &'static str {
        match self {
            LocalRuntimeKind::Whisper => "Whisper",
            LocalRuntimeKind::Nvidia => "NVIDIA",
            LocalRuntimeKind::Qwen => "Qwen",
        }
    }
}

#[derive(Deserialize)]
struct RuntimeManifest {
    version: String,
    #[serde(rename = "macos-aarch64")]
    macos_aarch64: Option<RuntimeAsset>,
    #[serde(rename = "macos-x86_64")]
    macos_x86_64: Option<RuntimeAsset>,
}

#[derive(Deserialize)]
struct RuntimeAsset {
    url: String,
    sha256: String,
}

#[derive(Deserialize)]
struct HealthResponse {
    status: Option<String>,
    runtime: Option<String>,
    engine: Option<String>,
}

enum LocalSttProbe {
    Ready,
    StaleManagedRuntime,
    Unavailable,
}

#[derive(Serialize, Clone)]
pub struct ModelDownloadProgress {
    pub model: String,
    pub status: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

struct LocalModelInfo {
    id: &'static str,
    file_name: &'static str,
    url: &'static str,
}

struct QwenModelFile {
    file_name: &'static str,
    size: u64,
}

struct NvidiaModelInfo {
    id: &'static str,
    dir_name: &'static str,
    files: &'static [QwenModelFile],
}

const LOCAL_WHISPER_MODELS: &[LocalModelInfo] = &[
    LocalModelInfo {
        id: "whisper-tiny",
        file_name: "ggml-tiny.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    },
    LocalModelInfo {
        id: "whisper-base",
        file_name: "ggml-base.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    },
    LocalModelInfo {
        id: "whisper-small",
        file_name: "ggml-small.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    },
    LocalModelInfo {
        id: "whisper-medium",
        file_name: "ggml-medium.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    },
    LocalModelInfo {
        id: "whisper-large-v2",
        file_name: "ggml-large-v2.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v2.bin",
    },
    LocalModelInfo {
        id: "whisper-large-v3",
        file_name: "ggml-large-v3.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
    },
    LocalModelInfo {
        id: "whisper-large-v3-turbo",
        file_name: "ggml-large-v3-turbo.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
    },
];

const LOCAL_QWEN_MODEL_ID: &str = "Qwen/Qwen3-ASR-0.6B";
const LOCAL_QWEN_MODEL_DIR: &str = "qwen3-asr-06b";
const LOCAL_QWEN_MODEL_FILES: &[QwenModelFile] = &[
    QwenModelFile {
        file_name: ".gitattributes",
        size: 1_519,
    },
    QwenModelFile {
        file_name: "README.md",
        size: 57_456,
    },
    QwenModelFile {
        file_name: "chat_template.json",
        size: 1_161,
    },
    QwenModelFile {
        file_name: "config.json",
        size: 6_193,
    },
    QwenModelFile {
        file_name: "generation_config.json",
        size: 142,
    },
    QwenModelFile {
        file_name: "merges.txt",
        size: 1_671_853,
    },
    QwenModelFile {
        file_name: "model.safetensors",
        size: 1_876_091_704,
    },
    QwenModelFile {
        file_name: "preprocessor_config.json",
        size: 330,
    },
    QwenModelFile {
        file_name: "tokenizer_config.json",
        size: 12_487,
    },
    QwenModelFile {
        file_name: "vocab.json",
        size: 2_776_833,
    },
];

const LOCAL_NVIDIA_V3_MODEL_ID: &str = "mlx-community/parakeet-tdt-0.6b-v3";
const LOCAL_NVIDIA_V3_MODEL_DIR: &str = "parakeet-tdt-06b-v3";
const LOCAL_NVIDIA_V3_MODEL_FILES: &[QwenModelFile] = &[
    QwenModelFile {
        file_name: ".gitattributes",
        size: 1_519,
    },
    QwenModelFile {
        file_name: "README.md",
        size: 1_081,
    },
    QwenModelFile {
        file_name: "config.json",
        size: 244_093,
    },
    QwenModelFile {
        file_name: "model.safetensors",
        size: 2_508_288_736,
    },
    QwenModelFile {
        file_name: "tokenizer.model",
        size: 360_916,
    },
    QwenModelFile {
        file_name: "tokenizer.vocab",
        size: 101_024,
    },
    QwenModelFile {
        file_name: "vocab.txt",
        size: 46_772,
    },
];

const LOCAL_NVIDIA_V2_MODEL_ID: &str = "mlx-community/parakeet-tdt-0.6b-v2";
const LOCAL_NVIDIA_V2_MODEL_DIR: &str = "parakeet-tdt-06b-v2";
const LOCAL_NVIDIA_V2_MODEL_FILES: &[QwenModelFile] = &[
    QwenModelFile {
        file_name: ".gitattributes",
        size: 1_519,
    },
    QwenModelFile {
        file_name: "README.md",
        size: 945,
    },
    QwenModelFile {
        file_name: "config.json",
        size: 36_200,
    },
    QwenModelFile {
        file_name: "model.safetensors",
        size: 2_469_999_999,
    },
    QwenModelFile {
        file_name: "tokenizer.model",
        size: 251_000,
    },
    QwenModelFile {
        file_name: "tokenizer.vocab",
        size: 10_400,
    },
    QwenModelFile {
        file_name: "vocab.txt",
        size: 5_071,
    },
];

const LOCAL_NVIDIA_MODELS: &[NvidiaModelInfo] = &[
    NvidiaModelInfo {
        id: LOCAL_NVIDIA_V3_MODEL_ID,
        dir_name: LOCAL_NVIDIA_V3_MODEL_DIR,
        files: LOCAL_NVIDIA_V3_MODEL_FILES,
    },
    NvidiaModelInfo {
        id: LOCAL_NVIDIA_V2_MODEL_ID,
        dir_name: LOCAL_NVIDIA_V2_MODEL_DIR,
        files: LOCAL_NVIDIA_V2_MODEL_FILES,
    },
];

fn resolve_stt_base_url_from_models_url(models_url: &str) -> String {
    models_url
        .trim_end_matches('/')
        .strip_suffix("/v1/models")
        .or_else(|| models_url.trim_end_matches('/').strip_suffix("/models"))
        .unwrap_or_else(|| models_url.trim_end_matches('/'))
        .to_string()
}

pub fn managed_runtime_kind(models_url: &str) -> Option<LocalRuntimeKind> {
    let parsed = url::Url::parse(models_url.trim()).ok()?;
    let host = parsed.host_str()?.to_lowercase();
    if host != "127.0.0.1" && host != "localhost" {
        return None;
    }

    runtime_kind_for_port(parsed.port()?)
}

pub fn is_managed_whisper_runtime_url(models_url: &str) -> bool {
    managed_runtime_kind(models_url) == Some(LocalRuntimeKind::Whisper)
}

fn runtime_kind_for_port(port: u16) -> Option<LocalRuntimeKind> {
    if port == LocalRuntimeKind::Whisper.default_port() || (18000..=18049).contains(&port) {
        return Some(LocalRuntimeKind::Whisper);
    }

    if port == LocalRuntimeKind::Nvidia.default_port() || (18050..=18099).contains(&port) {
        return Some(LocalRuntimeKind::Nvidia);
    }

    if port == LocalRuntimeKind::Qwen.default_port() || (18100..=18149).contains(&port) {
        return Some(LocalRuntimeKind::Qwen);
    }

    None
}

fn dynamic_port_range(kind: LocalRuntimeKind) -> std::ops::RangeInclusive<u16> {
    match kind {
        LocalRuntimeKind::Whisper => 18000..=18049,
        LocalRuntimeKind::Nvidia => 18050..=18099,
        LocalRuntimeKind::Qwen => 18100..=18149,
    }
}

fn requested_port(base_url: &str, kind: LocalRuntimeKind) -> u16 {
    url::Url::parse(base_url)
        .ok()
        .and_then(|url| url.port())
        .filter(|port| runtime_kind_for_port(*port) == Some(kind))
        .unwrap_or_else(|| kind.default_port())
}

fn managed_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{}", port)
}

fn managed_models_url(base_url: &str) -> String {
    format!("{}/v1/models", base_url.trim_end_matches('/'))
}

fn port_is_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn find_available_runtime_port(kind: LocalRuntimeKind, preferred_port: u16) -> Result<u16, String> {
    if port_is_available(preferred_port) {
        return Ok(preferred_port);
    }

    if preferred_port != kind.default_port() && port_is_available(kind.default_port()) {
        return Ok(kind.default_port());
    }

    for port in dynamic_port_range(kind) {
        if port != preferred_port && port_is_available(port) {
            return Ok(port);
        }
    }

    Err(format!(
        "Не найден свободный порт для локального {} runtime. Освободите порт {} или закройте лишние локальные STT процессы.",
        kind.label(),
        kind.default_port()
    ))
}

fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(local_stt_dir(app)?.join("runtime"))
}

fn local_stt_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|err| format!("Не удалось найти папку данных Talkis: {}", err))
        .map(|dir| dir.join("local-stt"))
}

pub fn default_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(local_stt_dir(app)?.join("models"))
}

fn resolve_models_dir(app: &AppHandle, custom_dir: Option<&str>) -> Result<PathBuf, String> {
    custom_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| default_models_dir(app))
}

fn local_model_info(value: &str) -> Option<&'static LocalModelInfo> {
    let normalized = value.trim().to_lowercase();
    match normalized.as_str() {
        "whisper-tiny" | "tiny" | "systran/faster-whisper-tiny" | "ggml-tiny.bin" => {
            LOCAL_WHISPER_MODELS
                .iter()
                .find(|model| model.id == "whisper-tiny")
        }
        "whisper-base" | "base" | "systran/faster-whisper-base" | "ggml-base.bin" => {
            LOCAL_WHISPER_MODELS
                .iter()
                .find(|model| model.id == "whisper-base")
        }
        "whisper-small" | "small" | "systran/faster-whisper-small" | "ggml-small.bin" => {
            LOCAL_WHISPER_MODELS
                .iter()
                .find(|model| model.id == "whisper-small")
        }
        "whisper-medium" | "medium" | "systran/faster-whisper-medium" | "ggml-medium.bin" => {
            LOCAL_WHISPER_MODELS
                .iter()
                .find(|model| model.id == "whisper-medium")
        }
        "whisper-large-v2"
        | "large-v2"
        | "systran/faster-whisper-large-v2"
        | "ggml-large-v2.bin" => LOCAL_WHISPER_MODELS
            .iter()
            .find(|model| model.id == "whisper-large-v2"),
        "whisper-large-v3"
        | "large-v3"
        | "systran/faster-whisper-large-v3"
        | "ggml-large-v3.bin" => LOCAL_WHISPER_MODELS
            .iter()
            .find(|model| model.id == "whisper-large-v3"),
        "whisper-large-v3-turbo"
        | "large-v3-turbo"
        | "systran/faster-whisper-large-v3-turbo"
        | "mlx-community/whisper-large-v3-turbo-4bit"
        | "ggml-large-v3-turbo.bin" => LOCAL_WHISPER_MODELS
            .iter()
            .find(|model| model.id == "whisper-large-v3-turbo"),
        _ => None,
    }
}

fn emit_download_progress(app: &AppHandle, progress: ModelDownloadProgress) {
    let _ = app.emit(MODEL_DOWNLOAD_PROGRESS_EVENT, progress);
}

fn progress_percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    total
        .filter(|value| *value > 0)
        .map(|value| ((downloaded.saturating_mul(100) / value).min(100)) as u8)
}

fn model_download_progress(
    model: &str,
    status: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) -> ModelDownloadProgress {
    ModelDownloadProgress {
        model: model.to_string(),
        status: status.to_string(),
        downloaded_bytes,
        total_bytes,
        percent: progress_percent(downloaded_bytes, total_bytes),
        message: None,
    }
}

pub fn emit_model_download_progress_message(
    app: &AppHandle,
    model: &str,
    status: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    message: &str,
) {
    let mut progress = model_download_progress(model, status, downloaded_bytes, total_bytes);
    progress.message = Some(message.to_string());
    emit_download_progress(app, progress);
}

pub async fn download_model_with_progress(
    app: &AppHandle,
    _client: &reqwest::Client,
    custom_dir: Option<&str>,
    model: &str,
) -> Result<String, String> {
    let info = local_model_info(model).ok_or_else(|| {
        format!(
            "Модель «{}» не поддерживается встроенным Whisper runtime.",
            model
        )
    })?;
    let models_dir = resolve_models_dir(app, custom_dir)?;
    tokio::fs::create_dir_all(&models_dir)
        .await
        .map_err(|err| format!("Не удалось подготовить директорию моделей: {}", err))?;

    let model_path = models_dir.join(info.file_name);
    let marker_path = models_dir.join(format!("{}.json", info.id));
    let temp_path = model_path.with_extension("download");
    if model_path.is_file() {
        emit_download_progress(
            app,
            model_download_progress(model, "downloaded", 1, Some(1)),
        );
        write_model_marker(&marker_path, info)?;
        return Ok(info.id.to_string());
    }

    emit_download_progress(app, model_download_progress(model, "starting", 0, None));
    let download_client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .connect_timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut response = download_client
        .get(info.url)
        .send()
        .await
        .map_err(|err| format!("Не удалось скачать модель «{}»: {}", info.id, err))?
        .error_for_status()
        .map_err(|err| format!("Скачивание модели «{}» вернуло ошибку: {}", info.id, err))?;
    let total_bytes = response.content_length();
    let mut downloaded_bytes = 0u64;
    let mut last_percent: Option<u8> = None;
    let mut last_emitted_bytes = 0u64;

    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|err| format!("Не удалось сохранить модель «{}»: {}", info.id, err))?;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("Не удалось прочитать модель «{}»: {}", info.id, err))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("Не удалось записать модель «{}»: {}", info.id, err))?;
        downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
        let percent = progress_percent(downloaded_bytes, total_bytes);
        let byte_delta = downloaded_bytes.saturating_sub(last_emitted_bytes);

        if percent != last_percent || byte_delta >= 8 * 1024 * 1024 {
            emit_download_progress(
                app,
                model_download_progress(model, "downloading", downloaded_bytes, total_bytes),
            );
            last_percent = percent;
            last_emitted_bytes = downloaded_bytes;
        }
    }

    file.flush()
        .await
        .map_err(|err| format!("Не удалось завершить запись модели «{}»: {}", info.id, err))?;
    drop(file);

    tokio::fs::rename(&temp_path, &model_path)
        .await
        .map_err(|err| format!("Не удалось установить модель «{}»: {}", info.id, err))?;
    write_model_marker(&marker_path, info)?;
    emit_download_progress(
        app,
        model_download_progress(model, "downloaded", downloaded_bytes, total_bytes),
    );

    Ok(info.id.to_string())
}

fn write_model_marker(path: &Path, model: &LocalModelInfo) -> Result<(), String> {
    let marker = serde_json::json!({
        "id": model.id,
        "file": model.file_name,
        "engine": "whisper.cpp"
    });
    fs::write(path, marker.to_string()).map_err(|err| {
        format!(
            "Не удалось сохранить состояние модели «{}»: {}",
            model.id, err
        )
    })
}

pub fn delete_downloaded_model(
    app: &AppHandle,
    custom_dir: Option<&str>,
    model: &str,
) -> Result<(), String> {
    let info = local_model_info(model).ok_or_else(|| {
        format!(
            "Модель «{}» не поддерживается встроенным Whisper runtime.",
            model
        )
    })?;
    let models_dir = resolve_models_dir(app, custom_dir)?;
    let model_path = models_dir.join(info.file_name);
    let marker_path = models_dir.join(format!("{}.json", info.id));
    let temp_path = model_path.with_extension("download");

    for path in [&model_path, &marker_path, &temp_path] {
        if path.is_file() {
            fs::remove_file(path)
                .map_err(|err| format!("Не удалось удалить {}: {}", path.display(), err))?;
        }
    }

    Ok(())
}

pub fn installed_model_ids(
    app: &AppHandle,
    custom_dir: Option<&str>,
) -> Result<Vec<String>, String> {
    let models_dir = resolve_models_dir(app, custom_dir)?;
    let mut models = LOCAL_WHISPER_MODELS
        .iter()
        .filter(|model| models_dir.join(model.file_name).is_file())
        .map(|model| model.id.to_string())
        .collect::<Vec<_>>();

    if qwen_model_is_installed_in_dir(&models_dir) {
        models.push(LOCAL_QWEN_MODEL_ID.to_string());
    }
    for model in LOCAL_NVIDIA_MODELS {
        if nvidia_model_is_installed_in_dir(&models_dir, model) {
            models.push(model.id.to_string());
        }
    }

    models.sort();
    models.dedup();
    Ok(models)
}

fn qwen_model_is_installed_in_dir(models_dir: &Path) -> bool {
    let model_dir = models_dir.join(LOCAL_QWEN_MODEL_DIR);
    LOCAL_QWEN_MODEL_FILES
        .iter()
        .all(|file| model_dir.join(file.file_name).is_file())
}

fn nvidia_model_info(requested: &str) -> Option<&'static NvidiaModelInfo> {
    LOCAL_NVIDIA_MODELS.iter().find(|model| {
        model.id.eq_ignore_ascii_case(requested)
            || model.dir_name.eq_ignore_ascii_case(requested)
            || (requested.eq_ignore_ascii_case("nvidia/parakeet-tdt-0.6b-v3")
                && model.id == LOCAL_NVIDIA_V3_MODEL_ID)
            || (requested.eq_ignore_ascii_case("nvidia/parakeet-tdt-0.6b-v2")
                && model.id == LOCAL_NVIDIA_V2_MODEL_ID)
    })
}

fn nvidia_model_is_installed_in_dir(models_dir: &Path, model: &NvidiaModelInfo) -> bool {
    let model_dir = models_dir.join(model.dir_name);
    model
        .files
        .iter()
        .all(|file| model_dir.join(file.file_name).is_file())
}

pub fn qwen_model_is_installed(app: &AppHandle, custom_dir: Option<&str>) -> Result<bool, String> {
    let models_dir = resolve_models_dir(app, custom_dir)?;
    Ok(qwen_model_is_installed_in_dir(&models_dir))
}

pub fn nvidia_model_is_installed(
    app: &AppHandle,
    custom_dir: Option<&str>,
    requested: &str,
) -> Result<bool, String> {
    let models_dir = resolve_models_dir(app, custom_dir)?;
    Ok(nvidia_model_info(requested)
        .map(|model| nvidia_model_is_installed_in_dir(&models_dir, model))
        .unwrap_or(false))
}

pub fn qwen_model_progress_snapshot(
    app: &AppHandle,
    custom_dir: Option<&str>,
) -> Result<(u64, Option<u64>), String> {
    let models_dir = resolve_models_dir(app, custom_dir)?;
    let model_dir = models_dir.join(LOCAL_QWEN_MODEL_DIR);
    let total = LOCAL_QWEN_MODEL_FILES
        .iter()
        .map(|file| file.size)
        .sum::<u64>();
    let downloaded = directory_size(&model_dir).unwrap_or(0).min(total);

    Ok((downloaded, Some(total)))
}

pub fn nvidia_model_progress_snapshot(
    app: &AppHandle,
    custom_dir: Option<&str>,
    requested: &str,
) -> Result<(u64, Option<u64>), String> {
    let models_dir = resolve_models_dir(app, custom_dir)?;
    let model = nvidia_model_info(requested).unwrap_or(&LOCAL_NVIDIA_MODELS[0]);
    let model_dir = models_dir.join(model.dir_name);
    let total = model.files.iter().map(|file| file.size).sum::<u64>();
    let downloaded = directory_size(&model_dir).unwrap_or(0).min(total);

    Ok((downloaded, Some(total)))
}

pub fn resolve_installed_model_for_runtime(
    app: &AppHandle,
    kind: LocalRuntimeKind,
    custom_dir: Option<&str>,
    requested: &str,
) -> Result<Option<String>, String> {
    let models_dir = resolve_models_dir(app, custom_dir)?;

    match kind {
        LocalRuntimeKind::Whisper => {
            if let Some(model) = local_model_info(requested) {
                if models_dir.join(model.file_name).is_file() {
                    return Ok(Some(model.id.to_string()));
                }
            }

            for model_id in [
                "whisper-medium",
                "whisper-base",
                "whisper-small",
                "whisper-large-v3-turbo",
                "whisper-large-v3",
                "whisper-large-v2",
                "whisper-tiny",
            ] {
                if let Some(model) = local_model_info(model_id) {
                    if models_dir.join(model.file_name).is_file() {
                        return Ok(Some(model.id.to_string()));
                    }
                }
            }

            Ok(None)
        }
        LocalRuntimeKind::Qwen => {
            if qwen_model_is_installed_in_dir(&models_dir) {
                Ok(Some(LOCAL_QWEN_MODEL_ID.to_string()))
            } else {
                Ok(None)
            }
        }
        LocalRuntimeKind::Nvidia => {
            if let Some(model) = nvidia_model_info(requested) {
                if nvidia_model_is_installed_in_dir(&models_dir, model) {
                    return Ok(Some(model.id.to_string()));
                }
            }

            for model in LOCAL_NVIDIA_MODELS {
                if nvidia_model_is_installed_in_dir(&models_dir, model) {
                    return Ok(Some(model.id.to_string()));
                }
            }

            Ok(None)
        }
    }
}

fn directory_size(path: &Path) -> Result<u64, std::io::Error> {
    if !path.exists() {
        return Ok(0);
    }

    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            total = total.saturating_add(directory_size(&entry.path())?);
        }
    }

    Ok(total)
}

fn runtime_executable_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_dir(app)?.join(WHISPER_RUNTIME_NAME))
}

fn runtime_manifest_url() -> String {
    std::env::var("TALKIS_STT_RUNTIME_MANIFEST")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_RUNTIME_MANIFEST_URL.to_string())
}

fn platform_asset<'a>(manifest: &'a RuntimeManifest) -> Option<&'a RuntimeAsset> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => manifest.macos_aarch64.as_ref(),
        ("macos", "x86_64") => manifest.macos_x86_64.as_ref(),
        _ => None,
    }
}

fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = hex::encode(Sha256::digest(bytes));
    if actual.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err("Загруженный локальный STT runtime не прошел проверку целостности.".to_string())
    }
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)
        .map_err(|err| format!("Не удалось прочитать права runtime: {}", err))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|err| format!("Не удалось сделать runtime исполняемым: {}", err))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

async fn download_runtime(app: &AppHandle, client: &reqwest::Client) -> Result<PathBuf, String> {
    let manifest_url = runtime_manifest_url();
    logger::log_info(
        "LOCAL_STT",
        &format!("Downloading local STT runtime manifest: {}", manifest_url),
    );

    let manifest = client
        .get(&manifest_url)
        .send()
        .await
        .map_err(|err| {
            format!(
                "Не удалось скачать manifest локального STT runtime: {}",
                err
            )
        })?
        .error_for_status()
        .map_err(|err| format!("Manifest локального STT runtime вернул ошибку: {}", err))?
        .json::<RuntimeManifest>()
        .await
        .map_err(|err| format!("Manifest локального STT runtime некорректен: {}", err))?;

    let asset = platform_asset(&manifest).ok_or_else(|| {
        format!(
            "Для этой платформы нет локального STT runtime: {}-{}.",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;

    logger::log_info(
        "LOCAL_STT",
        &format!(
            "Downloading local STT runtime version {}: {}",
            manifest.version, asset.url
        ),
    );

    let bytes = client
        .get(&asset.url)
        .send()
        .await
        .map_err(|err| format!("Не удалось скачать локальный STT runtime: {}", err))?
        .error_for_status()
        .map_err(|err| format!("Скачивание локального STT runtime вернуло ошибку: {}", err))?
        .bytes()
        .await
        .map_err(|err| format!("Не удалось прочитать локальный STT runtime: {}", err))?;

    verify_sha256(&bytes, &asset.sha256)?;

    let dir = runtime_dir(app)?;
    fs::create_dir_all(&dir).map_err(|err| {
        format!(
            "Не удалось подготовить папку локального STT runtime: {}",
            err
        )
    })?;

    let executable_path = runtime_executable_path(app)?;
    let temp_path = executable_path.with_extension("download");
    fs::write(&temp_path, &bytes)
        .map_err(|err| format!("Не удалось сохранить локальный STT runtime: {}", err))?;
    make_executable(&temp_path)?;
    fs::rename(&temp_path, &executable_path)
        .map_err(|err| format!("Не удалось установить локальный STT runtime: {}", err))?;

    Ok(executable_path)
}

fn is_expected_runtime_health(health: &HealthResponse, kind: LocalRuntimeKind) -> bool {
    health
        .status
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("ok"))
        .unwrap_or(false)
        && health
            .runtime
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case(kind.runtime_name()))
            .unwrap_or(false)
        && health
            .engine
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case(kind.engine_name()))
            .unwrap_or(false)
}

fn is_stale_managed_runtime_health(health: &HealthResponse, kind: LocalRuntimeKind) -> bool {
    health
        .runtime
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case(kind.runtime_name()))
        .unwrap_or(false)
        && !is_expected_runtime_health(health, kind)
}

async fn probe_local_stt(
    client: &reqwest::Client,
    kind: LocalRuntimeKind,
    base_url: &str,
    models_url: &str,
) -> LocalSttProbe {
    let health_url = format!("{}/health", base_url.trim_end_matches('/'));
    if let Ok(response) = client
        .get(&health_url)
        .timeout(Duration::from_secs(3))
        .send()
        .await
    {
        if response.status().is_success() {
            if let Ok(text) = response.text().await {
                if let Ok(health) = serde_json::from_str::<HealthResponse>(&text) {
                    if is_expected_runtime_health(&health, kind) {
                        return LocalSttProbe::Ready;
                    }

                    if is_stale_managed_runtime_health(&health, kind) {
                        logger::log_info(
                            "LOCAL_STT",
                            &format!("Detected stale managed runtime: engine={:?}", health.engine),
                        );
                        return LocalSttProbe::StaleManagedRuntime;
                    }
                }
            }
        }
    }

    if client
        .get(models_url)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
    {
        LocalSttProbe::Ready
    } else {
        LocalSttProbe::Unavailable
    }
}

async fn local_stt_is_ready(
    client: &reqwest::Client,
    kind: LocalRuntimeKind,
    base_url: &str,
    models_url: &str,
) -> bool {
    matches!(
        probe_local_stt(client, kind, base_url, models_url).await,
        LocalSttProbe::Ready
    )
}

#[cfg(unix)]
fn stop_stale_managed_runtime(kind: LocalRuntimeKind, port: u16) -> Result<(), String> {
    let output = StdCommand::new("ps")
        .args(["-ax", "-o", "pid=,command="])
        .output()
        .map_err(|err| format!("Не удалось проверить старый локальный runtime: {}", err))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut killed = 0usize;

    for line in text.lines() {
        let trimmed = line.trim_start();
        let Some((pid_text, command)) = trimmed.split_once(char::is_whitespace) else {
            continue;
        };

        if !command.contains(kind.runtime_name())
            || !command.contains("--port")
            || !command.contains(&port.to_string())
        {
            continue;
        }

        let Some(pid) = pid_text.parse::<u32>().ok() else {
            continue;
        };

        let status = StdCommand::new("kill")
            .arg(pid.to_string())
            .status()
            .map_err(|err| format!("Не удалось остановить старый локальный runtime: {}", err))?;
        if status.success() {
            killed += 1;
        }
    }

    if killed > 0 {
        logger::log_info(
            "LOCAL_STT",
            &format!("Stopped {} stale managed runtime process(es)", killed),
        );
        Ok(())
    } else {
        Err("Не найден процесс старого локального runtime для остановки.".to_string())
    }
}

#[cfg(not(unix))]
fn stop_stale_managed_runtime(_kind: LocalRuntimeKind, _port: u16) -> Result<(), String> {
    Err(
        "Автоматическая остановка старого локального runtime недоступна на этой платформе."
            .to_string(),
    )
}

async fn wait_for_local_stt(
    client: &reqwest::Client,
    kind: LocalRuntimeKind,
    base_url: &str,
    models_url: &str,
    timeout: Duration,
) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if local_stt_is_ready(client, kind, base_url, models_url).await {
            return true;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    false
}

async fn start_bundled_runtime(
    app: &AppHandle,
    kind: LocalRuntimeKind,
    port: u16,
    models_dir: &Path,
) -> Result<(), String> {
    let data_dir = local_stt_dir(app)?;
    let command = app
        .shell()
        .sidecar(kind.runtime_name())
        .map_err(|err| format!("Встроенный локальный STT runtime недоступен: {}", err))?;

    command
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--data-dir",
            &data_dir.to_string_lossy(),
            "--models-dir",
            &models_dir.to_string_lossy(),
        ])
        .spawn()
        .map(|_| ())
        .map_err(|err| {
            format!(
                "Не удалось запустить встроенный локальный STT runtime: {}",
                err
            )
        })
}

async fn start_downloaded_runtime(
    app: &AppHandle,
    client: &reqwest::Client,
    port: u16,
    models_dir: &Path,
) -> Result<(), String> {
    let data_dir = local_stt_dir(app)?;
    let executable_path = match runtime_executable_path(app) {
        Ok(path) if path.is_file() => path,
        Ok(_) => download_runtime(app, client).await?,
        Err(err) => return Err(err),
    };

    TokioCommand::new(&executable_path)
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--data-dir",
            &data_dir.to_string_lossy(),
            "--models-dir",
            &models_dir.to_string_lossy(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|err| {
            format!(
                "Не удалось запустить локальный STT runtime {}: {}",
                executable_path.display(),
                err
            )
        })
}

pub async fn ensure_runtime(
    app: &AppHandle,
    client: &reqwest::Client,
    models_url: &str,
    custom_models_dir: Option<&str>,
) -> Result<String, String> {
    let kind = managed_runtime_kind(models_url).ok_or_else(|| {
        "Автоматический запуск локального runtime поддержан только для портов Talkis 8000/8001/8002."
            .to_string()
    })?;

    let base_url = resolve_stt_base_url_from_models_url(models_url);
    let preferred_port = requested_port(&base_url, kind);
    match probe_local_stt(client, kind, &base_url, models_url).await {
        LocalSttProbe::Ready => return Ok(base_url),
        LocalSttProbe::StaleManagedRuntime => {
            if let Err(err) = stop_stale_managed_runtime(kind, preferred_port) {
                logger::log_error("LOCAL_STT", &err);
            }
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
        LocalSttProbe::Unavailable => {}
    }

    logger::log_info(
        "LOCAL_STT",
        &format!("Starting managed local {} STT runtime", kind.label()),
    );
    let models_dir = resolve_models_dir(app, custom_models_dir)?;
    fs::create_dir_all(&models_dir)
        .map_err(|err| format!("Не удалось подготовить папку локальных моделей: {}", err))?;
    let runtime_port = find_available_runtime_port(kind, preferred_port)?;
    let runtime_base_url = managed_base_url(runtime_port);
    let runtime_models_url = managed_models_url(&runtime_base_url);
    if runtime_port != preferred_port {
        logger::log_info(
            "LOCAL_STT",
            &format!(
                "Port {} is unavailable for {}; using {}",
                preferred_port,
                kind.label(),
                runtime_port
            ),
        );
    }

    if let Err(err) = start_bundled_runtime(app, kind, runtime_port, &models_dir).await {
        logger::log_info(
            "LOCAL_STT",
            &format!("Bundled local STT runtime unavailable: {}", err),
        );
        if kind == LocalRuntimeKind::Whisper {
            start_downloaded_runtime(app, client, runtime_port, &models_dir).await?;
        } else {
            return Err(format!(
                "Встроенный {} runtime пока не подключен в сборку Talkis.",
                kind.label()
            ));
        }
    }

    if wait_for_local_stt(
        client,
        kind,
        &runtime_base_url,
        &runtime_models_url,
        Duration::from_secs(90),
    )
    .await
    {
        Ok(runtime_base_url)
    } else {
        Err("Локальный STT runtime запущен, но не успел стать доступным. Повторите установку модели через минуту.".to_string())
    }
}

#[tauri::command]
pub fn get_local_stt_default_models_dir(app: AppHandle) -> Result<String, String> {
    default_models_dir(&app).map(|path| path.to_string_lossy().to_string())
}
