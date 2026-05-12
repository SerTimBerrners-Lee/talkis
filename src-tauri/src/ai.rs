use crate::local_stt;
use crate::logger;
use crate::media;
use crate::prompt_config;
use base64::Engine;
use reqwest::multipart;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static LONG_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Disable connection pooling so VPN / network changes take effect
            // immediately without requiring an app restart.
            .pool_max_idle_per_host(0)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn long_http_client() -> &'static reqwest::Client {
    LONG_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(1800))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TranscribeRequest {
    pub audio_base64: String,
    pub language: String,
    pub api_key: String,
    pub whisper_api_key: Option<String>,
    pub llm_api_key: Option<String>,
    pub style: String,
    pub whisper_endpoint: Option<String>,
    pub local_models_dir: Option<String>,
    pub llm_endpoint: Option<String>,
    pub whisper_model: Option<String>,
    pub llm_model: Option<String>,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub mode: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct TranscribeResponse {
    pub raw: String,
    pub cleaned: String,
}

#[derive(Serialize, Deserialize)]
pub struct FilePathTranscriptionRequest {
    pub request_id: String,
    pub file_path: String,
    pub file_name: Option<String>,
    pub file_size: Option<u64>,
    pub language: String,
    pub api_key: String,
    pub whisper_api_key: Option<String>,
    pub style: String,
    pub whisper_endpoint: Option<String>,
    pub local_models_dir: Option<String>,
    pub whisper_model: Option<String>,
    pub use_own_key: bool,
    pub device_token: Option<String>,
}

#[derive(Serialize, Clone)]
struct FileTranscriptionProgressPayload {
    request_id: String,
    status: String,
    current_chunk: usize,
    total_chunks: usize,
    message: String,
}

const FILE_TRANSCRIPTION_PROGRESS_EVENT: &str = "file-transcription-progress";

fn build_whisper_prompt(language: &str, style: &str) -> Option<String> {
    match prompt_config::build_whisper_hint(language, style) {
        Ok(hint) => hint,
        Err(err) => {
            logger::log_error("WHISPER", &format!("Failed to build whisper hint: {}", err));
            None
        }
    }
}

fn is_known_whisper_hallucination(text: &str) -> bool {
    let normalized = text.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }

    let has_subtitle_credit_pattern = normalized.contains("редактор субтитров")
        || normalized.contains("editor subs")
        || normalized.contains("subtitles by");
    let has_proofreader_pattern = normalized.contains("корректор")
        || normalized.contains("proofread")
        || normalized.contains("correction by");
    let has_known_name = normalized.contains("синецк") || normalized.contains("егоров");

    (has_subtitle_credit_pattern && has_proofreader_pattern)
        || (has_subtitle_credit_pattern && has_known_name)
}

#[derive(Deserialize, Debug)]
struct WhisperSegment {
    #[serde(default)]
    avg_logprob: Option<f64>,
    #[serde(default)]
    no_speech_prob: Option<f64>,
    #[serde(default)]
    compression_ratio: Option<f64>,
}

#[derive(Deserialize, Debug)]
struct WhisperResp {
    text: String,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    segments: Vec<WhisperSegment>,
}

fn is_likely_short_uncertain_transcription(
    text: &str,
    duration_seconds: Option<f64>,
    segments: &[WhisperSegment],
) -> bool {
    let normalized = text.trim();
    if normalized.is_empty() {
        return true;
    }

    let duration_seconds = duration_seconds.unwrap_or_default();
    let short_audio = duration_seconds > 0.0 && duration_seconds <= 1.2;
    let short_text = normalized.chars().count() <= 18;
    let short_token_count = normalized.split_whitespace().count() <= 4;

    if !short_audio || !short_text || !short_token_count || segments.is_empty() {
        return false;
    }

    let all_high_no_speech = segments
        .iter()
        .all(|segment| segment.no_speech_prob.unwrap_or(0.0) >= 0.55);
    let all_low_confidence = segments
        .iter()
        .all(|segment| segment.avg_logprob.unwrap_or(0.0) <= -0.9);
    let any_high_compression = segments
        .iter()
        .any(|segment| segment.compression_ratio.unwrap_or(0.0) >= 2.2);

    all_high_no_speech || all_low_confidence || any_high_compression
}

#[tauri::command]
pub async fn transcribe_and_clean(
    app: AppHandle,
    req: TranscribeRequest,
) -> Result<TranscribeResponse, String> {
    logger::log_info(
        "API",
        &format!(
            "Starting transcription... style={}, language={}, whisper_model={:?}, llm_model={:?}",
            req.style, req.language, req.whisper_model, req.llm_model
        ),
    );

    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.audio_base64)
        .map_err(|e| {
            let err = format!("Base64 decode error: {}", e);
            logger::log_error("API", &err);
            err
        })?;

    let file_name = req
        .file_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("audio.webm")
        .to_string();
    let mime_type = req
        .mime_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("audio/webm")
        .to_string();

    transcribe_audio_bytes(app, &req, audio_bytes, file_name, mime_type).await
}

async fn transcribe_audio_bytes(
    app: AppHandle,
    req: &TranscribeRequest,
    audio_bytes: Vec<u8>,
    mut file_name: String,
    mut mime_type: String,
) -> Result<TranscribeResponse, String> {
    let client = http_client();

    // ── Step 1: Whisper Speech-to-Text ──────────────────────────────────
    let mut whisper_url = req
        .whisper_endpoint
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| {
            let base = s.trim_end_matches('/');
            if base.ends_with("/transcriptions") {
                base.to_string()
            } else if base.ends_with("/audio") {
                format!("{}/transcriptions", base)
            } else {
                format!("{}/v1/audio/transcriptions", base)
            }
        })
        .unwrap_or_else(|| "https://api.openai.com/v1/audio/transcriptions".to_string());

    let local_models_url =
        is_likely_local_url(&whisper_url).then(|| resolve_whisper_models_url(&whisper_url));
    let managed_runtime_kind = local_models_url
        .as_deref()
        .and_then(local_stt::managed_runtime_kind);

    if let (Some(models_url), Some(_)) = (local_models_url.as_deref(), managed_runtime_kind) {
        let runtime_base_url =
            local_stt::ensure_runtime(&app, client, models_url, req.local_models_dir.as_deref())
                .await?;
        whisper_url = resolve_managed_transcription_url(&runtime_base_url);
    }

    logger::log_info(
        "WHISPER",
        &format!(
            "Sending request to {}, audio_size: {} bytes",
            whisper_url,
            audio_bytes.len()
        ),
    );

    let audio_bytes = if is_likely_local_url(&whisper_url) {
        let input_file_name = file_name.clone();
        file_name = "talkis-local-stt.wav".to_string();
        mime_type = "audio/wav".to_string();
        media::convert_audio_to_local_stt_wav(&app, &audio_bytes, &input_file_name).await?
    } else {
        audio_bytes
    };

    let file_part = multipart::Part::bytes(audio_bytes)
        .file_name(file_name)
        .mime_str(&mime_type)
        .map_err(|e| format!("MIME error: {}", e))?;

    let lang_param = if req.language == "auto" {
        String::new()
    } else {
        req.language.clone()
    };

    let mut whisper_model = req
        .whisper_model
        .as_deref()
        .unwrap_or("whisper-1")
        .to_string();
    if let Some(kind) = managed_runtime_kind {
        if let Ok(Some(installed_model)) = local_stt::resolve_installed_model_for_runtime(
            &app,
            kind,
            req.local_models_dir.as_deref(),
            &whisper_model,
        ) {
            if installed_model != whisper_model {
                logger::log_info(
                    "LOCAL_STT",
                    &format!(
                        "Requested local STT model {} is not installed; using {}",
                        whisper_model, installed_model
                    ),
                );
                whisper_model = installed_model;
            }
        }
    }
    let is_transcribe_model = whisper_model.contains("transcribe");

    // Local faster-whisper runtimes do not always support verbose_json.
    // Fall back to plain "json" for local endpoints so segments/duration won't
    // be available, but transcription will succeed.
    let is_local_endpoint = whisper_url.contains("127.0.0.1") || whisper_url.contains("localhost");

    let mut form = multipart::Form::new()
        .part("file", file_part)
        .text("model", whisper_model.clone());

    if is_transcribe_model {
        // gpt-4o-transcribe / gpt-4o-mini-transcribe:
        // - Only support "json" or "text" response_format (not verbose_json)
        // - Don't support "language" or "prompt" params
        // - Use "instructions" instead of "prompt" for hints
        form = form.text("response_format", "json");

        if let Some(hint) = build_whisper_prompt(&req.language, "classic") {
            form = form.text("instructions", hint);
        }
    } else if is_local_endpoint {
        // Local faster-whisper: use the most compatible response format.
        form = form.text("response_format", "json");

        if !lang_param.is_empty() {
            form = form.text("language", lang_param);
        }

        if let Some(prompt) = build_whisper_prompt(&req.language, "classic") {
            form = form.text("prompt", prompt.to_string());
        }
    } else {
        // Classic Whisper API (OpenAI / compatible): support verbose_json, language, prompt
        form = form.text("response_format", "verbose_json");

        if let Some(prompt) = build_whisper_prompt(&req.language, "classic") {
            form = form.text("prompt", prompt.to_string());
        }

        if !lang_param.is_empty() {
            form = form.text("language", lang_param);
        }
    }

    let whisper_key = req
        .whisper_api_key
        .as_ref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&req.api_key);

    let stt_client = if is_local_endpoint {
        reqwest::Client::builder()
            .pool_max_idle_per_host(0)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(1800))
            .build()
            .unwrap_or_else(|_| (*client).clone())
    } else {
        (*client).clone()
    };

    let whisper_res = stt_client
        .post(&whisper_url)
        .bearer_auth(whisper_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            let err = format!("Whisper request failed: {}", e);
            logger::log_error("WHISPER", &err);
            err
        })?;

    let status = whisper_res.status();
    logger::log_info("WHISPER", &format!("Response status: {}", status));

    if !status.is_success() {
        let body = whisper_res.text().await.unwrap_or_default();
        let err = format!("Whisper API error ({}): {}", status, body);
        logger::log_error("WHISPER", &err);
        return Err(err);
    }

    let whisper_body: WhisperResp = whisper_res.json().await.map_err(|e| {
        let err = format!("Whisper response parse error: {}", e);
        logger::log_error("WHISPER", &err);
        err
    })?;
    let raw = whisper_body.text.trim().to_string();
    logger::log_info("WHISPER", &format!("Transcribed: \"{}\"", raw));

    if raw.is_empty() {
        logger::log_info("WHISPER", "Empty transcription, returning empty response");
        return Ok(TranscribeResponse {
            raw: String::new(),
            cleaned: String::new(),
        });
    }

    if is_known_whisper_hallucination(&raw) {
        logger::log_info(
            "WHISPER",
            &format!(
                "Detected likely silence hallucination, dropping transcription: \"{}\"",
                raw
            ),
        );
        return Ok(TranscribeResponse {
            raw: String::new(),
            cleaned: String::new(),
        });
    }

    // Transcribe models don't return segments/duration, skip uncertainty check
    if !is_transcribe_model
        && is_likely_short_uncertain_transcription(
            &raw,
            whisper_body.duration,
            &whisper_body.segments,
        )
    {
        logger::log_info(
            "WHISPER",
            &format!(
                "Detected likely short uncertain transcription, dropping result: \"{}\" duration={:?} segments={:?}",
                raw, whisper_body.duration, whisper_body.segments
            ),
        );
        return Ok(TranscribeResponse {
            raw: String::new(),
            cleaned: String::new(),
        });
    }

    logger::log_info(
        "LLM",
        "Own API/local transcription mode: style cleanup is disabled by policy",
    );
    logger::log_info("API", "Transcription complete");

    Ok(TranscribeResponse {
        raw: raw.clone(),
        cleaned: raw,
    })
}

#[tauri::command]
pub async fn transcribe_only(
    app: AppHandle,
    mut req: TranscribeRequest,
) -> Result<TranscribeResponse, String> {
    req.mode = Some("transcribe_only".to_string());
    transcribe_and_clean(app, req).await
}

fn emit_file_progress(
    app: &AppHandle,
    request_id: &str,
    status: &str,
    current_chunk: usize,
    total_chunks: usize,
    message: &str,
) {
    let _ = app.emit(
        FILE_TRANSCRIPTION_PROGRESS_EVENT,
        FileTranscriptionProgressPayload {
            request_id: request_id.to_string(),
            status: status.to_string(),
            current_chunk,
            total_chunks,
            message: message.to_string(),
        },
    );
}

async fn transcribe_file_chunk_via_proxy(
    req: &FilePathTranscriptionRequest,
    chunk: &media::PreparedMediaChunk,
) -> Result<TranscribeResponse, String> {
    let token = req
        .device_token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Talkis Cloud session missing".to_string())?;
    let bytes = fs::read(&chunk.path)
        .map_err(|err| format!("Не удалось прочитать фрагмент аудио: {}", err))?;
    let file_part = multipart::Part::bytes(bytes)
        .file_name(chunk.file_name.clone())
        .mime_str(&chunk.mime_type)
        .map_err(|err| format!("MIME error: {}", err))?;
    let form = multipart::Form::new()
        .part("file", file_part)
        .text("language", req.language.clone())
        .text("style", req.style.clone());
    let response = long_http_client()
        .post("https://proxy.talkis.ru/api/transcribe-only")
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|err| format!("Proxy request failed: {}", err))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Proxy response read failed: {}", err))?;

    if !status.is_success() {
        return Err(format!("Proxy error ({}): {}", status, body));
    }

    #[derive(Deserialize)]
    struct ProxyTranscribeResponse {
        raw: Option<String>,
        cleaned: Option<String>,
    }

    let parsed = serde_json::from_str::<ProxyTranscribeResponse>(&body)
        .map_err(|err| format!("Talkis Cloud returned an invalid response: {}", err))?;
    let raw = parsed.raw.unwrap_or_default();
    Ok(TranscribeResponse {
        cleaned: parsed.cleaned.unwrap_or_else(|| raw.clone()),
        raw,
    })
}

#[tauri::command]
pub async fn transcribe_file_path(
    app: AppHandle,
    req: FilePathTranscriptionRequest,
) -> Result<TranscribeResponse, String> {
    let input_path = PathBuf::from(&req.file_path);
    let metadata =
        fs::metadata(&input_path).map_err(|err| format!("Не удалось прочитать файл: {}", err))?;
    if let Some(file_size) = req.file_size {
        if metadata.len() != file_size {
            logger::log_info(
                "FILE_TRANSCRIPTION",
                &format!(
                    "File size changed before transcription: declared={}, actual={}",
                    file_size,
                    metadata.len()
                ),
            );
        }
    }
    if let Some(file_name) = req
        .file_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        logger::log_info(
            "FILE_TRANSCRIPTION",
            &format!("Starting file transcription: {}", file_name),
        );
    }
    if metadata.len() > media::MAX_FILE_TRANSCRIPTION_INPUT_BYTES {
        return Err(
            "Файл слишком большой. Максимальный размер для транскрибации: 1 ГБ.".to_string(),
        );
    }

    emit_file_progress(&app, &req.request_id, "preparing", 0, 0, "Готовим файл");
    let prepared = media::prepare_media_file_chunks_for_transcription(&app, &input_path).await?;
    let total_chunks = prepared.chunks.len();
    emit_file_progress(
        &app,
        &req.request_id,
        "transcribing",
        0,
        total_chunks,
        "Распознаём фрагменты",
    );

    let base_req = TranscribeRequest {
        audio_base64: String::new(),
        language: req.language.clone(),
        api_key: req.api_key.clone(),
        whisper_api_key: req.whisper_api_key.clone(),
        llm_api_key: None,
        style: req.style.clone(),
        whisper_endpoint: req.whisper_endpoint.clone(),
        local_models_dir: req.local_models_dir.clone(),
        llm_endpoint: None,
        whisper_model: req.whisper_model.clone(),
        llm_model: Some("none".to_string()),
        file_name: None,
        mime_type: None,
        mode: Some("transcribe_only".to_string()),
    };

    let mut parts = Vec::with_capacity(total_chunks);
    for (index, chunk) in prepared.chunks.iter().enumerate() {
        emit_file_progress(
            &app,
            &req.request_id,
            "transcribing",
            index + 1,
            total_chunks,
            &format!("Распознаём фрагмент {} из {}", index + 1, total_chunks),
        );
        logger::log_info(
            "FILE_TRANSCRIPTION",
            &format!(
                "Transcribing chunk {} of {}, size={} bytes",
                index + 1,
                total_chunks,
                chunk.size_bytes
            ),
        );

        let result = if !req.use_own_key {
            transcribe_file_chunk_via_proxy(&req, chunk).await
        } else {
            match fs::read(&chunk.path) {
                Ok(bytes) => {
                    transcribe_audio_bytes(
                        app.clone(),
                        &base_req,
                        bytes,
                        chunk.file_name.clone(),
                        chunk.mime_type.clone(),
                    )
                    .await
                }
                Err(err) => Err(format!("Не удалось прочитать фрагмент аудио: {}", err)),
            }
        };

        let result = match result {
            Ok(result) => result,
            Err(err) => {
                let _ = fs::remove_dir_all(&prepared.temp_dir);
                return Err(err);
            }
        };

        let text = if result.raw.trim().is_empty() {
            result.cleaned
        } else {
            result.raw
        };
        let text = text.trim().to_string();
        if !text.is_empty() {
            parts.push(text);
        }
    }

    let _ = fs::remove_dir_all(&prepared.temp_dir);
    emit_file_progress(
        &app,
        &req.request_id,
        "done",
        total_chunks,
        total_chunks,
        "Готово",
    );

    let raw = parts.join("\n\n");
    Ok(TranscribeResponse {
        cleaned: raw.clone(),
        raw,
    })
}

// ── Connection test ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct TestConnectionRequest {
    pub api_key: String,
    pub whisper_api_key: Option<String>,
    pub whisper_endpoint: Option<String>,
    pub local_models_dir: Option<String>,
    pub whisper_model: Option<String>,
    pub llm_api_key: Option<String>,
    pub llm_endpoint: Option<String>,
    pub llm_model: Option<String>,
    pub test_stt: bool,
    pub test_llm: bool,
}

#[derive(Serialize, Deserialize)]
pub struct TestConnectionResult {
    pub success: bool,
    pub message: String,
    pub latency_ms: u64,
}

#[derive(Deserialize)]
struct ModelsListResponse {
    #[serde(default)]
    data: Vec<ModelListItem>,
}

#[derive(Deserialize)]
struct ModelListItem {
    id: String,
}

fn is_likely_local_url(value: &str) -> bool {
    let normalized = value.trim().to_lowercase();
    normalized.contains("127.0.0.1") || normalized.contains("localhost")
}

fn resolve_whisper_url(endpoint: Option<&str>) -> String {
    endpoint
        .filter(|s| !s.is_empty())
        .map(|s| {
            let base = s.trim_end_matches('/');
            if base.ends_with("/transcriptions") {
                base.to_string()
            } else if base.ends_with("/audio") {
                format!("{}/transcriptions", base)
            } else {
                format!("{}/v1/audio/transcriptions", base)
            }
        })
        .unwrap_or_else(|| "https://api.openai.com/v1/audio/transcriptions".to_string())
}

fn resolve_managed_transcription_url(base_url: &str) -> String {
    format!("{}/v1/audio/transcriptions", base_url.trim_end_matches('/'))
}

fn resolve_managed_models_url(base_url: &str) -> String {
    format!("{}/v1/models", base_url.trim_end_matches('/'))
}

fn resolve_whisper_models_url(whisper_url: &str) -> String {
    if let Some(base) = whisper_url.strip_suffix("/v1/audio/transcriptions") {
        return format!("{}/v1/models", base);
    }

    if let Some(base) = whisper_url.strip_suffix("/audio/transcriptions") {
        return format!("{}/models", base);
    }

    if let Some(base) = whisper_url.strip_suffix("/transcriptions") {
        return format!("{}/models", base);
    }

    format!("{}/v1/models", whisper_url.trim_end_matches('/'))
}

fn percent_encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());

    for byte in value.bytes() {
        let is_unreserved =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~');
        if is_unreserved {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{:02X}", byte));
        }
    }

    encoded
}

fn resolve_whisper_model_download_url(models_url: &str, model: &str) -> String {
    let encoded_model = percent_encode_path_segment(model);
    format!("{}/{}", models_url.trim_end_matches('/'), encoded_model)
}

async fn test_stt_connection(
    app: &AppHandle,
    client: &reqwest::Client,
    req: &TestConnectionRequest,
) -> Result<String, String> {
    let whisper_url = resolve_whisper_url(req.whisper_endpoint.as_deref());
    let mut models_url = resolve_whisper_models_url(&whisper_url);
    let managed_runtime_kind = local_stt::managed_runtime_kind(&models_url);
    let whisper_key = req
        .whisper_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(req.api_key.as_str());

    if managed_runtime_kind.is_some() {
        let runtime_base_url =
            local_stt::ensure_runtime(app, client, &models_url, req.local_models_dir.as_deref())
                .await?;
        models_url = resolve_managed_models_url(&runtime_base_url);
    }

    let mut request = client.get(&models_url);
    if !whisper_key.trim().is_empty() {
        request = request.bearer_auth(whisper_key);
    }

    let response = request.send().await.map_err(|err| {
        if err.is_connect() {
            if is_likely_local_url(&models_url) {
                "Локальный STT runtime пока недоступен. Нажмите «Скачать» для нужной Whisper-модели, Talkis запустит runtime автоматически.".to_string()
            } else {
                "Не удалось подключиться к STT endpoint. Проверьте адрес и сеть.".to_string()
            }
        } else if err.is_timeout() {
            "STT endpoint не ответил вовремя.".to_string()
        } else {
            format!("Ошибка проверки STT: {}", err)
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        let message = match status.as_u16() {
            401 => "STT endpoint отклонил API-ключ.".to_string(),
            403 => "STT endpoint запретил доступ. Проверьте ключ и endpoint.".to_string(),
            404 => {
                if is_likely_local_url(&models_url) {
                    "Локальный STT endpoint отвечает, но не поддерживает проверку моделей по /v1/models.".to_string()
                } else {
                    "STT endpoint не поддерживает проверку по /v1/models.".to_string()
                }
            }
            _ => format!(
                "STT endpoint вернул ошибку {}: {}",
                status.as_u16(),
                error_text.chars().take(200).collect::<String>()
            ),
        };
        return Err(message);
    }

    let requested_model = req
        .whisper_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("whisper-1");

    let response_text = response
        .text()
        .await
        .map_err(|err| format!("Ошибка чтения STT ответа: {}", err))?;
    if let Ok(models) = serde_json::from_str::<ModelsListResponse>(&response_text) {
        let has_model = models.data.iter().any(|item| item.id == requested_model);
        if !has_model {
            if is_likely_local_url(&models_url) {
                let download_url = resolve_whisper_model_download_url(&models_url, requested_model);
                return Err(format!(
                    "STT сервер доступен, но модель «{}» не установлена. Установите её: curl {} -X POST",
                    requested_model, download_url
                ));
            }

            return Err(format!(
                "STT endpoint доступен, но модель «{}» на нём не найдена.",
                requested_model
            ));
        }
    }

    Ok(format!(
        "STT доступен, модель «{}» найдена.",
        requested_model
    ))
}

#[derive(Serialize, Deserialize)]
pub struct InstallSttModelRequest {
    pub api_key: String,
    pub whisper_api_key: Option<String>,
    pub whisper_endpoint: Option<String>,
    pub local_models_dir: Option<String>,
    pub whisper_model: String,
}

#[derive(Serialize, Deserialize)]
pub struct InstallSttModelResult {
    pub success: bool,
    pub message: String,
    pub whisper_endpoint: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct DeleteSttModelRequest {
    pub api_key: String,
    pub whisper_api_key: Option<String>,
    pub whisper_endpoint: Option<String>,
    pub local_models_dir: Option<String>,
    pub whisper_model: String,
}

#[derive(Serialize, Deserialize)]
pub struct DeleteSttModelResult {
    pub success: bool,
    pub message: String,
}

#[derive(Serialize, Deserialize)]
pub struct ListSttModelsRequest {
    pub api_key: String,
    pub whisper_api_key: Option<String>,
    pub whisper_endpoint: Option<String>,
    pub local_models_dir: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct ListSttModelsResult {
    pub success: bool,
    pub models: Vec<String>,
    pub message: String,
}

#[tauri::command]
pub async fn list_stt_models(
    app: AppHandle,
    req: ListSttModelsRequest,
) -> Result<ListSttModelsResult, String> {
    let whisper_url = resolve_whisper_url(req.whisper_endpoint.as_deref());
    let mut models_url = resolve_whisper_models_url(&whisper_url);
    let managed_runtime_kind = local_stt::managed_runtime_kind(&models_url);
    let whisper_key = req
        .whisper_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(req.api_key.as_str());

    let client = http_client();
    if managed_runtime_kind.is_some() {
        if let Ok(runtime_base_url) =
            local_stt::ensure_runtime(&app, client, &models_url, req.local_models_dir.as_deref())
                .await
        {
            models_url = resolve_managed_models_url(&runtime_base_url);
        }
    }

    let mut request = client.get(&models_url);
    if !whisper_key.trim().is_empty() {
        request = request.bearer_auth(whisper_key);
    }

    let response = match request.send().await {
        Ok(response) => Ok(response),
        Err(err) if managed_runtime_kind.is_some() => {
            let models = local_stt::installed_model_ids(&app, req.local_models_dir.as_deref())
                .unwrap_or_default();
            return Ok(ListSttModelsResult {
                success: !models.is_empty(),
                models,
                message: if err.is_connect() {
                    "Локальный STT runtime пока недоступен, список восстановлен по файлам на диске."
                        .to_string()
                } else {
                    format!(
                        "Не удалось опросить локальный STT runtime, список восстановлен по файлам на диске: {}",
                        err
                    )
                },
            });
        }
        Err(err) => Err(if err.is_connect() {
            if is_likely_local_url(&models_url) {
                "Локальный STT runtime пока недоступен. Нажмите «Скачать» для нужной Whisper-модели, Talkis запустит runtime автоматически."
                    .to_string()
            } else {
                "Не удалось подключиться к STT endpoint. Проверьте адрес и сеть.".to_string()
            }
        } else if err.is_timeout() {
            "STT endpoint не ответил вовремя.".to_string()
        } else {
            format!("Ошибка чтения моделей STT: {}", err)
        }),
    }?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        if managed_runtime_kind.is_some() {
            let models = local_stt::installed_model_ids(&app, req.local_models_dir.as_deref())
                .unwrap_or_default();
            if !models.is_empty() {
                return Ok(ListSttModelsResult {
                    success: true,
                    models,
                    message: format!(
                        "Локальный STT endpoint вернул {}, список восстановлен по файлам на диске.",
                        status.as_u16()
                    ),
                });
            }
        }

        return Ok(ListSttModelsResult {
            success: false,
            models: Vec::new(),
            message: format!(
                "STT endpoint вернул ошибку {} при чтении моделей: {}",
                status.as_u16(),
                error_text.chars().take(200).collect::<String>()
            ),
        });
    }

    let response_text = response
        .text()
        .await
        .map_err(|err| format!("Ошибка чтения STT ответа: {}", err))?;
    let mut models = serde_json::from_str::<ModelsListResponse>(&response_text)
        .map(|response| {
            response
                .data
                .into_iter()
                .map(|item| item.id)
                .collect::<Vec<_>>()
        })
        .map_err(|err| format!("STT endpoint вернул некорректный список моделей: {}", err))?;

    if managed_runtime_kind.is_some() {
        if let Ok(local_models) =
            local_stt::installed_model_ids(&app, req.local_models_dir.as_deref())
        {
            for model in local_models {
                if !models.contains(&model) {
                    models.push(model);
                }
            }
        }
    }

    models.sort();

    Ok(ListSttModelsResult {
        success: true,
        models,
        message: "Список локальных моделей обновлен.".to_string(),
    })
}

#[tauri::command]
pub async fn install_stt_model(
    app: AppHandle,
    req: InstallSttModelRequest,
) -> Result<InstallSttModelResult, String> {
    let requested_model = req.whisper_model.trim();
    if requested_model.is_empty() {
        return Ok(InstallSttModelResult {
            success: false,
            message: "Укажите имя модели для установки.".to_string(),
            whisper_endpoint: None,
        });
    }

    logger::log_info(
        "STT_INSTALL",
        &format!("Installing STT model: {}", requested_model),
    );

    let whisper_url = resolve_whisper_url(req.whisper_endpoint.as_deref());
    let mut models_url = resolve_whisper_models_url(&whisper_url);
    let mut download_url = resolve_whisper_model_download_url(&models_url, requested_model);
    let mut effective_whisper_endpoint: Option<String> = None;
    let whisper_key = req
        .whisper_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(req.api_key.as_str());

    let client = http_client();
    if local_stt::is_managed_whisper_runtime_url(&models_url) {
        let runtime_base_url =
            local_stt::ensure_runtime(&app, client, &models_url, req.local_models_dir.as_deref())
                .await
                .map_err(|message| {
                    logger::log_error("STT_INSTALL", &message);
                    message
                })?;
        effective_whisper_endpoint = Some(runtime_base_url.clone());
        let installed_model = local_stt::download_model_with_progress(
            &app,
            client,
            req.local_models_dir.as_deref(),
            requested_model,
        )
        .await
        .map_err(|message| {
            logger::log_error("STT_INSTALL", &message);
            message
        })?;

        logger::log_info(
            "STT_INSTALL",
            &format!("Local STT model installed: {}", installed_model),
        );
        return Ok(InstallSttModelResult {
            success: true,
            message: format!(
                "Модель «{}» скачана и готова к локальному распознаванию.",
                requested_model
            ),
            whisper_endpoint: effective_whisper_endpoint,
        });
    }

    let managed_runtime_kind = local_stt::managed_runtime_kind(&models_url);
    if let Some(kind) = managed_runtime_kind {
        if kind != local_stt::LocalRuntimeKind::Whisper {
            let runtime_label = match kind {
                local_stt::LocalRuntimeKind::Nvidia => "Parakeet",
                local_stt::LocalRuntimeKind::Qwen => "Qwen",
                local_stt::LocalRuntimeKind::Whisper => "Whisper",
            };
            local_stt::emit_model_download_progress_message(
                &app,
                requested_model,
                "preparing",
                0,
                None,
                &format!("Готовим локальный {} runtime.", runtime_label),
            );
        }

        let runtime_base_url =
            local_stt::ensure_runtime(&app, client, &models_url, req.local_models_dir.as_deref())
                .await
                .map_err(|message| {
                    logger::log_error("STT_INSTALL", &message);
                    message
                })?;
        effective_whisper_endpoint = Some(runtime_base_url.clone());
        models_url = resolve_managed_models_url(&runtime_base_url);
        download_url = resolve_whisper_model_download_url(&models_url, requested_model);
    }

    let already_installed_snapshot = match managed_runtime_kind {
        Some(local_stt::LocalRuntimeKind::Qwen)
            if local_stt::qwen_model_is_installed(&app, req.local_models_dir.as_deref())
                .unwrap_or(false) =>
        {
            Some((
                local_stt::qwen_model_progress_snapshot(&app, req.local_models_dir.as_deref())
                    .unwrap_or((1, Some(1))),
                "Модель Qwen уже скачана.",
            ))
        }
        Some(local_stt::LocalRuntimeKind::Nvidia)
            if local_stt::nvidia_model_is_installed(
                &app,
                req.local_models_dir.as_deref(),
                requested_model,
            )
            .unwrap_or(false) =>
        {
            Some((
                local_stt::nvidia_model_progress_snapshot(
                    &app,
                    req.local_models_dir.as_deref(),
                    requested_model,
                )
                .unwrap_or((1, Some(1))),
                "Модель Parakeet уже скачана.",
            ))
        }
        _ => None,
    };
    if let Some(((downloaded, total), message)) = already_installed_snapshot {
        local_stt::emit_model_download_progress_message(
            &app,
            requested_model,
            "downloaded",
            downloaded,
            total,
            message,
        );
        return Ok(InstallSttModelResult {
            success: true,
            message: format!(
                "Модель «{}» скачана и готова к локальному распознаванию.",
                requested_model
            ),
            whisper_endpoint: effective_whisper_endpoint.clone(),
        });
    }

    let install_client =
        if managed_runtime_kind.is_some_and(|kind| kind != local_stt::LocalRuntimeKind::Whisper) {
            reqwest::Client::builder()
                .pool_max_idle_per_host(0)
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(7200))
                .build()
                .unwrap_or_else(|_| (*client).clone())
        } else {
            (*client).clone()
        };

    let local_progress_stop = if matches!(
        managed_runtime_kind,
        Some(local_stt::LocalRuntimeKind::Qwen | local_stt::LocalRuntimeKind::Nvidia)
    ) {
        let stop = Arc::new(AtomicBool::new(false));
        let task_stop = Arc::clone(&stop);
        let task_app = app.clone();
        let task_model = requested_model.to_string();
        let task_models_dir = req.local_models_dir.clone();
        let task_kind = managed_runtime_kind.unwrap();
        tokio::spawn(async move {
            let mut last_percent: Option<u8> = None;
            let mut last_downloaded = 0u64;
            while !task_stop.load(Ordering::Relaxed) {
                let snapshot = match task_kind {
                    local_stt::LocalRuntimeKind::Qwen => local_stt::qwen_model_progress_snapshot(
                        &task_app,
                        task_models_dir.as_deref(),
                    ),
                    local_stt::LocalRuntimeKind::Nvidia => {
                        local_stt::nvidia_model_progress_snapshot(
                            &task_app,
                            task_models_dir.as_deref(),
                            &task_model,
                        )
                    }
                    local_stt::LocalRuntimeKind::Whisper => Ok((0, None)),
                };
                if let Ok((downloaded, total)) = snapshot {
                    let percent = total
                        .filter(|value| *value > 0)
                        .map(|value| ((downloaded.saturating_mul(100) / value).min(99)) as u8);
                    if percent != last_percent
                        || downloaded.saturating_sub(last_downloaded) >= 4 * 1024 * 1024
                    {
                        local_stt::emit_model_download_progress_message(
                            &task_app,
                            &task_model,
                            "downloading",
                            downloaded,
                            total,
                            if downloaded == 0 {
                                match task_kind {
                                    local_stt::LocalRuntimeKind::Nvidia => {
                                        "Устанавливаем Parakeet зависимости."
                                    }
                                    _ => "Устанавливаем Qwen зависимости.",
                                }
                            } else {
                                match task_kind {
                                    local_stt::LocalRuntimeKind::Nvidia => {
                                        "Скачиваем файлы Parakeet модели."
                                    }
                                    _ => "Скачиваем файлы Qwen модели.",
                                }
                            },
                        );
                        last_percent = percent;
                        last_downloaded = downloaded;
                    }
                }

                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        Some(stop)
    } else {
        None
    };

    let mut request = install_client.post(&download_url);
    if !whisper_key.trim().is_empty() {
        request = request.bearer_auth(whisper_key);
    }

    let response = request.send().await.map_err(|err| {
        if let Some(stop) = &local_progress_stop {
            stop.store(true, Ordering::Relaxed);
        }
        let message = if err.is_connect() {
            if is_likely_local_url(&download_url) {
                "Не удалось подключиться к локальному STT runtime после автоматического запуска."
                    .to_string()
            } else {
                "Не удалось подключиться к STT endpoint для установки модели.".to_string()
            }
        } else if err.is_timeout() {
            "STT сервер не ответил во время установки модели.".to_string()
        } else {
            format!("Ошибка установки модели: {}", err)
        };
        logger::log_error("STT_INSTALL", &message);
        message
    })?;
    if let Some(stop) = &local_progress_stop {
        stop.store(true, Ordering::Relaxed);
    }

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        let message = match status.as_u16() {
            401 => "STT endpoint отклонил API-ключ при установке модели.".to_string(),
            403 => "STT endpoint запретил установку модели. Проверьте права доступа.".to_string(),
            404 => format!(
                "Модель «{}» не найдена в реестре локального STT runtime.",
                requested_model
            ),
            409 => format!(
                "Модель «{}» уже устанавливается или уже доступна.",
                requested_model
            ),
            _ => format!(
                "STT endpoint вернул ошибку {} при установке модели: {}",
                status.as_u16(),
                error_text.chars().take(200).collect::<String>()
            ),
        };
        logger::log_error("STT_INSTALL", &message);
        return Ok(InstallSttModelResult {
            success: false,
            message,
            whisper_endpoint: effective_whisper_endpoint.clone(),
        });
    }

    logger::log_info(
        "STT_INSTALL",
        &format!("STT model install request accepted: {}", requested_model),
    );
    if managed_runtime_kind.is_some_and(|kind| kind != local_stt::LocalRuntimeKind::Whisper) {
        let (downloaded, total) = match managed_runtime_kind {
            Some(local_stt::LocalRuntimeKind::Nvidia) => local_stt::nvidia_model_progress_snapshot(
                &app,
                req.local_models_dir.as_deref(),
                requested_model,
            )
            .unwrap_or((1, Some(1))),
            _ => local_stt::qwen_model_progress_snapshot(&app, req.local_models_dir.as_deref())
                .unwrap_or((1, Some(1))),
        };
        local_stt::emit_model_download_progress_message(
            &app,
            requested_model,
            "downloaded",
            downloaded,
            total,
            "Модель скачана.",
        );
    }
    Ok(InstallSttModelResult {
        success: true,
        message: format!(
            "Модель «{}» скачана и готова к локальному распознаванию.",
            requested_model
        ),
        whisper_endpoint: effective_whisper_endpoint,
    })
}

#[tauri::command]
pub async fn delete_stt_model(
    app: AppHandle,
    req: DeleteSttModelRequest,
) -> Result<DeleteSttModelResult, String> {
    let requested_model = req.whisper_model.trim();
    if requested_model.is_empty() {
        return Ok(DeleteSttModelResult {
            success: false,
            message: "Укажите имя модели для удаления.".to_string(),
        });
    }

    logger::log_info(
        "STT_DELETE",
        &format!("Deleting STT model: {}", requested_model),
    );

    let whisper_url = resolve_whisper_url(req.whisper_endpoint.as_deref());
    let mut models_url = resolve_whisper_models_url(&whisper_url);
    let mut delete_url = resolve_whisper_model_download_url(&models_url, requested_model);
    let whisper_key = req
        .whisper_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(req.api_key.as_str());

    let client = http_client();
    if local_stt::is_managed_whisper_runtime_url(&models_url) {
        local_stt::ensure_runtime(&app, client, &models_url, req.local_models_dir.as_deref())
            .await
            .map_err(|message| {
                logger::log_error("STT_DELETE", &message);
                message
            })?;
        local_stt::delete_downloaded_model(&app, req.local_models_dir.as_deref(), requested_model)
            .map_err(|message| {
                logger::log_error("STT_DELETE", &message);
                message
            })?;

        return Ok(DeleteSttModelResult {
            success: true,
            message: format!("Модель «{}» удалена.", requested_model),
        });
    }

    if local_stt::managed_runtime_kind(&models_url).is_some() {
        let runtime_base_url =
            local_stt::ensure_runtime(&app, client, &models_url, req.local_models_dir.as_deref())
                .await
                .map_err(|message| {
                    logger::log_error("STT_DELETE", &message);
                    message
                })?;
        models_url = resolve_managed_models_url(&runtime_base_url);
        delete_url = resolve_whisper_model_download_url(&models_url, requested_model);
    }

    let mut request = client.delete(&delete_url);
    if !whisper_key.trim().is_empty() {
        request = request.bearer_auth(whisper_key);
    }

    let response = request.send().await.map_err(|err| {
        let message = if err.is_connect() {
            if is_likely_local_url(&delete_url) {
                "Не удалось подключиться к локальному STT runtime после автоматического запуска."
                    .to_string()
            } else {
                "Не удалось подключиться к STT endpoint для удаления модели.".to_string()
            }
        } else if err.is_timeout() {
            "STT сервер не ответил во время удаления модели.".to_string()
        } else {
            format!("Ошибка удаления модели: {}", err)
        };
        logger::log_error("STT_DELETE", &message);
        message
    })?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        let message = match status.as_u16() {
            401 => "STT endpoint отклонил API-ключ при удалении модели.".to_string(),
            403 => "STT endpoint запретил удаление модели. Проверьте права доступа.".to_string(),
            404 => format!(
                "Модель «{}» не найдена в реестре локального STT runtime.",
                requested_model
            ),
            _ => format!(
                "STT endpoint вернул ошибку {} при удалении модели: {}",
                status.as_u16(),
                error_text.chars().take(200).collect::<String>()
            ),
        };
        logger::log_error("STT_DELETE", &message);
        return Ok(DeleteSttModelResult {
            success: false,
            message,
        });
    }

    Ok(DeleteSttModelResult {
        success: true,
        message: format!("Модель «{}» удалена.", requested_model),
    })
}

#[tauri::command]
pub async fn test_api_connection(
    app: AppHandle,
    req: TestConnectionRequest,
) -> Result<TestConnectionResult, String> {
    logger::log_info("TEST", "Testing API connection...");

    let client = http_client();
    let start = std::time::Instant::now();

    let mut messages: Vec<String> = Vec::new();

    if req.test_stt {
        match test_stt_connection(&app, client, &req).await {
            Ok(message) => messages.push(message),
            Err(message) => {
                logger::log_error("TEST", &format!("STT test failed: {}", message));
                let latency_ms = start.elapsed().as_millis() as u64;
                return Ok(TestConnectionResult {
                    success: false,
                    message,
                    latency_ms,
                });
            }
        }
    }

    if req.test_llm {
        logger::log_info(
            "TEST",
            "Skipping LLM test: own API/local modes are STT-only by policy",
        );
    }

    if messages.is_empty() {
        let latency_ms = start.elapsed().as_millis() as u64;
        return Ok(TestConnectionResult {
            success: false,
            message: "Нет активных endpoint'ов для проверки.".to_string(),
            latency_ms,
        });
    }

    let latency_ms = start.elapsed().as_millis() as u64;
    logger::log_info("TEST", &format!("Connection OK, {}ms", latency_ms));
    Ok(TestConnectionResult {
        success: true,
        message: format!("{} ({}ms)", messages.join(" "), latency_ms),
        latency_ms,
    })
}
