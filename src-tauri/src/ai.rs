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
    #[serde(default)]
    pub mode: TranscriptionMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speakers: Option<Vec<Speaker>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segments: Option<Vec<SpeakerTranscriptSegment>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionMode {
    Plain,
    Speakers,
}

impl Default for TranscriptionMode {
    fn default() -> Self {
        Self::Plain
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Speaker {
    pub id: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerTranscriptSegment {
    pub start: f64,
    pub end: f64,
    pub speaker_id: String,
    pub speaker_label: String,
    pub text: String,
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
    #[serde(default)]
    pub speaker_diarization: bool,
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
    text: Option<String>,
    #[serde(default)]
    start: Option<f64>,
    #[serde(default)]
    end: Option<f64>,
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

#[derive(Clone, Debug, PartialEq)]
struct SttTranscriptSegment {
    start: f64,
    end: f64,
    text: String,
}

struct AudioTranscriptionResult {
    raw: String,
    cleaned: String,
    segments: Vec<SttTranscriptSegment>,
}

fn plain_transcribe_response(raw: String, cleaned: String) -> TranscribeResponse {
    TranscribeResponse {
        raw,
        cleaned,
        mode: TranscriptionMode::Plain,
        speakers: None,
        segments: None,
    }
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

fn normalize_repetition_key(value: &str) -> String {
    let normalized = value.trim().to_lowercase().replace('ё', "е");
    let mut key = String::with_capacity(normalized.len());

    for ch in normalized.chars() {
        if ch.is_alphanumeric() {
            key.push(ch);
        } else {
            key.push(' ');
        }
    }

    key.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_known_caption_artifact_key(key: &str) -> bool {
    key == "продолжение следует"
        || key == "to be continued"
        || key == "thanks for watching"
        || key == "спасибо за просмотр"
}

fn split_transcript_units(text: &str) -> Vec<String> {
    let mut units = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '.' | '!' | '?' | '…' | '\n') {
            let trimmed = current.trim();
            if !normalize_repetition_key(trimmed).is_empty() {
                units.push(trimmed.to_string());
            }
            current.clear();
        }
    }

    let trimmed = current.trim();
    if !normalize_repetition_key(trimmed).is_empty() {
        units.push(trimmed.to_string());
    }

    if units.is_empty() && !text.trim().is_empty() {
        units.push(text.trim().to_string());
    }

    units
}

fn sanitize_repetitive_transcript_text(text: &str) -> String {
    let units = split_transcript_units(text);
    if units.is_empty() {
        return String::new();
    }

    let mut totals = std::collections::HashMap::<String, usize>::new();
    for unit in &units {
        let key = normalize_repetition_key(unit);
        if !key.is_empty() {
            *totals.entry(key).or_insert(0) += 1;
        }
    }

    let mut kept_counts = std::collections::HashMap::<String, usize>::new();
    let mut kept = Vec::new();

    for unit in units {
        let key = normalize_repetition_key(&unit);
        if key.is_empty() || is_known_caption_artifact_key(&key) {
            continue;
        }

        let total = totals.get(&key).copied().unwrap_or(0);
        if total >= 3 {
            let count = kept_counts.entry(key).or_insert(0);
            if *count >= 1 {
                continue;
            }
            *count += 1;
        }

        kept.push(unit);
    }

    kept.join(" ").trim().to_string()
}

fn is_repeated_segment_filter_candidate(key: &str) -> bool {
    if is_known_caption_artifact_key(key) {
        return true;
    }

    let token_count = key.split_whitespace().count();
    key == "спасибо" || (2..=12).contains(&token_count)
}

fn sanitize_stt_segments(segments: Vec<SttTranscriptSegment>) -> Vec<SttTranscriptSegment> {
    let mut cleaned = Vec::with_capacity(segments.len());
    for mut segment in segments {
        segment.text = sanitize_repetitive_transcript_text(&segment.text);
        if !segment.text.trim().is_empty() {
            cleaned.push(segment);
        }
    }

    let mut totals = std::collections::HashMap::<String, usize>::new();
    for segment in &cleaned {
        let key = normalize_repetition_key(&segment.text);
        if !key.is_empty() {
            *totals.entry(key).or_insert(0) += 1;
        }
    }

    let original_len = cleaned.len();
    let mut seen = std::collections::HashMap::<String, usize>::new();
    let filtered = cleaned
        .into_iter()
        .filter(|segment| {
            let key = normalize_repetition_key(&segment.text);
            if key.is_empty() || is_known_caption_artifact_key(&key) {
                return false;
            }

            let total = totals.get(&key).copied().unwrap_or(0);
            if total >= 3 && is_repeated_segment_filter_candidate(&key) {
                let count = seen.entry(key).or_insert(0);
                if *count >= 1 {
                    return false;
                }
                *count += 1;
            }

            true
        })
        .collect::<Vec<_>>();

    if filtered.len() != original_len {
        logger::log_info(
            "WHISPER",
            &format!(
                "Filtered repetitive local STT segments: before={}, after={}",
                original_len,
                filtered.len()
            ),
        );
    }

    filtered
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
    file_name: String,
    mime_type: String,
) -> Result<TranscribeResponse, String> {
    let result =
        transcribe_audio_bytes_internal(app, req, audio_bytes, file_name, mime_type, false, 0.0)
            .await?;
    Ok(plain_transcribe_response(result.raw, result.cleaned))
}

async fn transcribe_audio_bytes_internal(
    app: AppHandle,
    req: &TranscribeRequest,
    audio_bytes: Vec<u8>,
    mut file_name: String,
    mut mime_type: String,
    require_segments: bool,
    segment_offset_seconds: f64,
) -> Result<AudioTranscriptionResult, String> {
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
        form = form.text(
            "response_format",
            if require_segments {
                "verbose_json"
            } else {
                "json"
            },
        );

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
        return Ok(AudioTranscriptionResult {
            raw: String::new(),
            cleaned: String::new(),
            segments: Vec::new(),
        });
    }

    let sanitized_raw = sanitize_repetitive_transcript_text(&raw);
    if sanitized_raw != raw {
        logger::log_info(
            "WHISPER",
            &format!(
                "Sanitized repetitive local STT text: before_chars={}, after_chars={}",
                raw.chars().count(),
                sanitized_raw.chars().count()
            ),
        );
    }

    if sanitized_raw.is_empty() {
        logger::log_info(
            "WHISPER",
            &format!(
                "Detected likely repetitive silence hallucination, dropping transcription: \"{}\"",
                raw
            ),
        );
        return Ok(AudioTranscriptionResult {
            raw: String::new(),
            cleaned: String::new(),
            segments: Vec::new(),
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
        return Ok(AudioTranscriptionResult {
            raw: String::new(),
            cleaned: String::new(),
            segments: Vec::new(),
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
        return Ok(AudioTranscriptionResult {
            raw: String::new(),
            cleaned: String::new(),
            segments: Vec::new(),
        });
    }

    logger::log_info(
        "LLM",
        "Own API/local transcription mode: style cleanup is disabled by policy",
    );
    logger::log_info("API", "Transcription complete");

    let raw_segments = whisper_body
        .segments
        .iter()
        .filter_map(|segment| {
            let text = segment.text.as_deref()?.trim();
            if text.is_empty() {
                return None;
            }

            let start = segment.start? + segment_offset_seconds;
            let end = segment.end? + segment_offset_seconds;
            if end <= start {
                return None;
            }

            Some(SttTranscriptSegment {
                start,
                end,
                text: text.to_string(),
            })
        })
        .collect::<Vec<_>>();
    let segments = sanitize_stt_segments(raw_segments);

    if require_segments && segments.is_empty() {
        if whisper_body.segments.is_empty() {
            return Err(
                "Для разделения по говорящим нужна локальная Whisper-модель с таймкодами."
                    .to_string(),
            );
        }

        logger::log_info(
            "WHISPER",
            "All timestamped local STT segments were filtered as repetitive hallucinations",
        );
        return Ok(AudioTranscriptionResult {
            raw: String::new(),
            cleaned: String::new(),
            segments: Vec::new(),
        });
    }

    let cleaned_raw = if require_segments && !segments.is_empty() {
        segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        sanitized_raw
    };

    Ok(AudioTranscriptionResult {
        raw: cleaned_raw.clone(),
        cleaned: cleaned_raw,
        segments,
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
    Ok(plain_transcribe_response(
        raw.clone(),
        parsed.cleaned.unwrap_or(raw),
    ))
}

async fn transcribe_file_via_proxy_diarized(
    req: &FilePathTranscriptionRequest,
    prepared: &media::PreparedProxyMedia,
) -> Result<TranscribeResponse, String> {
    let token = req
        .device_token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Talkis Cloud session missing".to_string())?;
    let bytes = fs::read(&prepared.path)
        .map_err(|err| format!("Не удалось прочитать аудио для разметки: {}", err))?;
    let file_part = multipart::Part::bytes(bytes)
        .file_name(prepared.file_name.clone())
        .mime_str(&prepared.mime_type)
        .map_err(|err| format!("MIME error: {}", err))?;
    let form = multipart::Form::new()
        .part("file", file_part)
        .text("language", req.language.clone())
        .text("style", req.style.clone());
    let response = long_http_client()
        .post("https://proxy.talkis.ru/api/transcribe-diarized")
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|err| format!("Proxy diarized request failed: {}", err))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Proxy diarized response read failed: {}", err))?;

    if !status.is_success() {
        return Err(format!("Proxy diarized error ({}): {}", status, body));
    }

    serde_json::from_str::<TranscribeResponse>(&body).map_err(|err| {
        format!(
            "Talkis Cloud returned an invalid diarized response: {}",
            err
        )
    })
}

#[derive(Deserialize)]
struct DiarizationResponse {
    #[serde(default)]
    segments: Vec<DiarizationSegment>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DiarizationSegment {
    start: f64,
    end: f64,
    #[serde(alias = "speaker_id")]
    speaker_id: String,
}

fn local_runtime_kind_from_endpoint(endpoint: Option<&str>) -> Option<local_stt::LocalRuntimeKind> {
    let whisper_url = resolve_whisper_url(endpoint);
    let models_url = resolve_whisper_models_url(&whisper_url);
    local_stt::managed_runtime_kind(&models_url)
}

fn port_from_url(value: &str) -> Option<u16> {
    reqwest::Url::parse(value)
        .ok()
        .and_then(|url| url.port_or_known_default())
}

fn is_repairable_diarization_runtime_error(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("sherpa-onnx установлен")
        && (normalized.contains("diarization binary")
            || normalized.contains("binary для разметки говорящих")
            || normalized.contains("python runtime для разметки говорящих"))
}

fn ensure_diarized_file_preconditions(req: &FilePathTranscriptionRequest) -> Result<(), String> {
    if !req.use_own_key {
        return Err(
            "Для разделения по говорящим нужна локальная Whisper-модель с таймкодами.".to_string(),
        );
    }

    let kind = local_runtime_kind_from_endpoint(req.whisper_endpoint.as_deref());
    if kind != Some(local_stt::LocalRuntimeKind::Whisper) {
        return Err(
            "Для разделения по говорящим нужна локальная Whisper-модель с таймкодами.".to_string(),
        );
    }

    if req
        .whisper_model
        .as_deref()
        .unwrap_or_default()
        .contains("transcribe")
    {
        return Err(
            "Для разделения по говорящим нужна локальная Whisper-модель с таймкодами.".to_string(),
        );
    }

    Ok(())
}

async fn diarize_audio_file(
    app: &AppHandle,
    req: &FilePathTranscriptionRequest,
    wav_path: &std::path::Path,
) -> Result<Vec<DiarizationSegment>, String> {
    let client = long_http_client();
    let models_url = "http://127.0.0.1:8003/v1/models";
    let runtime_base_url =
        local_stt::ensure_runtime(app, client, models_url, req.local_models_dir.as_deref()).await?;
    let diarization_url = format!(
        "{}/v1/audio/diarization",
        runtime_base_url.trim_end_matches('/')
    );
    let bytes = fs::read(wav_path)
        .map_err(|err| format!("Не удалось прочитать WAV для разделения говорящих: {}", err))?;
    let file_part = multipart::Part::bytes(bytes)
        .file_name("talkis-diarization.wav")
        .mime_str("audio/wav")
        .map_err(|err| format!("MIME error: {}", err))?;
    let form = multipart::Form::new()
        .part("file", file_part)
        .text("model", local_stt::LOCAL_DIARIZATION_MODEL_ID);
    let response = client
        .post(&diarization_url)
        .multipart(form)
        .send()
        .await
        .map_err(|err| format!("Diarization request failed: {}", err))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Diarization response read failed: {}", err))?;

    if !status.is_success() {
        return Err(format!("Diarization error ({}): {}", status, body));
    }

    let parsed = serde_json::from_str::<DiarizationResponse>(&body)
        .map_err(|err| format!("Diarization returned an invalid response: {}", err))?;
    let mut segments = parsed
        .segments
        .into_iter()
        .filter(|segment| segment.end > segment.start && !segment.speaker_id.trim().is_empty())
        .collect::<Vec<_>>();
    segments.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    if segments.is_empty() {
        return Err("Разделение говорящих не нашло речевых сегментов.".to_string());
    }

    Ok(segments)
}

fn overlap_seconds(stt: &SttTranscriptSegment, diarization: &DiarizationSegment) -> f64 {
    let start = stt.start.max(diarization.start);
    let end = stt.end.min(diarization.end);
    (end - start).max(0.0)
}

fn nearest_diarization_segment<'a>(
    stt: &SttTranscriptSegment,
    diarization_segments: &'a [DiarizationSegment],
) -> Option<&'a DiarizationSegment> {
    let stt_mid = (stt.start + stt.end) / 2.0;
    diarization_segments.iter().min_by(|left, right| {
        let left_mid = (left.start + left.end) / 2.0;
        let right_mid = (right.start + right.end) / 2.0;
        (left_mid - stt_mid)
            .abs()
            .partial_cmp(&(right_mid - stt_mid).abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    })
}

fn speaker_for_stt_segment<'a>(
    stt: &SttTranscriptSegment,
    diarization_segments: &'a [DiarizationSegment],
) -> Option<&'a str> {
    let best_overlap = diarization_segments
        .iter()
        .map(|segment| (segment, overlap_seconds(stt, segment)))
        .filter(|(_, overlap)| *overlap > 0.0)
        .max_by(|(_, left), (_, right)| {
            left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)
        });

    if let Some((segment, _)) = best_overlap {
        return Some(segment.speaker_id.as_str());
    }

    nearest_diarization_segment(stt, diarization_segments)
        .map(|segment| segment.speaker_id.as_str())
}

fn speaker_labels(
    assigned_segments: &[(SttTranscriptSegment, String)],
) -> (Vec<Speaker>, std::collections::HashMap<String, String>) {
    let mut ordered_ids = Vec::<String>::new();
    for (_, speaker_id) in assigned_segments {
        if !ordered_ids.contains(speaker_id) {
            ordered_ids.push(speaker_id.clone());
        }
    }

    let mut labels = std::collections::HashMap::new();
    let speakers = ordered_ids
        .into_iter()
        .enumerate()
        .map(|(index, id)| {
            let label = format!("Гость {}", index + 1);
            labels.insert(id.clone(), label.clone());
            Speaker { id, label }
        })
        .collect::<Vec<_>>();

    (speakers, labels)
}

fn merge_speaker_segments(
    assigned_segments: Vec<(SttTranscriptSegment, String)>,
    labels: &std::collections::HashMap<String, String>,
) -> Vec<SpeakerTranscriptSegment> {
    let mut merged = Vec::<SpeakerTranscriptSegment>::new();
    for (segment, speaker_id) in assigned_segments {
        let label = labels
            .get(&speaker_id)
            .cloned()
            .unwrap_or_else(|| "Гость 1".to_string());

        if let Some(last) = merged.last_mut() {
            if last.speaker_id == speaker_id && segment.start - last.end < 1.2 {
                last.end = last.end.max(segment.end);
                if !last.text.ends_with(char::is_whitespace) {
                    last.text.push(' ');
                }
                last.text.push_str(segment.text.trim());
                continue;
            }
        }

        merged.push(SpeakerTranscriptSegment {
            start: segment.start,
            end: segment.end,
            speaker_id,
            speaker_label: label,
            text: segment.text.trim().to_string(),
        });
    }

    merged
}

fn format_timestamp(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    format!("{:02}:{:02}:{:02}", hours, minutes, seconds)
}

fn format_speaker_transcript(segments: &[SpeakerTranscriptSegment]) -> String {
    segments
        .iter()
        .map(|segment| {
            format!(
                "[{}] {}: {}",
                format_timestamp(segment.start),
                segment.speaker_label,
                segment.text.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn assemble_speaker_transcript(
    stt_segments: Vec<SttTranscriptSegment>,
    diarization_segments: Vec<DiarizationSegment>,
) -> Result<(String, Vec<Speaker>, Vec<SpeakerTranscriptSegment>), String> {
    let assigned_segments = stt_segments
        .into_iter()
        .filter_map(|segment| {
            let speaker_id = speaker_for_stt_segment(&segment, &diarization_segments)?.to_string();
            Some((segment, speaker_id))
        })
        .collect::<Vec<_>>();

    if assigned_segments.is_empty() {
        return Err("Не удалось сопоставить речь с говорящими.".to_string());
    }

    let (speakers, labels) = speaker_labels(&assigned_segments);
    let segments = merge_speaker_segments(assigned_segments, &labels);
    let transcript = format_speaker_transcript(&segments);

    Ok((transcript, speakers, segments))
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
            "Файл слишком большой. Максимальный размер для транскрибации: 8 ГБ.".to_string(),
        );
    }
    if req.speaker_diarization && req.use_own_key {
        ensure_diarized_file_preconditions(&req)?;
    }

    emit_file_progress(&app, &req.request_id, "preparing", 0, 0, "Готовим файл");
    if req.speaker_diarization && !req.use_own_key {
        let prepared = media::prepare_media_file_for_proxy_transcription(&app, &input_path).await?;
        emit_file_progress(
            &app,
            &req.request_id,
            "diarizing",
            0,
            0,
            "Разделяем говорящих в Talkis Cloud",
        );
        logger::log_info(
            "FILE_TRANSCRIPTION",
            &format!(
                "Sending diarized cloud file, size={} bytes",
                prepared.size_bytes
            ),
        );
        let result = transcribe_file_via_proxy_diarized(&req, &prepared).await;
        let _ = fs::remove_dir_all(&prepared.temp_dir);
        return result;
    }

    let diarization_segments = if req.speaker_diarization {
        let diarization_audio =
            media::prepare_media_file_for_diarization(&app, &input_path).await?;
        emit_file_progress(
            &app,
            &req.request_id,
            "diarizing",
            0,
            0,
            "Разделяем говорящих",
        );
        let result = diarize_audio_file(&app, &req, &diarization_audio.path).await;
        let _ = fs::remove_dir_all(&diarization_audio.temp_dir);
        Some(result?)
    } else {
        None
    };

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
    let mut stt_segments = Vec::<SttTranscriptSegment>::new();
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

        let text = if !req.use_own_key {
            let result = transcribe_file_chunk_via_proxy(&req, chunk).await;
            let result = match result {
                Ok(result) => result,
                Err(err) => {
                    let _ = fs::remove_dir_all(&prepared.temp_dir);
                    return Err(err);
                }
            };
            if result.raw.trim().is_empty() {
                result.cleaned
            } else {
                result.raw
            }
        } else {
            match fs::read(&chunk.path) {
                Ok(bytes) => match transcribe_audio_bytes_internal(
                    app.clone(),
                    &base_req,
                    bytes,
                    chunk.file_name.clone(),
                    chunk.mime_type.clone(),
                    req.speaker_diarization,
                    chunk.start_offset_seconds,
                )
                .await
                {
                    Ok(result) => {
                        if req.speaker_diarization {
                            stt_segments.extend(result.segments);
                        }
                        if result.raw.trim().is_empty() {
                            result.cleaned
                        } else {
                            result.raw
                        }
                    }
                    Err(err) => {
                        let _ = fs::remove_dir_all(&prepared.temp_dir);
                        return Err(err);
                    }
                },
                Err(err) => {
                    let _ = fs::remove_dir_all(&prepared.temp_dir);
                    return Err(format!("Не удалось прочитать фрагмент аудио: {}", err));
                }
            }
        };

        let text = text.trim().to_string();
        if !text.is_empty() {
            parts.push(text);
        }
    }

    let _ = fs::remove_dir_all(&prepared.temp_dir);

    if let Some(diarization_segments) = diarization_segments {
        emit_file_progress(
            &app,
            &req.request_id,
            "assembling",
            total_chunks,
            total_chunks,
            "Собираем протокол",
        );
        let (raw, speakers, segments) =
            assemble_speaker_transcript(stt_segments, diarization_segments)?;
        emit_file_progress(
            &app,
            &req.request_id,
            "done",
            total_chunks,
            total_chunks,
            "Готово",
        );

        return Ok(TranscribeResponse {
            cleaned: raw.clone(),
            raw,
            mode: TranscriptionMode::Speakers,
            speakers: Some(speakers),
            segments: Some(segments),
        });
    }

    emit_file_progress(
        &app,
        &req.request_id,
        "done",
        total_chunks,
        total_chunks,
        "Готово",
    );

    let raw = parts.join("\n\n");
    Ok(plain_transcribe_response(raw.clone(), raw))
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

#[derive(Deserialize)]
struct SttEndpointErrorResponse {
    error: SttEndpointError,
}

#[derive(Deserialize)]
struct SttEndpointError {
    message: String,
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
                local_stt::LocalRuntimeKind::Diarization => "Diarization",
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
                    local_stt::LocalRuntimeKind::Whisper
                    | local_stt::LocalRuntimeKind::Diarization => Ok((0, None)),
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
                                    local_stt::LocalRuntimeKind::Diarization => {
                                        "Скачиваем sherpa-onnx модели diarization."
                                    }
                                    _ => "Устанавливаем Qwen зависимости.",
                                }
                            } else {
                                match task_kind {
                                    local_stt::LocalRuntimeKind::Nvidia => {
                                        "Скачиваем файлы Parakeet модели."
                                    }
                                    local_stt::LocalRuntimeKind::Diarization => {
                                        "Скачиваем sherpa-onnx модели diarization."
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
        let mut status_code = status.as_u16();
        let mut error_text = response.text().await.unwrap_or_default();

        if managed_runtime_kind == Some(local_stt::LocalRuntimeKind::Diarization)
            && is_repairable_diarization_runtime_error(&error_text)
        {
            logger::log_info(
                "STT_INSTALL",
                "Restarting Diarization runtime after incomplete sherpa-onnx runtime error",
            );
            if let Some(port) = port_from_url(&models_url) {
                if let Err(err) =
                    local_stt::stop_managed_runtime(local_stt::LocalRuntimeKind::Diarization, port)
                {
                    logger::log_error("STT_INSTALL", &err);
                }
                tokio::time::sleep(Duration::from_millis(700)).await;
            }

            if let Ok(runtime_base_url) = local_stt::ensure_runtime(
                &app,
                client,
                &models_url,
                req.local_models_dir.as_deref(),
            )
            .await
            {
                effective_whisper_endpoint = Some(runtime_base_url.clone());
                let retry_models_url = resolve_managed_models_url(&runtime_base_url);
                let retry_download_url =
                    resolve_whisper_model_download_url(&retry_models_url, requested_model);
                match install_client.post(&retry_download_url).send().await {
                    Ok(retry_response) if retry_response.status().is_success() => {
                        logger::log_info(
                            "STT_INSTALL",
                            "Diarization runtime repair succeeded after restart",
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
                    Ok(retry_response) => {
                        status_code = retry_response.status().as_u16();
                        error_text = retry_response.text().await.unwrap_or_default();
                    }
                    Err(err) => {
                        error_text =
                            format!("Ошибка повторной установки diarization runtime: {}", err);
                    }
                }
            }
        }

        let error_detail = stt_endpoint_error_message(&error_text).unwrap_or_else(|| {
            error_text
                .chars()
                .take(200)
                .collect::<String>()
                .trim()
                .to_string()
        });
        let message = match status_code {
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
                status_code, error_detail
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
            Some(local_stt::LocalRuntimeKind::Diarization) => (1, Some(1)),
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

fn stt_endpoint_error_message(response_text: &str) -> Option<String> {
    serde_json::from_str::<SttEndpointErrorResponse>(response_text)
        .ok()
        .map(|response| response.error.message.trim().to_string())
        .filter(|message| !message.is_empty())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn stt(start: f64, end: f64, text: &str) -> SttTranscriptSegment {
        SttTranscriptSegment {
            start,
            end,
            text: text.to_string(),
        }
    }

    fn dia(start: f64, end: f64, speaker_id: &str) -> DiarizationSegment {
        DiarizationSegment {
            start,
            end,
            speaker_id: speaker_id.to_string(),
        }
    }

    #[test]
    fn assigns_speaker_by_maximum_overlap() {
        let diarization = vec![dia(0.0, 3.0, "SPEAKER_00"), dia(3.0, 8.0, "SPEAKER_01")];
        let speaker = speaker_for_stt_segment(&stt(2.0, 6.0, "hello"), &diarization);

        assert_eq!(speaker, Some("SPEAKER_01"));
    }

    #[test]
    fn falls_back_to_nearest_speaker_when_overlap_is_missing() {
        let diarization = vec![dia(0.0, 2.0, "SPEAKER_00"), dia(8.0, 10.0, "SPEAKER_01")];
        let speaker = speaker_for_stt_segment(&stt(4.8, 5.0, "gap"), &diarization);

        assert_eq!(speaker, Some("SPEAKER_00"));
    }

    #[test]
    fn maps_speaker_ids_to_guest_labels_in_first_appearance_order() {
        let (transcript, speakers, segments) = assemble_speaker_transcript(
            vec![
                stt(600.0, 602.0, "Второй chunk"),
                stt(603.0, 605.0, "Ответ"),
            ],
            vec![
                dia(599.0, 602.5, "SPEAKER_01"),
                dia(602.5, 606.0, "SPEAKER_00"),
            ],
        )
        .expect("speaker transcript");

        assert_eq!(speakers[0].id, "SPEAKER_01");
        assert_eq!(speakers[0].label, "Гость 1");
        assert_eq!(speakers[1].id, "SPEAKER_00");
        assert_eq!(segments[0].start, 600.0);
        assert!(transcript.starts_with("[00:10:00] Гость 1:"));
    }

    #[test]
    fn merges_adjacent_segments_for_same_speaker_under_pause_threshold() {
        let (_, _, segments) = assemble_speaker_transcript(
            vec![stt(0.0, 1.0, "Давайте"), stt(1.8, 2.5, "начнем")],
            vec![dia(0.0, 3.0, "SPEAKER_00")],
        )
        .expect("speaker transcript");

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "Давайте начнем");
    }

    #[test]
    fn removes_caption_artifact_units_from_local_stt_text() {
        let text = sanitize_repetitive_transcript_text(
            "Продолжение следует... Продолжение следует... Сколько уйдет времени?",
        );

        assert_eq!(text, "Сколько уйдет времени?");
    }

    #[test]
    fn compacts_repeated_sentence_runs_inside_segment() {
        let text = sanitize_repetitive_transcript_text(
            "Проверим пайплайн. Убедимся в том, что у нас все было. Убедимся в том, что у нас все было. Убедимся в том, что у нас все было.",
        );

        assert_eq!(
            text,
            "Проверим пайплайн. Убедимся в том, что у нас все было."
        );
    }

    #[test]
    fn filters_repeated_low_information_stt_segments() {
        let segments = sanitize_stt_segments(vec![
            stt(0.0, 1.0, "Спасибо."),
            stt(30.0, 31.0, "Спасибо."),
            stt(60.0, 61.0, "Спасибо."),
            stt(90.0, 94.0, "Реальная фраза"),
        ]);

        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, "Спасибо.");
        assert_eq!(segments[1].text, "Реальная фраза");
    }

    #[test]
    fn plain_response_keeps_legacy_raw_cleaned_shape() {
        let response = plain_transcribe_response("raw".to_string(), "cleaned".to_string());

        assert_eq!(response.raw, "raw");
        assert_eq!(response.cleaned, "cleaned");
        assert_eq!(response.mode, TranscriptionMode::Plain);
        assert!(response.speakers.is_none());
        assert!(response.segments.is_none());
    }
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
