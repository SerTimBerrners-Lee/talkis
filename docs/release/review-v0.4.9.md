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

- `bun run check:release`: passed locally on the versioned release commit `d1d656531be4c7e67498180751d562b757648402` (version sync, sidecars, TypeScript, Rust check, 6 hotkey smoke tests and production frontend build).
- `bun test`: passed locally, 276 passed, 0 failed, 0 skipped, 39 files.
- Native workspace tests: `cargo test --manifest-path src-tauri/Cargo.toml --workspace --all-targets --no-run -j 2` succeeded, then all five generated test executables ran with `--test-threads=1`: 139 passed, 0 failed, 3 ignored. The isolated Windows exception parent test passed and exercised its ignored child. The hardware test was run separately; the NLLB integration test remains unrun because `TALKIS_NLLB_TEST_MODEL` is unavailable.
- Windows hardware probe: `TALKIS_RECORDER_IDLE_TEST_SECONDS=60`, exact `native_voice_recorder::windows_smoke::windows_microphone_restarts_after_idle_and_device_error` test with `--ignored --nocapture --test-threads=1`: 1 passed, 0 failed, 0 ignored; real default/selected-device restarts, pause/resume, unavailable-device recovery, injected callback failure and recording after 60-second idle all passed. Audio stays in memory; no transcription service is contacted.
- Windows build/test environment: static MSVC runtime (`RUSTFLAGS=-C target-feature=+crt-static`, `TRANSCRIBE_CMAKE_ARGS=-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`); native compilation limited to 2 jobs, tests sequential.
- `bun run build:release:windows`: Talkis, sidecars and `Talkis_0.4.9_x64-setup.exe` built successfully; the command exited 1 only at updater signing because this workstation has no private signing key. GitHub builds signed bundles using the repository secret.
- `bun run verify:windows-release`: passed for the process cleanup hook, Talkis, all four bundled sidecars and the new NSIS installer; the application reports file/product version 0.4.9.
- `bun run build:release:macos` / `bun run build:release:linux`: unavailable on the Windows workstation; native platform builds are required in Release Preflight.
- GitHub Release Preflight: implementation and versioned release tree passed native macOS, Windows and Linux build/packaging checks in [run 36859505925](https://github.com/SerTimBerrners-Lee/talkis/actions/runs/36859505925). The final review-only revision must repeat the three required checks before merge/tag; its results are available in [PR #21 checks](https://github.com/SerTimBerrners-Lee/talkis/pull/21/checks).
- Additional manual checks: versioned-tree hardware checks above passed on Windows 11. Development startup registered the tray and global shortcuts; recording logs confirm native start/stop and silence rejection. `git diff --check` passed.

## Manual review

- Hotkey flow: command names and payloads remain compatible; recording starts/stops asynchronously, retains WebView fallback and serializes lifecycle operations. Hotkey state tests are included in the release checks.
- Onboarding permissions: existing permission prompts and microphone selection are preserved.
- Widget position and notice behavior: position/size contracts are preserved; polling cancellation suppresses obsolete results; interruption warning states explicitly that later speech was not captured.
- Transcription quality and short-utterance handling: WAV remains 16 kHz mono PCM16; existing silence/hallucination guards are preserved; a driver stop failure returns the captured WAV for batch transcription.
- README refreshed: yes, English and Russian v0.4.9 notes describe the behavior and remaining Windows 10 verification limit.

## Findings

- Blockers: none in the reviewed implementation. Main and tag remain gated on all three successful preflight checks for the final review revision.
- Non-blocking issues: the customer's complete process exit on Windows 10 after sleep has not been reproduced; this host runs Windows 11. Actual sleep/hibernate and physical unplug were not tested. Mid-session call/live-translation reconnection is outside this change. These limits were disclosed before the user's release approval.
- Native test harness: on this workstation the generated test executables need the existing Talkis Common Controls v6 manifest embedded with the Windows SDK `mt.exe` before execution; production packaging already embeds the manifest. Only ignored build artifacts are adjusted.
- Follow-ups after release: verify the affected Windows 10 sleep/resume scenario and inspect the new crash log if the exit recurs. Beads CLI/workspace is unavailable on this workstation, so Beads task updates/sync could not be performed; no alternate tracker was created.

## Decision

- Ready for `main` merge: yes, after the final review-only revision receives all three required preflight checks. The user approved review, commit, merge and release after the Windows 10 verification limit was disclosed.
- Release preflight green on exact tag commit: mandatory; the final revision's check-runs in PR #21 must show `Preflight macos`, `Preflight windows` and `Preflight linux` successful before tagging.
- Ready for tag publish: yes, after the exact-commit preflight gate succeeds and main points to that same commit. Use fast-forward merge to preserve the verified SHA.
