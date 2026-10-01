use std::sync::mpsc;
use std::time::Duration;

pub(crate) const MICROPHONE_START_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) fn wait_for_start<T>(
    response_rx: mpsc::Receiver<Result<T, String>>,
    timeout: Duration,
    timeout_message: &str,
    disconnected_message: &str,
) -> Result<T, String> {
    match response_rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(timeout_message.to_string()),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(disconnected_message.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait<T>(
        receiver: mpsc::Receiver<Result<T, String>>,
        timeout: Duration,
    ) -> Result<T, String> {
        wait_for_start(receiver, timeout, "startup timeout", "owner disconnected")
    }

    #[test]
    fn accepts_ready_stream() {
        let (sender, receiver) = mpsc::sync_channel(0);
        let owner = std::thread::spawn(move || sender.send(Ok(42)));

        assert_eq!(wait(receiver, Duration::from_secs(1)), Ok(42));
        assert!(owner.join().expect("owner thread").is_ok());
    }

    #[test]
    fn preserves_driver_error_for_fallback() {
        let (sender, receiver) = mpsc::sync_channel(0);
        let owner =
            std::thread::spawn(move || sender.send(Err::<(), _>("device lost".to_string())));

        assert_eq!(
            wait(receiver, Duration::from_secs(1)),
            Err("device lost".to_string())
        );
        assert!(owner.join().expect("owner thread").is_ok());
    }

    #[test]
    fn stalled_driver_times_out_and_rejects_late_stream() {
        let (sender, receiver) = mpsc::sync_channel(0);

        assert_eq!(
            wait::<u32>(receiver, Duration::from_millis(10)),
            Err("startup timeout".to_string())
        );
        assert_eq!(
            sender.send(Ok(42)).expect_err("late stream rejected").0,
            Ok(42)
        );
    }

    #[test]
    fn owner_shutdown_returns_without_waiting_for_timeout() {
        let (sender, receiver) = mpsc::sync_channel::<Result<(), String>>(0);
        drop(sender);

        assert_eq!(
            wait(receiver, Duration::from_secs(60)),
            Err("owner disconnected".to_string())
        );
    }
}
