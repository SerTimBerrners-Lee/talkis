# Release Review v0.1.15

## Release

- Version: 0.1.15
- Release branch: release/v0.1.15
- Target tag: v0.1.15
- Reviewer: Codex
- Date: 2026-05-12

## Scope

- Key changes included in this release:
  - Added Talkis-managed local STT runtimes for Whisper, NVIDIA Parakeet MLX, and Qwen ASR.
  - Added bundled STT sidecar preparation for development, checks, and release builds.
  - Added local model install/delete/progress handling in the settings model UI.
  - Added chunked file transcription support for larger audio/video files.
  - Updated README and local STT runtime documentation for managed local runtimes.
- User-facing changes:
  - Users can install and select local STT models from `Модели` without manually running Docker or Python.
  - Local STT uses managed localhost endpoints with fallback ports when defaults are occupied.
  - File transcription supports larger files with chunk progress.
- Risky areas:
  - Release packaging now includes multiple sidecars.
  - Local STT runtime startup, model download, and localhost port fallback are new runtime paths.
  - Qwen and NVIDIA runtimes download Python/model dependencies at runtime.

## Checks run

- `bun run check:release`: passed.
- `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/talkis-updater.key bun run build:release:macos`: app bundle and updater archive were created, then local updater signing failed because the local private key is password-protected and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is not available in this shell.
- Additional manual checks:
  - Release build initially exposed invalid `src-tauri/src/bin` contents: `local_runtime_stub`, `nvidia_engine.py`, and `qwen_engine.py` were interpreted by Tauri as bundle binaries.
  - Removed the unused `local_runtime_stub`.
  - Moved embedded Python engine scripts to `src-tauri/src/runtime_engines` and updated `include_str!` paths.
  - Re-ran `bun run check:release` after the packaging fix: passed.
  - Re-ran `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/talkis-updater.key bun run build:release:macos` after the packaging fix: reached updater signing, then failed only on the missing local key password.
  - `git diff --check`: passed.

## Manual review

- Hotkey flow: unchanged in behavior; smoke tests passed.
- Onboarding permissions: reviewed changed accessibility/settings window paths.
- Widget position and notice behavior: reviewed widget recording/hotkey changes.
- Transcription quality and short-utterance handling: reviewed STT pipeline, local STT, and prompt config changes.
- README refreshed: yes.

## Findings

- Blockers:
  - None remaining for GitHub release publish.
- Non-blocking issues:
  - Local updater signing still requires `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when using the password-protected local key.
  - The GitHub repository currently lists `TAURI_SIGNING_PRIVATE_KEY`; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is not listed.
- Follow-ups after release:
  - Add/verify the GitHub updater signing password secret if the release workflow fails at `.sig` generation.
  - Validate Qwen and NVIDIA runtime dependency downloads on a clean machine.

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
