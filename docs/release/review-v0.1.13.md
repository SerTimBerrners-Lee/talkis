# Release Review v0.1.13

## Release

- Version: 0.1.13
- Release branch: release/v0.1.13
- Target tag: v0.1.13
- Reviewer: Codex
- Date: 2026-04-29

## Scope

- Key changes included in this release:
  - Background update checks now only detect available updates.
  - Settings sidebar shows `Установить обновление vN.N.N` above the current app version when an update is available.
  - Update installation starts only by user click, then relaunches the app after install.
  - Updater state is shared between Tauri webviews through an app event.
- User-facing changes:
  - No automatic update install/restart during normal app use.
  - Update button appears in the left settings menu above the version, with compact balanced spacing.
- Risky areas:
  - Updater state is in-memory per webview; settings performs its own check to recover if it misses widget events.
  - Update installation still depends on signed GitHub updater artifacts.

## Checks run

- `bun run check:release`: passed
- `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/talkis-updater.key bun run build:release:macos`: failed at updater signing because the local private key is password-protected and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is not available in this shell. Frontend build, Rust release build, app bundle, and updater archive were created before signing failed.
- Additional manual checks:
  - Release diff reviewed for updater flow and settings sidebar layout.

## Manual review

- Hotkey flow: unchanged.
- Onboarding permissions: unchanged.
- Widget position and notice behavior: unchanged.
- Transcription quality and short-utterance handling: unchanged.
- README refreshed: yes.

## Findings

- Blockers:
  - None.
- Non-blocking issues:
  - Local updater signing may require `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if using the password-protected local key.
- Follow-ups after release:
  - Close issue #7 after the GitHub Release succeeds.

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
