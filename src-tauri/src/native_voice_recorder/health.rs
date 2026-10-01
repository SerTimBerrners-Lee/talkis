use std::time::{Duration, Instant};

const INPUT_STALL_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) struct CaptureHealth {
    last_input_at: Instant,
    failure: Option<String>,
}

impl Default for CaptureHealth {
    fn default() -> Self {
        Self {
            last_input_at: Instant::now(),
            failure: None,
        }
    }
}

impl CaptureHealth {
    pub(super) fn record_input(&mut self) {
        self.last_input_at = Instant::now();
    }

    pub(super) fn has_failed(&self) -> bool {
        self.failure.is_some()
    }

    pub(super) fn fail(&mut self, message: String) -> bool {
        if self.failure.is_some() {
            return false;
        }

        self.failure = Some(message);
        true
    }

    pub(super) fn check(&mut self, now: Instant, paused: bool) -> Option<&str> {
        if !paused && now.saturating_duration_since(self.last_input_at) >= INPUT_STALL_TIMEOUT {
            self.fail("Microphone stopped delivering audio for 5 seconds".to_string());
        }

        self.failure.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_missing_callbacks_without_confusing_silence_or_pause() {
        let start = Instant::now();
        let mut health = CaptureHealth {
            last_input_at: start,
            failure: None,
        };

        assert!(health
            .check(start + Duration::from_secs(4), false)
            .is_none());
        assert!(health
            .check(start + Duration::from_secs(60), true)
            .is_none());
        health.last_input_at = start + Duration::from_secs(60);
        assert!(health
            .check(start + Duration::from_secs(64), false)
            .is_none());
        assert!(health
            .check(start + Duration::from_secs(65), false)
            .is_some());
    }

    #[test]
    fn driver_failure_stays_visible_even_when_paused_or_callbacks_resume() {
        let mut health = CaptureHealth::default();
        assert!(health.fail("device disconnected".to_string()));
        assert!(!health.fail("second error".to_string()));
        health.record_input();

        assert_eq!(
            health.check(Instant::now(), true),
            Some("device disconnected")
        );
        assert!(!CaptureHealth::default().has_failed());
    }
}
