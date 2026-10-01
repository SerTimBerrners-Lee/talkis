use crate::audio_capture_startup::{wait_for_start, MICROPHONE_START_TIMEOUT};
use crate::call_capture::{self, CallCaptureSession, StartCallCaptureRequest};
use crate::logger;
use crate::realtime::{
    self, NormalizedRealtimeEvent, NormalizedRealtimeStatus, RealtimeAudioCommand,
    RealtimeConnectionRequest,
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const SAMPLE_RATE: u32 = 16_000;
const CHUNK_BYTES: usize = (SAMPLE_RATE as usize / 10) * 2;
const QUEUE_CHUNKS: usize = 24;
const EVENT_NAME: &str = "live-translation:update";
const OPENAI_OUTPUT_SAMPLE_RATE: u32 = 24_000;
const PLAYBACK_PREBUFFER_MS: u32 = 140;
const PLAYBACK_MAX_QUEUE_MS: u32 = 6_000;
const PLAYBACK_RECOVERY_QUEUE_MS: u32 = 3_000;
const ORIGINAL_PLAYBACK_VOLUME: f32 = 0.12;
const ORIGINAL_PLAYBACK_PREBUFFER_MS: u32 = 80;
const ORIGINAL_PLAYBACK_MAX_QUEUE_MS: u32 = 500;
const ORIGINAL_PLAYBACK_RECOVERY_QUEUE_MS: u32 = 200;
const TRANSLATION_WORKER_START_TIMEOUT: Duration = Duration::from_secs(15);
const TALKIS_CLOUD_PROVIDER: &str = "talkis-cloud";
const TALKIS_CLOUD_REALTIME_PATH: &str = "/api/realtime/client-secret";

static SESSION: OnceLock<Mutex<Option<LiveTranslationRuntime>>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLiveTranslationRequest {
    pub provider: String,
    pub api_key: String,
    pub model: String,
    pub endpoint: String,
    pub target_language: String,
    #[serde(default)]
    pub voice_enabled: bool,
    pub voice: Option<String>,
    pub voice_volume: Option<f32>,
    pub voice_speed: Option<f32>,
    #[serde(default)]
    pub mute_original: bool,
    #[serde(default)]
    pub include_microphone: bool,
    pub mic_device_label: Option<String>,
    pub save_audio: bool,
    pub storage_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudRealtimeClientSecret {
    client_secret: String,
    provider: String,
    model: String,
    endpoint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranslationSessionInfo {
    pub session_id: String,
    pub started_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopLiveTranslationResult {
    pub session_id: String,
    pub call_capture: CallCaptureSession,
}

#[tauri::command]
pub async fn get_live_translation_audio_level() -> Result<call_capture::SystemAudioLevel, String> {
    let call_session_id = slot()
        .lock()
        .map_err(|_| "Failed to lock live translation session.".to_string())?
        .as_ref()
        .map(|runtime| runtime.call_session_id.clone())
        .ok_or_else(|| "Синхронный перевод не запущен.".to_string())?;
    call_capture::get_system_audio_level(&call_session_id)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveTranslationEventPayload {
    session_id: String,
    channel: String,
    status: String,
    original: String,
    translated: String,
    started_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

struct LiveTranslationRuntime {
    info: LiveTranslationSessionInfo,
    call_session_id: String,
    mic: Option<LiveTranslationMicRuntime>,
    system_audio_tx: tokio::sync::mpsc::Sender<RealtimeAudioCommand>,
    system_worker_rx: mpsc::Receiver<Result<(), String>>,
    playback: Option<LiveTranslationPlaybackRuntime>,
}

struct LiveTranslationMicRuntime {
    mic_stop_tx: mpsc::Sender<()>,
    mic_stopped_rx: mpsc::Receiver<Result<(), String>>,
    mic_audio_tx: Option<tokio::sync::mpsc::Sender<RealtimeAudioCommand>>,
    mic_worker_rx: Option<mpsc::Receiver<Result<(), String>>>,
}

fn should_capture_live_microphone(include_microphone: bool, save_audio: bool) -> bool {
    include_microphone || save_audio
}

enum PlaybackCommand {
    Pcm(Vec<u8>),
    Finish,
    Cancel,
}

struct LiveTranslationPlaybackRuntime {
    command_tx: mpsc::SyncSender<PlaybackCommand>,
    original_audio_tx: mpsc::SyncSender<Vec<u8>>,
    stopped_rx: mpsc::Receiver<Result<(), String>>,
}

struct TranslationWorkerHandle {
    result_rx: mpsc::Receiver<Result<(), String>>,
    started_rx: mpsc::Receiver<Result<(), String>>,
}

struct PlaybackBuffer {
    samples: VecDeque<f32>,
    playing: bool,
    prebuffer_samples: usize,
    max_samples: usize,
    recovery_samples: usize,
    source_rate: u32,
    target_rate: u32,
    volume: f32,
}

impl PlaybackBuffer {
    fn new(target_rate: u32, volume: f32) -> Self {
        Self::with_config(
            OPENAI_OUTPUT_SAMPLE_RATE,
            target_rate,
            volume,
            PLAYBACK_PREBUFFER_MS,
            PLAYBACK_MAX_QUEUE_MS,
            PLAYBACK_RECOVERY_QUEUE_MS,
        )
    }

    fn new_original(target_rate: u32) -> Self {
        Self::with_config(
            SAMPLE_RATE,
            target_rate,
            ORIGINAL_PLAYBACK_VOLUME,
            ORIGINAL_PLAYBACK_PREBUFFER_MS,
            ORIGINAL_PLAYBACK_MAX_QUEUE_MS,
            ORIGINAL_PLAYBACK_RECOVERY_QUEUE_MS,
        )
    }

    fn with_config(
        source_rate: u32,
        target_rate: u32,
        volume: f32,
        prebuffer_ms: u32,
        max_queue_ms: u32,
        recovery_queue_ms: u32,
    ) -> Self {
        let samples_for_ms =
            |milliseconds: u32| ((target_rate as u64 * milliseconds as u64) / 1_000) as usize;
        Self {
            samples: VecDeque::new(),
            playing: false,
            prebuffer_samples: samples_for_ms(prebuffer_ms),
            max_samples: samples_for_ms(max_queue_ms),
            recovery_samples: samples_for_ms(recovery_queue_ms),
            source_rate,
            target_rate,
            volume: volume.clamp(0.0, 1.0),
        }
    }

    fn push_pcm16(&mut self, pcm: &[u8]) -> bool {
        let source = pcm
            .chunks_exact(2)
            .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / i16::MAX as f32)
            .collect::<Vec<_>>();
        if source.is_empty() {
            return false;
        }
        let output_len =
            ((source.len() as u64 * self.target_rate as u64) / self.source_rate as u64) as usize;
        let ratio = self.source_rate as f64 / self.target_rate as f64;
        let dropped = self.samples.len() + output_len > self.max_samples;
        if dropped {
            let keep = self.recovery_samples.min(self.samples.len());
            let remove = self.samples.len().saturating_sub(keep);
            self.samples.drain(..remove);
            self.playing = false;
        }
        for output_index in 0..output_len {
            let position = output_index as f64 * ratio;
            let index = position.floor() as usize;
            let fraction = (position - index as f64) as f32;
            let current = source.get(index).copied().unwrap_or_default();
            let next = source.get(index + 1).copied().unwrap_or(current);
            self.samples
                .push_back((current + (next - current) * fraction) * self.volume);
        }
        if self.samples.len() > self.max_samples {
            let remove = self.samples.len() - self.max_samples;
            self.samples.drain(..remove);
        }
        dropped
    }

    fn next_sample(&mut self) -> f32 {
        if !self.playing {
            if self.samples.len() < self.prebuffer_samples {
                return 0.0;
            }
            self.playing = true;
        }
        match self.samples.pop_front() {
            Some(sample) => sample,
            None => {
                self.playing = false;
                0.0
            }
        }
    }

    fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }
}

struct PlaybackMixer {
    voice: PlaybackBuffer,
    original: PlaybackBuffer,
}

impl PlaybackMixer {
    fn new(target_rate: u32, voice_volume: f32) -> Self {
        Self {
            voice: PlaybackBuffer::new(target_rate, voice_volume),
            original: PlaybackBuffer::new_original(target_rate),
        }
    }

    fn next_sample(&mut self) -> f32 {
        self.voice.next_sample() + self.original.next_sample()
    }

    fn is_empty(&self) -> bool {
        self.voice.is_empty() && self.original.is_empty()
    }
}

fn fill_playback_output<T, F>(
    output: &mut [T],
    channels: usize,
    buffer: &Arc<Mutex<PlaybackMixer>>,
    mut convert: F,
) where
    T: Copy,
    F: FnMut(f32) -> T,
{
    let Ok(mut buffer) = buffer.lock() else {
        for sample in output {
            *sample = convert(0.0);
        }
        return;
    };
    for frame in output.chunks_mut(channels.max(1)) {
        let sample = buffer.next_sample().clamp(-1.0, 1.0);
        for output_sample in frame {
            *output_sample = convert(sample);
        }
    }
}

fn start_translation_playback(volume: f32) -> Result<LiveTranslationPlaybackRuntime, String> {
    let (command_tx, command_rx) = mpsc::sync_channel::<PlaybackCommand>(96);
    let (original_audio_tx, original_audio_rx) = mpsc::sync_channel::<Vec<u8>>(24);
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (stopped_tx, stopped_rx) = mpsc::channel();
    thread::Builder::new()
        .name("talkis-live-translation-playback".to_string())
        .spawn(move || {
            let start = (|| -> Result<(cpal::Stream, Arc<Mutex<PlaybackMixer>>), String> {
                let host = cpal::default_host();
                let device = host
                    .default_output_device()
                    .ok_or_else(|| "Устройство вывода звука не найдено.".to_string())?;
                let supported = device
                    .default_output_config()
                    .map_err(|error| format!("Не удалось прочитать формат вывода: {}", error))?;
                let sample_format = supported.sample_format();
                let config: cpal::StreamConfig = supported.into();
                let channels = config.channels as usize;
                let buffer = Arc::new(Mutex::new(PlaybackMixer::new(config.sample_rate.0, volume)));
                let error_fn = |error| {
                    logger::log_error(
                        "LIVE_TRANSLATION",
                        &format!("Voice playback stream error: {}", error),
                    )
                };
                let stream = match sample_format {
                    cpal::SampleFormat::F32 => {
                        let state = buffer.clone();
                        device.build_output_stream(
                            &config,
                            move |output: &mut [f32], _| {
                                fill_playback_output(output, channels, &state, |sample| sample)
                            },
                            error_fn,
                            None,
                        )
                    }
                    cpal::SampleFormat::I16 => {
                        let state = buffer.clone();
                        device.build_output_stream(
                            &config,
                            move |output: &mut [i16], _| {
                                fill_playback_output(output, channels, &state, |sample| {
                                    (sample * i16::MAX as f32).round() as i16
                                })
                            },
                            error_fn,
                            None,
                        )
                    }
                    cpal::SampleFormat::U16 => {
                        let state = buffer.clone();
                        device.build_output_stream(
                            &config,
                            move |output: &mut [u16], _| {
                                fill_playback_output(output, channels, &state, |sample| {
                                    ((sample * 0.5 + 0.5) * u16::MAX as f32).round() as u16
                                })
                            },
                            error_fn,
                            None,
                        )
                    }
                    other => {
                        return Err(format!(
                            "Неподдерживаемый формат устройства вывода: {:?}",
                            other
                        ))
                    }
                }
                .map_err(|error| format!("Не удалось открыть устройство вывода: {}", error))?;
                stream
                    .play()
                    .map_err(|error| format!("Не удалось включить озвучку: {}", error))?;
                Ok((stream, buffer))
            })();
            let (stream, buffer) = match start {
                Ok(value) => value,
                Err(error) => {
                    let _ = started_tx.send(Err(error));
                    return;
                }
            };
            if started_tx.send(Ok(())).is_err() {
                return;
            }
            loop {
                while let Ok(pcm) = original_audio_rx.try_recv() {
                    if let Ok(mut buffer) = buffer.lock() {
                        if buffer.original.push_pcm16(&pcm) {
                            logger::log_info(
                                "LIVE_TRANSLATION",
                                "stage=original_queue_recover reason=latency_limit",
                            );
                        }
                    }
                }
                match command_rx.recv_timeout(Duration::from_millis(10)) {
                    Ok(PlaybackCommand::Pcm(pcm)) => {
                        if let Ok(mut buffer) = buffer.lock() {
                            if buffer.voice.push_pcm16(&pcm) {
                                logger::log_info(
                                    "LIVE_TRANSLATION",
                                    "stage=voice_queue_recover reason=latency_limit",
                                );
                            }
                        }
                    }
                    Ok(PlaybackCommand::Finish) => {
                        let deadline = std::time::Instant::now() + Duration::from_secs(6);
                        while std::time::Instant::now() < deadline {
                            if buffer
                                .lock()
                                .map(|buffer| buffer.is_empty())
                                .unwrap_or(true)
                            {
                                break;
                            }
                            thread::sleep(Duration::from_millis(20));
                        }
                        break;
                    }
                    Ok(PlaybackCommand::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        break
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                }
            }
            drop(stream);
            if stopped_tx.send(Ok(())).is_err() {
                logger::log_error("LIVE_TRANSLATION", "Voice playback result receiver closed.");
            }
        })
        .map_err(|error| format!("Не удалось запустить поток озвучки: {}", error))?;
    started_rx
        .recv()
        .map_err(|_| "Поток озвучки завершился до запуска.".to_string())??;
    Ok(LiveTranslationPlaybackRuntime {
        command_tx,
        original_audio_tx,
        stopped_rx,
    })
}

struct PcmEncoder {
    source_rate: u32,
    pending_source: Vec<f32>,
    next_source_pos: f64,
    pending_pcm: Vec<u8>,
}

impl PcmEncoder {
    fn new(source_rate: u32) -> Self {
        Self {
            source_rate: source_rate.max(1),
            pending_source: Vec::new(),
            next_source_pos: 0.0,
            pending_pcm: Vec::with_capacity(CHUNK_BYTES * 2),
        }
    }

    fn push(&mut self, samples: &[f32]) -> Vec<Vec<u8>> {
        self.pending_source.extend_from_slice(samples);
        let ratio = self.source_rate as f64 / SAMPLE_RATE as f64;
        while self.next_source_pos + 1.0 < self.pending_source.len() as f64 {
            let index = self.next_source_pos.floor() as usize;
            let frac = (self.next_source_pos - index as f64) as f32;
            let sample = self.pending_source[index]
                + (self.pending_source[index + 1] - self.pending_source[index]) * frac;
            let pcm = if sample < 0.0 {
                (sample.clamp(-1.0, 1.0) * 32_768.0).round() as i16
            } else {
                (sample.clamp(-1.0, 1.0) * 32_767.0).round() as i16
            };
            self.pending_pcm.extend_from_slice(&pcm.to_le_bytes());
            self.next_source_pos += ratio;
        }
        let drain = self.next_source_pos.floor() as usize;
        if drain > 0 {
            let drain = drain.min(self.pending_source.len());
            self.pending_source.drain(..drain);
            self.next_source_pos -= drain as f64;
        }
        let mut chunks = Vec::new();
        while self.pending_pcm.len() >= CHUNK_BYTES {
            chunks.push(self.pending_pcm.drain(..CHUNK_BYTES).collect());
        }
        chunks
    }

    fn flush(&mut self) -> Option<Vec<u8>> {
        (!self.pending_pcm.is_empty()).then(|| std::mem::take(&mut self.pending_pcm))
    }
}

fn slot() -> &'static Mutex<Option<LiveTranslationRuntime>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

async fn resolve_translation_connection(
    req: &StartLiveTranslationRequest,
) -> Result<RealtimeConnectionRequest, String> {
    if req.provider != TALKIS_CLOUD_PROVIDER {
        return Ok(RealtimeConnectionRequest {
            provider: req.provider.clone(),
            api_key: req.api_key.clone(),
            model: req.model.clone(),
            endpoint: req.endpoint.clone(),
            target_language: Some(req.target_language.clone()),
            purpose: "translation".to_string(),
            voice_output: req.voice_enabled,
            voice: req.voice.clone(),
            voice_speed: req.voice_speed,
        });
    }

    if req.api_key.trim().is_empty() {
        return Err("Войдите в Talkis и проверьте облачный баланс.".to_string());
    }
    let url = format!(
        "{}{}",
        req.endpoint.trim().trim_end_matches('/'),
        TALKIS_CLOUD_REALTIME_PATH
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Не удалось подготовить облачное подключение: {}", error))?;
    logger::log_info(
        "LIVE_TRANSLATION",
        "provider=talkis-cloud stage=client_secret_request",
    );
    let response = client
        .post(url)
        .bearer_auth(req.api_key.trim())
        .json(&serde_json::json!({
            "targetLanguage": req.target_language,
            "voiceOutput": req.voice_enabled,
            "voice": req.voice,
            "voiceSpeed": req.voice_speed,
        }))
        .send()
        .await
        .map_err(|error| format!("Облако Talkis недоступно: {}", error))?;
    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|error| format!("Некорректный ответ облака Talkis: {}", error))?;
    if !status.is_success() {
        let upstream_message = serde_json::from_str::<serde_json::Value>(&response_text)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.as_str())
                    .map(str::to_string)
            });
        let message =
            match status.as_u16() {
                401 => "Сессия Talkis истекла. Войдите в облако повторно.".to_string(),
                402 => "Облачный баланс закончился. Пополните его в личном кабинете Talkis."
                    .to_string(),
                403 => "Облачный доступ Talkis сейчас недоступен.".to_string(),
                429 => "Слишком много запусков синхронного перевода. Повторите через минуту."
                    .to_string(),
                _ => upstream_message.unwrap_or_else(|| {
                    format!("Облако Talkis не запустило синхронный перевод ({})", status)
                }),
            };
        logger::log_error(
            "LIVE_TRANSLATION",
            &format!(
                "provider=talkis-cloud stage=client_secret_failed status={}",
                status
            ),
        );
        return Err(message);
    }

    let secret: CloudRealtimeClientSecret = serde_json::from_str(&response_text)
        .map_err(|error| format!("Некорректный ответ облака Talkis: {}", error))?;
    if secret.client_secret.trim().is_empty()
        || secret.provider != "openai"
        || secret.model.trim().is_empty()
        || secret.endpoint.trim().is_empty()
    {
        return Err("Облако Talkis вернуло неполные данные Realtime-сессии.".to_string());
    }
    logger::log_info(
        "LIVE_TRANSLATION",
        &format!(
            "provider=talkis-cloud stage=client_secret_ready model={}",
            secret.model
        ),
    );

    Ok(RealtimeConnectionRequest {
        provider: secret.provider,
        api_key: secret.client_secret,
        model: secret.model,
        endpoint: secret.endpoint,
        target_language: Some(req.target_language.clone()),
        purpose: "translation".to_string(),
        voice_output: req.voice_enabled,
        voice: req.voice.clone(),
        voice_speed: req.voice_speed,
    })
}

fn reset_system_audio_policy() {
    call_capture::set_system_audio_monitor_sink(None);
    call_capture::set_require_self_audio_exclusion(false);
    call_capture::set_mute_captured_system_audio(false);
}

pub fn is_active() -> bool {
    slot().lock().map(|guard| guard.is_some()).unwrap_or(false)
}

fn session_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("live-{}-{}", std::process::id(), now)
}

fn emit_event(
    app: &AppHandle,
    session_id: &str,
    channel: &str,
    started_at_ms: u64,
    event: NormalizedRealtimeEvent,
) {
    let status = match event.status {
        NormalizedRealtimeStatus::Started => "started",
        NormalizedRealtimeStatus::Partial => "partial",
        NormalizedRealtimeStatus::Final => "final",
        NormalizedRealtimeStatus::Error => "error",
    };
    let payload = LiveTranslationEventPayload {
        session_id: session_id.to_string(),
        channel: channel.to_string(),
        status: status.to_string(),
        original: event.original,
        translated: event.translated,
        started_at_ms,
        message: event.message,
    };
    if let Err(error) = app.emit(EVENT_NAME, payload) {
        logger::log_error(
            "LIVE_TRANSLATION",
            &format!("Failed to emit translation event: {}", error),
        );
    }
}

fn spawn_translation_worker(
    app: AppHandle,
    session_id: String,
    channel: &'static str,
    started_at_ms: u64,
    connection: RealtimeConnectionRequest,
    rx: tokio::sync::mpsc::Receiver<RealtimeAudioCommand>,
    playback_tx: Option<mpsc::SyncSender<PlaybackCommand>>,
) -> Result<TranslationWorkerHandle, String> {
    let (result_tx, result_rx) = mpsc::channel();
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name(format!("talkis-live-translation-{}", channel))
        .spawn(move || {
            let event_app = app.clone();
            let event_session_id = session_id.clone();
            let mut started_tx = Some(started_tx);
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| format!("Failed to start translation runtime: {}", error))
                .and_then(|runtime| {
                    runtime.block_on(realtime::run_translation(
                        connection,
                        rx,
                        |event| {
                            if event.status == NormalizedRealtimeStatus::Started {
                                if let Some(sender) = started_tx.take() {
                                    let _ = sender.send(Ok(()));
                                }
                            }
                            emit_event(&app, &session_id, channel, started_at_ms, event);
                        },
                        move |pcm| {
                            if let Some(sender) = playback_tx.as_ref() {
                                if sender.try_send(PlaybackCommand::Pcm(pcm)).is_err() {
                                    logger::log_info(
                                        "LIVE_TRANSLATION",
                                        "stage=voice_chunk_drop reason=playback_channel_full",
                                    );
                                }
                            }
                        },
                    ))
                });
            if let Some(sender) = started_tx.take() {
                let startup_result = match &result {
                    Ok(()) => Err("Realtime worker stopped before startup.".to_string()),
                    Err(error) => Err(error.clone()),
                };
                let _ = sender.send(startup_result);
            }
            if let Err(error) = &result {
                logger::log_error(
                    "LIVE_TRANSLATION",
                    &format!("channel={} worker failed: {}", channel, error),
                );
                emit_event(
                    &event_app,
                    &event_session_id,
                    channel,
                    started_at_ms,
                    NormalizedRealtimeEvent::error(error.clone()),
                );
            }
            let _ = result_tx.send(result);
        })
        .map_err(|error| format!("Failed to spawn translation worker: {}", error))?;
    Ok(TranslationWorkerHandle {
        result_rx,
        started_rx,
    })
}

async fn wait_for_translation_worker(
    channel: &'static str,
    started_rx: mpsc::Receiver<Result<(), String>>,
) -> Result<(), String> {
    let startup = tokio::task::spawn_blocking(move || {
        started_rx.recv_timeout(TRANSLATION_WORKER_START_TIMEOUT)
    })
    .await
    .map_err(|error| format!("Failed to wait for Realtime worker: {}", error))?;

    match startup {
        Ok(Ok(())) => {
            logger::log_info(
                "LIVE_TRANSLATION",
                &format!("channel={} stage=realtime_ready", channel),
            );
            Ok(())
        }
        Ok(Err(error)) => Err(error),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
            "Не удалось подключиться к Realtime API за {} секунд. Проверьте сеть и повторите запуск.",
            TRANSLATION_WORKER_START_TIMEOUT.as_secs()
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Realtime worker завершился до подключения.".to_string())
        }
    }
}

fn select_microphone(label: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(label) = label.map(str::trim).filter(|value| !value.is_empty()) {
        let expected = label.to_lowercase();
        for device in host
            .input_devices()
            .map_err(|error| format!("Failed to list microphones: {}", error))?
        {
            if let Ok(name) = device.name() {
                if name == label || name.to_lowercase() == expected {
                    return Ok(device);
                }
            }
        }
        return Err(format!("Selected microphone is unavailable: {}", label));
    }
    host.default_input_device()
        .ok_or_else(|| "System microphone was not found.".to_string())
}

fn feed_mic_samples<T, F>(
    data: &[T],
    channels: usize,
    encoder: &Arc<Mutex<PcmEncoder>>,
    sender: Option<&tokio::sync::mpsc::Sender<RealtimeAudioCommand>>,
    writer: &Arc<Mutex<Option<hound::WavWriter<BufWriter<File>>>>>,
    mut to_f32: F,
) where
    T: Copy,
    F: FnMut(T) -> f32,
{
    if channels == 0 {
        return;
    }
    let mono: Vec<f32> = data
        .chunks(channels)
        .filter(|frame| !frame.is_empty())
        .map(|frame| frame.iter().copied().map(&mut to_f32).sum::<f32>() / frame.len() as f32)
        .collect();
    let chunks = match encoder.lock() {
        Ok(mut encoder) => encoder.push(&mono),
        Err(_) => return,
    };
    for chunk in chunks {
        if let Ok(mut guard) = writer.lock() {
            if let Some(writer) = guard.as_mut() {
                for sample in chunk.chunks_exact(2) {
                    let _ = writer.write_sample(i16::from_le_bytes([sample[0], sample[1]]));
                }
            }
        }
        if let Some(sender) = sender {
            let _ = sender.try_send(RealtimeAudioCommand::Pcm(chunk));
        }
    }
}

fn start_mic_capture(
    label: Option<String>,
    audio_tx: Option<tokio::sync::mpsc::Sender<RealtimeAudioCommand>>,
    wav_path: Option<PathBuf>,
) -> Result<(mpsc::Sender<()>, mpsc::Receiver<Result<(), String>>), String> {
    let (stop_tx, stop_rx) = mpsc::channel();
    let (started_tx, started_rx) = mpsc::sync_channel(0);
    let (stopped_tx, stopped_rx) = mpsc::channel();
    thread::Builder::new().name("talkis-live-translation-mic".to_string()).spawn(move || {
        let cleanup_path = wav_path.clone();
        let start = (|| -> Result<(cpal::Stream, Arc<Mutex<PcmEncoder>>, Arc<Mutex<Option<hound::WavWriter<BufWriter<File>>>>>), String> {
            let device = select_microphone(label.as_deref())?;
            let supported = device.default_input_config().map_err(|error| format!("Failed to read microphone format: {}", error))?;
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.into();
            let channels = config.channels as usize;
            let encoder = Arc::new(Mutex::new(PcmEncoder::new(config.sample_rate.0)));
            let writer = Arc::new(Mutex::new(match wav_path {
                Some(path) => Some(hound::WavWriter::create(path, hound::WavSpec { channels: 1, sample_rate: SAMPLE_RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int }).map_err(|error| format!("Failed to create mic WAV: {}", error))?),
                None => None,
            }));
            let error_fn = |error| logger::log_error("LIVE_TRANSLATION", &format!("Microphone stream error: {}", error));
            let stream = match format {
                cpal::SampleFormat::F32 => { let e=encoder.clone(); let s=audio_tx.clone(); let w=writer.clone(); device.build_input_stream(&config, move |d:&[f32],_| feed_mic_samples(d,channels,&e,s.as_ref(),&w,|v|v), error_fn, None) },
                cpal::SampleFormat::I16 => { let e=encoder.clone(); let s=audio_tx.clone(); let w=writer.clone(); device.build_input_stream(&config, move |d:&[i16],_| feed_mic_samples(d,channels,&e,s.as_ref(),&w,|v|v as f32/i16::MAX as f32), error_fn, None) },
                cpal::SampleFormat::U16 => { let e=encoder.clone(); let s=audio_tx.clone(); let w=writer.clone(); device.build_input_stream(&config, move |d:&[u16],_| feed_mic_samples(d,channels,&e,s.as_ref(),&w,|v|(v as f32-32768.0)/32768.0), error_fn, None) },
                other => return Err(format!("Unsupported microphone sample format: {:?}", other)),
            }.map_err(|error| format!("Failed to open microphone: {}", error))?;
            stream.play().map_err(|error| format!("Failed to start microphone: {}", error))?;
            Ok((stream, encoder, writer))
        })();
        let (stream, encoder, writer) = match start { Ok(value) => value, Err(error) => {
            let _=started_tx.send(Err(error));
            if let Some(path) = cleanup_path { let _ = std::fs::remove_file(path); }
            return;
        } };
        if started_tx.send(Ok(())).is_err() {
            drop(stream);
            if let Ok(mut guard) = writer.lock() {
                if let Some(writer) = guard.take() { let _ = writer.finalize(); }
            }
            if let Some(path) = cleanup_path { let _ = std::fs::remove_file(path); }
            logger::log_info("LIVE_TRANSLATION", "Released late translation microphone startup after timeout");
            return;
        }
        let _ = stop_rx.recv();
        drop(stream);
        if let Ok(mut encoder) = encoder.lock() {
            if let (Some(chunk), Some(audio_tx)) = (encoder.flush(), audio_tx.as_ref()) { let _ = audio_tx.blocking_send(RealtimeAudioCommand::Pcm(chunk)); }
        }
        if let Ok(mut guard) = writer.lock() {
            if let Some(writer) = guard.take() { let _ = writer.finalize(); }
        }
        let _ = stopped_tx.send(Ok(()));
    }).map_err(|error| format!("Failed to spawn microphone capture: {}", error))?;
    wait_for_start(
        started_rx,
        MICROPHONE_START_TIMEOUT,
        "Микрофон не ответил вовремя. Попробуйте снова запустить синхронный перевод.",
        "Микрофон синхронного перевода завершил работу до запуска.",
    )?;
    Ok((stop_tx, stopped_rx))
}

#[tauri::command]
pub async fn start_live_translation(
    app: AppHandle,
    req: StartLiveTranslationRequest,
) -> Result<LiveTranslationSessionInfo, String> {
    if crate::native_voice_recorder::is_active() || call_capture::has_active_sessions() {
        return Err(
            "Остановите текущую диктовку или запись звонка перед синхронным переводом.".to_string(),
        );
    }
    if slot()
        .lock()
        .map_err(|_| "Failed to lock live translation session.".to_string())?
        .is_some()
    {
        return Err("Синхронный перевод уже запущен.".to_string());
    }
    if req.voice_enabled && req.provider != "openai" && req.provider != TALKIS_CLOUD_PROVIDER {
        return Err("Озвучка сейчас поддерживается только через OpenAI Realtime API.".to_string());
    }
    #[cfg(not(target_os = "macos"))]
    if req.voice_enabled {
        return Err(
            "Озвучка синхронного перевода пока доступна только на macOS: на этой платформе Talkis ещё не умеет исключать собственный звук из системного захвата."
                .to_string(),
        );
    }

    let connection = resolve_translation_connection(&req).await?;
    let id = session_id();
    let started_at = chrono::Utc::now().to_rfc3339();
    let started_at_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
    let info = LiveTranslationSessionInfo {
        session_id: id.clone(),
        started_at,
    };
    let playback = if req.voice_enabled {
        Some(start_translation_playback(
            req.voice_volume.unwrap_or(0.8).clamp(0.0, 1.0),
        )?)
    } else {
        None
    };
    call_capture::set_require_self_audio_exclusion(req.voice_enabled);
    call_capture::set_mute_captured_system_audio(req.voice_enabled && req.mute_original);
    let (system_tx, system_rx) = tokio::sync::mpsc::channel(QUEUE_CHUNKS);
    let system_worker = match spawn_translation_worker(
        app.clone(),
        id.clone(),
        "system",
        started_at_ms,
        connection.clone(),
        system_rx,
        playback.as_ref().map(|runtime| runtime.command_tx.clone()),
    ) {
        Ok(worker) => worker,
        Err(error) => {
            reset_system_audio_policy();
            if let Some(playback) = playback.as_ref() {
                let _ = playback.command_tx.send(PlaybackCommand::Cancel);
            }
            return Err(error);
        }
    };
    let system_worker_rx = system_worker.result_rx;
    if let Err(error) = wait_for_translation_worker("system", system_worker.started_rx).await {
        reset_system_audio_policy();
        let _ = system_tx.send(RealtimeAudioCommand::Cancel).await;
        if let Some(playback) = playback.as_ref() {
            let _ = playback.command_tx.send(PlaybackCommand::Cancel);
        }
        logger::log_error(
            "LIVE_TRANSLATION",
            &format!("channel=system stage=startup_failed error={}", error),
        );
        return Err(error);
    }

    call_capture::set_system_audio_sink(Some(system_tx.clone()));
    call_capture::set_system_audio_monitor_sink(if req.voice_enabled && req.mute_original {
        playback
            .as_ref()
            .map(|runtime| runtime.original_audio_tx.clone())
    } else {
        None
    });
    let capture_microphone = should_capture_live_microphone(req.include_microphone, req.save_audio);
    let call_session = match call_capture::start_call_capture(
        app.clone(),
        StartCallCaptureRequest {
            target_id: None,
            include_mic: capture_microphone,
            include_system: true,
            mic_device_id: None,
            mic_device_label: None,
            sample_rate: Some(SAMPLE_RATE),
            storage_dir: req.storage_dir.clone(),
            save_audio: req.save_audio,
            native_mic_capture: false,
            live_transcription: None,
        },
    )
    .await
    {
        Ok(session) => session,
        Err(error) => {
            call_capture::set_system_audio_sink(None);
            reset_system_audio_policy();
            let _ = system_tx.send(RealtimeAudioCommand::Cancel).await;
            if let Some(playback) = playback.as_ref() {
                let _ = playback.command_tx.send(PlaybackCommand::Cancel);
            }
            return Err(error);
        }
    };
    let mic = if capture_microphone {
        let (mic_audio_tx, mic_worker_rx) = if req.include_microphone {
            let (mic_tx, mic_rx) = tokio::sync::mpsc::channel(QUEUE_CHUNKS);
            let mut mic_connection = connection;
            mic_connection.voice_output = false;
            mic_connection.voice = None;
            mic_connection.voice_speed = None;
            let mic_worker = match spawn_translation_worker(
                app.clone(),
                id.clone(),
                "mic",
                started_at_ms,
                mic_connection,
                mic_rx,
                None,
            ) {
                Ok(worker) => worker,
                Err(error) => {
                    let _ = call_capture::stop_call_capture(call_session.id.clone()).await;
                    call_capture::set_system_audio_sink(None);
                    reset_system_audio_policy();
                    let _ = system_tx.send(RealtimeAudioCommand::Cancel).await;
                    if let Some(playback) = playback.as_ref() {
                        let _ = playback.command_tx.send(PlaybackCommand::Cancel);
                    }
                    return Err(error);
                }
            };
            let mic_worker_rx = mic_worker.result_rx;
            if let Err(error) = wait_for_translation_worker("mic", mic_worker.started_rx).await {
                let _ = call_capture::stop_call_capture(call_session.id.clone()).await;
                call_capture::set_system_audio_sink(None);
                reset_system_audio_policy();
                let _ = system_tx.send(RealtimeAudioCommand::Cancel).await;
                let _ = mic_tx.send(RealtimeAudioCommand::Cancel).await;
                if let Some(playback) = playback.as_ref() {
                    let _ = playback.command_tx.send(PlaybackCommand::Cancel);
                }
                logger::log_error(
                    "LIVE_TRANSLATION",
                    &format!("channel=mic stage=startup_failed error={}", error),
                );
                return Err(error);
            }
            (Some(mic_tx), Some(mic_worker_rx))
        } else {
            (None, None)
        };
        let mic_path = req
            .save_audio
            .then(|| PathBuf::from(&call_session.directory).join("mic.wav"));
        let mic_device_label = req.mic_device_label;
        let startup_audio_tx = mic_audio_tx.clone();
        let mic_start = tokio::task::spawn_blocking(move || {
            start_mic_capture(mic_device_label, startup_audio_tx, mic_path)
        }).await.unwrap_or_else(|error| Err(format!("Не удалось запустить микрофон перевода: {error}")));
        let (mic_stop_tx, mic_stopped_rx) =
            match mic_start {
                Ok(value) => value,
                Err(error) => {
                    let _ = call_capture::stop_call_capture(call_session.id.clone()).await;
                    call_capture::set_system_audio_sink(None);
                    reset_system_audio_policy();
                    let _ = system_tx.send(RealtimeAudioCommand::Cancel).await;
                    if let Some(mic_audio_tx) = mic_audio_tx.as_ref() {
                        let _ = mic_audio_tx.send(RealtimeAudioCommand::Cancel).await;
                    }
                    if let Some(playback) = playback.as_ref() {
                        let _ = playback.command_tx.send(PlaybackCommand::Cancel);
                    }
                    return Err(error);
                }
            };
        Some(LiveTranslationMicRuntime {
            mic_stop_tx,
            mic_stopped_rx,
            mic_audio_tx,
            mic_worker_rx,
        })
    } else {
        None
    };

    *slot()
        .lock()
        .map_err(|_| "Failed to lock live translation session.".to_string())? =
        Some(LiveTranslationRuntime {
            info: info.clone(),
            call_session_id: call_session.id,
            mic,
            system_audio_tx: system_tx,
            system_worker_rx,
            playback,
        });
    logger::log_info(
        "LIVE_TRANSLATION",
        &format!(
            "Started session={} provider={} model={} target={} translation_sources=system{} saved_audio={} voice={}",
            id,
            req.provider,
            req.model,
            req.target_language,
            if req.include_microphone { "+mic" } else { "" },
            if req.save_audio { "system+mic" } else { "off" },
            req.voice_enabled
        ),
    );
    Ok(info)
}

#[tauri::command]
pub async fn stop_live_translation() -> Result<StopLiveTranslationResult, String> {
    let runtime = slot()
        .lock()
        .map_err(|_| "Failed to lock live translation session.".to_string())?
        .take()
        .ok_or_else(|| "Синхронный перевод не запущен.".to_string())?;
    if let Some(mic) = runtime.mic.as_ref() {
        let _ = mic.mic_stop_tx.send(());
        let _ = mic.mic_stopped_rx.recv_timeout(Duration::from_secs(3));
    }
    call_capture::set_system_audio_sink(None);
    let call_capture_result = call_capture::stop_call_capture(runtime.call_session_id).await;
    reset_system_audio_policy();
    if let Some(mic) = runtime.mic.as_ref() {
        if let Some(mic_audio_tx) = mic.mic_audio_tx.as_ref() {
            let _ = mic_audio_tx.send(RealtimeAudioCommand::Finish).await;
        }
    }
    let _ = runtime
        .system_audio_tx
        .send(RealtimeAudioCommand::Finish)
        .await;
    let mic_result = if let Some(mic_worker_rx) = runtime.mic.and_then(|mic| mic.mic_worker_rx) {
        Some(
            tokio::task::spawn_blocking(move || {
                mic_worker_rx.recv_timeout(Duration::from_secs(15))
            })
            .await
            .map_err(|error| format!("Mic translation worker failed: {}", error))?,
        )
    } else {
        None
    };
    let system_result = tokio::task::spawn_blocking(move || {
        runtime
            .system_worker_rx
            .recv_timeout(Duration::from_secs(15))
    })
    .await
    .map_err(|error| format!("System translation worker failed: {}", error))?;
    for result in mic_result.into_iter().chain(std::iter::once(system_result)) {
        if let Ok(Err(error)) = result {
            logger::log_error("LIVE_TRANSLATION", &error);
        }
    }
    if let Some(playback) = runtime.playback {
        let _ = playback.command_tx.send(PlaybackCommand::Finish);
        let playback_result = tokio::task::spawn_blocking(move || {
            playback.stopped_rx.recv_timeout(Duration::from_secs(7))
        })
        .await
        .map_err(|error| format!("Voice playback worker failed: {}", error))?;
        if let Ok(Err(error)) = playback_result {
            logger::log_error("LIVE_TRANSLATION", &error);
        }
    }
    logger::log_info(
        "LIVE_TRANSLATION",
        &format!("Stopped session={}", runtime.info.session_id),
    );
    Ok(StopLiveTranslationResult {
        session_id: runtime.info.session_id,
        call_capture: call_capture_result?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_resampled_pcm_into_100ms_frames() {
        let mut encoder = PcmEncoder::new(48_000);
        let chunks = encoder.push(&vec![0.25; 9_600]);
        assert_eq!(chunks.len(), 2);
        assert!(chunks.iter().all(|chunk| chunk.len() == CHUNK_BYTES));
    }

    #[test]
    fn bounded_audio_queue_never_blocks_callback() {
        let (sender, _receiver) = tokio::sync::mpsc::channel(2);
        assert!(sender.try_send(RealtimeAudioCommand::Pcm(vec![1])).is_ok());
        assert!(sender.try_send(RealtimeAudioCommand::Pcm(vec![2])).is_ok());
        assert!(matches!(
            sender.try_send(RealtimeAudioCommand::Pcm(vec![3])),
            Err(tokio::sync::mpsc::error::TrySendError::Full(_))
        ));
    }

    #[test]
    fn microphone_is_disabled_when_request_omits_the_option() {
        let request: StartLiveTranslationRequest = serde_json::from_value(serde_json::json!({
            "provider": "openai",
            "apiKey": "secret",
            "model": "realtime",
            "endpoint": "wss://example.test",
            "targetLanguage": "ru",
            "micDeviceLabel": null,
            "saveAudio": false,
            "storageDir": null
        }))
        .expect("request should deserialize");

        assert!(!request.include_microphone);
        assert!(!request.voice_enabled);
        assert!(request.voice.is_none());
        assert!(request.voice_volume.is_none());
        assert!(request.voice_speed.is_none());
        assert!(!request.mute_original);
    }

    #[test]
    fn saved_live_audio_always_captures_both_sides() {
        assert!(should_capture_live_microphone(false, true));
        assert!(should_capture_live_microphone(true, false));
        assert!(!should_capture_live_microphone(false, false));
    }

    #[test]
    fn playback_buffer_resamples_and_applies_volume() {
        let mut buffer = PlaybackBuffer::new(48_000, 0.5);
        let pcm = (0..2_400)
            .flat_map(|_| 16_384i16.to_le_bytes())
            .collect::<Vec<_>>();

        assert!(!buffer.push_pcm16(&pcm));
        assert_eq!(buffer.samples.len(), 4_800);
        assert!((buffer.samples[0] - 0.25).abs() < 0.001);
    }

    #[test]
    fn playback_buffer_drops_old_audio_when_latency_limit_is_reached() {
        let mut buffer = PlaybackBuffer::new(24_000, 1.0);
        let oversized = vec![0u8; (PLAYBACK_MAX_QUEUE_MS as usize + 100) * 48];

        assert!(buffer.push_pcm16(&oversized));
        assert!(buffer.samples.len() <= buffer.max_samples);
        assert!(!buffer.playing);
    }

    #[test]
    fn playback_mixer_keeps_ducked_original_audible() {
        let mut mixer = PlaybackMixer::new(48_000, 1.0);
        let pcm = (0..1_600)
            .flat_map(|_| 16_384i16.to_le_bytes())
            .collect::<Vec<_>>();

        assert!(!mixer.original.push_pcm16(&pcm));
        let sample = mixer.next_sample();
        assert!(sample > 0.05 && sample < 0.07);
    }
}
