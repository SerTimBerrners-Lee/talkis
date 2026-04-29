use crate::logger;
use crate::prompt_config;
use base64::Engine;
use reqwest::multipart;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

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

#[derive(Serialize, Deserialize, Clone)]
pub struct TranscribeRequest {
    pub audio_base64: String,
    pub language: String,
    pub api_key: String,
    pub whisper_api_key: Option<String>,
    pub llm_api_key: Option<String>,
    pub style: String,
    pub whisper_endpoint: Option<String>,
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
pub async fn transcribe_and_clean(req: TranscribeRequest) -> Result<TranscribeResponse, String> {
    logger::log_info(
        "API",
        &format!(
            "Starting transcription... style={}, language={}, whisper_model={:?}, llm_model={:?}",
            req.style, req.language, req.whisper_model, req.llm_model
        ),
    );

    let client = http_client();
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.audio_base64)
        .map_err(|e| {
            let err = format!("Base64 decode error: {}", e);
            logger::log_error("API", &err);
            err
        })?;

    // ── Step 1: Whisper Speech-to-Text ──────────────────────────────────
    let whisper_url = req
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

    logger::log_info(
        "WHISPER",
        &format!(
            "Sending request to {}, audio_size: {} bytes",
            whisper_url,
            audio_bytes.len()
        ),
    );

    let file_name = req
        .file_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("audio.webm");
    let mime_type = req
        .mime_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("audio/webm");

    let file_part = multipart::Part::bytes(audio_bytes)
        .file_name(file_name.to_string())
        .mime_str(mime_type)
        .map_err(|e| format!("MIME error: {}", e))?;

    let lang_param = if req.language == "auto" {
        String::new()
    } else {
        req.language.clone()
    };

    let whisper_model = req.whisper_model.as_deref().unwrap_or("whisper-1");
    let is_transcribe_model = whisper_model.contains("transcribe");

    // Speaches (faster-whisper) does not support verbose_json — it returns 500.
    // Fall back to plain "json" for local endpoints so segments/duration won't
    // be available, but transcription will succeed.
    let is_local_endpoint = whisper_url.contains("127.0.0.1") || whisper_url.contains("localhost");

    let mut form = multipart::Form::new()
        .part("file", file_part)
        .text("model", whisper_model.to_string());

    if is_transcribe_model {
        // gpt-4o-transcribe / gpt-4o-mini-transcribe:
        // - Only support "json" or "text" response_format (not verbose_json)
        // - Don't support "language" or "prompt" params
        // - Use "instructions" instead of "prompt" for hints
        form = form.text("response_format", "json");

        if let Some(hint) = build_whisper_prompt(&req.language, &req.style) {
            form = form.text("instructions", hint);
        }
    } else if is_local_endpoint {
        // Local Speaches / faster-whisper: only supports plain "json"
        form = form.text("response_format", "json");

        if !lang_param.is_empty() {
            form = form.text("language", lang_param);
        }

        if let Some(prompt) = build_whisper_prompt(&req.language, &req.style) {
            form = form.text("prompt", prompt.to_string());
        }
    } else {
        // Classic Whisper API (OpenAI / compatible): support verbose_json, language, prompt
        form = form.text("response_format", "verbose_json");

        if let Some(prompt) = build_whisper_prompt(&req.language, &req.style) {
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

    let whisper_res = client
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

    // ── Step 2: LLM Text Cleanup ────────────────────────────────────────

    // Skip LLM processing when llm_model is "none" or no LLM key is available
    let llm_key = req
        .llm_api_key
        .as_ref()
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| req.api_key.clone());

    let transcribe_only = req.mode.as_deref() == Some("transcribe_only");
    let skip_llm = transcribe_only
        || req
            .llm_model
            .as_deref()
            .map(|m| m == "none")
            .unwrap_or(false)
        || llm_key.trim().is_empty();

    if skip_llm {
        logger::log_info("LLM", "Skipping LLM cleanup");
        return Ok(TranscribeResponse {
            raw: raw.clone(),
            cleaned: raw,
        });
    }

    let prompt_preview = prompt_config::build_cleanup_prompt_preview(&req.language, &req.style)
        .map_err(|err| {
            logger::log_error("PROMPT", &err);
            err
        })?;
    logger::log_info(
        "PROMPT",
        &format!(
            "Using profile={} version={} layers={}",
            prompt_preview.profile_key,
            prompt_preview.version,
            prompt_preview.layers.join(", ")
        ),
    );
    let system_prompt = prompt_preview.prompt;

    // Map transcribe model names to their chat equivalents
    // (e.g. "gpt-4o-mini-transcribe" → "gpt-4o-mini")
    let llm_model_raw = req.llm_model.as_deref().unwrap_or("gpt-4o-mini");
    let llm_model = if llm_model_raw.contains("transcribe") {
        llm_model_raw.replace("-transcribe", "")
    } else {
        llm_model_raw.to_string()
    };
    let llm_url = req
        .llm_endpoint
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| {
            let base = s.trim_end_matches('/');
            if base.ends_with("/chat/completions") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{}/chat/completions", base)
            } else {
                format!("{}/v1/chat/completions", base)
            }
        })
        .unwrap_or_else(|| "https://api.openai.com/v1/chat/completions".to_string());

    let gpt_body = serde_json::json!({
        "model": llm_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": raw}
        ],
        "temperature": prompt_preview.temperature.unwrap_or(0.15),
        "max_tokens": 4096
    });

    logger::log_info(
        "LLM",
        &format!("Sending to {}, model: {}", llm_url, llm_model),
    );

    let gpt_res = client
        .post(&llm_url)
        .bearer_auth(&llm_key)
        .header("Content-Type", "application/json")
        .json(&gpt_body)
        .send()
        .await
        .map_err(|e| {
            let err = format!("LLM request failed: {}", e);
            logger::log_error("LLM", &err);
            err
        })?;

    let gpt_status = gpt_res.status();
    logger::log_info("LLM", &format!("Response status: {}", gpt_status));

    if !gpt_status.is_success() {
        let body = gpt_res.text().await.unwrap_or_default();
        let err = format!("LLM API error ({}): {}", gpt_status, body);
        logger::log_error("LLM", &err);
        return Err(err);
    }

    #[derive(Deserialize)]
    struct Choice {
        message: ChatMsg,
    }
    #[derive(Deserialize)]
    struct ChatMsg {
        content: String,
    }
    #[derive(Deserialize)]
    struct GPTResp {
        choices: Vec<Choice>,
    }

    let gpt_parsed: GPTResp = gpt_res.json().await.map_err(|e| {
        let err = format!("LLM response parse error: {}", e);
        logger::log_error("LLM", &err);
        err
    })?;
    let cleaned = gpt_parsed
        .choices
        .first()
        .map(|c| c.message.content.trim().to_string())
        .unwrap_or_else(|| raw.clone());

    logger::log_info("LLM", &format!("Cleaned: \"{}\"", cleaned));
    logger::log_info("API", "Transcription complete");

    Ok(TranscribeResponse { raw, cleaned })
}

#[tauri::command]
pub async fn transcribe_only(mut req: TranscribeRequest) -> Result<TranscribeResponse, String> {
    req.mode = Some("transcribe_only".to_string());
    transcribe_and_clean(req).await
}

// ── Connection test ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct TestConnectionRequest {
    pub api_key: String,
    pub whisper_api_key: Option<String>,
    pub whisper_endpoint: Option<String>,
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
    client: &reqwest::Client,
    req: &TestConnectionRequest,
) -> Result<String, String> {
    let whisper_url = resolve_whisper_url(req.whisper_endpoint.as_deref());
    let models_url = resolve_whisper_models_url(&whisper_url);
    let whisper_key = req
        .whisper_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(req.api_key.as_str());

    let mut request = client.get(&models_url);
    if !whisper_key.trim().is_empty() {
        request = request.bearer_auth(whisper_key);
    }

    let response = request.send().await.map_err(|err| {
        if err.is_connect() {
            if is_likely_local_url(&models_url) {
                "Локальный STT сервер недоступен. Запустите его или проверьте endpoint.".to_string()
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
    pub whisper_model: String,
}

#[derive(Serialize, Deserialize)]
pub struct InstallSttModelResult {
    pub success: bool,
    pub message: String,
}

#[tauri::command]
pub async fn install_stt_model(
    req: InstallSttModelRequest,
) -> Result<InstallSttModelResult, String> {
    let requested_model = req.whisper_model.trim();
    if requested_model.is_empty() {
        return Ok(InstallSttModelResult {
            success: false,
            message: "Укажите имя модели для установки.".to_string(),
        });
    }

    logger::log_info(
        "STT_INSTALL",
        &format!("Installing STT model: {}", requested_model),
    );

    let whisper_url = resolve_whisper_url(req.whisper_endpoint.as_deref());
    let models_url = resolve_whisper_models_url(&whisper_url);
    let download_url = resolve_whisper_model_download_url(&models_url, requested_model);
    let whisper_key = req
        .whisper_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(req.api_key.as_str());

    let client = http_client();
    let mut request = client.post(&download_url);
    if !whisper_key.trim().is_empty() {
        request = request.bearer_auth(whisper_key);
    }

    let response = request.send().await.map_err(|err| {
        let message = if err.is_connect() {
            if is_likely_local_url(&download_url) {
                "Локальный STT сервер недоступен. Сначала запустите Speaches.".to_string()
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

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        let message = match status.as_u16() {
            401 => "STT endpoint отклонил API-ключ при установке модели.".to_string(),
            403 => "STT endpoint запретил установку модели. Проверьте права доступа.".to_string(),
            404 => format!(
                "Модель «{}» не найдена в реестре Speaches.",
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
        });
    }

    logger::log_info(
        "STT_INSTALL",
        &format!("STT model install request accepted: {}", requested_model),
    );
    Ok(InstallSttModelResult {
        success: true,
        message: format!(
            "Установка модели «{}» запущена. Если модель большая, подождите немного и затем нажмите «Тестировать соединение».",
            requested_model
        ),
    })
}

async fn test_llm_connection(
    client: &reqwest::Client,
    req: &TestConnectionRequest,
) -> Result<String, String> {
    let llm_model = req.llm_model.as_deref().unwrap_or("gpt-4o-mini");
    let llm_url = req
        .llm_endpoint
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| {
            let base = s.trim_end_matches('/');
            if base.ends_with("/chat/completions") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{}/chat/completions", base)
            } else {
                format!("{}/v1/chat/completions", base)
            }
        })
        .unwrap_or_else(|| "https://api.openai.com/v1/chat/completions".to_string());

    let llm_key = req
        .llm_api_key
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(req.api_key.as_str());

    if llm_key.trim().is_empty() {
        return Err("Для проверки LLM нужен API-ключ.".to_string());
    }

    let body = serde_json::json!({
        "model": llm_model,
        "messages": [{"role": "user", "content": "Hi"}],
        "max_tokens": 1
    });

    let response = client
        .post(&llm_url)
        .bearer_auth(llm_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await;

    match response {
        Ok(res) => {
            let status = res.status();
            if status.is_success() {
                Ok(format!("LLM доступен, модель «{}» отвечает.", llm_model))
            } else {
                let error_text = res.text().await.unwrap_or_default();
                let msg = match status.as_u16() {
                    401 => "Неверный API ключ для LLM".to_string(),
                    403 => "LLM endpoint запретил доступ (проверьте ключ и endpoint)".to_string(),
                    404 => format!("Модель «{}» не найдена на LLM endpoint", llm_model),
                    429 => "Превышен лимит запросов на LLM endpoint".to_string(),
                    _ => format!(
                        "Ошибка LLM {}: {}",
                        status.as_u16(),
                        error_text.chars().take(200).collect::<String>()
                    ),
                };
                Err(msg)
            }
        }
        Err(err) => {
            if err.is_connect() {
                Err("Не удалось подключиться к LLM endpoint. Проверьте адрес и сеть.".to_string())
            } else if err.is_timeout() {
                Err("Таймаут соединения с LLM endpoint.".to_string())
            } else {
                Err(format!("Ошибка сети LLM: {}", err))
            }
        }
    }
}

#[tauri::command]
pub async fn test_api_connection(
    req: TestConnectionRequest,
) -> Result<TestConnectionResult, String> {
    logger::log_info("TEST", "Testing API connection...");

    let client = http_client();
    let start = std::time::Instant::now();

    let mut messages: Vec<String> = Vec::new();

    if req.test_stt {
        match test_stt_connection(client, &req).await {
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
        match test_llm_connection(client, &req).await {
            Ok(message) => messages.push(message),
            Err(message) => {
                logger::log_error("TEST", &format!("LLM test failed: {}", message));
                let latency_ms = start.elapsed().as_millis() as u64;
                return Ok(TestConnectionResult {
                    success: false,
                    message,
                    latency_ms,
                });
            }
        }
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
