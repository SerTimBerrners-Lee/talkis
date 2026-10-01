//! Opt-in Windows hardware check. Records only sample counts in memory;
//! no audio is saved and no transcription service is contacted.
use super::*;

fn record_once(
    host: &cpal::Host,
    label: Option<&str>,
    pause: bool,
    inject_error: bool,
) -> Result<usize, String> {
    let device = select_input_device(host, label)?;
    let supported = device
        .default_input_config()
        .map_err(|err| err.to_string())?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let state = Arc::new(Mutex::new(NativeRecorderState::default()));
    let stream = build_input_stream(&device, &config, format, Arc::clone(&state), None)?;
    stream.play().map_err(|err| err.to_string())?;
    std::thread::sleep(Duration::from_millis(500));

    if pause {
        stream.pause().map_err(|err| err.to_string())?;
        std::thread::sleep(Duration::from_millis(200));
        let paused_count = state.lock().map_err(|err| err.to_string())?.samples.len();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(
            state.lock().map_err(|err| err.to_string())?.samples.len(),
            paused_count
        );
        stream.play().map_err(|err| err.to_string())?;
        std::thread::sleep(Duration::from_millis(500));
        assert!(state.lock().map_err(|err| err.to_string())?.samples.len() > paused_count);
    }

    if inject_error {
        mark_input_failed(
            &state,
            "Injected microphone disconnection for hardware smoke test".to_string(),
        );
        let captured = state.lock().map_err(|err| err.to_string())?.samples.len();
        std::thread::sleep(Duration::from_millis(200));
        let mut guard = state.lock().map_err(|err| err.to_string())?;
        assert!(guard.health.check(Instant::now(), false).is_some());
        assert_eq!(guard.samples.len(), captured);
    }

    drop_native_input_stream(stream)?;
    let sample_count = state.lock().map_err(|err| err.to_string())?.samples.len();
    if sample_count == 0 {
        return Err("Microphone did not deliver samples".to_string());
    }

    Ok(sample_count)
}

#[test]
#[ignore = "Needs a real Windows microphone; run explicitly with --ignored --nocapture"]
fn windows_microphone_restarts_after_idle_and_device_error() {
    // Keep the first WASAPI/COM owner alive for the entire test, as production
    // does. Run this exact test alone in its own process to avoid prior owners.
    let owner = std::thread::Builder::new()
        .name("talkis-microphone-smoke-owner".to_string())
        .spawn(|| -> Result<(), String> {
            warm_up_windows_wasapi_owner();
            let host = cpal::default_host();
            let label = select_input_device(&host, None)?
                .name()
                .map_err(|err| err.to_string())?;

            for cycle in 0..8 {
                let selected = if cycle % 2 == 0 {
                    None
                } else {
                    Some(label.as_str())
                };
                let samples = record_once(&host, selected, cycle == 3, cycle == 5)?;
                eprintln!("Microphone restart cycle {cycle}: samples={samples}");
            }

            assert!(select_input_device(&host, Some("talkis-missing-device-smoke-test")).is_err());
            let samples = record_once(&host, None, false, false)?;
            eprintln!("Recording after unavailable-device error: samples={samples}");

            let idle_seconds = std::env::var("TALKIS_RECORDER_IDLE_TEST_SECONDS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(20);
            eprintln!("Idle interval: {idle_seconds}s; manual sleep/resume can be tested here");
            std::thread::sleep(Duration::from_secs(idle_seconds));
            let samples = record_once(&host, None, false, false)?;
            eprintln!("Recording after idle: samples={samples}");

            Ok(())
        })
        .expect("persistent hardware test owner");

    owner
        .join()
        .expect("hardware owner did not panic")
        .expect("microphone smoke check");
}
