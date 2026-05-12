# Release Review v0.1.16

## Release

- Version: 0.1.16
- Release branch: main
- Target tag: v0.1.16
- Reviewer: Codex
- Date: 2026-05-12

## Scope

- Key changes included in this release:
  - Enables GitHub Actions release builds for macOS, Windows, and Linux.
  - Adds platform-specific release scripts for macOS, Windows, and Linux.
  - Generates updater metadata for `darwin-aarch64`, `windows-x86_64`, and `linux-x86_64`.
  - Updates onboarding/runtime info so Windows and Linux do not require macOS Accessibility or Applications-folder handling.
  - Marks Qwen and NVIDIA local runtimes as macOS-only while keeping Whisper available on Windows/Linux.
- User-facing changes:
  - GitHub Release assets should include Windows and Linux installers in addition to macOS artifacts.
  - Onboarding text now reflects platform-specific permissions.
- Risky areas:
  - First Windows/Linux release artifacts are built only in GitHub Actions native runners.
  - Windows and Linux builds are unsigned.
  - Updater metadata depends on `.sig` files being produced for all required platforms.

## Checks run

- `bun run check:release`: passed
- `bun run build:release:macos`: not run locally before tagging; GitHub Actions will build native release bundles.
- Native/GitHub Windows build: pending GitHub Actions for `v0.1.16`
- Native/GitHub Linux build: pending GitHub Actions for `v0.1.16`
- Additional manual checks:
  - `scripts/create-updater-latest-json.sh` tested against synthetic macOS/Windows/Linux updater artifacts and signatures.
  - `.github/workflows/release.yml` parsed as valid YAML.

## Manual review

- Hotkey flow: smoke tests passed.
- Onboarding permissions: reviewed platform-specific macOS/Windows/Linux copy and gating.
- Widget position and notice behavior: not functionally changed.
- Transcription quality and short-utterance handling: not functionally changed.
- README refreshed: yes.

## Findings

- Blockers: none before tag publish.
- Non-blocking issues:
  - Windows/Linux release artifacts still need confirmation from the first Actions run.
  - Windows/Linux installers are unsigned.
- Follow-ups after release:
  - Verify `v0.1.16` GitHub Release contains Windows `.exe`/`.msi`, Linux `.AppImage`/`.deb`, matching `.sig` files, and `latest.json`.
  - If GitHub Actions fails on a native runner dependency, fix the workflow and re-run the tag workflow before announcing the release.

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
