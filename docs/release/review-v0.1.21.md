# Release Review v0.1.21

## Release

- Version: 0.1.21
- Release branch: release/v0.1.21
- Target tag: v0.1.21
- Reviewer: Codex
- Date: 2026-05-15

## Scope

- Key changes included in this release:
  - Linux widget window now uses a platform-specific Tauri config with `transparent: false` and `skipTaskbar: false`.
  - Linux widget notice window is created without transparency and without skip-taskbar hints.
  - Linux settings window is created without transparency.
- User-facing changes:
  - Fixes startup crash on Cinnamon/X11 where GDK reported `BadImplementation` from an unsupported X Window System operation.
  - macOS and Windows window behavior remains unchanged.
- Risky areas:
  - Linux visual appearance changes slightly because widget/settings/notice windows are no longer transparent.
  - The exact Cinnamon/X11 crash path cannot be reproduced on this macOS machine.

## Checks run

- `bun run check:release` — passed.
- `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/talkis-updater.key bun run build:release:macos` — built app, DMG, and updater archive, then failed at updater signature because the local key password is not configured.
- Native/GitHub Windows build: pending GitHub Actions for `v0.1.21`.
- Native/GitHub Linux build: pending GitHub Actions for `v0.1.21`.
- Additional manual checks:
  - `bunx tsc --noEmit`
  - `cargo check --manifest-path src-tauri/Cargo.toml`
  - `bun run check:versions`
  - `bun test ./src/lib/hotkeyValidation.test.ts ./src/windows/widget/services/hotkeyFsm.test.js`
  - `git diff --check`

## Manual review

- Hotkey flow: unchanged; hotkey smoke tests passed.
- Onboarding permissions: unchanged.
- Widget position and notice behavior: Linux window flags changed to avoid X11 crash; positioning code unchanged.
- Transcription quality and short-utterance handling: unchanged.
- README refreshed: yes, Linux/X11 startup behavior documented.

## Findings

- Blockers:
  - Local updater signing could not complete without `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the local environment.
- Non-blocking issues:
  - Linux Cinnamon/X11 runtime verification depends on GitHub/Linux runner build and user-side retest.
- Follow-ups after release:
  - Confirm the `v0.1.21` Linux artifact starts on Cinnamon/X11 without the `BadImplementation` crash.

## Decision

- Ready for `main` merge: yes, assuming GitHub release secrets are configured.
- Ready for tag publish: yes, via GitHub Actions signing secrets.
