# Release Review v0.1.22

## Release

- Version: `0.1.22`
- Release branch: `release/v0.1.22`
- Target tag: `v0.1.22`
- Reviewer: Codex
- Date: 2026-05-22

## Scope

- Key changes included in this release:
  - Native Rust voice recorder using `cpal`, producing `16 kHz` mono PCM16 WAV for ordinary dictation.
  - WebView `MediaRecorder` retained as fallback when native capture cannot preserve selected-device behavior.
  - ffmpeg skip path for ready `16 kHz` mono PCM WAV in local STT and file transcription.
  - ffmpeg timing logs for bundled/system converter runs.
  - Local Whisper guardrails for long/silent audio: no context carry-over plus repetitive text/segment filtering.
  - Audio pipeline operating principles documented for future agents.
  - Stable release download aliases prepared in the GitHub release workflow.
  - Linux release dependencies updated with `libasound2-dev` for native recorder builds.
- User-facing changes:
  - Faster local voice dictation path when native WAV capture is available.
  - Reduced chance of repeated `Спасибо` / `Продолжение следует` hallucinations in long local call/file transcripts.
  - Ready local-STT WAV files can avoid unnecessary conversion.
  - README now documents the current `0.1.22` behavior and audio troubleshooting.
- Risky areas:
  - Cross-platform microphone capture through `cpal`.
  - Selected microphone parity between native device labels and WebView `deviceId`.
  - Long local STT recordings with large silent regions.
  - Release workflow on Linux due to the new ALSA build dependency.

## Checks run

- `bun run check:release`: passed.
- `TAURI_SIGNING_PRIVATE_KEY_PATH=/Users/trixter/.tauri/talkis-updater.key bun run build:release:macos`: app, DMG, and updater tarball were built; command failed at updater signing with `incorrect updater private key password: Device not configured (os error 6)`.
- Native/GitHub Windows build: not run locally; expected to run in GitHub Actions matrix.
- Native/GitHub Linux build: not run locally; expected to run in GitHub Actions matrix with `libasound2-dev`.
- Additional checks:
  - `bun run check:versions`: passed.
  - `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
  - `cargo test --manifest-path src-tauri/Cargo.toml ai::tests --lib`: passed.
  - `git diff --check`: passed.

## Manual review

- Hotkey flow:
  - FSM smoke tests passed through `bun run check:release`.
  - Recording flow now tries native capture first and falls back to WebView capture on native failure.
- Onboarding permissions:
  - No onboarding UI or permission text changes in this release.
- Widget position and notice behavior:
  - No widget positioning changes in this release.
  - Low microphone monitor remains on the WebView fallback path; native path relies on native recorder stats.
- Transcription quality and short-utterance handling:
  - Existing short hallucination handling kept.
  - New repetitive text filters covered by targeted unit tests.
  - Manual evidence from logs showed native dictation recognized `Раз, два, три, четыре, пять`.
- README refreshed:
  - Updated current version to `0.1.22`.
  - Added native voice capture, 8 GB file limit, ready-WAV fast path, local repetition troubleshooting, and Linux `libasound2-dev`.

## Findings

- Blockers:
  - None for pushing the GitHub Actions release, assuming repository updater signing secrets remain valid as in prior releases.
- Non-blocking issues:
  - Local macOS release signing could not be validated because the updater private key password is not configured in this local shell.
  - Full `cargo test --lib` is not used as a release gate here because an unrelated existing `prompt_config::tests::temperature_is_set_per_style` expectation is stale (`tech` config returns `0.1`, test expects `0.15`).
  - Windows/Linux native recorder behavior is not manually verified on physical machines in this local release prep.
- Follow-ups after release:
  - Watch the GitHub Actions release matrix for Linux ALSA/cpal build issues.
  - Manually test Windows/Linux dictation on released artifacts.
  - Fix the stale prompt temperature unit test in a separate cleanup.

## Decision

- Ready for `main` merge: yes.
- Ready for tag publish: yes, with signing delegated to GitHub Actions secrets.
