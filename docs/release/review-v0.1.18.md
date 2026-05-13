# Release Review

## Release

- Version: 0.1.18
- Release branch: release/v0.1.18
- Target tag: v0.1.18
- Reviewer: Codex
- Date: 2026-05-13

## Scope

- Key changes included in this release: settings window appearance mode with system, light, and dark options; theme persistence and runtime application; dark-mode CSS variables across settings tabs, dropdowns, modal surfaces, and onboarding permissions.
- User-facing changes: users can choose the app appearance from `Настройки` and the default `Системная` mode follows macOS.
- Risky areas: settings persistence migration, first-render theme application, settings UI contrast in dark mode.

## Checks run

- `bun run check:release`: passed
- `bun run build:release:macos`: failed at updater signing because `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is not set for the password-protected updater key
- Native/GitHub Windows build: blocked until `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is added to GitHub secrets
- Native/GitHub Linux build: blocked until `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is added to GitHub secrets
- Additional manual checks: `bunx tsc --noEmit` passed during implementation; `bun run build` passed during implementation; final `bun run check:release` passed after the settings background fix.

## Manual review

- Hotkey flow: not changed; compile and release checks pending.
- Onboarding permissions: themed surfaces reviewed in code; manual app-window check not run in this session.
- Widget position and notice behavior: widget files were intentionally not changed.
- Transcription quality and short-utterance handling: not changed.
- README refreshed: yes.

## Findings

- Blockers: local macOS release build requires `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to sign updater artifacts; GitHub repository currently has `TAURI_SIGNING_PRIVATE_KEY` but not `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, so the release workflow is expected to fail before publishing signed updater assets.
- Non-blocking issues: local working tree contains pre-existing modified STT binaries that are not part of this release scope.
- Follow-ups after release: verify GitHub Actions artifacts for macOS, Windows, Linux, and updater metadata.

## Decision

- Ready for `main` merge: yes, with the signing secret blocker documented
- Ready for tag publish: yes for version visibility; signed updater artifacts remain blocked until the missing secret is added
