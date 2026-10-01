use crate::live_dictation::{
    self, LiveDictationFeeder, LiveDictationFinal, LiveDictationSession, LiveDictationStartRequest,
};
use crate::logger;
use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

mod startup;

#[cfg(all(test, windows))]
mod windows_smoke;

const TARGET_SAMPLE_RATE: u32 = 16_000;
const TARGET_CHANNELS: u16 = 1;
const PCM_TARGET_PEAK: f32 = 0.82;
const PCM_NORMALIZE_BELOW_PEAK: f32 = 0.35;
const PCM_MIN_SIGNAL_PEAK: f32 = 0.001;
const PCM_MAX_GAIN: f32 = 8.0;
const MAX_NATIVE_RECORDING_SECONDS: usize = 5 * 60;
const NATIVE_START_TIMEOUT: Duration = Duration::from_secs(3);

static RECORDER: OnceLock<Mutex<Option<NativeVoiceRecorder>>> = OnceLock::new();
static RECORDER_RUNTIME: OnceLock<Result<NativeRecorderRuntime, String>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartNativeVoiceRecordingRequest {
    pub device_label: Option<String>,
    pub live_dictation: Option<LiveDictationStartRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceRecordingResult {
    pub audio_base64: String,
    pub mime_type: String,
    pub file_name: String,
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub peak: f32,
    pub rms: f32,
    pub live_transcription: Option<LiveDictationFinal>,
}

struct NativeVoiceRecorder {
    state: Arc<Mutex<NativeRecorderState>>,
    source_sample_rate: u32,
    source_channels: u16,
    device_name: String,
    live_session: Option<LiveDictationSession>,
}

struct NativeRecorderRuntime {
    command_tx: mpsc::Sender<NativeRecorderCommand>,
}

struct NativeRecorderStartCommand {
    app: AppHandle,
    req: StartNativeVoiceRecordingRequest,
    state: Arc<Mutex<NativeRecorderState>>,
    response_tx: mpsc::SyncSender<Result<NativeRecorderThreadInfo, String>>,
    deadline: Instant,
}

enum NativeRecorderCommand {
    Start(Box<NativeRecorderStartCommand>),
    Stop {
        response_tx: mpsc::Sender<Result<(), String>>,
    },
    #[cfg(test)]
    Probe {
        response_tx: mpsc::Sender<std::thread::ThreadId>,
    },
    #[cfg(test)]
    Shutdown,
}

struct NativeRecorderThreadInfo {
    source_sample_rate: u32,
    source_channels: u16,
    device_name: String,
    live_session: Option<LiveDictationSession>,
}

type NativeRecorderOwnerParts = (
    mpsc::Sender<NativeRecorderCommand>,
    mpsc::Receiver<()>,
    std::thread::JoinHandle<()>,
);

#[derive(Default)]
struct NativeRecorderState {
    samples: Vec<f32>,
    paused: bool,
    max_samples: Option<usize>,
    limit_reached: bool,
}

struct PcmStats {
    peak: f32,
    rms: f32,
}

fn recorder_slot() -> &'static Mutex<Option<NativeVoiceRecorder>> {
    RECORDER.get_or_init(|| Mutex::new(None))
}

fn recorder_runtime() -> Result<&'static NativeRecorderRuntime, String> {
    match RECORDER_RUNTIME.get_or_init(NativeRecorderRuntime::spawn) {
        Ok(runtime) => Ok(runtime),
        Err(err) => Err(err.clone()),
    }
}

pub fn init() -> Result<(), String> {
    recorder_runtime().map(|_| ())
}

pub fn is_active() -> bool {
    recorder_slot()
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
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

fn select_input_device(
    host: &cpal::Host,
    device_label: Option<&str>,
) -> Result<cpal::Device, String> {
    if let Some(label) = device_label
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let label_lower = label.to_lowercase();
        match host.input_devices() {
            Ok(devices) => {
                for device in devices {
                    let Ok(name) = device.name() else {
                        continue;
                    };
                    if name == label || name.to_lowercase() == label_lower {
                        logger::log_info(
                            "NATIVE_RECORDER",
                            &format!("Using selected native input device: {}", name),
                        );
                        return Ok(device);
                    }
                }
            }
            Err(err) => {
                logger::log_error(
                    "NATIVE_RECORDER",
                    &format!("Failed to list native input devices: {}", err),
                );
                return Err(format!(
                    "Не удалось найти выбранный микрофон для нативной записи: {}",
                    err
                ));
            }
        }

        return Err(format!(
            "Выбранный микрофон недоступен для нативной записи: {}",
            label
        ));
    }

    host.default_input_device()
        .ok_or_else(|| "Системный микрофон не найден.".to_string())
}

fn append_samples(
    state: &Arc<Mutex<NativeRecorderState>>,
    channels: usize,
    samples: &[f32],
    live_feeder: Option<&LiveDictationFeeder>,
) {
    if channels == 0 {
        return;
    }

    let mut live_samples = Vec::new();
    {
        let mut guard = match state.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        if guard.paused {
            return;
        }

        if let Some(max_samples) = guard.max_samples {
            if guard.samples.len() >= max_samples {
                guard.limit_reached = true;
                return;
            }
        }

        let remaining_samples = guard
            .max_samples
            .map(|max_samples| max_samples.saturating_sub(guard.samples.len()))
            .unwrap_or(samples.len() / channels);
        guard
            .samples
            .reserve((samples.len() / channels).min(remaining_samples));
        live_samples.reserve((samples.len() / channels).min(remaining_samples));
        for frame in samples.chunks(channels) {
            if let Some(max_samples) = guard.max_samples {
                if guard.samples.len() >= max_samples {
                    guard.limit_reached = true;
                    break;
                }
            }

            let mut sum = 0.0;
            for sample in frame {
                sum += *sample;
            }
            let mono = sum / frame.len().max(1) as f32;
            guard.samples.push(mono);
            live_samples.push(mono);
        }
    }

    if let Some(feeder) = live_feeder {
        live_dictation::feed_source_samples(feeder, &live_samples);
    }
}

fn append_f32_samples(
    state: &Arc<Mutex<NativeRecorderState>>,
    channels: usize,
    data: &[f32],
    live_feeder: Option<&LiveDictationFeeder>,
) {
    append_samples(state, channels, data, live_feeder);
}

fn append_i16_samples(
    state: &Arc<Mutex<NativeRecorderState>>,
    channels: usize,
    data: &[i16],
    live_feeder: Option<&LiveDictationFeeder>,
) {
    if channels == 0 {
        return;
    }

    let mut live_samples = Vec::new();
    {
        let mut guard = match state.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        if guard.paused {
            return;
        }

        if let Some(max_samples) = guard.max_samples {
            if guard.samples.len() >= max_samples {
                guard.limit_reached = true;
                return;
            }
        }

        let remaining_samples = guard
            .max_samples
            .map(|max_samples| max_samples.saturating_sub(guard.samples.len()))
            .unwrap_or(data.len() / channels);
        guard
            .samples
            .reserve((data.len() / channels).min(remaining_samples));
        live_samples.reserve((data.len() / channels).min(remaining_samples));
        for frame in data.chunks(channels) {
            if let Some(max_samples) = guard.max_samples {
                if guard.samples.len() >= max_samples {
                    guard.limit_reached = true;
                    break;
                }
            }

            let mut sum = 0.0;
            for sample in frame {
                sum += *sample as f32 / i16::MAX as f32;
            }
            let mono = sum / frame.len().max(1) as f32;
            guard.samples.push(mono);
            live_samples.push(mono);
        }
    }

    if let Some(feeder) = live_feeder {
        live_dictation::feed_source_samples(feeder, &live_samples);
    }
}

fn append_u16_samples(
    state: &Arc<Mutex<NativeRecorderState>>,
    channels: usize,
    data: &[u16],
    live_feeder: Option<&LiveDictationFeeder>,
) {
    if channels == 0 {
        return;
    }

    let mut live_samples = Vec::new();
    {
        let mut guard = match state.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        if guard.paused {
            return;
        }

        if let Some(max_samples) = guard.max_samples {
            if guard.samples.len() >= max_samples {
                guard.limit_reached = true;
                return;
            }
        }

        let remaining_samples = guard
            .max_samples
            .map(|max_samples| max_samples.saturating_sub(guard.samples.len()))
            .unwrap_or(data.len() / channels);
        guard
            .samples
            .reserve((data.len() / channels).min(remaining_samples));
        live_samples.reserve((data.len() / channels).min(remaining_samples));
        for frame in data.chunks(channels) {
            if let Some(max_samples) = guard.max_samples {
                if guard.samples.len() >= max_samples {
                    guard.limit_reached = true;
                    break;
                }
            }

            let mut sum = 0.0;
            for sample in frame {
                sum += (*sample as f32 - 32_768.0) / 32_768.0;
            }
            let mono = sum / frame.len().max(1) as f32;
            guard.samples.push(mono);
            live_samples.push(mono);
        }
    }

    if let Some(feeder) = live_feeder {
        live_dictation::feed_source_samples(feeder, &live_samples);
    }
}

fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    state: Arc<Mutex<NativeRecorderState>>,
    live_feeder: Option<LiveDictationFeeder>,
) -> Result<cpal::Stream, String> {
    let channels = config.channels as usize;
    if channels == 0 {
        return Err("Микрофон вернул аудиоформат без каналов.".to_string());
    }

    let err_fn = |err| {
        logger::log_error(
            "NATIVE_RECORDER",
            &format!("Native input stream error: {}", err),
        );
    };

    match sample_format {
        cpal::SampleFormat::F32 => {
            let live_feeder = live_feeder.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[f32], _| {
                        append_f32_samples(&state, channels, data, live_feeder.as_ref())
                    },
                    err_fn,
                    None,
                )
                .map_err(|err| format!("Не удалось открыть микрофон: {}", err))
        }
        cpal::SampleFormat::I16 => {
            let live_feeder = live_feeder.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[i16], _| {
                        append_i16_samples(&state, channels, data, live_feeder.as_ref())
                    },
                    err_fn,
                    None,
                )
                .map_err(|err| format!("Не удалось открыть микрофон: {}", err))
        }
        cpal::SampleFormat::U16 => {
            let live_feeder = live_feeder.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[u16], _| {
                        append_u16_samples(&state, channels, data, live_feeder.as_ref())
                    },
                    err_fn,
                    None,
                )
                .map_err(|err| format!("Не удалось открыть микрофон: {}", err))
        }
        other => Err(format!(
            "Нативная запись пока не поддерживает формат микрофона {:?}.",
            other
        )),
    }
}

fn resample_linear(input: &[f32], source_sample_rate: u32) -> Vec<f32> {
    if input.is_empty() || source_sample_rate == 0 {
        return Vec::new();
    }

    if source_sample_rate == TARGET_SAMPLE_RATE {
        return input.to_vec();
    }

    let ratio = source_sample_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let output_len = ((input.len() as f64) / ratio).round().max(1.0) as usize;
    let mut output = Vec::with_capacity(output_len);

    for output_index in 0..output_len {
        let source_pos = output_index as f64 * ratio;
        let index = source_pos.floor() as usize;
        let frac = (source_pos - index as f64) as f32;
        let current = input.get(index).copied().unwrap_or(0.0);
        let next = input.get(index + 1).copied().unwrap_or(current);
        output.push(current + (next - current) * frac);
    }

    output
}

fn normalize_to_i16(samples: &[f32]) -> (Vec<i16>, PcmStats) {
    if samples.is_empty() {
        return (
            Vec::new(),
            PcmStats {
                peak: 0.0,
                rms: 0.0,
            },
        );
    }

    let mean = samples.iter().copied().sum::<f32>() / samples.len() as f32;
    let mut peak: f32 = 0.0;

    for sample in samples {
        let centered = *sample - mean;
        peak = peak.max(centered.abs());
    }

    let gain = if peak > PCM_MIN_SIGNAL_PEAK && peak < PCM_NORMALIZE_BELOW_PEAK {
        (PCM_TARGET_PEAK / peak).min(PCM_MAX_GAIN)
    } else {
        1.0
    };

    let mut normalized_peak: f32 = 0.0;
    let mut normalized_sum_squares = 0.0_f64;
    let mut pcm = Vec::with_capacity(samples.len());
    for sample in samples {
        let normalized = ((*sample - mean) * gain).clamp(-1.0, 1.0);
        normalized_peak = normalized_peak.max(normalized.abs());
        normalized_sum_squares += (normalized as f64) * (normalized as f64);
        let value = if normalized < 0.0 {
            normalized * 32_768.0
        } else {
            normalized * 32_767.0
        };
        pcm.push(value.round() as i16);
    }

    let rms = (normalized_sum_squares / samples.len() as f64).sqrt() as f32;
    (
        pcm,
        PcmStats {
            peak: normalized_peak,
            rms,
        },
    )
}

fn write_wav_bytes(samples: &[i16]) -> Result<Vec<u8>, String> {
    let path = unique_temp_path("native-voice-recording", "wav");
    let spec = hound::WavSpec {
        channels: TARGET_CHANNELS,
        sample_rate: TARGET_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let write_result = (|| -> Result<(), String> {
        let mut writer = hound::WavWriter::create(&path, spec)
            .map_err(|err| format!("Не удалось создать WAV запись: {}", err))?;
        for sample in samples {
            writer
                .write_sample(*sample)
                .map_err(|err| format!("Не удалось записать WAV sample: {}", err))?;
        }
        writer
            .finalize()
            .map_err(|err| format!("Не удалось завершить WAV запись: {}", err))
    })();

    if let Err(err) = write_result {
        let _ = fs::remove_file(&path);
        return Err(err);
    }

    let bytes = fs::read(&path).map_err(|err| {
        let _ = fs::remove_file(&path);
        format!("Не удалось прочитать WAV запись: {}", err)
    })?;
    let _ = fs::remove_file(&path);
    Ok(bytes)
}

fn open_native_input_stream(
    app: AppHandle,
    req: StartNativeVoiceRecordingRequest,
    state: Arc<Mutex<NativeRecorderState>>,
) -> Result<(cpal::Stream, NativeRecorderThreadInfo), String> {
    logger::log_info(
        "NATIVE_RECORDER",
        &format!(
            "Opening native input on persistent owner thread: requested_device={}",
            req.device_label.as_deref().unwrap_or("[system-default]")
        ),
    );
    let host = cpal::default_host();
    let device = select_input_device(&host, req.device_label.as_deref())?;
    let device_name = device
        .name()
        .unwrap_or_else(|_| "default input".to_string());
    logger::log_info(
        "NATIVE_RECORDER",
        &format!("Native input resolved: device={device_name}; querying format"),
    );
    let supported_config = device
        .default_input_config()
        .map_err(|err| format!("Не удалось получить формат микрофона: {}", err))?;
    let sample_format = supported_config.sample_format();
    let config: cpal::StreamConfig = supported_config.into();
    let source_sample_rate = config.sample_rate.0;
    let source_channels = config.channels;
    {
        let mut guard = state
            .lock()
            .map_err(|_| "Не удалось настроить лимит нативной записи.".to_string())?;
        guard.max_samples = Some(source_sample_rate as usize * MAX_NATIVE_RECORDING_SECONDS);
        guard.limit_reached = false;
    }
    let live_session = live_dictation::start_live_dictation_session(
        app,
        req.live_dictation.clone(),
        source_sample_rate,
    );
    let live_feeder = live_session.as_ref().map(LiveDictationSession::feeder);
    logger::log_info(
        "NATIVE_RECORDER",
        &format!("Building native input stream: sample_rate={source_sample_rate}, channels={source_channels}"),
    );
    let stream = match build_input_stream(
        &device,
        &config,
        sample_format,
        Arc::clone(&state),
        live_feeder,
    ) {
        Ok(stream) => stream,
        Err(err) => {
            if let Some(session) = live_session {
                live_dictation::cancel_live_dictation_session(session);
            }
            return Err(err);
        }
    };

    if let Err(err) = stream.play() {
        if let Some(session) = live_session {
            live_dictation::cancel_live_dictation_session(session);
        }
        return Err(format!("Не удалось запустить нативную запись: {}", err));
    }

    logger::log_info(
        "NATIVE_RECORDER",
        &format!(
            "Native voice recorder started: device={}, source_sample_rate={}, channels={}, sample_format={:?}",
            device_name, source_sample_rate, source_channels, sample_format
        ),
    );

    Ok((
        stream,
        NativeRecorderThreadInfo {
            source_sample_rate,
            source_channels,
            device_name,
            live_session,
        },
    ))
}

fn drop_native_input_stream(stream: cpal::Stream) -> Result<(), String> {
    catch_unwind(AssertUnwindSafe(|| drop(stream)))
        .map_err(|_| "Нативный аудиодрайвер аварийно завершил остановку записи.".to_string())
}

#[cfg(windows)]
fn warm_up_windows_wasapi_owner() {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let host = cpal::default_host();
        host.default_input_device().is_some()
    }));

    match result {
        Ok(has_default_input) => logger::log_info(
            "NATIVE_RECORDER",
            &format!(
                "Persistent WASAPI owner initialized: default_input_present={}",
                has_default_input
            ),
        ),
        Err(_) => logger::log_error(
            "NATIVE_RECORDER",
            "WASAPI owner warm-up panicked; keeping the owner thread alive for safe fallback",
        ),
    }
}

fn run_native_recorder_owner(
    command_rx: mpsc::Receiver<NativeRecorderCommand>,
    ready_tx: mpsc::Sender<()>,
    warm_up_audio_owner: bool,
) {
    logger::log_info(
        "NATIVE_RECORDER",
        "Persistent native recorder owner started",
    );
    #[cfg(windows)]
    if warm_up_audio_owner {
        warm_up_windows_wasapi_owner();
    }
    #[cfg(not(windows))]
    let _ = warm_up_audio_owner;
    let _ = ready_tx.send(());

    let mut active_stream: Option<cpal::Stream> = None;
    while let Ok(command) = command_rx.recv() {
        match command {
            NativeRecorderCommand::Start(command) => {
                let NativeRecorderStartCommand {
                    app,
                    req,
                    state,
                    response_tx,
                    deadline,
                } = *command;
                if Instant::now() >= deadline {
                    logger::log_info(
                        "NATIVE_RECORDER",
                        "Skipping expired native recording request",
                    );
                    continue;
                }

                if active_stream.is_some() {
                    let _ = response_tx.send(Err("Запись уже идёт.".to_string()));
                    continue;
                }

                let start_result = catch_unwind(AssertUnwindSafe(|| {
                    open_native_input_stream(app, req, state)
                }))
                .unwrap_or_else(|_| {
                    Err("Нативный аудиодрайвер аварийно завершил запуск записи.".to_string())
                });

                match start_result {
                    Ok((stream, info)) => match response_tx.send(Ok(info)) {
                        Ok(()) => active_stream = Some(stream),
                        Err(send_error) => {
                            if let Ok(info) = send_error.0 {
                                if let Some(session) = info.live_session {
                                    live_dictation::cancel_live_dictation_session(session);
                                }
                            }
                            if let Err(err) = drop_native_input_stream(stream) {
                                logger::log_error("NATIVE_RECORDER", &err);
                            }
                        }
                    },
                    Err(err) => {
                        logger::log_error(
                            "NATIVE_RECORDER",
                            &format!("Native recorder owner failed to start stream: {}", err),
                        );
                        let _ = response_tx.send(Err(err));
                    }
                }
            }
            NativeRecorderCommand::Stop { response_tx } => {
                let result = active_stream
                    .take()
                    .ok_or_else(|| "Активная нативная запись не найдена.".to_string())
                    .and_then(drop_native_input_stream);
                if let Err(err) = &result {
                    logger::log_error(
                        "NATIVE_RECORDER",
                        &format!("Native recorder owner failed to stop stream: {}", err),
                    );
                }
                let _ = response_tx.send(result);
            }
            #[cfg(test)]
            NativeRecorderCommand::Probe { response_tx } => {
                let _ = response_tx.send(std::thread::current().id());
            }
            #[cfg(test)]
            NativeRecorderCommand::Shutdown => break,
        }
    }

    if let Some(stream) = active_stream.take() {
        if let Err(err) = drop_native_input_stream(stream) {
            logger::log_error("NATIVE_RECORDER", &err);
        }
    }
    logger::log_info(
        "NATIVE_RECORDER",
        "Persistent native recorder owner stopped",
    );
}

fn spawn_native_recorder_owner(
    warm_up_audio_owner: bool,
) -> Result<NativeRecorderOwnerParts, String> {
    let (command_tx, command_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread_handle = std::thread::Builder::new()
        .name("talkis-native-voice-owner".to_string())
        .spawn(move || run_native_recorder_owner(command_rx, ready_tx, warm_up_audio_owner))
        .map_err(|err| format!("Не удалось создать поток нативной записи: {}", err))?;
    Ok((command_tx, ready_rx, thread_handle))
}

impl NativeRecorderRuntime {
    fn spawn() -> Result<Self, String> {
        let (command_tx, ready_rx, thread_handle) = spawn_native_recorder_owner(true)?;
        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(()) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => logger::log_error(
                "NATIVE_RECORDER",
                "Persistent native recorder owner warm-up exceeded 3 seconds",
            ),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = thread_handle.join();
                return Err("Поток нативной записи завершился при запуске.".to_string());
            }
        }
        drop(thread_handle);
        Ok(Self { command_tx })
    }

    fn start(
        &self,
        app: AppHandle,
        req: StartNativeVoiceRecordingRequest,
        state: Arc<Mutex<NativeRecorderState>>,
    ) -> Result<NativeRecorderThreadInfo, String> {
        // A rendezvous hands stream ownership over only when the caller receives
        // the result. A response arriving after timeout must drop the stream.
        let (response_tx, response_rx) = mpsc::sync_channel(0);
        self.command_tx
            .send(NativeRecorderCommand::Start(Box::new(
                NativeRecorderStartCommand {
                    app,
                    req,
                    state,
                    response_tx,
                    deadline: Instant::now() + NATIVE_START_TIMEOUT,
                },
            )))
            .map_err(|_| "Поток нативной записи недоступен.".to_string())?;
        let result = startup::wait_for_start(response_rx, NATIVE_START_TIMEOUT);
        if let Err(err) = &result {
            logger::log_error(
                "NATIVE_RECORDER",
                &format!("Native recording start failed: {err}"),
            );
        }

        result
    }

    fn stop(&self) -> Result<(), String> {
        let (response_tx, response_rx) = mpsc::channel();
        self.command_tx
            .send(NativeRecorderCommand::Stop { response_tx })
            .map_err(|_| "Не удалось остановить поток нативной записи.".to_string())?;
        match response_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("Нативная запись не остановилась вовремя.".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                logger::log_error(
                    "NATIVE_RECORDER",
                    "Native recorder owner ended before stop acknowledgement",
                );
                Ok(())
            }
        }
    }
}

#[tauri::command]
pub async fn start_native_voice_recording(
    app: AppHandle,
    req: StartNativeVoiceRecordingRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start_recording(app, req))
        .await
        .map_err(|err| format!("Не удалось запустить нативную запись: {err}"))?
}

fn start_recording(app: AppHandle, req: StartNativeVoiceRecordingRequest) -> Result<(), String> {
    if crate::live_translation::is_active() {
        return Err("Сначала остановите синхронный перевод.".to_string());
    }
    let mut guard = recorder_slot()
        .lock()
        .map_err(|_| "Не удалось заблокировать нативную запись.".to_string())?;
    if guard.is_some() {
        return Err("Запись уже идёт.".to_string());
    }

    let state = Arc::new(Mutex::new(NativeRecorderState::default()));
    let info = recorder_runtime()?.start(app, req, Arc::clone(&state))?;

    *guard = Some(NativeVoiceRecorder {
        state,
        source_sample_rate: info.source_sample_rate,
        source_channels: info.source_channels,
        device_name: info.device_name,
        live_session: info.live_session,
    });

    Ok(())
}

#[tauri::command]
pub fn pause_native_voice_recording() -> Result<(), String> {
    let guard = recorder_slot()
        .lock()
        .map_err(|_| "Не удалось заблокировать нативную запись.".to_string())?;
    let recorder = guard
        .as_ref()
        .ok_or_else(|| "Активная нативная запись не найдена.".to_string())?;
    let mut state = recorder
        .state
        .lock()
        .map_err(|_| "Не удалось поставить нативную запись на паузу.".to_string())?;
    state.paused = true;
    logger::log_info("NATIVE_RECORDER", "Native voice recorder paused");
    Ok(())
}

#[tauri::command]
pub fn resume_native_voice_recording() -> Result<(), String> {
    let guard = recorder_slot()
        .lock()
        .map_err(|_| "Не удалось заблокировать нативную запись.".to_string())?;
    let recorder = guard
        .as_ref()
        .ok_or_else(|| "Активная нативная запись не найдена.".to_string())?;
    let mut state = recorder
        .state
        .lock()
        .map_err(|_| "Не удалось продолжить нативную запись.".to_string())?;
    state.paused = false;
    logger::log_info("NATIVE_RECORDER", "Native voice recorder resumed");
    Ok(())
}

#[tauri::command]
pub async fn stop_native_voice_recording() -> Result<NativeVoiceRecordingResult, String> {
    tauri::async_runtime::spawn_blocking(stop_recording)
        .await
        .map_err(|err| format!("Не удалось завершить нативную запись: {err}"))?
}

fn stop_recording() -> Result<NativeVoiceRecordingResult, String> {
    let recorder = recorder_slot()
        .lock()
        .map_err(|_| "Не удалось заблокировать нативную запись.".to_string())?
        .take()
        .ok_or_else(|| "Активная нативная запись не найдена.".to_string())?;

    let source_sample_rate = recorder.source_sample_rate;
    let source_channels = recorder.source_channels;
    let device_name = recorder.device_name.clone();
    let live_session = recorder.live_session;
    let state = Arc::clone(&recorder.state);
    logger::log_info(
        "NATIVE_RECORDER",
        "Stopping native input stream on persistent owner",
    );
    recorder_runtime()?.stop()?;

    let (source_samples, limit_reached) = {
        let mut guard = state
            .lock()
            .map_err(|_| "Не удалось прочитать нативную запись.".to_string())?;
        (std::mem::take(&mut guard.samples), guard.limit_reached)
    };
    let live_transcription = live_session.and_then(|session| {
        match live_dictation::finish_live_dictation_session(session) {
            Ok(result) => {
                logger::log_info(
                    "LIVE_DICTATION",
                    &format!(
                        "Live dictation finalized: request_id={}, chars={}",
                        result.request_id,
                        result.text.chars().count()
                    ),
                );
                Some(result)
            }
            Err(err) => {
                logger::log_error(
                    "LIVE_DICTATION",
                    &format!(
                        "Live dictation failed, full-audio transcription fallback will be used: {}",
                        err
                    ),
                );
                None
            }
        }
    });
    let resampled = resample_linear(&source_samples, source_sample_rate);
    let (pcm_samples, stats) = normalize_to_i16(&resampled);
    let wav_bytes = write_wav_bytes(&pcm_samples)?;
    let duration_ms =
        ((pcm_samples.len() as f64 / TARGET_SAMPLE_RATE as f64) * 1000.0).round() as u64;

    logger::log_info(
        "NATIVE_RECORDER",
        &format!(
            "Native voice recorder stopped: device={}, source_sample_rate={}, source_channels={}, source_samples={}, duration_ms={}, sample_rate={}, channels={}, peak={:.4}, rms={:.4}, limit_reached={}",
            device_name,
            source_sample_rate,
            source_channels,
            source_samples.len(),
            duration_ms,
            TARGET_SAMPLE_RATE,
            TARGET_CHANNELS,
            stats.peak,
            stats.rms,
            limit_reached
        ),
    );

    Ok(NativeVoiceRecordingResult {
        audio_base64: base64::engine::general_purpose::STANDARD.encode(wav_bytes),
        mime_type: "audio/wav".to_string(),
        file_name: "recording.wav".to_string(),
        duration_ms,
        sample_rate: TARGET_SAMPLE_RATE,
        channels: TARGET_CHANNELS,
        peak: stats.peak,
        rms: stats.rms,
        live_transcription,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe_owner_thread(
        command_tx: &mpsc::Sender<NativeRecorderCommand>,
    ) -> std::thread::ThreadId {
        let (response_tx, response_rx) = mpsc::channel();
        command_tx
            .send(NativeRecorderCommand::Probe { response_tx })
            .expect("owner command channel");
        response_rx.recv().expect("owner probe response")
    }

    #[test]
    fn sequential_commands_reuse_one_long_lived_owner_thread() {
        let (command_tx, ready_rx, thread_handle) =
            spawn_native_recorder_owner(false).expect("native recorder owner");
        ready_rx.recv().expect("native recorder owner ready");

        let first_thread = probe_owner_thread(&command_tx);
        let second_thread = probe_owner_thread(&command_tx);

        assert_eq!(first_thread, second_thread);
        command_tx
            .send(NativeRecorderCommand::Shutdown)
            .expect("owner shutdown command");
        thread_handle.join().expect("owner thread shutdown");
    }
}
