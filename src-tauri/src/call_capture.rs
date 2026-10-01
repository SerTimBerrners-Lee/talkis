mod microphone;

use crate::live_dictation::{
    self, LiveDictationFinal, LiveDictationSession, LiveDictationStartRequest,
};
use crate::logger;
use crate::realtime::RealtimeAudioCommand;
use base64::Engine;
use chrono::{DateTime, Utc};
#[cfg(target_os = "windows")]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use std::io::BufWriter;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::ptr::NonNull;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::sync::Arc;
use std::sync::{mpsc, Mutex, OnceLock};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use objc2::AnyThread;
#[cfg(target_os = "macos")]
use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceIsStackedKey,
    kAudioAggregateDeviceNameKey, kAudioAggregateDeviceTapAutoStartKey,
    kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey,
    kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioSubTapDriftCompensationKey,
    kAudioSubTapUIDKey, kAudioTapPropertyFormat, AudioDeviceCreateIOProcID,
    AudioDeviceDestroyIOProcID, AudioDeviceIOProc, AudioDeviceIOProcID, AudioDeviceStart,
    AudioDeviceStop, AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
    AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap,
    AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress,
    AudioObjectPropertySelector, CATapDescription, CATapMuteBehavior,
};
#[cfg(target_os = "macos")]
use objc2_core_audio_types::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, kAudioFormatFlagIsSignedInteger,
    kAudioFormatLinearPCM, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp,
};
#[cfg(target_os = "macos")]
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFRetained, CFString, CFType, Type};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSNumber, NSString, NSUUID};
#[cfg(target_os = "linux")]
use pipewire as pw;
#[cfg(target_os = "linux")]
use pw::{properties::properties, spa};

static SESSIONS: OnceLock<Mutex<HashMap<String, StoredCallCaptureSession>>> = OnceLock::new();
static SESSION_DIRECTORIES: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
static SYSTEM_AUDIO_SINK: OnceLock<Mutex<Option<tokio::sync::mpsc::Sender<RealtimeAudioCommand>>>> =
    OnceLock::new();
static SYSTEM_AUDIO_MONITOR_SINK: OnceLock<Mutex<Option<mpsc::SyncSender<Vec<u8>>>>> =
    OnceLock::new();
#[cfg(target_os = "macos")]
static REQUIRE_SELF_AUDIO_EXCLUSION: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static MUTE_CAPTURED_SYSTEM_AUDIO: AtomicBool = AtomicBool::new(false);
const CALL_SYSTEM_CAPTURE_SAMPLE_RATE: u32 = 16_000;
const CALL_SYSTEM_CAPTURE_CHANNELS: u16 = 1;
const CALL_SYSTEM_CAPTURE_BITS_PER_SAMPLE: u16 = 16;
const LIVE_PCM_CHUNK_BYTES: usize = (CALL_SYSTEM_CAPTURE_SAMPLE_RATE as usize / 10) * 2;
const AUDIO_CHECKPOINT_SAMPLES: u64 = CALL_SYSTEM_CAPTURE_SAMPLE_RATE as u64 * 5;
const TRANSCRIPT_CHECKPOINT_FILE: &str = "transcript.jsonl";

fn system_audio_sink() -> &'static Mutex<Option<tokio::sync::mpsc::Sender<RealtimeAudioCommand>>> {
    SYSTEM_AUDIO_SINK.get_or_init(|| Mutex::new(None))
}

pub fn set_system_audio_sink(sender: Option<tokio::sync::mpsc::Sender<RealtimeAudioCommand>>) {
    if let Ok(mut sink) = system_audio_sink().lock() {
        *sink = sender;
    }
}

fn system_audio_monitor_sink() -> &'static Mutex<Option<mpsc::SyncSender<Vec<u8>>>> {
    SYSTEM_AUDIO_MONITOR_SINK.get_or_init(|| Mutex::new(None))
}

pub fn set_system_audio_monitor_sink(sender: Option<mpsc::SyncSender<Vec<u8>>>) {
    if let Ok(mut sink) = system_audio_monitor_sink().lock() {
        *sink = sender;
    }
}

pub fn set_require_self_audio_exclusion(required: bool) {
    #[cfg(target_os = "macos")]
    REQUIRE_SELF_AUDIO_EXCLUSION.store(required, Ordering::SeqCst);

    #[cfg(not(target_os = "macos"))]
    let _ = required;
}

pub fn set_mute_captured_system_audio(muted: bool) {
    #[cfg(target_os = "macos")]
    MUTE_CAPTURED_SYSTEM_AUDIO.store(muted, Ordering::SeqCst);

    #[cfg(not(target_os = "macos"))]
    let _ = muted;
}

fn sessions() -> &'static Mutex<HashMap<String, StoredCallCaptureSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_directories() -> &'static Mutex<HashMap<String, PathBuf>> {
    SESSION_DIRECTORIES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn has_active_sessions() -> bool {
    sessions()
        .lock()
        .map(|guard| !guard.is_empty())
        .unwrap_or(false)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    pub id: String,
    pub label: String,
    pub kind: CaptureTargetKind,
    pub platform: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureTargetKind {
    SystemOutput,
    Process,
    Window,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCallCaptureRequest {
    pub target_id: Option<String>,
    #[serde(default = "default_true")]
    pub include_mic: bool,
    #[serde(default = "default_true")]
    pub include_system: bool,
    pub mic_device_id: Option<String>,
    pub mic_device_label: Option<String>,
    pub sample_rate: Option<u32>,
    pub storage_dir: Option<String>,
    #[serde(default = "default_true")]
    pub save_audio: bool,
    #[serde(default = "default_true")]
    pub native_mic_capture: bool,
    pub live_transcription: Option<CallLiveTranscriptionRequest>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallLiveTranscriptionRequest {
    pub mic: Option<LiveDictationStartRequest>,
    pub system: Option<LiveDictationStartRequest>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallLiveTranscriptionState {
    pub mic_request_id: Option<String>,
    pub system_request_id: Option<String>,
    pub mic_text: Option<String>,
    pub system_text: Option<String>,
    #[serde(default)]
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallCaptureSession {
    pub id: String,
    pub platform: String,
    pub status: CallCaptureStatus,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub directory: String,
    pub tracks: Vec<CallCaptureTrack>,
    #[serde(default)]
    pub native_mic_active: bool,
    #[serde(default)]
    pub live_transcription: Option<CallLiveTranscriptionState>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallCaptureTrack {
    pub kind: CallCaptureTrackKind,
    pub label: String,
    pub path: String,
    pub channels: u16,
    pub sample_rate: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioLevel {
    pub max_dbfs: f32,
    pub frames_above_noise_floor: u64,
    pub output_frames_written: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CallCaptureTrackKind {
    Mic,
    System,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CallCaptureStatus {
    Starting,
    Recording,
    Stopped,
    Failed,
}

struct StoredCallCaptureSession {
    session: CallCaptureSession,
    mic: Option<microphone::CallMicrophoneCapture>,
    system_live_session: Option<LiveDictationSession>,
    #[cfg(target_os = "macos")]
    macos: Option<MacosCallCaptureState>,
    #[cfg(target_os = "windows")]
    windows: Option<WindowsCallCaptureState>,
    #[cfg(target_os = "linux")]
    linux: Option<LinuxCallCaptureState>,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
struct MacosCallCaptureState {
    tap_id: AudioObjectID,
    aggregate_device_id: AudioObjectID,
    io_proc_id: AudioDeviceIOProcID,
    callback_state_ptr: usize,
}

#[cfg(target_os = "macos")]
struct MacosAudioWriterState {
    writer: Mutex<SystemAudioWriter<BufWriter<File>>>,
    stream_description: AudioStreamBasicDescription,
}

#[cfg(target_os = "windows")]
/// Wraps a cpal `Stream`, which cpal marks `!Send` for cross-platform uniformity.
/// The WASAPI backend runs its audio work on a dedicated thread; the `Stream` itself
/// is a control handle that is sound to move and drop across threads. Access is
/// additionally serialized through the global `SESSIONS` mutex.
struct SendStream(cpal::Stream);
#[cfg(target_os = "windows")]
// SAFETY: see the SendStream doc comment above.
unsafe impl Send for SendStream {}

#[cfg(target_os = "windows")]
struct WindowsCallCaptureState {
    stream: Option<SendStream>,
    writer: Arc<Mutex<Option<SystemAudioWriter<BufWriter<File>>>>>,
    device_name: String,
    source_sample_rate: u32,
    source_channels: u16,
    sample_format: cpal::SampleFormat,
}

#[cfg(target_os = "linux")]
struct LinuxCallCaptureState {
    stop_tx: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    writer: Arc<Mutex<Option<SystemAudioWriter<BufWriter<File>>>>>,
    source_sample_rate: u32,
    source_channels: u16,
    source_format: String,
    target: String,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
struct SystemAudioResampler {
    source_sample_rate: f64,
    source_frames_seen: u64,
    next_output_source_frame: f64,
    previous_sample: Option<f32>,
    max_abs_sample: f32,
    frames_above_noise_floor: u64,
    output_frames_written: u64,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
impl SystemAudioResampler {
    fn new(source_sample_rate: u32) -> Self {
        Self {
            source_sample_rate: source_sample_rate.max(1) as f64,
            source_frames_seen: 0,
            next_output_source_frame: 0.0,
            previous_sample: None,
            max_abs_sample: 0.0,
            frames_above_noise_floor: 0,
            output_frames_written: 0,
        }
    }

    fn push_source_frame<F>(&mut self, sample: f32, mut write_sample: F)
    where
        F: FnMut(i16),
    {
        let output_step = self.source_sample_rate / CALL_SYSTEM_CAPTURE_SAMPLE_RATE as f64;
        let source_frame = self.source_frames_seen as f64;
        let normalized = sample.clamp(-1.0, 1.0);
        let abs_sample = normalized.abs();
        self.max_abs_sample = self.max_abs_sample.max(abs_sample);
        if abs_sample > 0.001 {
            self.frames_above_noise_floor = self.frames_above_noise_floor.saturating_add(1);
        }

        if let Some(previous) = self.previous_sample {
            let previous_source_frame = (source_frame - 1.0).max(0.0);
            while self.next_output_source_frame <= source_frame {
                let frac =
                    (self.next_output_source_frame - previous_source_frame).clamp(0.0, 1.0) as f32;
                let interpolated = previous + (normalized - previous) * frac;
                write_sample(float_to_pcm_i16(interpolated));
                self.output_frames_written = self.output_frames_written.saturating_add(1);
                self.next_output_source_frame += output_step;
            }
        } else {
            while self.next_output_source_frame <= source_frame {
                write_sample(float_to_pcm_i16(normalized));
                self.output_frames_written = self.output_frames_written.saturating_add(1);
                self.next_output_source_frame += output_step;
            }
        }

        self.previous_sample = Some(normalized);
        self.source_frames_seen = self.source_frames_seen.saturating_add(1);
    }

    #[cfg(any(target_os = "windows", target_os = "linux", test))]
    fn push_interleaved_f32<F>(&mut self, samples: &[f32], channels: usize, mut write_sample: F)
    where
        F: FnMut(i16),
    {
        if channels == 0 {
            return;
        }

        for frame in samples.chunks(channels) {
            if frame.is_empty() {
                continue;
            }
            let mono = frame.iter().copied().sum::<f32>() / frame.len() as f32;
            self.push_source_frame(mono, &mut write_sample);
        }
    }

    fn max_dbfs(&self) -> f32 {
        if self.max_abs_sample <= 0.0 {
            -120.0
        } else {
            20.0 * self.max_abs_sample.log10()
        }
    }

    fn frames_above_noise_floor(&self) -> u64 {
        self.frames_above_noise_floor
    }

    #[cfg(target_os = "linux")]
    fn reset_source_sample_rate(&mut self, source_sample_rate: u32) {
        if self.source_frames_seen == 0 {
            *self = Self::new(source_sample_rate);
        }
    }

    fn output_frames_written(&self) -> u64 {
        self.output_frames_written
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
fn float_to_pcm_i16(sample: f32) -> i16 {
    let normalized = sample.clamp(-1.0, 1.0);
    let value = if normalized < 0.0 {
        normalized * 32_768.0
    } else {
        normalized * 32_767.0
    };
    value.round() as i16
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
struct SystemAudioWriter<W>
where
    W: Write + Seek,
{
    writer: hound::WavWriter<W>,
    resampler: SystemAudioResampler,
    live_pcm: Vec<u8>,
    samples_since_checkpoint: u64,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
impl<W> SystemAudioWriter<W>
where
    W: Write + Seek,
{
    fn new(writer: hound::WavWriter<W>, source_sample_rate: u32) -> Self {
        Self {
            writer,
            resampler: SystemAudioResampler::new(source_sample_rate),
            live_pcm: Vec::with_capacity(LIVE_PCM_CHUNK_BYTES * 2),
            samples_since_checkpoint: 0,
        }
    }

    fn write_output_sample(&mut self, sample: i16) {
        if let Err(error) = self.writer.write_sample(sample) {
            logger::log_error(
                "CALL_CAPTURE",
                &format!("Failed to write system audio sample: {}", error),
            );
            return;
        }
        self.samples_since_checkpoint = self.samples_since_checkpoint.saturating_add(1);
        if self.samples_since_checkpoint >= AUDIO_CHECKPOINT_SAMPLES {
            self.samples_since_checkpoint = 0;
            if let Err(error) = self.writer.flush() {
                logger::log_error(
                    "CALL_CAPTURE",
                    &format!("Failed to checkpoint system audio WAV: {}", error),
                );
            }
        }
        self.live_pcm.extend_from_slice(&sample.to_le_bytes());
        if self.live_pcm.len() < LIVE_PCM_CHUNK_BYTES {
            return;
        }
        let chunk: Vec<u8> = self.live_pcm.drain(..LIVE_PCM_CHUNK_BYTES).collect();
        if let Ok(sink) = system_audio_monitor_sink().lock() {
            if let Some(sender) = sink.as_ref() {
                let _ = sender.try_send(chunk.clone());
            }
        }
        if let Ok(sink) = system_audio_sink().lock() {
            if let Some(sender) = sink.as_ref() {
                let _ = sender.try_send(RealtimeAudioCommand::Pcm(chunk));
            }
        }
    }

    fn write_source_frame(&mut self, sample: f32) {
        let mut output = Vec::new();
        self.resampler
            .push_source_frame(sample, |sample| output.push(sample));
        for sample in output {
            self.write_output_sample(sample);
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    fn write_interleaved_f32(&mut self, samples: &[f32], channels: usize) {
        let mut output = Vec::new();
        self.resampler
            .push_interleaved_f32(samples, channels, |sample| output.push(sample));
        for sample in output {
            self.write_output_sample(sample);
        }
    }

    #[cfg(target_os = "linux")]
    fn reset_source_sample_rate(&mut self, source_sample_rate: u32) {
        self.resampler.reset_source_sample_rate(source_sample_rate);
    }

    fn finalize(mut self) -> Result<(), hound::Error> {
        if !self.live_pcm.is_empty() {
            if let Ok(sink) = system_audio_monitor_sink().lock() {
                if let Some(sender) = sink.as_ref() {
                    let _ = sender.try_send(self.live_pcm.clone());
                }
            }
            if let Ok(sink) = system_audio_sink().lock() {
                if let Some(sender) = sink.as_ref() {
                    let _ = sender.try_send(RealtimeAudioCommand::Pcm(std::mem::take(
                        &mut self.live_pcm,
                    )));
                }
            }
        }
        self.writer.finalize()
    }

    fn max_dbfs(&self) -> f32 {
        self.resampler.max_dbfs()
    }

    fn frames_above_noise_floor(&self) -> u64 {
        self.resampler.frames_above_noise_floor()
    }

    fn output_frames_written(&self) -> u64 {
        self.resampler.output_frames_written()
    }
}

fn default_true() -> bool {
    true
}

fn platform_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "unsupported"
    }
}

fn call_capture_root(app: &AppHandle, _storage_dir: Option<&str>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|err| format!("Не удалось найти папку данных Talkis: {}", err))
        .map(|dir| dir.join("history").join("call-capture"))
}

fn create_session_dir(
    app: &AppHandle,
    req: &StartCallCaptureRequest,
    session_id: &str,
) -> Result<PathBuf, String> {
    let dir = call_capture_root(app, req.storage_dir.as_deref())?.join(session_id);
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Не удалось подготовить папку записи созвона: {}", err))?;
    Ok(dir)
}

fn write_manifest(session: &CallCaptureSession) -> Result<(), String> {
    let path = PathBuf::from(&session.directory).join("manifest.json");
    let json = serde_json::to_string_pretty(session)
        .map_err(|err| format!("Не удалось подготовить manifest созвона: {}", err))?;
    let temp_path = path.with_extension("json.tmp");
    let mut file = File::create(&temp_path)
        .map_err(|err| format!("Не удалось создать manifest созвона: {}", err))?;
    file.write_all(json.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|err| format!("Не удалось сохранить manifest созвона: {}", err))?;
    drop(file);
    replace_file(&temp_path, &path).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        format!("Не удалось заменить manifest созвона: {}", err)
    })?;
    #[cfg(unix)]
    File::open(
        path.parent()
            .ok_or_else(|| "Не удалось найти папку manifest созвона.".to_string())?,
    )
    .and_then(|directory| directory.sync_all())
    .map_err(|err| {
        format!(
            "Не удалось синхронизировать папку manifest созвона: {}",
            err
        )
    })?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn build_session(
    app: &AppHandle,
    req: &StartCallCaptureRequest,
) -> Result<CallCaptureSession, String> {
    if !req.include_mic && !req.include_system {
        return Err("Выберите хотя бы одну дорожку для записи созвона.".to_string());
    }

    let session_id = uuid_like_id();
    let dir = create_session_dir(app, req, &session_id)?;
    let sample_rate = req.sample_rate.unwrap_or(48_000);
    let mut tracks = Vec::new();

    if req.include_mic && req.save_audio {
        tracks.push(CallCaptureTrack {
            kind: CallCaptureTrackKind::Mic,
            label: "Вы".to_string(),
            path: dir.join("mic.wav").to_string_lossy().to_string(),
            channels: 1,
            sample_rate,
        });
    }

    if req.include_system && req.save_audio {
        tracks.push(CallCaptureTrack {
            kind: CallCaptureTrackKind::System,
            label: "Созвон".to_string(),
            path: dir.join("system.wav").to_string_lossy().to_string(),
            channels: CALL_SYSTEM_CAPTURE_CHANNELS,
            sample_rate: CALL_SYSTEM_CAPTURE_SAMPLE_RATE,
        });
    }

    Ok(CallCaptureSession {
        id: session_id,
        platform: platform_name().to_string(),
        status: CallCaptureStatus::Starting,
        started_at: Utc::now().to_rfc3339(),
        ended_at: None,
        directory: dir.to_string_lossy().to_string(),
        tracks,
        native_mic_active: false,
        live_transcription: req.live_transcription.as_ref().map(|live| {
            CallLiveTranscriptionState {
                mic_request_id: live.mic.as_ref().map(|request| request.request_id.clone()),
                system_request_id: live
                    .system
                    .as_ref()
                    .map(|request| request.request_id.clone()),
                ..CallLiveTranscriptionState::default()
            }
        }),
    })
}

fn uuid_like_id() -> String {
    let now = Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| Utc::now().timestamp_millis() * 1_000_000);
    format!("call-{}-{}", std::process::id(), now)
}

fn parse_started_at(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Utc))
}

fn finish_live_transcription(
    state: Option<&mut CallLiveTranscriptionState>,
    mic_session: Option<LiveDictationSession>,
    system_session: Option<LiveDictationSession>,
) {
    let mic = mic_session.map(|session| {
        std::thread::spawn(move || live_dictation::finish_live_dictation_session(session))
    });
    let system = system_session.map(|session| {
        std::thread::spawn(move || live_dictation::finish_live_dictation_session(session))
    });

    let Some(state) = state else {
        if let Some(handle) = mic {
            let _ = handle.join();
        }
        if let Some(handle) = system {
            let _ = handle.join();
        }
        return;
    };

    apply_live_finish_result(state, "mic", mic.map(|handle| handle.join()));
    apply_live_finish_result(state, "system", system.map(|handle| handle.join()));
}

fn apply_live_finish_result(
    state: &mut CallLiveTranscriptionState,
    channel: &str,
    result: Option<std::thread::Result<Result<LiveDictationFinal, String>>>,
) {
    let Some(result) = result else {
        return;
    };
    match result {
        Ok(Ok(final_text)) => {
            let text = final_text.text.trim().to_string();
            if text.is_empty() {
                return;
            }
            if channel == "mic" {
                state.mic_text = Some(text);
            } else {
                state.system_text = Some(text);
            }
        }
        Ok(Err(error)) => state.errors.push(format!("{}: {}", channel, error)),
        Err(_) => state
            .errors
            .push(format!("{}: realtime worker завершился аварийно", channel)),
    }
}

fn stop_capture_components(stored: &mut StoredCallCaptureSession) {
    let mic_live_session = stored.mic.take().and_then(|capture| {
        let (session, result) = capture.stop();
        if let Err(error) = result {
            logger::log_error("CALL_CAPTURE", &error);
            if let Some(live) = stored.session.live_transcription.as_mut() {
                live.errors.push(error);
            }
        }
        session
    });

    if let Err(error) = stop_platform_capture(stored) {
        logger::log_error("CALL_CAPTURE", &error);
        if let Some(live) = stored.session.live_transcription.as_mut() {
            live.errors.push(error);
        }
    }
    set_system_audio_sink(None);
    finish_live_transcription(
        stored.session.live_transcription.as_mut(),
        mic_live_session,
        stored.system_live_session.take(),
    );
}

#[tauri::command]
pub async fn list_call_capture_targets() -> Result<Vec<CaptureTarget>, String> {
    Ok(platform_targets())
}

#[tauri::command]
pub async fn start_call_capture(
    app: AppHandle,
    req: StartCallCaptureRequest,
) -> Result<CallCaptureSession, String> {
    if has_active_sessions() {
        return Err("Запись созвона уже запущена.".to_string());
    }
    if crate::live_translation::is_active() {
        return Err("Сначала остановите синхронный перевод.".to_string());
    }
    // Ordinary call recording must never alter what the user hears. Live
    // translation temporarily changes these process-wide Core Audio policies
    // when voice playback is enabled, so reset them explicitly before creating
    // the call tap even if a previous translation session ended unexpectedly.
    set_require_self_audio_exclusion(false);
    set_mute_captured_system_audio(false);

    let mut session = build_session(&app, &req)?;
    logger::log_info(
        "CALL_CAPTURE",
        &format!(
            "Starting call capture session={}, platform={}, target={:?}, preferred_mic_selected={}",
            session.id,
            session.platform,
            req.target_id,
            req.mic_device_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        ),
    );

    session_directories()
        .lock()
        .map_err(|_| "Не удалось сохранить папку записи созвона.".to_string())?
        .insert(session.id.clone(), PathBuf::from(&session.directory));
    write_manifest(&session)?;

    let system_live_session = if req.include_system {
        req.live_transcription
            .as_ref()
            .and_then(|live| live.system.clone())
            .and_then(|request| {
                live_dictation::start_live_dictation_session(
                    app.clone(),
                    Some(request),
                    CALL_SYSTEM_CAPTURE_SAMPLE_RATE,
                )
            })
    } else {
        None
    };
    if req
        .live_transcription
        .as_ref()
        .and_then(|live| live.system.as_ref())
        .is_some()
        && system_live_session.is_none()
    {
        if let Some(live) = session.live_transcription.as_mut() {
            live.errors
                .push("system: не удалось запустить live-транскрибацию".to_string());
        }
    }
    if let Some(live_session) = system_live_session.as_ref() {
        set_system_audio_sink(Some(live_session.command_sender()));
    }

    let platform_state = match start_platform_capture(&session, &req) {
        Ok(state) => state,
        Err(error) => {
            set_system_audio_sink(None);
            if let Some(live_session) = system_live_session {
                live_dictation::cancel_live_dictation_session(live_session);
            }
            session.status = CallCaptureStatus::Failed;
            session.ended_at = Some(Utc::now().to_rfc3339());
            if let Some(live) = session.live_transcription.as_mut() {
                live.errors.push(error.clone());
            }
            let _ = write_manifest(&session);
            return Err(error);
        }
    };

    let mic = if req.include_mic && req.native_mic_capture {
        let mic_path = session
            .tracks
            .iter()
            .find(|track| matches!(track.kind, CallCaptureTrackKind::Mic))
            .map(|track| PathBuf::from(&track.path));
        match mic_path {
            Some(path) => match tokio::task::spawn_blocking({
                let device_label = req.mic_device_label.clone();
                let live_request = req.live_transcription
                    .as_ref()
                    .and_then(|live| live.mic.clone());

                move || microphone::start(app, path, device_label, live_request)
            }).await.unwrap_or_else(|error| Err(format!("Не удалось запустить микрофон созвона: {error}"))) {
                Ok(capture) => {
                    if req
                        .live_transcription
                        .as_ref()
                        .and_then(|live| live.mic.as_ref())
                        .is_some()
                        && !capture.has_live_session()
                    {
                        if let Some(live) = session.live_transcription.as_mut() {
                            live.errors
                                .push("mic: не удалось запустить live-транскрибацию".to_string());
                        }
                    }
                    if let Some(track) = session
                        .tracks
                        .iter_mut()
                        .find(|track| matches!(track.kind, CallCaptureTrackKind::Mic))
                    {
                        track.sample_rate = capture.sample_rate;
                        track.path = capture.path.to_string_lossy().to_string();
                    }
                    session.native_mic_active = true;
                    logger::log_info(
                        "CALL_CAPTURE",
                        &format!(
                            "Native call microphone ready: device={}, sample_rate={}",
                            capture.device_name, capture.sample_rate
                        ),
                    );
                    Some(capture)
                }
                Err(error) => {
                    logger::log_error(
                        "CALL_CAPTURE",
                        &format!(
                            "Native call microphone unavailable; WebView fallback required: {}",
                            error
                        ),
                    );
                    session
                        .tracks
                        .retain(|track| !matches!(track.kind, CallCaptureTrackKind::Mic));
                    if let Some(live) = session.live_transcription.as_mut() {
                        live.errors.push(format!(
                            "Микрофон записывается резервным способом: {}",
                            error
                        ));
                    }
                    None
                }
            },
            None => None,
        }
    } else {
        None
    };

    session.status = CallCaptureStatus::Recording;
    let mut pending = Some(StoredCallCaptureSession {
        session: session.clone(),
        mic,
        system_live_session,
        #[cfg(target_os = "macos")]
        macos: platform_state,
        #[cfg(target_os = "windows")]
        windows: platform_state,
        #[cfg(target_os = "linux")]
        linux: platform_state,
    });
    match sessions().lock() {
        Ok(mut guard) => {
            guard.insert(
                session.id.clone(),
                pending.take().expect("stored call session"),
            );
        }
        Err(_) => {
            let mut stored = pending.take().expect("pending call session");
            stop_capture_components(&mut stored);
            stored.session.status = CallCaptureStatus::Failed;
            stored.session.ended_at = Some(Utc::now().to_rfc3339());
            let _ = write_manifest(&stored.session);
            return Err("Не удалось заблокировать менеджер записи созвона.".to_string());
        }
    }
    if let Err(error) = write_manifest(&session) {
        let _ = stop_call_capture(session.id.clone()).await;
        return Err(error);
    }

    Ok(session)
}

#[tauri::command]
pub async fn stop_call_capture(session_id: String) -> Result<CallCaptureSession, String> {
    let mut stored = sessions()
        .lock()
        .map_err(|_| "Не удалось заблокировать менеджер записи созвона.".to_string())?
        .remove(&session_id)
        .ok_or_else(|| "Активная запись созвона не найдена.".to_string())?;

    logger::log_info(
        "CALL_CAPTURE",
        &format!("Stopping call capture session={}", session_id),
    );

    stop_capture_components(&mut stored);
    stored.session.native_mic_active = false;
    stored.session.status = CallCaptureStatus::Stopped;
    stored.session.ended_at = Some(Utc::now().to_rfc3339());
    write_manifest(&stored.session)?;

    Ok(stored.session)
}

#[tauri::command]
pub async fn save_call_capture_mic_track(
    session_id: String,
    audio_base64: String,
    mime_type: Option<String>,
) -> Result<CallCaptureTrack, String> {
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|err| format!("Не удалось прочитать дорожку микрофона: {}", err))?;
    let mut guard = sessions()
        .lock()
        .map_err(|_| "Не удалось заблокировать менеджер записи созвона.".to_string())?;
    let stored = guard
        .get_mut(&session_id)
        .ok_or_else(|| "Активная запись созвона не найдена.".to_string())?;
    let extension = mime_type
        .as_deref()
        .filter(|value| value.to_ascii_lowercase().contains("wav"))
        .map(|_| "wav")
        .unwrap_or("webm");
    let path = PathBuf::from(&stored.session.directory).join(format!("mic.{}", extension));

    fs::write(&path, audio_bytes)
        .map_err(|err| format!("Не удалось сохранить дорожку микрофона: {}", err))?;

    let track = CallCaptureTrack {
        kind: CallCaptureTrackKind::Mic,
        label: "Вы".to_string(),
        path: path.to_string_lossy().to_string(),
        channels: 1,
        sample_rate: 48_000,
    };

    if let Some(existing) = stored
        .session
        .tracks
        .iter_mut()
        .find(|item| matches!(item.kind, CallCaptureTrackKind::Mic))
    {
        *existing = track.clone();
    } else {
        stored.session.tracks.insert(0, track.clone());
    }

    write_manifest(&stored.session)?;
    Ok(track)
}

#[tauri::command]
pub fn pause_call_capture_mic(session_id: String) -> Result<bool, String> {
    let guard = sessions()
        .lock()
        .map_err(|_| "Не удалось заблокировать менеджер записи созвона.".to_string())?;
    let stored = guard
        .get(&session_id)
        .ok_or_else(|| "Активная запись созвона не найдена.".to_string())?;
    let Some(mic) = stored.mic.as_ref() else {
        return Ok(false);
    };
    mic.pause();
    logger::log_info("CALL_CAPTURE", "Paused native call microphone");
    Ok(true)
}

#[tauri::command]
pub fn resume_call_capture_mic(session_id: String) -> Result<bool, String> {
    let guard = sessions()
        .lock()
        .map_err(|_| "Не удалось заблокировать менеджер записи созвона.".to_string())?;
    let stored = guard
        .get(&session_id)
        .ok_or_else(|| "Активная запись созвона не найдена.".to_string())?;
    let Some(mic) = stored.mic.as_ref() else {
        return Ok(false);
    };
    mic.resume();
    logger::log_info("CALL_CAPTURE", "Resumed native call microphone");
    Ok(true)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallTranscriptCheckpoint {
    session_id: String,
    channel: String,
    status: String,
    text: String,
    started_at_ms: u64,
    written_at: String,
}

fn update_live_transcription_state(
    session: &mut CallCaptureSession,
    channel: &str,
    status: &str,
    text: &str,
    message: Option<&str>,
) {
    let state = session
        .live_transcription
        .get_or_insert_with(CallLiveTranscriptionState::default);
    if (status == "final" || status == "draft") && !text.trim().is_empty() {
        if channel == "mic" {
            state.mic_text = Some(text.trim().to_string());
        } else {
            state.system_text = Some(text.trim().to_string());
        }
    }
    if status == "error" {
        let error = message
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Realtime-транскрибация недоступна");
        let formatted = format!("{}: {}", channel, error);
        if !state.errors.iter().any(|known| known == &formatted) {
            state.errors.push(formatted);
        }
    }
}

fn session_directory(session_id: &str) -> Result<PathBuf, String> {
    session_directories()
        .lock()
        .map_err(|_| "Не удалось прочитать папку записи созвона.".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Папка записи созвона не найдена.".to_string())
}

fn read_manifest(directory: &PathBuf) -> Result<CallCaptureSession, String> {
    let path = directory.join("manifest.json");
    let json = fs::read_to_string(&path)
        .map_err(|error| format!("Не удалось прочитать manifest созвона: {}", error))?;
    serde_json::from_str(&json)
        .map_err(|error| format!("Не удалось разобрать manifest созвона: {}", error))
}

fn append_transcript_checkpoint(
    directory: &PathBuf,
    checkpoint: &CallTranscriptCheckpoint,
) -> Result<(), String> {
    let path = directory.join(TRANSCRIPT_CHECKPOINT_FILE);
    let json = serde_json::to_string(checkpoint)
        .map_err(|error| format!("Не удалось подготовить checkpoint транскрипта: {}", error))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Не удалось открыть журнал транскрипта: {}", error))?;
    file.write_all(json.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("Не удалось сохранить checkpoint транскрипта: {}", error))
}

#[tauri::command]
pub fn checkpoint_call_transcription(
    session_id: String,
    channel: String,
    status: String,
    text: String,
    started_at_ms: u64,
    message: Option<String>,
) -> Result<(), String> {
    if channel != "mic" && channel != "system" {
        return Err("Некорректная дорожка live-транскрибации.".to_string());
    }
    if status != "final" && status != "draft" && status != "error" {
        return Ok(());
    }

    let directory = session_directory(&session_id)?;
    let checkpoint = CallTranscriptCheckpoint {
        session_id: session_id.clone(),
        channel: channel.clone(),
        status: status.clone(),
        text: text.trim().to_string(),
        started_at_ms,
        written_at: Utc::now().to_rfc3339(),
    };
    append_transcript_checkpoint(&directory, &checkpoint)?;

    let active_manifest = {
        let mut guard = sessions()
            .lock()
            .map_err(|_| "Не удалось заблокировать менеджер записи созвона.".to_string())?;
        guard.get_mut(&session_id).map(|stored| {
            update_live_transcription_state(
                &mut stored.session,
                &channel,
                &status,
                &text,
                message.as_deref(),
            );
            stored.session.clone()
        })
    };
    let session = match active_manifest {
        Some(session) => session,
        None => {
            let mut session = read_manifest(&directory)?;
            update_live_transcription_state(
                &mut session,
                &channel,
                &status,
                &text,
                message.as_deref(),
            );
            session
        }
    };
    write_manifest(&session)
}

fn restore_transcript_checkpoints(directory: &PathBuf, state: &mut CallLiveTranscriptionState) {
    let path = directory.join(TRANSCRIPT_CHECKPOINT_FILE);
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(checkpoint) = serde_json::from_str::<CallTranscriptCheckpoint>(line) else {
            continue;
        };
        if (checkpoint.status != "final" && checkpoint.status != "draft")
            || checkpoint.text.trim().is_empty()
        {
            continue;
        }
        if checkpoint.channel == "mic" {
            state.mic_text = Some(checkpoint.text);
        } else if checkpoint.channel == "system" {
            state.system_text = Some(checkpoint.text);
        }
    }
}

fn repair_pcm_wav_header(path: &PathBuf, directory: &PathBuf) -> Result<(), String> {
    if path.extension().and_then(|value| value.to_str()) != Some("wav") || !path.is_file() {
        return Ok(());
    }
    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| format!("Не удалось проверить папку созвона: {}", error))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("Не удалось проверить WAV созвона: {}", error))?;
    if !canonical_path.starts_with(canonical_directory) {
        return Err("WAV созвона находится вне папки сессии.".to_string());
    }

    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&canonical_path)
        .map_err(|error| format!("Не удалось открыть WAV для восстановления: {}", error))?;
    let file_len = file
        .metadata()
        .map_err(|error| format!("Не удалось прочитать размер WAV: {}", error))?
        .len();
    if file_len < 44 || file_len > u64::from(u32::MAX) {
        return Ok(());
    }

    let mut header = [0u8; 12];
    file.read_exact(&mut header)
        .map_err(|error| format!("Не удалось прочитать WAV-заголовок: {}", error))?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Ok(());
    }

    let mut chunk_offset = 12u64;
    let mut data_size_offset = None;
    let mut data_start = None;
    while chunk_offset + 8 <= file_len {
        file.seek(SeekFrom::Start(chunk_offset))
            .map_err(|error| format!("Не удалось проверить WAV chunk: {}", error))?;
        let mut chunk_header = [0u8; 8];
        file.read_exact(&mut chunk_header)
            .map_err(|error| format!("Не удалось прочитать WAV chunk: {}", error))?;
        let declared_size = u32::from_le_bytes([
            chunk_header[4],
            chunk_header[5],
            chunk_header[6],
            chunk_header[7],
        ]) as u64;
        if &chunk_header[0..4] == b"data" {
            data_size_offset = Some(chunk_offset + 4);
            data_start = Some(chunk_offset + 8);
            break;
        }
        chunk_offset = chunk_offset
            .saturating_add(8)
            .saturating_add(declared_size)
            .saturating_add(declared_size % 2);
    }

    let (Some(data_size_offset), Some(data_start)) = (data_size_offset, data_start) else {
        return Ok(());
    };
    let riff_size = (file_len - 8) as u32;
    let data_size = (file_len - data_start) as u32;
    file.seek(SeekFrom::Start(4))
        .and_then(|_| file.write_all(&riff_size.to_le_bytes()))
        .and_then(|_| file.seek(SeekFrom::Start(data_size_offset)))
        .and_then(|_| file.write_all(&data_size.to_le_bytes()))
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Не удалось восстановить WAV-заголовок: {}", error))
}

#[tauri::command]
pub async fn recover_call_capture_sessions(
    app: AppHandle,
) -> Result<Vec<CallCaptureSession>, String> {
    let root = call_capture_root(&app, None)?;
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let active_ids = sessions()
        .lock()
        .map_err(|_| "Не удалось прочитать активные записи созвонов.".to_string())?
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let entries = fs::read_dir(&root)
        .map_err(|error| format!("Не удалось прочитать записи созвонов: {}", error))?;
    let mut recovered = Vec::new();

    for entry in entries.flatten() {
        let directory = entry.path();
        if !directory.is_dir() {
            continue;
        }
        let Ok(mut session) = read_manifest(&directory) else {
            continue;
        };
        if active_ids.contains(&session.id)
            || !matches!(
                session.status,
                CallCaptureStatus::Starting | CallCaptureStatus::Recording
            )
        {
            continue;
        }

        session.tracks.retain(|track| {
            if let Err(error) = repair_pcm_wav_header(&PathBuf::from(&track.path), &directory) {
                logger::log_error("CALL_CAPTURE", &error);
                return false;
            }
            fs::metadata(&track.path)
                .map(|metadata| metadata.is_file() && metadata.len() > 44)
                .unwrap_or(false)
        });
        let state = session
            .live_transcription
            .get_or_insert_with(CallLiveTranscriptionState::default);
        restore_transcript_checkpoints(&directory, state);
        if session.tracks.is_empty()
            && state.mic_text.as_deref().unwrap_or("").trim().is_empty()
            && state.system_text.as_deref().unwrap_or("").trim().is_empty()
        {
            session.status = CallCaptureStatus::Failed;
            session.native_mic_active = false;
            session.ended_at = Some(Utc::now().to_rfc3339());
            state
                .errors
                .push("Незавершённая запись не содержала аудио или текста.".to_string());
            write_manifest(&session)?;
            continue;
        }
        state
            .errors
            .push("Talkis восстановил запись после незавершённого сеанса.".to_string());
        session.status = CallCaptureStatus::Stopped;
        session.native_mic_active = false;
        session.ended_at = Some(Utc::now().to_rfc3339());
        write_manifest(&session)?;
        session_directories()
            .lock()
            .map_err(|_| "Не удалось сохранить папку восстановленного созвона.".to_string())?
            .insert(session.id.clone(), directory);
        recovered.push(session);
    }

    recovered.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    Ok(recovered)
}

#[tauri::command]
pub async fn get_call_capture_status(session_id: String) -> Result<CallCaptureSession, String> {
    sessions()
        .lock()
        .map_err(|_| "Не удалось заблокировать менеджер записи созвона.".to_string())?
        .get(&session_id)
        .map(|stored| stored.session.clone())
        .ok_or_else(|| "Активная запись созвона не найдена.".to_string())
}

#[tauri::command]
pub async fn get_call_capture_duration_ms(session_id: String) -> Result<u64, String> {
    let session = get_call_capture_status(session_id).await?;
    let started_at = parse_started_at(&session.started_at)
        .ok_or_else(|| "Не удалось прочитать время начала записи созвона.".to_string())?;
    Ok((Utc::now() - started_at).num_milliseconds().max(0) as u64)
}

pub fn get_system_audio_level(session_id: &str) -> Result<SystemAudioLevel, String> {
    let guard = sessions()
        .lock()
        .map_err(|_| "Не удалось заблокировать менеджер записи созвона.".to_string())?;
    let stored = guard
        .get(session_id)
        .ok_or_else(|| "Активная запись созвона не найдена.".to_string())?;

    #[cfg(target_os = "macos")]
    {
        let state = stored
            .macos
            .as_ref()
            .ok_or_else(|| "Системная аудиодорожка macOS не запущена.".to_string())?;
        if state.callback_state_ptr == 0 {
            return Err("Системная аудиодорожка macOS недоступна.".to_string());
        }
        // SAFETY: the callback state is owned by the stored session and is freed
        // only by stop_platform_capture while the sessions mutex is held.
        let callback_state =
            unsafe { &*(state.callback_state_ptr as *const MacosAudioWriterState) };
        let writer = callback_state
            .writer
            .lock()
            .map_err(|_| "Не удалось прочитать уровень системного звука macOS.".to_string())?;
        return Ok(SystemAudioLevel {
            max_dbfs: writer.max_dbfs(),
            frames_above_noise_floor: writer.frames_above_noise_floor(),
            output_frames_written: writer.output_frames_written(),
        });
    }

    #[cfg(target_os = "windows")]
    {
        let state = stored
            .windows
            .as_ref()
            .ok_or_else(|| "Системная аудиодорожка Windows не запущена.".to_string())?;
        let guard = state
            .writer
            .lock()
            .map_err(|_| "Не удалось прочитать уровень системного звука Windows.".to_string())?;
        let writer = guard
            .as_ref()
            .ok_or_else(|| "Системная аудиодорожка Windows недоступна.".to_string())?;
        return Ok(SystemAudioLevel {
            max_dbfs: writer.max_dbfs(),
            frames_above_noise_floor: writer.frames_above_noise_floor(),
            output_frames_written: writer.output_frames_written(),
        });
    }

    #[cfg(target_os = "linux")]
    {
        let state = stored
            .linux
            .as_ref()
            .ok_or_else(|| "Системная аудиодорожка Linux не запущена.".to_string())?;
        let guard = state
            .writer
            .lock()
            .map_err(|_| "Не удалось прочитать уровень системного звука Linux.".to_string())?;
        let writer = guard
            .as_ref()
            .ok_or_else(|| "Системная аудиодорожка Linux недоступна.".to_string())?;
        return Ok(SystemAudioLevel {
            max_dbfs: writer.max_dbfs(),
            frames_above_noise_floor: writer.frames_above_noise_floor(),
            output_frames_written: writer.output_frames_written(),
        });
    }

    #[allow(unreachable_code)]
    Err("Захват системного звука не поддерживается на этой платформе.".to_string())
}

#[cfg(target_os = "macos")]
fn platform_targets() -> Vec<CaptureTarget> {
    vec![CaptureTarget {
        id: "system-output".to_string(),
        label: "Системный звук".to_string(),
        kind: CaptureTargetKind::SystemOutput,
        platform: "macos".to_string(),
    }]
}

#[cfg(target_os = "windows")]
fn platform_targets() -> Vec<CaptureTarget> {
    vec![CaptureTarget {
        id: "default-loopback".to_string(),
        label: "Системный звук Windows".to_string(),
        kind: CaptureTargetKind::SystemOutput,
        platform: "windows".to_string(),
    }]
}

#[cfg(target_os = "linux")]
fn platform_targets() -> Vec<CaptureTarget> {
    vec![CaptureTarget {
        id: "default-pipewire-monitor".to_string(),
        label: "Системный звук PipeWire".to_string(),
        kind: CaptureTargetKind::SystemOutput,
        platform: "linux".to_string(),
    }]
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn platform_targets() -> Vec<CaptureTarget> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn start_platform_capture(
    session: &CallCaptureSession,
    req: &StartCallCaptureRequest,
) -> Result<Option<MacosCallCaptureState>, String> {
    if req.include_mic {
        logger::log_info(
            "CALL_CAPTURE",
            "Mic track is reserved in the manifest; native mic capture will be attached after the system tap path.",
        );
    }

    if !req.include_system {
        return Ok(None);
    }

    start_macos_system_audio_capture(session, req.save_audio)
}

#[cfg(target_os = "windows")]
fn start_platform_capture(
    session: &CallCaptureSession,
    req: &StartCallCaptureRequest,
) -> Result<Option<WindowsCallCaptureState>, String> {
    if req.include_mic {
        logger::log_info(
            "CALL_CAPTURE",
            "Mic track is reserved in the manifest; native mic capture will be attached after the Windows loopback path.",
        );
    }

    if !req.include_system {
        return Ok(None);
    }

    start_windows_system_audio_capture(session, req.save_audio)
}

#[cfg(target_os = "linux")]
fn start_platform_capture(
    session: &CallCaptureSession,
    req: &StartCallCaptureRequest,
) -> Result<Option<LinuxCallCaptureState>, String> {
    if req.include_mic {
        logger::log_info(
            "CALL_CAPTURE",
            "Mic track is reserved in the manifest; native mic capture will be attached after the PipeWire monitor path.",
        );
    }

    if !req.include_system {
        return Ok(None);
    }

    start_linux_system_audio_capture(session, req.save_audio)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn start_platform_capture(
    _session: &CallCaptureSession,
    _req: &StartCallCaptureRequest,
) -> Result<(), String> {
    Err("Захват созвона не поддерживается на этой платформе.".to_string())
}

#[cfg(target_os = "macos")]
fn stop_platform_capture(stored: &mut StoredCallCaptureSession) -> Result<(), String> {
    let Some(state) = stored.macos.take() else {
        return Ok(());
    };

    unsafe {
        let stop_status = AudioDeviceStop(state.aggregate_device_id, state.io_proc_id);
        if stop_status != 0 {
            logger::log_error(
                "CALL_CAPTURE",
                &format!("AudioDeviceStop failed: {}", stop_status),
            );
        }

        let destroy_proc_status =
            AudioDeviceDestroyIOProcID(state.aggregate_device_id, state.io_proc_id);
        if destroy_proc_status != 0 {
            logger::log_error(
                "CALL_CAPTURE",
                &format!("AudioDeviceDestroyIOProcID failed: {}", destroy_proc_status),
            );
        }

        let destroy_device_status = AudioHardwareDestroyAggregateDevice(state.aggregate_device_id);
        if destroy_device_status != 0 {
            logger::log_error(
                "CALL_CAPTURE",
                &format!(
                    "AudioHardwareDestroyAggregateDevice failed: {}",
                    destroy_device_status
                ),
            );
        }

        let destroy_tap_status = AudioHardwareDestroyProcessTap(state.tap_id);
        if destroy_tap_status != 0 {
            logger::log_error(
                "CALL_CAPTURE",
                &format!(
                    "AudioHardwareDestroyProcessTap failed: {}",
                    destroy_tap_status
                ),
            );
        }

        if state.callback_state_ptr != 0 {
            let writer_state =
                Box::from_raw(state.callback_state_ptr as *mut MacosAudioWriterState);
            match writer_state.writer.into_inner() {
                Ok(writer) => {
                    logger::log_info(
                        "CALL_CAPTURE",
                        &format!(
                            "System audio capture level: max={:.1} dBFS, frames_above_noise_floor={}",
                            writer.max_dbfs(),
                            writer.frames_above_noise_floor()
                        ),
                    );
                    if let Err(err) = writer.finalize() {
                        logger::log_error(
                            "CALL_CAPTURE",
                            &format!("Failed to finalize system WAV: {}", err),
                        );
                    }
                }
                Err(err) => {
                    logger::log_error(
                        "CALL_CAPTURE",
                        &format!("Failed to unlock system WAV writer: {}", err),
                    );
                }
            }
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn stop_platform_capture(stored: &mut StoredCallCaptureSession) -> Result<(), String> {
    let Some(mut state) = stored.windows.take() else {
        return Ok(());
    };

    state.stream.take();
    let mut guard = state
        .writer
        .lock()
        .map_err(|_| "Не удалось заблокировать writer системной дорожки Windows.".to_string())?;

    if let Some(writer) = guard.take() {
        logger::log_info(
            "CALL_CAPTURE",
            &format!(
                "System audio capture level: max={:.1} dBFS, frames_above_noise_floor={}",
                writer.max_dbfs(),
                writer.frames_above_noise_floor()
            ),
        );
        writer.finalize().map_err(|err| {
            logger::log_error(
                "CALL_CAPTURE",
                &format!("Failed to finalize Windows system WAV: {}", err),
            );
            format!("Не удалось завершить system.wav Windows: {}", err)
        })?;
    }

    logger::log_info(
        "CALL_CAPTURE",
        &format!(
            "Stopped Windows system audio capture: device={}, source={}Hz/{}ch/{:?}",
            state.device_name, state.source_sample_rate, state.source_channels, state.sample_format
        ),
    );

    Ok(())
}

#[cfg(target_os = "linux")]
fn stop_platform_capture(stored: &mut StoredCallCaptureSession) -> Result<(), String> {
    let Some(mut state) = stored.linux.take() else {
        return Ok(());
    };

    if let Some(stop_tx) = state.stop_tx.take() {
        if stop_tx.send(()).is_err() {
            logger::log_error(
                "CALL_CAPTURE",
                "Linux PipeWire capture thread already stopped",
            );
        }
    }

    if let Some(thread) = state.thread.take() {
        if thread.join().is_err() {
            logger::log_error("CALL_CAPTURE", "Linux PipeWire capture thread panicked");
        }
    }

    let mut guard = state
        .writer
        .lock()
        .map_err(|_| "Не удалось заблокировать writer системной дорожки Linux.".to_string())?;

    if let Some(writer) = guard.take() {
        logger::log_info(
            "CALL_CAPTURE",
            &format!(
                "System audio capture level: max={:.1} dBFS, frames_above_noise_floor={}",
                writer.max_dbfs(),
                writer.frames_above_noise_floor()
            ),
        );
        writer.finalize().map_err(|err| {
            logger::log_error(
                "CALL_CAPTURE",
                &format!("Failed to finalize Linux system WAV: {}", err),
            );
            format!("Не удалось завершить system.wav Linux: {}", err)
        })?;
    }

    logger::log_info(
        "CALL_CAPTURE",
        &format!(
            "Stopped Linux PipeWire system audio capture: target={}, source={}Hz/{}ch/{}",
            state.target, state.source_sample_rate, state.source_channels, state.source_format
        ),
    );

    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn stop_platform_capture(_stored: &mut StoredCallCaptureSession) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn status_result(status: i32, operation: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{} failed with OSStatus {}", operation, status))
    }
}

#[cfg(target_os = "macos")]
fn cf_key(value: &'static std::ffi::CStr) -> Result<CFRetained<CFString>, String> {
    let key = value
        .to_str()
        .map_err(|err| format!("Не удалось прочитать CoreAudio key: {}", err))?;
    Ok(CFString::from_str(key))
}

#[cfg(target_os = "macos")]
fn audio_property_address(selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

#[cfg(target_os = "macos")]
fn read_audio_property<T: Copy>(
    object_id: AudioObjectID,
    selector: AudioObjectPropertySelector,
    default_value: T,
) -> Result<T, String> {
    let mut address = audio_property_address(selector);
    let mut size = std::mem::size_of::<T>() as u32;
    let mut value = default_value;
    let status = unsafe {
        AudioObjectGetPropertyData(
            object_id,
            NonNull::from(&mut address),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::new((&mut value as *mut T).cast())
                .ok_or_else(|| "CoreAudio output pointer is null.".to_string())?,
        )
    };
    status_result(status, "AudioObjectGetPropertyData")?;
    Ok(value)
}

#[cfg(target_os = "macos")]
fn current_audio_process_object() -> Result<AudioObjectID, String> {
    let mut address = audio_property_address(kAudioHardwarePropertyTranslatePIDToProcessObject);
    let pid = std::process::id() as i32;
    let mut process_object = 0 as AudioObjectID;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&mut address),
            std::mem::size_of_val(&pid) as u32,
            (&pid as *const i32).cast(),
            NonNull::from(&mut size),
            NonNull::new((&mut process_object as *mut AudioObjectID).cast())
                .ok_or_else(|| "CoreAudio process output pointer is null.".to_string())?,
        )
    };
    status_result(status, "Translate Talkis PID to CoreAudio process")?;
    if process_object == 0 {
        return Err("CoreAudio did not return an audio process for Talkis.".to_string());
    }
    Ok(process_object)
}

#[cfg(target_os = "macos")]
fn current_audio_process_object_for_tap() -> Result<AudioObjectID, String> {
    let required = REQUIRE_SELF_AUDIO_EXCLUSION.load(Ordering::SeqCst);
    let attempts = if required { 20 } else { 1 };
    let mut last_error = None;
    for attempt in 0..attempts {
        match current_audio_process_object() {
            Ok(process_object) => return Ok(process_object),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < attempts {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    Err(last_error
        .unwrap_or_else(|| "CoreAudio did not return an audio process for Talkis.".to_string()))
}

#[cfg(target_os = "macos")]
fn read_tap_stream_description(
    tap_id: AudioObjectID,
) -> Result<AudioStreamBasicDescription, String> {
    read_audio_property(
        tap_id,
        kAudioTapPropertyFormat,
        AudioStreamBasicDescription {
            mSampleRate: 0.0,
            mFormatID: 0,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: 0,
            mBytesPerFrame: 0,
            mChannelsPerFrame: 0,
            mBitsPerChannel: 0,
            mReserved: 0,
        },
    )
}

#[cfg(target_os = "macos")]
fn cf_type<T>(value: &T) -> &CFType
where
    T: objc2_core_foundation::Type + AsRef<CFType>,
{
    <T as AsRef<CFType>>::as_ref(value)
}

#[cfg(target_os = "macos")]
fn build_macos_aggregate_description(
    session_id: &str,
    tap_uuid: &str,
) -> Result<CFRetained<CFDictionary<CFString, CFType>>, String> {
    let name_key = cf_key(kAudioAggregateDeviceNameKey)?;
    let uid_key = cf_key(kAudioAggregateDeviceUIDKey)?;
    let private_key = cf_key(kAudioAggregateDeviceIsPrivateKey)?;
    let stacked_key = cf_key(kAudioAggregateDeviceIsStackedKey)?;
    let auto_start_key = cf_key(kAudioAggregateDeviceTapAutoStartKey)?;
    let tap_list_key = cf_key(kAudioAggregateDeviceTapListKey)?;
    let sub_tap_drift_key = cf_key(kAudioSubTapDriftCompensationKey)?;
    let sub_tap_uid_key = cf_key(kAudioSubTapUIDKey)?;

    let name = CFString::from_str(&format!("Talkis Call Capture {}", session_id));
    let aggregate_uid = CFString::from_str(&format!("com.trixter.talkis.call.{}", session_id));
    let tap_uuid = CFString::from_str(tap_uuid);
    let true_value = CFBoolean::new(true);
    let false_value = CFBoolean::new(false);

    let sub_tap = CFDictionary::<CFString, CFType>::from_slices(
        &[sub_tap_drift_key.as_ref(), sub_tap_uid_key.as_ref()],
        &[
            cf_type::<CFBoolean>(true_value),
            cf_type::<CFString>(&tap_uuid),
        ],
    );
    let sub_taps = CFArray::<CFDictionary<CFString, CFType>>::from_objects(&[sub_tap.as_ref()]);

    Ok(CFDictionary::<CFString, CFType>::from_slices(
        &[
            name_key.as_ref(),
            uid_key.as_ref(),
            private_key.as_ref(),
            stacked_key.as_ref(),
            auto_start_key.as_ref(),
            tap_list_key.as_ref(),
        ],
        &[
            cf_type::<CFString>(&name),
            cf_type::<CFString>(&aggregate_uid),
            cf_type::<CFBoolean>(true_value),
            cf_type::<CFBoolean>(false_value),
            cf_type::<CFBoolean>(true_value),
            cf_type::<CFArray<CFDictionary<CFString, CFType>>>(&sub_taps),
        ],
    ))
}

#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn macos_system_audio_io_proc(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input_data: NonNull<AudioBufferList>,
    _input_time: NonNull<AudioTimeStamp>,
    _output_data: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    client_data: *mut std::ffi::c_void,
) -> i32 {
    if client_data.is_null() {
        return 0;
    }

    let state = unsafe { &*(client_data as *const MacosAudioWriterState) };
    let Ok(mut writer) = state.writer.lock() else {
        return 0;
    };

    let stream = state.stream_description;
    if stream.mFormatID != kAudioFormatLinearPCM {
        return 0;
    }

    let list = unsafe { input_data.as_ref() };
    let buffers =
        unsafe { std::slice::from_raw_parts(list.mBuffers.as_ptr(), list.mNumberBuffers as usize) };
    let is_float = (stream.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    let is_signed_int = (stream.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
    let is_non_interleaved = (stream.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
    let channels = stream.mChannelsPerFrame.max(1) as usize;

    if is_float && stream.mBitsPerChannel == 32 {
        if is_non_interleaved {
            let min_samples = buffers
                .iter()
                .map(|buffer| buffer.mDataByteSize as usize / std::mem::size_of::<f32>())
                .min()
                .unwrap_or(0);

            for index in 0..min_samples {
                let mut mono = 0.0f32;
                let mut channel_count = 0usize;

                for buffer in buffers {
                    if buffer.mData.is_null() {
                        continue;
                    }
                    let samples = unsafe {
                        std::slice::from_raw_parts(
                            buffer.mData.cast::<f32>(),
                            buffer.mDataByteSize as usize / std::mem::size_of::<f32>(),
                        )
                    };
                    if let Some(sample) = samples.get(index) {
                        mono += *sample;
                        channel_count += 1;
                    }
                }

                if channel_count > 0 {
                    writer.write_source_frame(mono / channel_count as f32);
                }
            }
        } else {
            for buffer in buffers {
                if buffer.mData.is_null() {
                    continue;
                }
                let samples = unsafe {
                    std::slice::from_raw_parts(
                        buffer.mData.cast::<f32>(),
                        buffer.mDataByteSize as usize / std::mem::size_of::<f32>(),
                    )
                };
                for frame in samples.chunks(channels) {
                    if frame.is_empty() {
                        continue;
                    }
                    let mono = frame.iter().copied().sum::<f32>() / frame.len() as f32;
                    writer.write_source_frame(mono);
                }
            }
        }
    } else if is_signed_int && stream.mBitsPerChannel == 16 {
        if is_non_interleaved {
            let min_samples = buffers
                .iter()
                .map(|buffer| buffer.mDataByteSize as usize / std::mem::size_of::<i16>())
                .min()
                .unwrap_or(0);

            for index in 0..min_samples {
                let mut mono = 0.0f32;
                let mut channel_count = 0usize;

                for buffer in buffers {
                    if buffer.mData.is_null() {
                        continue;
                    }
                    let samples = unsafe {
                        std::slice::from_raw_parts(
                            buffer.mData.cast::<i16>(),
                            buffer.mDataByteSize as usize / std::mem::size_of::<i16>(),
                        )
                    };
                    if let Some(sample) = samples.get(index) {
                        mono += *sample as f32 / i16::MAX as f32;
                        channel_count += 1;
                    }
                }

                if channel_count > 0 {
                    writer.write_source_frame(mono / channel_count as f32);
                }
            }
        } else {
            for buffer in buffers {
                if buffer.mData.is_null() {
                    continue;
                }
                let samples = unsafe {
                    std::slice::from_raw_parts(
                        buffer.mData.cast::<i16>(),
                        buffer.mDataByteSize as usize / std::mem::size_of::<i16>(),
                    )
                };
                for frame in samples.chunks(channels) {
                    if frame.is_empty() {
                        continue;
                    }
                    let mono = frame
                        .iter()
                        .map(|sample| *sample as f32 / i16::MAX as f32)
                        .sum::<f32>()
                        / frame.len() as f32;
                    writer.write_source_frame(mono);
                }
            }
        }
    }

    0
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn system_wav_spec() -> hound::WavSpec {
    hound::WavSpec {
        channels: CALL_SYSTEM_CAPTURE_CHANNELS,
        sample_rate: CALL_SYSTEM_CAPTURE_SAMPLE_RATE,
        bits_per_sample: CALL_SYSTEM_CAPTURE_BITS_PER_SAMPLE,
        sample_format: hound::SampleFormat::Int,
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn system_track_path(session: &CallCaptureSession, save_audio: bool) -> Result<PathBuf, String> {
    if !save_audio {
        #[cfg(windows)]
        return Ok(PathBuf::from("NUL"));
        #[cfg(not(windows))]
        return Ok(PathBuf::from("/dev/null"));
    }
    session
        .tracks
        .iter()
        .find(|track| matches!(track.kind, CallCaptureTrackKind::System))
        .map(|track| PathBuf::from(&track.path))
        .ok_or_else(|| "В сессии созвона нет системной дорожки.".to_string())
}

#[cfg(target_os = "linux")]
#[derive(Clone, Debug)]
struct LinuxPipeWireCaptureInfo {
    source_sample_rate: u32,
    source_channels: u16,
    source_format: String,
    target: String,
}

#[cfg(target_os = "linux")]
struct LinuxPipeWireUserData {
    format: spa::param::audio::AudioInfoRaw,
    writer: Arc<Mutex<Option<SystemAudioWriter<BufWriter<File>>>>>,
    ready_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<Result<LinuxPipeWireCaptureInfo, String>>>>>,
}

#[cfg(target_os = "linux")]
fn linux_pipewire_error(operation: &str, err: impl std::fmt::Display) -> String {
    format!(
        "{}: {}. Убедитесь, что PipeWire запущен и в системе есть устройство вывода.",
        operation, err
    )
}

#[cfg(target_os = "linux")]
fn send_linux_pipewire_ready_once(
    user_data: &LinuxPipeWireUserData,
    result: Result<LinuxPipeWireCaptureInfo, String>,
) {
    let Ok(mut guard) = user_data.ready_tx.lock() else {
        return;
    };
    let Some(tx) = guard.take() else {
        return;
    };
    let _ = tx.send(result);
}

#[cfg(target_os = "linux")]
fn linux_pipewire_capture_info(user_data: &LinuxPipeWireUserData) -> LinuxPipeWireCaptureInfo {
    LinuxPipeWireCaptureInfo {
        source_sample_rate: user_data.format.rate().max(CALL_SYSTEM_CAPTURE_SAMPLE_RATE),
        source_channels: user_data
            .format
            .channels()
            .max(CALL_SYSTEM_CAPTURE_CHANNELS as u32)
            .min(u16::MAX as u32) as u16,
        source_format: format!("{:?}", user_data.format.format()),
        target: "default PipeWire output monitor".to_string(),
    }
}

#[cfg(target_os = "linux")]
fn parse_pipewire_f32_samples(payload: &[u8]) -> Vec<f32> {
    payload
        .chunks_exact(std::mem::size_of::<f32>())
        .map(|sample| f32::from_le_bytes(sample.try_into().unwrap_or([0; 4])))
        .collect()
}

#[cfg(target_os = "linux")]
fn write_linux_pipewire_buffer(user_data: &LinuxPipeWireUserData, payload: &[u8], channels: usize) {
    if payload.is_empty() || channels == 0 {
        return;
    }

    let samples = parse_pipewire_f32_samples(payload);
    if samples.is_empty() {
        return;
    }

    let Ok(mut guard) = user_data.writer.lock() else {
        return;
    };
    let Some(writer) = guard.as_mut() else {
        return;
    };

    writer.write_interleaved_f32(&samples, channels);
}

#[cfg(target_os = "linux")]
fn run_linux_pipewire_capture(
    session_id: String,
    writer: Arc<Mutex<Option<SystemAudioWriter<BufWriter<File>>>>>,
    ready_tx: std::sync::mpsc::Sender<Result<LinuxPipeWireCaptureInfo, String>>,
    stop_rx: std::sync::mpsc::Receiver<()>,
) {
    let ready_for_setup = ready_tx.clone();
    let setup_result = (|| -> Result<(), String> {
        let thread_loop =
            unsafe { pw::thread_loop::ThreadLoopRc::new(Some("talkis-call-capture"), None) }
                .map_err(|err| {
                    linux_pipewire_error(
                        "Не удалось создать PipeWire loop для записи системного звука Linux",
                        err,
                    )
                })?;
        let context = pw::context::ContextRc::new(&thread_loop, None).map_err(|err| {
            linux_pipewire_error(
                "Не удалось создать PipeWire context для записи системного звука Linux",
                err,
            )
        })?;
        let core = context.connect_rc(None).map_err(|err| {
            linux_pipewire_error(
                "Не удалось подключиться к PipeWire для записи системного звука Linux",
                err,
            )
        })?;
        let ready_tx = Arc::new(Mutex::new(Some(ready_tx)));
        let data = LinuxPipeWireUserData {
            format: Default::default(),
            writer: Arc::clone(&writer),
            ready_tx,
        };

        let props = properties! {
            *pw::keys::MEDIA_TYPE => "Audio",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Communication",
            *pw::keys::MEDIA_NAME => "Talkis Call Capture",
            *pw::keys::APP_NAME => "Talkis",
            *pw::keys::APP_ID => "talkis.call-capture",
            *pw::keys::STREAM_CAPTURE_SINK => "true",
            *pw::keys::STREAM_MONITOR => "true",
        };
        let stream = pw::stream::StreamBox::new(&core, "talkis-call-capture-system", props)
            .map_err(|err| {
                linux_pipewire_error(
                    "Не удалось создать PipeWire stream для записи системного звука Linux",
                    err,
                )
            })?;

        let _listener = stream
            .add_local_listener_with_user_data(data)
            .state_changed(|_, user_data, _old, new| match new {
                pw::stream::StreamState::Error(err) => {
                    send_linux_pipewire_ready_once(
                        user_data,
                        Err(format!(
                            "Не удалось найти PipeWire monitor системного звука Linux: {}. Убедитесь, что PipeWire запущен и есть активное устройство вывода.",
                            err
                        )),
                    );
                }
                pw::stream::StreamState::Paused | pw::stream::StreamState::Streaming => {
                    send_linux_pipewire_ready_once(
                        user_data,
                        Ok(linux_pipewire_capture_info(user_data)),
                    );
                }
                _ => {}
            })
            .param_changed(|_, user_data, id, param| {
                let Some(param) = param else {
                    return;
                };
                if id != pw::spa::param::ParamType::Format.as_raw() {
                    return;
                }

                let Ok((media_type, media_subtype)) = pw::spa::param::format_utils::parse_format(param) else {
                    return;
                };
                if media_type != pw::spa::param::format::MediaType::Audio
                    || media_subtype != pw::spa::param::format::MediaSubtype::Raw
                {
                    return;
                }

                if user_data.format.parse(param).is_err() {
                    return;
                }

                let source_sample_rate = user_data
                    .format
                    .rate()
                    .max(CALL_SYSTEM_CAPTURE_SAMPLE_RATE);
                if let Ok(mut guard) = user_data.writer.lock() {
                    if let Some(writer) = guard.as_mut() {
                        writer.reset_source_sample_rate(source_sample_rate);
                    }
                }
            })
            .process(|stream, user_data| {
                let Some(mut buffer) = stream.dequeue_buffer() else {
                    return;
                };
                let datas = buffer.datas_mut();
                if datas.is_empty() {
                    return;
                }

                let data = &mut datas[0];
                let offset = data.chunk().offset() as usize;
                let size = data.chunk().size() as usize;
                if size == 0 {
                    return;
                }

                let channels = user_data
                    .format
                    .channels()
                    .max(CALL_SYSTEM_CAPTURE_CHANNELS as u32) as usize;
                let Some(bytes) = data.data() else {
                    return;
                };
                let end = offset.saturating_add(size).min(bytes.len());
                if offset >= end {
                    return;
                }

                write_linux_pipewire_buffer(user_data, &bytes[offset..end], channels);
            })
            .register()
            .map_err(|err| linux_pipewire_error("Не удалось подписаться на PipeWire stream events", err))?;

        let mut audio_info = spa::param::audio::AudioInfoRaw::new();
        audio_info.set_format(spa::param::audio::AudioFormat::F32LE);
        audio_info.set_rate(CALL_SYSTEM_CAPTURE_SAMPLE_RATE);
        audio_info.set_channels(CALL_SYSTEM_CAPTURE_CHANNELS as u32);
        let obj = pw::spa::pod::Object {
            type_: pw::spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
            id: pw::spa::param::ParamType::EnumFormat.as_raw(),
            properties: audio_info.into(),
        };
        let values: Vec<u8> = pw::spa::pod::serialize::PodSerializer::serialize(
            std::io::Cursor::new(Vec::new()),
            &pw::spa::pod::Value::Object(obj),
        )
        .map_err(|err| linux_pipewire_error("Не удалось подготовить PipeWire audio format", err))?
        .0
        .into_inner();
        let mut params = [spa::pod::Pod::from_bytes(&values)
            .ok_or_else(|| "Не удалось прочитать PipeWire audio format".to_string())?];

        stream
            .connect(
                spa::utils::Direction::Input,
                None,
                pw::stream::StreamFlags::AUTOCONNECT
                    | pw::stream::StreamFlags::MAP_BUFFERS
                    | pw::stream::StreamFlags::RT_PROCESS,
                &mut params,
            )
            .map_err(|err| {
                linux_pipewire_error(
                    "Не удалось начать PipeWire stream записи системного звука Linux",
                    err,
                )
            })?;

        thread_loop.start();
        logger::log_info(
            "CALL_CAPTURE",
            &format!(
                "Linux PipeWire capture thread is running for session={}",
                session_id
            ),
        );

        let _ = stop_rx.recv();
        thread_loop.stop();
        drop(_listener);
        drop(stream);
        drop(core);
        drop(context);
        drop(thread_loop);
        Ok(())
    })();

    if let Err(err) = setup_result {
        let _ = ready_for_setup.send(Err(err));
    }
}

#[cfg(target_os = "linux")]
fn start_linux_system_audio_capture(
    session: &CallCaptureSession,
    save_audio: bool,
) -> Result<Option<LinuxCallCaptureState>, String> {
    let path = system_track_path(session, save_audio)?;
    let wav_writer = hound::WavWriter::create(&path, system_wav_spec())
        .map_err(|err| format!("Не удалось открыть system.wav для записи: {}", err))?;
    let writer = Arc::new(Mutex::new(Some(SystemAudioWriter::new(
        wav_writer,
        CALL_SYSTEM_CAPTURE_SAMPLE_RATE,
    ))));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel();
    let session_id = session.id.clone();
    let thread_writer = Arc::clone(&writer);
    let thread = std::thread::Builder::new()
        .name("talkis-pipewire-call-capture".to_string())
        .spawn(move || run_linux_pipewire_capture(session_id, thread_writer, ready_tx, stop_rx))
        .map_err(|err| {
            format!(
                "Не удалось запустить PipeWire thread записи системного звука Linux: {}",
                err
            )
        })?;

    let info = match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(info)) => info,
        Ok(Err(err)) => {
            let _ = stop_tx.send(());
            let _ = thread.join();
            return Err(err);
        }
        Err(err) => {
            let _ = stop_tx.send(());
            let _ = thread.join();
            return Err(format!(
                "Не удалось найти PipeWire monitor системного звука Linux: {}. Убедитесь, что PipeWire запущен и есть активное устройство вывода.",
                err
            ));
        }
    };

    logger::log_info(
        "CALL_CAPTURE",
        &format!(
            "Started Linux PipeWire system audio capture session={}, target={}, source={}Hz/{}ch/{}, stored={}Hz/{}ch/{}bit",
            session.id,
            info.target,
            info.source_sample_rate,
            info.source_channels,
            info.source_format,
            CALL_SYSTEM_CAPTURE_SAMPLE_RATE,
            CALL_SYSTEM_CAPTURE_CHANNELS,
            CALL_SYSTEM_CAPTURE_BITS_PER_SAMPLE
        ),
    );

    Ok(Some(LinuxCallCaptureState {
        stop_tx: Some(stop_tx),
        thread: Some(thread),
        writer,
        source_sample_rate: info.source_sample_rate,
        source_channels: info.source_channels,
        source_format: info.source_format,
        target: info.target,
    }))
}

#[cfg(target_os = "windows")]
fn write_windows_loopback_samples<T, F>(
    writer: &Arc<Mutex<Option<SystemAudioWriter<BufWriter<File>>>>>,
    channels: usize,
    samples: &[T],
    mut to_f32: F,
) where
    T: Copy,
    F: FnMut(T) -> f32,
{
    if channels == 0 {
        return;
    }

    let Ok(mut guard) = writer.lock() else {
        return;
    };
    let Some(writer) = guard.as_mut() else {
        return;
    };

    let mut mono_frames = Vec::with_capacity(samples.len() / channels);
    for frame in samples.chunks(channels) {
        if frame.is_empty() {
            continue;
        }
        let mono = frame.iter().copied().map(&mut to_f32).sum::<f32>() / frame.len() as f32;
        mono_frames.push(mono);
    }

    writer.write_interleaved_f32(&mono_frames, 1);
}

#[cfg(target_os = "windows")]
fn windows_stream_error(err: cpal::StreamError) {
    logger::log_error(
        "CALL_CAPTURE",
        &format!("Windows loopback stream error: {}", err),
    );
}

#[cfg(target_os = "windows")]
fn build_windows_loopback_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    writer: Arc<Mutex<Option<SystemAudioWriter<BufWriter<File>>>>>,
) -> Result<cpal::Stream, String> {
    let channels = config.channels as usize;
    if channels == 0 {
        return Err("Устройство вывода Windows вернуло аудиоформат без каналов.".to_string());
    }

    match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _| {
                write_windows_loopback_samples(&writer, channels, data, |sample| sample)
            },
            windows_stream_error,
            None,
        ),
        cpal::SampleFormat::F64 => device.build_input_stream(
            config,
            move |data: &[f64], _| {
                write_windows_loopback_samples(&writer, channels, data, |sample| sample as f32)
            },
            windows_stream_error,
            None,
        ),
        cpal::SampleFormat::I8 => device.build_input_stream(
            config,
            move |data: &[i8], _| {
                write_windows_loopback_samples(&writer, channels, data, |sample| {
                    sample as f32 / i8::MAX as f32
                })
            },
            windows_stream_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _| {
                write_windows_loopback_samples(&writer, channels, data, |sample| {
                    sample as f32 / i16::MAX as f32
                })
            },
            windows_stream_error,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream(
            config,
            move |data: &[i32], _| {
                write_windows_loopback_samples(&writer, channels, data, |sample| {
                    sample as f32 / i32::MAX as f32
                })
            },
            windows_stream_error,
            None,
        ),
        cpal::SampleFormat::I64 => device.build_input_stream(
            config,
            move |data: &[i64], _| {
                write_windows_loopback_samples(&writer, channels, data, |sample| {
                    (sample as f64 / i64::MAX as f64) as f32
                })
            },
            windows_stream_error,
            None,
        ),
        cpal::SampleFormat::U8 => device.build_input_stream(
            config,
            move |data: &[u8], _| {
                write_windows_loopback_samples(&writer, channels, data, |sample| {
                    (sample as f32 - 128.0) / 128.0
                })
            },
            windows_stream_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            config,
            move |data: &[u16], _| {
                write_windows_loopback_samples(&writer, channels, data, |sample| {
                    (sample as f32 - 32_768.0) / 32_768.0
                })
            },
            windows_stream_error,
            None,
        ),
        cpal::SampleFormat::U32 => device.build_input_stream(
            config,
            move |data: &[u32], _| {
                write_windows_loopback_samples(&writer, channels, data, |sample| {
                    ((sample as f64 - 2_147_483_648.0) / 2_147_483_648.0) as f32
                })
            },
            windows_stream_error,
            None,
        ),
        cpal::SampleFormat::U64 => device.build_input_stream(
            config,
            move |data: &[u64], _| {
                write_windows_loopback_samples(&writer, channels, data, |sample| {
                    ((sample as f64 - 9_223_372_036_854_775_808.0) / 9_223_372_036_854_775_808.0)
                        as f32
                })
            },
            windows_stream_error,
            None,
        ),
        other => {
            return Err(format!(
                "Неподдерживаемый формат системного звука Windows: {:?}.",
                other
            ))
        }
    }
    .map_err(|err| format!("Не удалось начать запись системного звука Windows: {}", err))
}

#[cfg(target_os = "windows")]
fn start_windows_system_audio_capture(
    session: &CallCaptureSession,
    save_audio: bool,
) -> Result<Option<WindowsCallCaptureState>, String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or_else(|| {
        "Не найдено устройство вывода Windows для записи системного звука.".to_string()
    })?;
    let device_name = device
        .name()
        .unwrap_or_else(|_| "default Windows output".to_string());
    let supported_config = device
        .default_output_config()
        .map_err(|err| format!("Не удалось начать запись системного звука Windows: {}", err))?;
    let sample_format = supported_config.sample_format();
    let config: cpal::StreamConfig = supported_config.into();
    let source_sample_rate = config.sample_rate.0;
    let source_channels = config.channels;
    let path = system_track_path(session, save_audio)?;
    let wav_writer = hound::WavWriter::create(&path, system_wav_spec())
        .map_err(|err| format!("Не удалось открыть system.wav для записи: {}", err))?;
    let writer = Arc::new(Mutex::new(Some(SystemAudioWriter::new(
        wav_writer,
        source_sample_rate,
    ))));
    let stream =
        build_windows_loopback_stream(&device, &config, sample_format, Arc::clone(&writer))?;
    stream
        .play()
        .map_err(|err| format!("Не удалось начать запись системного звука Windows: {}", err))?;

    logger::log_info(
        "CALL_CAPTURE",
        &format!(
            "Started Windows system audio capture session={}, device={}, source={}Hz/{}ch/{:?}, stored={}Hz/{}ch/{}bit",
            session.id,
            device_name,
            source_sample_rate,
            source_channels,
            sample_format,
            CALL_SYSTEM_CAPTURE_SAMPLE_RATE,
            CALL_SYSTEM_CAPTURE_CHANNELS,
            CALL_SYSTEM_CAPTURE_BITS_PER_SAMPLE
        ),
    );

    Ok(Some(WindowsCallCaptureState {
        stream: Some(SendStream(stream)),
        writer,
        device_name,
        source_sample_rate,
        source_channels,
        sample_format,
    }))
}

#[cfg(target_os = "macos")]
fn start_macos_system_audio_capture(
    session: &CallCaptureSession,
    save_audio: bool,
) -> Result<Option<MacosCallCaptureState>, String> {
    let talkis_process = current_audio_process_object_for_tap();
    let excluded_processes = match &talkis_process {
        Ok(process_object) => {
            let excluded_process = NSNumber::numberWithUnsignedInt(*process_object);
            NSArray::from_retained_slice(&[excluded_process])
        }
        Err(error) if REQUIRE_SELF_AUDIO_EXCLUSION.load(Ordering::SeqCst) => {
            return Err(format!(
                "Не удалось исключить озвучку Talkis из системного звука: {}",
                error
            ));
        }
        Err(error) => {
            logger::log_error(
                "CALL_CAPTURE",
                &format!("Talkis audio process exclusion unavailable: {}", error),
            );
            NSArray::<NSNumber>::from_slice(&[])
        }
    };
    let tap_description = unsafe {
        CATapDescription::initStereoGlobalTapButExcludeProcesses(
            CATapDescription::alloc(),
            &excluded_processes,
        )
    };
    let tap_name = NSString::from_str("Talkis Call Capture");
    let tap_uuid = NSUUID::new();

    unsafe {
        tap_description.setName(&tap_name);
        tap_description.setUUID(&tap_uuid);
        tap_description.setPrivate(true);
        tap_description.setMixdown(true);
        tap_description.setMuteBehavior(if MUTE_CAPTURED_SYSTEM_AUDIO.load(Ordering::SeqCst) {
            CATapMuteBehavior::MutedWhenTapped
        } else {
            CATapMuteBehavior::Unmuted
        });
    }
    if let Ok(process_object) = talkis_process {
        logger::log_info(
            "CALL_CAPTURE",
            &format!(
                "Core Audio tap excludes Talkis process object={}",
                process_object
            ),
        );
    }
    logger::log_info(
        "CALL_CAPTURE",
        &format!(
            "Core Audio source playback muted_while_tapped={}",
            MUTE_CAPTURED_SYSTEM_AUDIO.load(Ordering::SeqCst)
        ),
    );

    let mut tap_id: AudioObjectID = 0;
    status_result(
        unsafe { AudioHardwareCreateProcessTap(Some(&tap_description), &mut tap_id) },
        "AudioHardwareCreateProcessTap",
    )?;

    let stream_description = match read_tap_stream_description(tap_id) {
        Ok(description) => description,
        Err(err) => {
            unsafe {
                let _ = AudioHardwareDestroyProcessTap(tap_id);
            }
            return Err(err);
        }
    };

    let tap_uuid_string = tap_uuid.UUIDString().to_string();
    let aggregate_description = build_macos_aggregate_description(&session.id, &tap_uuid_string)?;
    let mut aggregate_device_id: AudioObjectID = 0;
    if let Err(err) = status_result(
        unsafe {
            AudioHardwareCreateAggregateDevice(
                aggregate_description.as_ref(),
                NonNull::from(&mut aggregate_device_id),
            )
        },
        "AudioHardwareCreateAggregateDevice",
    ) {
        unsafe {
            let _ = AudioHardwareDestroyProcessTap(tap_id);
        }
        return Err(err);
    }

    let path = system_track_path(session, save_audio)?;
    let source_channels = stream_description
        .mChannelsPerFrame
        .max(1)
        .min(u16::MAX as u32) as u16;
    let source_sample_rate = stream_description.mSampleRate.max(1.0).round() as u32;
    let is_float = (stream_description.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    let source_bits_per_sample = if is_float {
        32
    } else {
        stream_description.mBitsPerChannel.clamp(16, 32) as u16
    };
    let writer = match hound::WavWriter::create(&path, system_wav_spec()) {
        Ok(writer) => writer,
        Err(err) => {
            unsafe {
                let _ = AudioHardwareDestroyAggregateDevice(aggregate_device_id);
                let _ = AudioHardwareDestroyProcessTap(tap_id);
            }
            return Err(format!("Не удалось открыть system.wav для записи: {}", err));
        }
    };
    let callback_state = Box::new(MacosAudioWriterState {
        writer: Mutex::new(SystemAudioWriter::new(writer, source_sample_rate)),
        stream_description,
    });
    let callback_state_ptr = Box::into_raw(callback_state);
    let mut io_proc_id: AudioDeviceIOProcID = None;

    let create_status = unsafe {
        let io_proc: AudioDeviceIOProc = Some(macos_system_audio_io_proc);
        AudioDeviceCreateIOProcID(
            aggregate_device_id,
            io_proc,
            callback_state_ptr.cast(),
            NonNull::from(&mut io_proc_id),
        )
    };
    if let Err(err) = status_result(create_status, "AudioDeviceCreateIOProcID") {
        unsafe {
            let _ = Box::from_raw(callback_state_ptr);
            let _ = AudioHardwareDestroyAggregateDevice(aggregate_device_id);
            let _ = AudioHardwareDestroyProcessTap(tap_id);
        }
        return Err(err);
    }

    if let Err(err) = status_result(
        unsafe { AudioDeviceStart(aggregate_device_id, io_proc_id) },
        "AudioDeviceStart",
    ) {
        unsafe {
            let _ = AudioDeviceDestroyIOProcID(aggregate_device_id, io_proc_id);
            let _ = Box::from_raw(callback_state_ptr);
            let _ = AudioHardwareDestroyAggregateDevice(aggregate_device_id);
            let _ = AudioHardwareDestroyProcessTap(tap_id);
        }
        return Err(err);
    }

    logger::log_info(
        "CALL_CAPTURE",
        &format!(
            "Started macOS global system audio capture session={}, tap={}, aggregate={}, source={}Hz/{}ch/{}bit, stored={}Hz/{}ch/{}bit",
            session.id,
            tap_id,
            aggregate_device_id,
            source_sample_rate,
            source_channels,
            source_bits_per_sample,
            CALL_SYSTEM_CAPTURE_SAMPLE_RATE,
            CALL_SYSTEM_CAPTURE_CHANNELS,
            CALL_SYSTEM_CAPTURE_BITS_PER_SAMPLE
        ),
    );

    Ok(Some(MacosCallCaptureState {
        tap_id,
        aggregate_device_id,
        io_proc_id,
        callback_state_ptr: callback_state_ptr as usize,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "talkis-call-capture-{}-{}-{}",
            name,
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&path).expect("test directory");
        path
    }

    fn collect_resampled(
        source_sample_rate: u32,
        channels: usize,
        samples: &[f32],
    ) -> (SystemAudioResampler, Vec<i16>) {
        let mut resampler = SystemAudioResampler::new(source_sample_rate);
        let mut output = Vec::new();
        resampler.push_interleaved_f32(samples, channels, |sample| output.push(sample));
        (resampler, output)
    }

    #[test]
    fn downmixes_interleaved_frames_to_mono() {
        let (resampler, output) = collect_resampled(16_000, 2, &[0.5, -0.5, 0.25, 0.75]);

        assert_eq!(output, vec![0, float_to_pcm_i16(0.5)]);
        assert_eq!(resampler.frames_above_noise_floor(), 1);
        assert_eq!(resampler.output_frames_written(), 2);
    }

    #[test]
    fn resamples_48khz_to_16khz() {
        let source = vec![0.25; 480];
        let (resampler, output) = collect_resampled(48_000, 1, &source);

        assert_eq!(output.len(), 160);
        assert_eq!(resampler.output_frames_written(), 160);
        assert!(output
            .iter()
            .all(|sample| *sample == float_to_pcm_i16(0.25)));
    }

    #[test]
    fn tracks_silence_stats() {
        let source = vec![0.0; 160];
        let (resampler, output) = collect_resampled(16_000, 1, &source);

        assert_eq!(output.len(), 160);
        assert_eq!(resampler.max_dbfs(), -120.0);
        assert_eq!(resampler.frames_above_noise_floor(), 0);
    }

    #[test]
    fn tracks_nonzero_stats() {
        let (resampler, output) = collect_resampled(16_000, 1, &[0.0, 0.002, -0.5]);

        assert_eq!(output.len(), 3);
        assert_eq!(resampler.frames_above_noise_floor(), 2);
        assert!((resampler.max_dbfs() - -6.0206).abs() < 0.01);
    }

    #[test]
    fn interpolates_when_upsampling() {
        let (_resampler, output) = collect_resampled(8_000, 1, &[0.0, 1.0]);

        assert_eq!(
            output,
            vec![
                float_to_pcm_i16(0.0),
                float_to_pcm_i16(0.5),
                float_to_pcm_i16(1.0),
            ]
        );
    }

    #[test]
    fn repairs_wav_header_after_unfinalized_tail() {
        let directory = test_directory("wav-repair");
        let path = directory.join("mic.wav");
        let mut writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .expect("wav writer");
        for sample in [1_i16, 2, 3] {
            writer.write_sample(sample).expect("wav sample");
        }
        writer.finalize().expect("finalize initial wav");

        let mut file = OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("append wav tail");
        file.write_all(&4_i16.to_le_bytes()).expect("tail sample");
        file.write_all(&5_i16.to_le_bytes()).expect("tail sample");
        file.sync_all().expect("sync wav tail");

        repair_pcm_wav_header(&path, &directory).expect("repair wav");
        let samples = hound::WavReader::open(&path)
            .expect("repaired wav")
            .into_samples::<i16>()
            .collect::<Result<Vec<_>, _>>()
            .expect("wav samples");
        assert_eq!(samples, vec![1, 2, 3, 4, 5]);

        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn restores_latest_durable_transcript_per_channel() {
        let directory = test_directory("transcript-restore");
        let checkpoint = |channel: &str, status: &str, text: &str, started_at_ms: u64| {
            append_transcript_checkpoint(
                &directory,
                &CallTranscriptCheckpoint {
                    session_id: "call-test".to_string(),
                    channel: channel.to_string(),
                    status: status.to_string(),
                    text: text.to_string(),
                    started_at_ms,
                    written_at: Utc::now().to_rfc3339(),
                },
            )
            .expect("append transcript checkpoint");
        };
        checkpoint("mic", "draft", "первая версия", 100);
        checkpoint("system", "final", "ответ собеседника", 200);
        checkpoint("mic", "error", "", 300);
        checkpoint("mic", "final", "последняя версия", 400);

        let mut state = CallLiveTranscriptionState::default();
        restore_transcript_checkpoints(&directory, &mut state);

        assert_eq!(state.mic_text.as_deref(), Some("последняя версия"));
        assert_eq!(state.system_text.as_deref(), Some("ответ собеседника"));

        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn atomically_replaces_existing_session_manifest() {
        let directory = test_directory("manifest-replace");
        let mut session = CallCaptureSession {
            id: "call-test".to_string(),
            platform: "test".to_string(),
            status: CallCaptureStatus::Starting,
            started_at: Utc::now().to_rfc3339(),
            ended_at: None,
            directory: directory.to_string_lossy().to_string(),
            tracks: Vec::new(),
            native_mic_active: false,
            live_transcription: None,
        };
        write_manifest(&session).expect("write initial manifest");
        session.status = CallCaptureStatus::Recording;
        write_manifest(&session).expect("replace manifest");

        let restored = read_manifest(&directory).expect("read replaced manifest");
        assert_eq!(restored.status, CallCaptureStatus::Recording);
        assert!(!directory.join("manifest.json.tmp").exists());

        fs::remove_dir_all(directory).expect("remove test directory");
    }
}
