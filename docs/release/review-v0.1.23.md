# Release Review v0.1.23

## Release

- Version: `0.1.23`
- Release branch: `release/v0.1.23`
- Target tag: `v0.1.23`
- Reviewer: Codex
- Date: 2026-05-25

## Scope

- Key changes included in this release:
  - Call recording now explicitly requests microphone and macOS system audio permissions before starting.
  - Call recording start failures now map raw WebView/CoreAudio errors to user-facing Russian messages.
  - Widget notice overlay is shown for call-recording permission failures instead of leaving only the red `!` state.
  - Permission onboarding version was bumped so existing installs re-check the new system-audio requirement.
- User-facing changes:
  - Users see why call recording failed and which permission needs action.
  - Settings/onboarding can reappear after a call-recording permission failure.
  - README documents call recording permissions and troubleshooting.
- Risky areas:
  - macOS system audio permission probing starts and immediately stops a short native capture session.
  - Existing widget notice behavior is reused from call mode without changing the notice window implementation.

## Checks run

- `bun run check:release`: passed.
- `TAURI_SIGNING_PRIVATE_KEY_PATH=/Users/trixter/.tauri/talkis-updater.key bun run build:release:macos`: app, DMG, and updater tarball were built; command failed at updater signing with `incorrect updater private key password: Device not configured (os error 6)`.
- Native/GitHub Windows build: pending GitHub Actions for `v0.1.23`
- Native/GitHub Linux build: pending GitHub Actions for `v0.1.23`
- Additional manual checks:
  - `bunx tsc --noEmit` passed before release prep.
  - `cargo check --manifest-path src-tauri/Cargo.toml` passed before release prep.
  - `git diff --check` passed before release prep.
  - `bun run check:versions` passed inside `bun run check:release`.

## Manual review

- Hotkey flow:
  - No hotkey state-machine changes in this release.
  - Ordinary voice recording still pauses/resumes call mic capture through the existing call-mic runtime hooks.
- Onboarding permissions:
  - Permission version bumped from `2` to `3`.
  - Permission failures during call recording reset the passed flag so settings can ask again.
  - README now documents microphone and macOS system-audio access for call recording.
- Widget position and notice behavior:
  - Existing widget notice window is reused for call-recording errors.
  - Call bubble has a new `starting` state with spinner while permissions are requested.
- Transcription quality and short-utterance handling:
  - No STT, ffmpeg, hallucination filter, or transcript assembly changes in this release.
- README refreshed:
  - Current version updated to `0.1.23`.
  - Call recording usage, permissions, and troubleshooting added.

## Findings

- Blockers:
  - None for pushing the GitHub Actions release, assuming repository updater signing secrets remain configured as in prior releases.
- Non-blocking issues:
  - Manual macOS permission prompt validation should be done against the built app because TCC state depends on the installed bundle.
  - Local macOS updater signing could not be validated because the updater private key password is not configured in this local shell.
- Follow-ups after release:
  - Confirm the GitHub Actions release publishes `latest.json`, macOS, Windows, and Linux artifacts.
  - Verify a fresh installed macOS build surfaces the system-audio permission prompt when pressing the phone button.

## Decision

- Ready for `main` merge: yes.
- Ready for tag publish: yes, with updater signing delegated to GitHub Actions secrets.
