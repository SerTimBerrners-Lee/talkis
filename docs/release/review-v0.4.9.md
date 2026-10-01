# Release Review v0.4.9

## Release

- Version: 0.4.9
- Release branch: `release/v0.4.9`
- Target tag: `v0.4.9`
- Reviewer: Codex
- Date: 2026-10-01

## Scope

- Key changes included in this release: bounded native microphone startup for dictation, calls and live translation; asynchronous dictation start/stop; ordinary dictation interruption detection and captured-prefix preservation; cleanup of late starts; separate native call track paths; crash diagnostics and serialized polling with backoff.
- Existing changes on main since v0.4.8: restored Windows manual record button; 4096-token local text-model context to reduce memory usage alongside STT.
- User-facing changes: a stalled microphone cannot hold the interface thread during dictation startup/stop; interrupted ordinary dictation processes the recorded prefix and warns that subsequent words were lost; Windows crashes leave build/process evidence in the log.
- Risky areas: Windows WASAPI/COM ownership, microphone start/stop races, live-session cleanup, fallback track ownership, native exception diagnostics.

## Checks run

- `bun run check:release`: running on the versioned release tree.
- `bun test`: passed locally, 276 passed, 0 failed, 0 skipped, 39 files.
- Native workspace tests and Windows hardware microphone probe: final versioned-tree rerun pending. The approved implementation previously passed 139 native tests (0 failed, 3 ignored) and the separately invoked hardware probe.
- `bun run build:release:windows`: pending. This workstation has no private updater signing key; signed production bundles are checked in GitHub Actions using the repository secret.
- `bun run build:release:macos` / `bun run build:release:linux`: unavailable on the Windows workstation; native platform builds are required in Release Preflight.
- GitHub Release Preflight: pending for the release branch; macOS, Windows and Linux must pass on the exact tag commit.
- Additional manual checks: Windows 11 microphone default/selected-device restarts, pause/resume, unavailable-device recovery, injected callback failure and 60-second idle probe passed on the approved implementation. Development startup registered the tray and global shortcuts; recording logs confirm native start/stop and silence rejection.

## Manual review

- Hotkey flow: command names and payloads remain compatible; recording starts/stops asynchronously, retains WebView fallback and serializes lifecycle operations. Hotkey state tests are included in the release checks.
- Onboarding permissions: existing permission prompts and microphone selection are preserved.
- Widget position and notice behavior: position/size contracts are preserved; polling cancellation suppresses obsolete results; interruption warning states explicitly that later speech was not captured.
- Transcription quality and short-utterance handling: WAV remains 16 kHz mono PCM16; existing silence/hallucination guards are preserved; a driver stop failure returns the captured WAV for batch transcription.
- README refreshed: yes, English and Russian v0.4.9 notes describe the behavior and remaining Windows 10 verification limit.

## Findings

- Blockers: release gates are still pending; main and tag must not be pushed until final local checks and all three exact-commit preflight checks succeed.
- Non-blocking issues: the customer's complete process exit on Windows 10 after sleep has not been reproduced; this host runs Windows 11. Actual sleep/hibernate and physical unplug were not tested. Mid-session call/live-translation reconnection is outside this change. These limits were disclosed before the user's release approval.
- Native test harness: on this workstation the generated test executables need the existing Talkis Common Controls v6 manifest embedded with the Windows SDK `mt.exe` before execution; production packaging already embeds the manifest. Only ignored build artifacts are adjusted.
- Follow-ups after release: verify the affected Windows 10 sleep/resume scenario and inspect the new crash log if the exit recurs. Beads CLI/workspace is unavailable on this workstation, so Beads task updates/sync could not be performed; no alternate tracker was created.

## Decision

- Ready for `main` merge: no, pending final local checks and release preflight.
- Release preflight green on exact tag commit: no, pending.
- Ready for tag publish: no, pending the mandatory gates.
