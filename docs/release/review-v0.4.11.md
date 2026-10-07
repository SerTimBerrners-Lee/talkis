# Release Review v0.4.11

## Release

- Version: 0.4.11
- Release branch: `release/v0.4.11`
- Target tag: `v0.4.11`
- Base: `main`; the repository has no `canary` branch.
- Reviewer: Codex
- Date: 2026-10-07

## Scope

- Key changes included in this release: persistent effectively-silent-recording warnings, Windows native widget visibility/topmost repair and presentation diagnostics, background activity for notification overlays, bounded file logging and access to its folder from Settings.
- User-facing changes: a muted or disconnected microphone no longer silently ends an effectively silent dictation; Settings exposes Diagnostic log using the existing App data directory row layout and Open button. The active log and three archives normally retain up to 2 MiB each.
- Risky areas: Windows window-state caching and focus, ordering of recording completion and notices, hidden WebView activity, log rotation while the emergency crash handle remains open.

## Checks run

- Reviewed and locally tested implementation: `a5b287fe199ea29f560daa3f292deb6fa5513857`. Subsequent review-document changes do not alter code, dependencies or test configuration. The exact final release commit must pass all three preflight jobs before main/tag promotion.
- `bun run check:release`: passed locally on version 0.4.11 after the final visibility fix: version synchronization, bundled sidecars, TypeScript, Rust check, six hotkey smoke tests and production frontend build.
- `bun test`: 287 passed, 0 failed, 0 skipped, 41 files, 708 assertions.
- Full native workspace: `cargo test --manifest-path src-tauri/Cargo.toml --workspace --all-targets --no-run --message-format=json -j 2`, then every generated test executable with `--test-threads=1`: 146 passed, 0 failed, 3 ignored, across all five workspace test targets. Includes actual Windows HWND hide/topmost repair, unchanged foreground window/geometry, bounded rotation, oversized legacy logs, Unicode truncation and the pre-opened crash handle.
- Applicable hardware integration: the ignored `native_voice_recorder::windows_smoke::windows_microphone_restarts_after_idle_and_device_error` test was run explicitly and separately with `--exact --ignored --nocapture --test-threads=1`: 1 passed, 0 failed, 0 ignored. A real USB microphone delivered samples across eight restarts, pause/resume, an injected disconnection, unavailable-device recovery and a 20-second idle interval. No audio file was saved and no STT service was contacted. This verifies sample delivery, not speech intelligibility or a real OS sleep/resume.
- Remaining ignored tests: the crash child probe is exercised by its passing parent; NLLB integration requires an installed test model and was not run. The default suite's third ignored test is the separately passed hardware integration above.
- Windows test setup: static MSVC runtime (`RUSTFLAGS=-C target-feature=+crt-static`, `TRANSCRIBE_CMAKE_ARGS=-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`), two compilation jobs, serial tests. The SDK `mt.exe` embeds the existing Common Controls v6 manifest into generated test executables only. Tests use temporary data and no working cloud database or service.
- `bun run build:release:windows`: started locally on the final source; production sidecars and frontend compiled successfully, with the application/installer still compiling at review time. This is an incomplete local bundle check, not a successful local signing check. There is no local updater private key; signed Windows build readiness must be confirmed by the native GitHub preflight runner. The final local command result is recorded in the publication handoff.
- `bun run build:release:macos` and `bun run build:release:linux`: unavailable on this Windows workstation. Native signed updater bundles and platform checks are required in Release Preflight.
- GitHub Release Preflight: required on the final release commit. Verify successful `Preflight macos`, `Preflight windows` and `Preflight linux` check-runs before promoting that same SHA to main and tagging it. [Release branch runs](https://github.com/SerTimBerrners-Lee/talkis/actions/workflows/release-preflight.yml?query=branch%3Arelease%2Fv0.4.11).
- Additional manual evidence: the development application logged a successful diagnostic-folder opening at 15:35:35 on 2026-10-07. The settings row reuses the exact directory-row constants, Open button and read-only path field; no new component or explanatory description remains.
- `git diff --check` and focused Rust formatting checks passed. Repository updater signing secret is configured; this workstation has no local updater private key. Existing unrelated Rust/linker and frontend bundle-size warnings remain.

## Manual review

- Hotkey flow: recorder/STT/paste routing and shortcut contracts remain unchanged. The invisible widget stays mounted. Native restoration is serialized on the UI thread and returns early when the saved preference hides the widget.
- Onboarding permissions: no change to first-run, permission recovery, main-window startup or the independent Start minimized setting.
- Widget position and notice behavior: Windows reads actual visibility, minimization, topmost and DWM cloaking rather than relying on cached topmost state. Repair preserves position, size and keyboard focus. Desktop cloaking is diagnostic only; the widget is not pulled onto another virtual desktop. Unchanged presentation does not flood watchdog logs.
- Resolved during review: Tao 0.35.3 caches its VISIBLE flag, skips an unchanged show request, and does not synchronize external hiding into that cache. The Windows restoration path now verifies real visibility after show and uses native `SetWindowPos` with `SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE` when still hidden. Its regression test uses a transparent disposable window. [Windows API contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos).
- Notifications: silent audio completes processing and resizes to idle before opening the persistent existing error surface. The effectively-silent threshold is unchanged. Hidden notice/text overlays request lifetime browser activity and native background-throttling protection; display/hide failures are logged, with the existing persistent error surface as fallback for informational notice failures.
- Transcription quality and short-utterance handling: silent input skips STT/paste as before; meaningful quiet speech remains outside the silence gate. Audio formats, ffmpeg routing, endpoint/model selection and hallucination filters are unchanged.
- Logging: regular messages are capped at 16 KiB on a UTF-8 boundary. Rotation limits the active file and three archives, bounds legacy oversized active files and truncates the same file rather than replacing its identity. The emergency crash writer can append its small final record outside normal rotation. Folder opening is a backend command for the fixed log directory; no new broad frontend filesystem permission was added.
- README refreshed: yes, both English and Russian release notes describe behavior, retention and the remaining uncertainty about the reported spontaneous disappearance. Existing documentation notes that logs may contain transcribed text.

## Findings

- Blockers: none in the reviewed implementation. Main/tag publication remains blocked until all three exact-commit preflight checks succeed.
- Non-blocking limitations: the original spontaneous disappearance and real Windows 10 screen-off/sleep sequence have not been reproduced. Native macOS interaction and extended hidden-window idle were not manually tested on this Windows host; macOS native WebView suspension control requires macOS 14+, with browser activity best effort on older or unsupported browsers. These limits were disclosed before the user requested the new release.
- Tracking: Beads CLI and project workspace are unavailable on this workstation, so task status/sync could not be updated. No alternative tracker was created.

## Decision

- Ready for `main` merge: yes, conditional on all three successful preflight checks for the final release revision. The user explicitly requested this release; no further product decision is needed.
- Release preflight green on exact tag commit: must be verified from actual check-runs after pushing this final review revision; source-only or earlier checks are insufficient.
- Ready for tag publish: yes, only after the gate succeeds and main points to the same verified commit. Fast-forward promotion preserves the verified SHA; the tag-triggered workflow repeats the preflight gate and publishes all supported platform artifacts.
