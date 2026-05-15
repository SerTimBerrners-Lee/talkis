# Release Review v0.1.20

## Release

- Version: 0.1.20
- Release branch: release/v0.1.20
- Target tag: v0.1.20
- Reviewer: Codex
- Date: 2026-05-15

## Scope

- Key changes included in this release:
  - Cloud file speaker diarization now routes through `proxy.talkis.ru/api/transcribe-diarized`.
  - Desktop checks Talkis Cloud profile state and proxy capabilities before enabling cloud speaker diarization.
  - Cloud mode no longer silently falls back to local diarization when cloud diarization is unavailable.
  - File audio for cloud diarization is prepared as compressed mono MP3 before upload.
- User-facing changes:
  - In Cloud mode, `Разделить по говорящим` uses Talkis Cloud / AssemblyAI instead of local Whisper.
  - If Cloud speaker diarization is unavailable, Talkis shows an error instead of starting a slow local job.
  - Processing status names Talkis Cloud while the cloud diarization job is running.
- Risky areas:
  - Cloud diarization depends on active PRO status and proxy `/api/capabilities`.
  - Large-file preparation still depends on the bundled ffmpeg sidecar.

## Checks run

- `bun run check:release` — passed.
- `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/talkis-updater.key bun run build:release:macos` — built app, DMG, and updater archive, then failed at updater signature because the local key password is not configured.
- Native/GitHub Windows build: pending GitHub Actions for `v0.1.20`.
- Native/GitHub Linux build: pending GitHub Actions for `v0.1.20`.
- Additional manual checks:
  - `curl https://proxy.talkis.ru/api/capabilities` returns `speakerDiarization: true`.
  - `bunx tsc --noEmit` passed.
  - `cargo check --manifest-path src-tauri/Cargo.toml` passed.

## Manual review

- Hotkey flow: unchanged in this release; smoke tests passed.
- Onboarding permissions: unchanged.
- Widget position and notice behavior: unchanged.
- Transcription quality and short-utterance handling: unchanged for voice recording.
- README refreshed: yes, file transcription and privacy sections now document cloud speaker diarization.

## Findings

- Blockers:
  - Local updater signing could not complete without the private key password in the local environment.
- Non-blocking issues:
  - AssemblyAI runtime latency depends on file length and provider queue time.
- Follow-ups after release:
  - Verify GitHub Actions publish signed updater assets for macOS, Windows, and Linux.
  - Test one PRO account end-to-end with Cloud mode + `Разделить по говорящим`.

## Decision

- Ready for `main` merge: yes, assuming GitHub release secrets are configured.
- Ready for tag publish: yes, via GitHub Actions signing secrets.
