# Release Review v0.1.19

## Release

- Version: 0.1.19
- Release branch: release/v0.1.19
- Target tag: v0.1.19
- Reviewer: Codex
- Date: 2026-05-15

## Scope

- Key changes included in this release:
  - Added file speaker diarization flow with local Whisper timestamp transcription and bundled `talkis-diarize` runtime.
  - Added background-safe diarized file transcription so global API/local/cloud model settings are not overwritten by speaker splitting.
  - Reworked model selection UX so API, local, and cloud sections can be viewed without changing the active recognition mode; the active mode changes only after `Выбрать`.
  - Added optional API adapter host field with reset-to-default behavior.
  - Improved cloud mode selection state so cloud cannot appear selected without active PRO.
  - Renamed bundled ffmpeg sidecar to `talkis-ffmpeg` to avoid Linux package conflicts with system `/usr/bin/ffmpeg`.
  - Updated widget and settings UI details for current model/account selection states.
- User-facing changes:
  - `Файлы` can split transcripts by speakers after the required local components are prepared.
  - API adapter cards support custom OpenAI-compatible hosts such as localhost.
  - API/local/cloud model cards now distinguish ready/saved state from the selected active mode.
  - Cloud selection button appears only when PRO is active.
  - Linux `.deb` installs should no longer collide with the distro `ffmpeg` package binary path.
- Risky areas:
  - Diarized file transcription depends on local Whisper timestamps and the `talkis-diarize` sidecar being included for each release platform.
  - API adapter selection now persists a selected adapter id and snapshots API settings when switching away.
  - Linux/Windows sidecar packaging needs GitHub Actions validation because this local review ran on macOS.

## Checks run

- `bun run check:release`: passed
- `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/talkis-updater.key bun run build:release:macos`: app bundle, DMG, and updater archive were created; updater signing then failed because the local private key password is not configured in this shell (`failed to decode secret key: incorrect updater private key password: Device not configured (os error 6)`).
- Native/GitHub Windows build: not run locally; expected to run in GitHub Actions on tag.
- Native/GitHub Linux build: not run locally; expected to run in GitHub Actions on tag.
- Additional manual checks:
  - `bash scripts/check-version-sync.sh`: passed for `0.1.19`.
  - `git diff --check`: passed.
  - Confirmed local macOS artifacts exist:
    - `src-tauri/target/release/bundle/macos/Talkis.app.tar.gz`
    - `src-tauri/target/release/bundle/dmg/Talkis_0.1.19_aarch64.dmg`

## Manual review

- Hotkey flow: not intentionally changed; `bun test ./src/windows/widget/services/hotkeyFsm.test.js` passed inside `bun run check:release`.
- Onboarding permissions: not intentionally changed in this release.
- Widget position and notice behavior: widget UI changed; TypeScript/build checks passed, but manual app-window QA was not run in this session.
- Transcription quality and short-utterance handling: short-hallucination guard remains in place; diarized mode now requires timestamp segments and returns a user-facing error if unavailable.
- README refreshed: yes.

## Findings

- Blockers: local updater signing cannot complete without `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for the password-protected local key.
- Non-blocking issues: Windows/Linux release artifacts and sidecar inclusion still need confirmation from the GitHub Actions release run.
- Follow-ups after release:
  - Verify GitHub Actions publishes macOS, Windows, Linux artifacts, matching `.sig` files, and `latest.json`.
  - If GitHub updater signing fails, add or fix `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in repository secrets.
  - Smoke-test diarized file transcription on a clean install for macOS and Linux.

## Decision

- Ready for `main` merge: yes, with the updater-signing caveat above.
- Ready for tag publish: yes if GitHub Actions has the updater key password secret; otherwise publish will likely stop at updater signing.
