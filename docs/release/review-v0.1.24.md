# Release Review v0.1.24

## Release

- Version: `0.1.24`
- Release branch: `release/v0.1.24`
- Target tag: `v0.1.24`
- Reviewer: Codex
- Date: 2026-05-25

## Scope

- Key changes included in this release:
  - Call recording now retries with the system default microphone when the saved selected microphone device ID fails.
  - Call recording start logs now preserve the raw WebView `DOMException` name/message for microphone failures.
  - User-facing microphone errors distinguish permission denial, busy/unavailable microphone, missing selected device, and startup aborts.
- User-facing changes:
  - Pressing the phone button should no longer fail only because a previously saved `micId` became stale after update or device reconnect.
  - If both selected and default microphone startup fail, the widget shows a more specific Russian error.
  - README documents the selected-microphone fallback for call recording.
- Risky areas:
  - The change touches only call-recording microphone preflight; ordinary dictation still uses the existing native/WebView recording path.
  - The call mic stream is still handed to the existing recording runtime after permission and fallback resolution.

## Checks run

- `bun run check:release`: passed.
- `TAURI_SIGNING_PRIVATE_KEY_PATH=/Users/trixter/.tauri/talkis-updater.key bun run build:release:macos`: app, DMG, and updater tarball were built; command failed at updater signing with `incorrect updater private key password: Device not configured (os error 6)`.
- Native/GitHub Windows build: pending GitHub Actions for `v0.1.24`.
- Native/GitHub Linux build: pending GitHub Actions for `v0.1.24`.
- Additional manual checks:
  - `bunx tsc --noEmit` passed before release prep.
  - `cargo check --manifest-path src-tauri/Cargo.toml` passed before release prep.
  - `git diff --check` passed after the code edit and again after release prep.
  - `bun run check:versions` passed for `0.1.24`.
  - Initial sandboxed macOS build left a temporary DMG mounted because `hdiutil detach` was denied; rerunning outside the sandbox reached the expected updater-signing failure and left no mounted image.

## Manual review

- Hotkey flow:
  - No hotkey state-machine changes in this release.
  - Ordinary voice recording paths are unchanged.
- Onboarding permissions:
  - Permission version remains `3`.
  - Only true permission-denied microphone errors reset the permissions flag; stale selected-device fallback does not.
- Widget position and notice behavior:
  - Existing call error state and notice behavior are reused.
  - The call bubble still uses the `starting` state while permissions and mic fallback resolve.
- Transcription quality and short-utterance handling:
  - No STT, ffmpeg, hallucination filter, diarization, or transcript assembly changes in this release.
- README refreshed:
  - Current version updated to `0.1.24`.
  - Call recording docs now state that Talkis falls back to the system default microphone when the saved selected microphone is unavailable.

## Findings

- Blockers:
  - None for pushing the GitHub Actions release, assuming repository updater signing secrets remain configured as in prior successful releases.
- Non-blocking issues:
  - Local updater artifact signing could not be completed because this shell does not have the updater private key password configured.
  - The exact installed-app microphone behavior should be confirmed after the GitHub-built updater package is installed.
- Follow-ups after release:
  - Confirm GitHub Actions publishes `latest.json`, macOS, Windows, and Linux artifacts.
  - After installing `0.1.24`, press the phone button with the current saved microphone setting and confirm the call recording starts or shows a specific raw-backed error.

## Decision

- Ready for `main` merge: yes.
- Ready for tag publish: yes, with updater signing delegated to GitHub Actions secrets.
