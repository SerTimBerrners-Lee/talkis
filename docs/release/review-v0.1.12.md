# Release Review v0.1.12

## Release

- Version: 0.1.12
- Release branch: release/v0.1.12
- Target tag: v0.1.12
- Reviewer: Codex
- Date: 2026-04-29

## Scope

- Key changes included in this release:
  - Redesigned floating widget with interactive audio-reactive wave and copy success checkmark.
  - Low microphone signal notice above the widget.
  - File transcription tab for audio/video files with raw `transcribe_only` flow.
  - Bundled ffmpeg sidecar preparation for extracting and compressing media before transcription.
  - History filters for all, voice, and file entries, with source-specific retention limits.
  - App version footer and background updater scheduler.
  - Release workflow now publishes updater artifacts and `latest.json`.
- User-facing changes:
  - Users can transcribe files from settings.
  - Widget has no outer shadow/halo and shows quieter notices.
  - History table is more compact and separates voice/file entries.
  - Settings sidebar shows `v0.1.12`.
- Risky areas:
  - Media conversion relies on the bundled ffmpeg sidecar being prepared for the target platform.
  - Updater requires valid signing secrets in GitHub Actions.
  - Hotkey behavior changed to show recording state immediately while microphone startup completes.

## Checks run

- `bun run check:release`: passed
- `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/talkis-updater.key bun run build:release:macos`: failed at updater signing because the local private key is password-protected and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is not available in this shell.
- `TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/talkis-updater.key)" bun run build:release:macos`: failed at updater signing for the same missing password.
- Additional manual checks:
  - Release diff reviewed for widget, file transcription, updater, and history behavior.
  - GitHub release workflow history checked: previous `v0.1.11` Release workflow completed successfully.
  - GitHub repository secrets checked: `TAURI_SIGNING_PRIVATE_KEY` exists; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is not configured.
  - First `v0.1.12` GitHub Actions run failed because `cargo check` ran before preparing the ffmpeg sidecar on a fresh runner; `bun run check` now prepares the sidecar before Rust checks.

## Manual review

- Hotkey flow: recording state is set immediately on hotkey press; existing hotkey FSM smoke test covers core transitions.
- Onboarding permissions: unchanged.
- Widget position and notice behavior: widget dimensions updated with matching Rust constants; notice icon removed; low microphone notice uses existing notice channel.
- Transcription quality and short-utterance handling: voice path keeps the existing hallucination filters; file path uses `transcribe_only` and skips LLM cleanup.
- README refreshed: yes.

## Findings

- Blockers:
  - Local updater signing cannot complete without the private key password.
- Non-blocking issues:
  - ffmpeg-static binary licensing/source distribution should be reviewed before broader public distribution.
  - If the GitHub `TAURI_SIGNING_PRIVATE_KEY` secret is also password-protected, the Release workflow needs `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` before updater artifacts can be signed.
- Follow-ups after release:
  - Add UI for custom prompt processing when product flow is finalized.
  - Consider timestamp/chunked transcription for long files.

## Decision

- Ready for `main` merge: yes, with the local signing limitation noted above
- Ready for tag publish: yes, provided GitHub Actions has a usable updater private key secret
