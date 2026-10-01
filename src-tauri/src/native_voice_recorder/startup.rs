use std::sync::mpsc;
use std::time::Duration;

pub(super) fn wait_for_start<T>(
    response_rx: mpsc::Receiver<Result<T, String>>,
    timeout: Duration,
) -> Result<T, String> {
    match response_rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("Микрофон не ответил вовремя. Используется резервный способ записи.".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Нативная запись завершилась до запуска.".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ready_stream() {
        let (response_tx, response_rx) = mpsc::sync_channel(0);
        let owner = std::thread::spawn(move || response_tx.send(Ok(42)));

        assert_eq!(wait_for_start(response_rx, Duration::from_secs(1)), Ok(42));
        assert!(owner.join().expect("owner thread").is_ok());
    }

    #[test]
    fn preserves_driver_error_for_fallback() {
        let (response_tx, response_rx) = mpsc::sync_channel(0);
        let owner = std::thread::spawn(move || {
            response_tx.send(Err::<(), _>("Microphone disconnected".to_string()))
        });

        assert_eq!(
            wait_for_start(response_rx, Duration::from_secs(1)),
            Err("Microphone disconnected".to_string())
        );
        assert!(owner.join().expect("owner thread").is_ok());
    }

    #[test]
    fn stalled_driver_times_out_and_rejects_late_stream() {
        let (response_tx, response_rx) = mpsc::sync_channel(0);

        let result = wait_for_start::<u32>(response_rx, Duration::from_millis(10));

        assert!(result
            .expect_err("driver must time out")
            .contains("не ответил вовремя"));
        // The real owner receives the rejected stream info and releases both
        // the microphone and its live transcription session.
        assert_eq!(
            response_tx
                .send(Ok(42))
                .expect_err("late stream rejected")
                .0,
            Ok(42)
        );
    }

    #[test]
    fn owner_shutdown_returns_error_without_waiting_for_timeout() {
        let (response_tx, response_rx) = mpsc::sync_channel::<Result<(), String>>(0);
        drop(response_tx);

        assert_eq!(
            wait_for_start(response_rx, Duration::from_secs(60)),
            Err("Нативная запись завершилась до запуска.".to_string())
        );
    }
}
