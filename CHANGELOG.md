# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Extracted `formatErrorMessage` into shared `src/lib/utils.ts` (was duplicated 3×)
- Extracted `create_settings_window` helper in Rust backend (was duplicated in `open_settings` and `open_settings_tab`)
- Reused HTTP client via `OnceLock<reqwest::Client>` singleton instead of creating per-request
- Logger mutex now recovers from poisoning instead of panicking
- Temperature is now configurable per transcription style (classic=0.0, business=0.1, tech=0.15)
- Added version-sync check (`scripts/check-version-sync.sh`) to `check:release` pipeline
- Synchronized `NOTICE_WIDGET_GAP` constant between TypeScript and Rust

### Added
- `CHANGELOG.md` (this file)

## [0.1.7] - 2026-03-27

### Fixed
- Reset stale macOS Accessibility permission entry before sending user to System Settings
- Explain the reset behavior in the onboarding permission screen

## [0.1.6] - 2026-03-26

### Added
- Initial public release with voice-to-text transcription
- Whisper API integration for speech recognition
- GPT-4o-mini integration for text cleanup
- Three transcription styles: Classic, Business, Tech
- Global hotkey with push-to-talk and double-tap lock modes
- Widget with waveform visualization
- Settings window with language, microphone, and hotkey configuration
- Transcription history with copy and retry
- macOS permissions onboarding flow
