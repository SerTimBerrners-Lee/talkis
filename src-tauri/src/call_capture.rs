use crate::logger;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
#[cfg(target_os = "macos")]
use std::fs::File;
#[cfg(target_os = "macos")]
use std::io::BufWriter;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use objc2::AnyThread;
#[cfg(target_os = "macos")]
use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceIsStackedKey,
    kAudioAggregateDeviceMainSubDeviceKey, kAudioAggregateDeviceNameKey,
    kAudioAggregateDeviceSubDeviceListKey, kAudioAggregateDeviceTapAutoStartKey,
    kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey, kAudioDevicePropertyDeviceUID,
    kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioSubDeviceUIDKey,
    kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey, kAudioTapPropertyFormat,
    AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProc, AudioDeviceIOProcID,
    AudioDeviceStart, AudioDeviceStop, AudioHardwareCreateAggregateDevice,
    AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice,
    AudioHardwareDestroyProcessTap, AudioObjectGetPropertyData, AudioObjectID,
    AudioObjectPropertyAddress, AudioObjectPropertySelector, CATapDescription, CATapMuteBehavior,
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

static SESSIONS: OnceLock<Mutex<HashMap<String, StoredCallCaptureSession>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, StoredCallCaptureSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCallCaptureRequest {
    pub target_id: Option<String>,
    #[serde(default = "default_true")]
    pub include_mic: bool,
    #[serde(default = "default_true")]
    pub include_system: bool,
    pub mic_device_id: Option<String>,
    pub sample_rate: Option<u32>,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CallCaptureTrackKind {
    Mic,
    System,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CallCaptureStatus {
    Starting,
    Recording,
    Stopped,
    Failed,
}

#[derive(Clone, Debug)]
struct StoredCallCaptureSession {
    session: CallCaptureSession,
    #[cfg(target_os = "macos")]
    macos: Option<MacosCallCaptureState>,
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
    writer: Mutex<hound::WavWriter<BufWriter<File>>>,
    stream_description: AudioStreamBasicDescription,
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

fn call_capture_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|err| format!("Не удалось найти папку данных Talkis: {}", err))
        .map(|dir| dir.join("call-capture"))
}

fn create_session_dir(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let dir = call_capture_root(app)?.join(session_id);
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Не удалось подготовить папку записи созвона: {}", err))?;
    Ok(dir)
}

fn write_manifest(session: &CallCaptureSession) -> Result<(), String> {
    let path = PathBuf::from(&session.directory).join("manifest.json");
    let json = serde_json::to_string_pretty(session)
        .map_err(|err| format!("Не удалось подготовить manifest созвона: {}", err))?;
    fs::write(path, json).map_err(|err| format!("Не удалось сохранить manifest созвона: {}", err))
}

fn build_session(
    app: &AppHandle,
    req: &StartCallCaptureRequest,
) -> Result<CallCaptureSession, String> {
    if !req.include_mic && !req.include_system {
        return Err("Выберите хотя бы одну дорожку для записи созвона.".to_string());
    }

    let session_id = uuid_like_id();
    let dir = create_session_dir(app, &session_id)?;
    let sample_rate = req.sample_rate.unwrap_or(48_000);
    let mut tracks = Vec::new();

    if req.include_mic {
        tracks.push(CallCaptureTrack {
            kind: CallCaptureTrackKind::Mic,
            label: "Вы".to_string(),
            path: dir.join("mic.wav").to_string_lossy().to_string(),
            channels: 1,
            sample_rate,
        });
    }

    if req.include_system {
        tracks.push(CallCaptureTrack {
            kind: CallCaptureTrackKind::System,
            label: "Созвон".to_string(),
            path: dir.join("system.wav").to_string_lossy().to_string(),
            channels: 2,
            sample_rate,
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

#[tauri::command]
pub async fn list_call_capture_targets() -> Result<Vec<CaptureTarget>, String> {
    Ok(platform_targets())
}

#[tauri::command]
pub async fn start_call_capture(
    app: AppHandle,
    req: StartCallCaptureRequest,
) -> Result<CallCaptureSession, String> {
    let mut session = build_session(&app, &req)?;
    logger::log_info(
        "CALL_CAPTURE",
        &format!(
            "Starting call capture session={}, platform={}, target={:?}",
            session.id, session.platform, req.target_id
        ),
    );

    let platform_state = start_platform_capture(&session, &req)?;
    session.status = CallCaptureStatus::Recording;
    write_manifest(&session)?;

    sessions()
        .lock()
        .map_err(|_| "Не удалось заблокировать менеджер записи созвона.".to_string())?
        .insert(
            session.id.clone(),
            StoredCallCaptureSession {
                session: session.clone(),
                #[cfg(target_os = "macos")]
                macos: platform_state,
            },
        );

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

    stop_platform_capture(&mut stored)?;
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

    start_macos_system_audio_capture(session)
}

#[cfg(target_os = "windows")]
fn start_platform_capture(
    _session: &CallCaptureSession,
    _req: &StartCallCaptureRequest,
) -> Result<(), String> {
    Err("Захват созвона на Windows будет подключен через WASAPI loopback.".to_string())
}

#[cfg(target_os = "linux")]
fn start_platform_capture(
    _session: &CallCaptureSession,
    _req: &StartCallCaptureRequest,
) -> Result<(), String> {
    Err("Захват созвона на Linux будет подключен через PipeWire monitor source.".to_string())
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

#[cfg(not(target_os = "macos"))]
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
fn read_audio_cf_string(
    object_id: AudioObjectID,
    selector: AudioObjectPropertySelector,
) -> Result<String, String> {
    let mut address = audio_property_address(selector);
    let mut size = std::mem::size_of::<*const CFString>() as u32;
    let mut value: *const CFString = std::ptr::null();
    let status = unsafe {
        AudioObjectGetPropertyData(
            object_id,
            NonNull::from(&mut address),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::new((&mut value as *mut *const CFString).cast())
                .ok_or_else(|| "CoreAudio CFString output pointer is null.".to_string())?,
        )
    };
    status_result(status, "AudioObjectGetPropertyData CFString")?;

    let value = NonNull::new(value as *mut CFString)
        .ok_or_else(|| "CoreAudio вернул пустой CFString.".to_string())?;
    let retained = unsafe { value.as_ref() }.retain();
    Ok(retained.to_string())
}

#[cfg(target_os = "macos")]
fn read_default_output_device() -> Result<AudioObjectID, String> {
    let value = read_audio_property(
        kAudioObjectSystemObject as AudioObjectID,
        kAudioHardwarePropertyDefaultOutputDevice,
        0 as AudioObjectID,
    )?;

    if value == 0 {
        Err("CoreAudio не вернул output-устройство.".to_string())
    } else {
        Ok(value)
    }
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
    output_uid: &str,
    tap_uuid: &str,
) -> Result<CFRetained<CFDictionary<CFString, CFType>>, String> {
    let name_key = cf_key(kAudioAggregateDeviceNameKey)?;
    let uid_key = cf_key(kAudioAggregateDeviceUIDKey)?;
    let main_key = cf_key(kAudioAggregateDeviceMainSubDeviceKey)?;
    let private_key = cf_key(kAudioAggregateDeviceIsPrivateKey)?;
    let stacked_key = cf_key(kAudioAggregateDeviceIsStackedKey)?;
    let auto_start_key = cf_key(kAudioAggregateDeviceTapAutoStartKey)?;
    let sub_device_list_key = cf_key(kAudioAggregateDeviceSubDeviceListKey)?;
    let tap_list_key = cf_key(kAudioAggregateDeviceTapListKey)?;
    let sub_device_uid_key = cf_key(kAudioSubDeviceUIDKey)?;
    let sub_tap_drift_key = cf_key(kAudioSubTapDriftCompensationKey)?;
    let sub_tap_uid_key = cf_key(kAudioSubTapUIDKey)?;

    let name = CFString::from_str(&format!("Talkis Call Capture {}", session_id));
    let aggregate_uid = CFString::from_str(&format!("com.trixter.talkis.call.{}", session_id));
    let output_uid = CFString::from_str(output_uid);
    let tap_uuid = CFString::from_str(tap_uuid);
    let true_value = CFBoolean::new(true);
    let false_value = CFBoolean::new(false);

    let sub_device = CFDictionary::<CFString, CFType>::from_slices(
        &[sub_device_uid_key.as_ref()],
        &[cf_type::<CFString>(&output_uid)],
    );
    let sub_devices =
        CFArray::<CFDictionary<CFString, CFType>>::from_objects(&[sub_device.as_ref()]);

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
            main_key.as_ref(),
            private_key.as_ref(),
            stacked_key.as_ref(),
            auto_start_key.as_ref(),
            sub_device_list_key.as_ref(),
            tap_list_key.as_ref(),
        ],
        &[
            cf_type::<CFString>(&name),
            cf_type::<CFString>(&aggregate_uid),
            cf_type::<CFString>(&output_uid),
            cf_type::<CFBoolean>(true_value),
            cf_type::<CFBoolean>(false_value),
            cf_type::<CFBoolean>(true_value),
            cf_type::<CFArray<CFDictionary<CFString, CFType>>>(&sub_devices),
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

    if is_float && stream.mBitsPerChannel == 32 {
        if is_non_interleaved {
            let min_samples = buffers
                .iter()
                .map(|buffer| buffer.mDataByteSize as usize / std::mem::size_of::<f32>())
                .min()
                .unwrap_or(0);

            for index in 0..min_samples {
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
                    let _ = writer.write_sample(samples[index]);
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
                for sample in samples {
                    let _ = writer.write_sample(*sample);
                }
            }
        }
    } else if is_signed_int && stream.mBitsPerChannel == 16 {
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
            for sample in samples {
                let _ = writer.write_sample(*sample);
            }
        }
    }

    0
}

#[cfg(target_os = "macos")]
fn system_track_path(session: &CallCaptureSession) -> Result<PathBuf, String> {
    session
        .tracks
        .iter()
        .find(|track| matches!(track.kind, CallCaptureTrackKind::System))
        .map(|track| PathBuf::from(&track.path))
        .ok_or_else(|| "В сессии созвона нет системной дорожки.".to_string())
}

#[cfg(target_os = "macos")]
fn start_macos_system_audio_capture(
    session: &CallCaptureSession,
) -> Result<Option<MacosCallCaptureState>, String> {
    let output_device = read_default_output_device()?;
    let output_uid = read_audio_cf_string(output_device, kAudioDevicePropertyDeviceUID)?;
    let empty_processes = NSArray::<NSNumber>::from_slice(&[]);
    let tap_description = unsafe {
        CATapDescription::initStereoGlobalTapButExcludeProcesses(
            CATapDescription::alloc(),
            &empty_processes,
        )
    };
    let tap_name = NSString::from_str("Talkis Call Capture");
    let tap_uuid = NSUUID::new();

    unsafe {
        tap_description.setName(&tap_name);
        tap_description.setUUID(&tap_uuid);
        tap_description.setPrivate(true);
        tap_description.setMixdown(true);
        tap_description.setMuteBehavior(CATapMuteBehavior::Unmuted);
    }

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
    let aggregate_description =
        build_macos_aggregate_description(&session.id, &output_uid, &tap_uuid_string)?;
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

    let path = system_track_path(session)?;
    let channels = stream_description
        .mChannelsPerFrame
        .max(1)
        .min(u16::MAX as u32) as u16;
    let sample_rate = stream_description.mSampleRate.max(1.0).round() as u32;
    let is_float = (stream_description.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    let bits_per_sample = if is_float {
        32
    } else {
        stream_description.mBitsPerChannel.max(16).min(32) as u16
    };
    let sample_format = if is_float {
        hound::SampleFormat::Float
    } else {
        hound::SampleFormat::Int
    };
    let writer = match hound::WavWriter::create(
        &path,
        hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample,
            sample_format,
        },
    ) {
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
        writer: Mutex::new(writer),
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
            "Started macOS system audio capture session={}, tap={}, aggregate={}, format={}Hz/{}ch/{}bit",
            session.id, tap_id, aggregate_device_id, sample_rate, channels, bits_per_sample
        ),
    );

    Ok(Some(MacosCallCaptureState {
        tap_id,
        aggregate_device_id,
        io_proc_id,
        callback_state_ptr: callback_state_ptr as usize,
    }))
}
