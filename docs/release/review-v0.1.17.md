# Release Review v0.1.17

## Release

- Version: 0.1.17
- Release branch: release/v0.1.17
- Target tag: v0.1.17
- Reviewer: Codex
- Date: 2026-05-12

## Scope

- Key changes included in this release:
  - Fixes local models directory selection in settings by opening a native directory picker from `Изменить`.
  - Shows `По умолчанию` for the models directory only when a custom directory is configured.
  - Restarts a managed local STT runtime when its `/v1/models` response no longer matches models installed in the currently configured directory.
  - Improves file transcription messaging when a selected local model is not installed.
  - Updates bundled macOS local STT sidecar binaries.
- User-facing changes:
  - Users can change the local models directory from settings without typing the path manually.
  - Local model missing/install errors are easier to understand.
- Risky areas:
  - Managed local STT runtime restart detection depends on the runtime `/v1/models` response.
  - Updated sidecar binaries need release artifact validation after GitHub Actions completes.

## Checks run

- `bun run check:release`: passed
- `TAURI_SIGNING_PRIVATE_KEY_PATH=/Users/trixter/.tauri/talkis-updater.key bun run build:release:macos`: app bundle, DMG, and updater archive were created; local updater signing then failed because the local private key is password-protected and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is not available in this shell.
- Native/GitHub Windows build: pending GitHub Actions for `v0.1.17`
- Native/GitHub Linux build: pending GitHub Actions for `v0.1.17`
- Additional manual checks:
  - `bunx tsc --noEmit`: passed before release prep.
  - GitHub release workflow for `v0.1.16` was checked and the latest run completed successfully with macOS, Windows, Linux, signatures, and `latest.json`.

## Manual review

- Hotkey flow: not functionally changed.
- Onboarding permissions: not functionally changed.
- Widget position and notice behavior: not functionally changed.
- Transcription quality and short-utterance handling: not functionally changed.
- README refreshed: yes.

## Findings

- Blockers: none for simplified release.
- Non-blocking issues:
  - Local updater signing still requires `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when using the password-protected local key.
  - Full Windows/Linux artifact verification remains dependent on GitHub Actions.
- Follow-ups after release:
  - Verify the `v0.1.17` GitHub Release contains macOS, Windows, and Linux artifacts, matching `.sig` files, and `latest.json`.

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
