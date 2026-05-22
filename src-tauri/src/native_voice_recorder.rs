use crate::logger;
use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const TARGET_CHANNELS: u16 = 1;
const PCM_TARGET_PEAK: f32 = 0.82;
const PCM_NORMALIZE_BELOW_PEAK: f32 = 0.35;
const PCM_MIN_SIGNAL_PEAK: f32 = 0.001;
const PCM_MAX_GAIN: f32 = 8.0;

static RECORDER: OnceLock<Mutex<Option<NativeVoiceRecorder>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartNativeVoiceRecordingRequest {
    pub device_label: Option<String>,
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
}

struct NativeVoiceRecorder {
    state: Arc<Mutex<NativeRecorderState>>,
    stop_tx: mpsc::Sender<()>,
    stopped_rx: mpsc::Receiver<Result<(), String>>,
    source_sample_rate: u32,
    source_channels: u16,
    device_name: String,
}

struct NativeRecorderThreadInfo {
    source_sample_rate: u32,
    source_channels: u16,
    device_name: String,
}

#[derive(Default)]
struct NativeRecorderState {
    samples: Vec<f32>,
    paused: bool,
}

struct PcmStats {
    peak: f32,
    rms: f32,
}

fn recorder_slot() -> &'static Mutex<Option<NativeVoiceRecorder>> {
    RECORDER.get_or_init(|| Mutex::new(None))
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

fn append_samples(state: &Arc<Mutex<NativeRecorderState>>, channels: usize, samples: &[f32]) {
    if channels == 0 {
        return;
    }

    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    if guard.paused {
        return;
    }

    guard.samples.reserve(samples.len() / channels);
    for frame in samples.chunks(channels) {
        let mut sum = 0.0;
        for sample in frame {
            sum += *sample;
        }
        guard.samples.push(sum / frame.len().max(1) as f32);
    }
}

fn append_f32_samples(state: &Arc<Mutex<NativeRecorderState>>, channels: usize, data: &[f32]) {
    append_samples(state, channels, data);
}

fn append_i16_samples(state: &Arc<Mutex<NativeRecorderState>>, channels: usize, data: &[i16]) {
    if channels == 0 {
        return;
    }

    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    if guard.paused {
        return;
    }

    guard.samples.reserve(data.len() / channels);
    for frame in data.chunks(channels) {
        let mut sum = 0.0;
        for sample in frame {
            sum += *sample as f32 / i16::MAX as f32;
        }
        guard.samples.push(sum / frame.len().max(1) as f32);
    }
}

fn append_u16_samples(state: &Arc<Mutex<NativeRecorderState>>, channels: usize, data: &[u16]) {
    if channels == 0 {
        return;
    }

    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    if guard.paused {
        return;
    }

    guard.samples.reserve(data.len() / channels);
    for frame in data.chunks(channels) {
        let mut sum = 0.0;
        for sample in frame {
            sum += (*sample as f32 - 32_768.0) / 32_768.0;
        }
        guard.samples.push(sum / frame.len().max(1) as f32);
    }
}

fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    state: Arc<Mutex<NativeRecorderState>>,
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
        cpal::SampleFormat::F32 => device
            .build_input_stream(
                config,
                move |data: &[f32], _| append_f32_samples(&state, channels, data),
                err_fn,
                None,
            )
            .map_err(|err| format!("Не удалось открыть микрофон: {}", err)),
        cpal::SampleFormat::I16 => device
            .build_input_stream(
                config,
                move |data: &[i16], _| append_i16_samples(&state, channels, data),
                err_fn,
                None,
            )
            .map_err(|err| format!("Не удалось открыть микрофон: {}", err)),
        cpal::SampleFormat::U16 => device
            .build_input_stream(
                config,
                move |data: &[u16], _| append_u16_samples(&state, channels, data),
                err_fn,
                None,
            )
            .map_err(|err| format!("Не удалось открыть микрофон: {}", err)),
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

fn run_recorder_thread(
    req: StartNativeVoiceRecordingRequest,
    state: Arc<Mutex<NativeRecorderState>>,
    started_tx: mpsc::Sender<Result<NativeRecorderThreadInfo, String>>,
    stop_rx: mpsc::Receiver<()>,
    stopped_tx: mpsc::Sender<Result<(), String>>,
) {
    let start_result = (|| -> Result<(cpal::Stream, NativeRecorderThreadInfo), String> {
        let host = cpal::default_host();
        let device = select_input_device(&host, req.device_label.as_deref())?;
        let device_name = device
            .name()
            .unwrap_or_else(|_| "default input".to_string());
        let supported_config = device
            .default_input_config()
            .map_err(|err| format!("Не удалось получить формат микрофона: {}", err))?;
        let sample_format = supported_config.sample_format();
        let config: cpal::StreamConfig = supported_config.into();
        let source_sample_rate = config.sample_rate.0;
        let source_channels = config.channels;
        let stream = build_input_stream(&device, &config, sample_format, Arc::clone(&state))?;

        stream
            .play()
            .map_err(|err| format!("Не удалось запустить нативную запись: {}", err))?;

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
            },
        ))
    })();

    let (stream, info) = match start_result {
        Ok(value) => value,
        Err(err) => {
            let _ = started_tx.send(Err(err));
            return;
        }
    };

    if started_tx.send(Ok(info)).is_err() {
        drop(stream);
        return;
    }

    let _ = stop_rx.recv();
    drop(stream);
    let _ = stopped_tx.send(Ok(()));
}

#[tauri::command]
pub fn start_native_voice_recording(req: StartNativeVoiceRecordingRequest) -> Result<(), String> {
    let mut guard = recorder_slot()
        .lock()
        .map_err(|_| "Не удалось заблокировать нативную запись.".to_string())?;
    if guard.is_some() {
        return Err("Запись уже идёт.".to_string());
    }

    let state = Arc::new(Mutex::new(NativeRecorderState::default()));
    let (started_tx, started_rx) = mpsc::channel();
    let (stop_tx, stop_rx) = mpsc::channel();
    let (stopped_tx, stopped_rx) = mpsc::channel();
    let thread_state = Arc::clone(&state);
    std::thread::Builder::new()
        .name("talkis-native-voice-recorder".to_string())
        .spawn(move || run_recorder_thread(req, thread_state, started_tx, stop_rx, stopped_tx))
        .map_err(|err| format!("Не удалось создать поток нативной записи: {}", err))?;

    let info = started_rx
        .recv()
        .map_err(|_| "Нативная запись завершилась до запуска.".to_string())??;

    *guard = Some(NativeVoiceRecorder {
        state,
        stop_tx,
        stopped_rx,
        source_sample_rate: info.source_sample_rate,
        source_channels: info.source_channels,
        device_name: info.device_name,
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
pub fn stop_native_voice_recording() -> Result<NativeVoiceRecordingResult, String> {
    let recorder = recorder_slot()
        .lock()
        .map_err(|_| "Не удалось заблокировать нативную запись.".to_string())?
        .take()
        .ok_or_else(|| "Активная нативная запись не найдена.".to_string())?;

    let source_sample_rate = recorder.source_sample_rate;
    let source_channels = recorder.source_channels;
    let device_name = recorder.device_name.clone();
    let state = Arc::clone(&recorder.state);
    recorder
        .stop_tx
        .send(())
        .map_err(|_| "Не удалось остановить поток нативной записи.".to_string())?;
    match recorder.stopped_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => {}
        Ok(Err(err)) => return Err(err),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err("Нативная запись не остановилась вовремя.".to_string());
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            logger::log_error(
                "NATIVE_RECORDER",
                "Native recorder thread ended before stop acknowledgement",
            );
        }
    }

    let source_samples = {
        let mut guard = state
            .lock()
            .map_err(|_| "Не удалось прочитать нативную запись.".to_string())?;
        std::mem::take(&mut guard.samples)
    };
    let resampled = resample_linear(&source_samples, source_sample_rate);
    let (pcm_samples, stats) = normalize_to_i16(&resampled);
    let wav_bytes = write_wav_bytes(&pcm_samples)?;
    let duration_ms =
        ((pcm_samples.len() as f64 / TARGET_SAMPLE_RATE as f64) * 1000.0).round() as u64;

    logger::log_info(
        "NATIVE_RECORDER",
        &format!(
            "Native voice recorder stopped: device={}, source_sample_rate={}, source_channels={}, source_samples={}, duration_ms={}, sample_rate={}, channels={}, peak={:.4}, rms={:.4}",
            device_name,
            source_sample_rate,
            source_channels,
            source_samples.len(),
            duration_ms,
            TARGET_SAMPLE_RATE,
            TARGET_CHANNELS,
            stats.peak,
            stats.rms
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
    })
}
