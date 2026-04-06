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
    pub style: String,
    pub whisper_endpoint: Option<String>,
    pub llm_endpoint: Option<String>,
    pub whisper_model: Option<String>,
    pub llm_model: Option<String>,
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
    logger::log_info("API", "Starting transcription...");

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

    let file_part = multipart::Part::bytes(audio_bytes)
        .file_name("audio.webm")
        .mime_str("audio/webm")
        .map_err(|e| format!("MIME error: {}", e))?;

    let lang_param = if req.language == "auto" {
        String::new()
    } else {
        req.language.clone()
    };

    let whisper_model = req.whisper_model.as_deref().unwrap_or("whisper-1");

    let mut form = multipart::Form::new()
        .part("file", file_part)
        .text("model", whisper_model.to_string())
        .text("response_format", "verbose_json");

    if let Some(prompt) = build_whisper_prompt(&req.language, &req.style) {
        form = form.text("prompt", prompt.to_string());
    }

    if !lang_param.is_empty() {
        form = form.text("language", lang_param);
    }

    let whisper_res = client
        .post(&whisper_url)
        .bearer_auth(&req.api_key)
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
            &format!("Detected likely silence hallucination, dropping transcription: \"{}\"", raw),
        );
        return Ok(TranscribeResponse {
            raw: String::new(),
            cleaned: String::new(),
        });
    }

    if is_likely_short_uncertain_transcription(&raw, whisper_body.duration, &whisper_body.segments)
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

    // Always use gpt-4o-mini — fast, cheap, excellent for cleanup tasks
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
        .bearer_auth(&req.api_key)
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
