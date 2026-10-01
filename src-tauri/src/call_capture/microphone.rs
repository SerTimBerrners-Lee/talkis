use crate::audio_capture_startup::{wait_for_start, MICROPHONE_START_TIMEOUT};
use crate::live_dictation::{
    self, LiveDictationFeeder, LiveDictationSession, LiveDictationStartRequest,
};
use crate::logger;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

const CHECKPOINT_SECONDS: u64 = 5;
const STOP_TIMEOUT: Duration = Duration::from_secs(3);

static CAPTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct CallMicrophoneCapture {
    stop_tx: mpsc::Sender<()>,
    stopped_rx: mpsc::Receiver<Result<(), String>>,
    paused: Arc<AtomicBool>,
    live_session: Option<LiveDictationSession>,
    pub device_name: String,
    pub sample_rate: u32,
    pub path: PathBuf,
}

struct CallMicrophoneWriter {
    writer: hound::WavWriter<BufWriter<File>>,
    samples_since_checkpoint: u64,
    checkpoint_samples: u64,
}

struct StartedCapture {
    device_name: String,
    sample_rate: u32,
    live_session: Option<LiveDictationSession>,
}

impl CallMicrophoneWriter {
    fn create(path: PathBuf, sample_rate: u32) -> Result<Self, String> {
        let writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .map_err(|error| {
            format!(
                "Не удалось создать WAV-дорожку микрофона {}: {}",
                path.display(),
                error
            )
        })?;
        Ok(Self {
            writer,
            samples_since_checkpoint: 0,
            checkpoint_samples: u64::from(sample_rate) * CHECKPOINT_SECONDS,
        })
    }

    fn write_samples(&mut self, samples: &[f32]) {
        for sample in samples {
            if let Err(error) = self.writer.write_sample(float_to_pcm16(*sample)) {
                logger::log_error(
                    "CALL_CAPTURE",
                    &format!("Failed to write call microphone sample: {}", error),
                );
                return;
            }
            self.samples_since_checkpoint = self.samples_since_checkpoint.saturating_add(1);
        }

        if self.samples_since_checkpoint < self.checkpoint_samples {
            return;
        }
        self.samples_since_checkpoint = 0;
        if let Err(error) = self.writer.flush() {
            logger::log_error(
                "CALL_CAPTURE",
                &format!("Failed to checkpoint call microphone WAV: {}", error),
            );
        }
    }

    fn finalize(self) -> Result<(), String> {
        self.writer
            .finalize()
            .map_err(|error| format!("Не удалось завершить WAV-дорожку микрофона: {}", error))
    }
}

impl CallMicrophoneCapture {
    pub fn has_live_session(&self) -> bool {
        self.live_session.is_some()
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
    }

    pub fn stop(self) -> (Option<LiveDictationSession>, Result<(), String>) {
        let result = self
            .stop_tx
            .send(())
            .map_err(|_| "Не удалось остановить нативную запись микрофона созвона.".to_string())
            .and_then(|_| match self.stopped_rx.recv_timeout(STOP_TIMEOUT) {
                Ok(Ok(())) => Ok(()),
                Ok(Err(error)) => Err(error),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    Err("Нативная запись микрофона созвона не остановилась вовремя.".to_string())
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    logger::log_error(
                        "CALL_CAPTURE",
                        "Call microphone thread ended before stop acknowledgement",
                    );
                    Ok(())
                }
            });
        (self.live_session, result)
    }
}

pub fn start(
    app: AppHandle,
    path: PathBuf,
    device_label: Option<String>,
    live_request: Option<LiveDictationStartRequest>,
) -> Result<CallMicrophoneCapture, String> {
    let paused = Arc::new(AtomicBool::new(false));
    let thread_paused = Arc::clone(&paused);
    // A late native start must never overwrite the WebView fallback's mic.wav.
    let sequence = CAPTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = path.with_file_name(format!("mic-native-{}-{sequence}.wav", std::process::id()));
    let thread_path = path.clone();
    let (started_tx, started_rx) = mpsc::sync_channel(0);
    let (stop_tx, stop_rx) = mpsc::channel();
    let (stopped_tx, stopped_rx) = mpsc::channel();

    std::thread::Builder::new()
        .name("talkis-call-microphone".to_string())
        .spawn(move || {
            run_thread(
                app,
                thread_path,
                device_label,
                live_request,
                thread_paused,
                started_tx,
                stop_rx,
                stopped_tx,
            )
        })
        .map_err(|error| format!("Не удалось создать поток микрофона созвона: {}", error))?;

    let started = wait_for_start(
        started_rx,
        MICROPHONE_START_TIMEOUT,
        "Микрофон созвона не ответил вовремя. Используется резервный способ записи.",
        "Поток микрофона созвона завершился до запуска.",
    )?;

    Ok(CallMicrophoneCapture {
        stop_tx,
        stopped_rx,
        paused,
        live_session: started.live_session,
        device_name: started.device_name,
        sample_rate: started.sample_rate,
        path,
    })
}

fn run_thread(
    app: AppHandle,
    path: PathBuf,
    device_label: Option<String>,
    live_request: Option<LiveDictationStartRequest>,
    paused: Arc<AtomicBool>,
    started_tx: mpsc::SyncSender<Result<StartedCapture, String>>,
    stop_rx: mpsc::Receiver<()>,
    stopped_tx: mpsc::Sender<Result<(), String>>,
) {
    let start_result = (|| {
        let host = cpal::default_host();
        let device = select_device(&host, device_label.as_deref())?;
        let device_name = device
            .name()
            .unwrap_or_else(|_| "System microphone".to_string());
        let supported = device
            .default_input_config()
            .map_err(|error| format!("Не удалось прочитать формат микрофона: {}", error))?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let channels = usize::from(config.channels.max(1));
        let sample_rate = config.sample_rate.0;
        let writer = Arc::new(Mutex::new(Some(CallMicrophoneWriter::create(
            path.clone(),
            sample_rate,
        )?)));
        let live_session =
            live_dictation::start_live_dictation_session(app, live_request, sample_rate);
        let live_feeder = live_session.as_ref().map(LiveDictationSession::feeder);
        let error_fn = |error| {
            logger::log_error(
                "CALL_CAPTURE",
                &format!("Call microphone stream error: {}", error),
            )
        };
        let stream_result = match sample_format {
            cpal::SampleFormat::F32 => build_stream(
                &device,
                &config,
                channels,
                Arc::clone(&writer),
                Arc::clone(&paused),
                live_feeder,
                |sample: f32| sample,
                error_fn,
            ),
            cpal::SampleFormat::I16 => build_stream(
                &device,
                &config,
                channels,
                Arc::clone(&writer),
                Arc::clone(&paused),
                live_feeder,
                |sample: i16| sample as f32 / i16::MAX as f32,
                error_fn,
            ),
            cpal::SampleFormat::U16 => build_stream(
                &device,
                &config,
                channels,
                Arc::clone(&writer),
                Arc::clone(&paused),
                live_feeder,
                |sample: u16| (sample as f32 - 32_768.0) / 32_768.0,
                error_fn,
            ),
            other => {
                if let Some(session) = live_session {
                    live_dictation::cancel_live_dictation_session(session);
                }
                return Err(format!(
                    "Формат микрофона {:?} пока не поддерживается.",
                    other
                ));
            }
        }
        .map_err(|error| format!("Не удалось открыть микрофон созвона: {}", error));

        let stream = match stream_result {
            Ok(stream) => stream,
            Err(error) => {
                if let Some(session) = live_session {
                    live_dictation::cancel_live_dictation_session(session);
                }
                return Err(error);
            }
        };

        if let Err(error) = stream.play() {
            if let Some(session) = live_session {
                live_dictation::cancel_live_dictation_session(session);
            }
            return Err(format!("Не удалось запустить микрофон созвона: {error}"));
        }

        Ok((stream, writer, device_name, sample_rate, live_session))
    })();

    let (stream, writer, device_name, sample_rate, live_session) = match start_result {
        Ok(value) => value,
        Err(error) => {
            let _ = started_tx.send(Err(error));
            let _ = std::fs::remove_file(&path);
            return;
        }
    };

    let feeder_session = live_session;
    if let Err(send_error) = started_tx.send(Ok(StartedCapture {
        device_name: device_name.clone(),
        sample_rate,
        live_session: feeder_session,
    })) {
        drop(stream);
        if let Ok(started) = send_error.0 {
            if let Some(session) = started.live_session {
                live_dictation::cancel_live_dictation_session(session);
            }
        }
        let _ = finalize_writer(&writer);
        let _ = std::fs::remove_file(&path);
        logger::log_info(
            "CALL_CAPTURE",
            "Released late call microphone startup after timeout",
        );
        return;
    }

    logger::log_info(
        "CALL_CAPTURE",
        &format!(
            "Started native call microphone: device={}, source={}Hz, stored=mono/PCM16",
            device_name, sample_rate
        ),
    );

    let _ = stop_rx.recv();
    drop(stream);
    let result = finalize_writer(&writer);
    let _ = stopped_tx.send(result);
}

fn finalize_writer(writer: &Arc<Mutex<Option<CallMicrophoneWriter>>>) -> Result<(), String> {
    writer
        .lock()
        .map_err(|_| "Не удалось заблокировать WAV-дорожку микрофона.".to_string())
        .and_then(|mut guard| match guard.take() {
            Some(writer) => writer.finalize(),
            None => Ok(()),
        })
}

fn select_device(host: &cpal::Host, requested_label: Option<&str>) -> Result<cpal::Device, String> {
    if let Some(label) = requested_label
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let normalized = label.to_lowercase();
        let devices = host
            .input_devices()
            .map_err(|error| format!("Не удалось получить список микрофонов: {}", error))?;
        for device in devices {
            let Ok(name) = device.name() else {
                continue;
            };
            if name == label || name.to_lowercase() == normalized {
                return Ok(device);
            }
        }
        return Err(format!("Выбранный микрофон недоступен: {}", label));
    }

    host.default_input_device()
        .ok_or_else(|| "Системный микрофон не найден.".to_string())
}

fn build_stream<T, F>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    writer: Arc<Mutex<Option<CallMicrophoneWriter>>>,
    paused: Arc<AtomicBool>,
    live_feeder: Option<LiveDictationFeeder>,
    normalize: F,
    error_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample,
    F: Fn(T) -> f32 + Send + Sync + 'static,
{
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            if paused.load(Ordering::Relaxed) || channels == 0 {
                return;
            }
            let mono = data
                .chunks(channels)
                .filter(|frame| !frame.is_empty())
                .map(|frame| {
                    frame.iter().copied().map(&normalize).sum::<f32>() / frame.len() as f32
                })
                .collect::<Vec<_>>();
            if mono.is_empty() {
                return;
            }
            if let Some(feeder) = live_feeder.as_ref() {
                live_dictation::feed_source_samples(feeder, &mono);
            }
            if let Ok(mut guard) = writer.lock() {
                if let Some(writer) = guard.as_mut() {
                    writer.write_samples(&mono);
                }
            }
        },
        error_fn,
        None,
    )
}

fn float_to_pcm16(sample: f32) -> i16 {
    let sample = sample.clamp(-1.0, 1.0);
    if sample < 0.0 {
        (sample * 32_768.0).round() as i16
    } else {
        (sample * 32_767.0).round() as i16
    }
}
