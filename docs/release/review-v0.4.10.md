# Release Review v0.4.10

## Release

- Version: 0.4.10
- Release branch: `release/v0.4.10`
- Target tag: `v0.4.10`
- Reviewer: Codex
- Date: 2026-10-02

## Scope

- Key changes included in this release: persistent widget visibility; independent Start minimized preference; hidden-window background activity; safe settings save/reload and rollback; compact settings switches.
- User-facing changes: users can hide the desktop widget without quitting Talkis and choose to keep the main window hidden on the next launch. Both explanatory descriptions were removed at the user's request. Existing installs retain a visible widget and normal startup by default.
- Risky areas: window creation and show/hide ordering; frontend hotkey handling while hidden; first-run and permission recovery; settings persistence across separate windows.

## Checks run

- Reviewed implementation and versioned source commit: `03fb898932d0ddff66f1a3b3eb285f9653bc46a0`. The final release review revision changes documentation only; its exact commit must receive all three preflight checks before main/tag.
- `bun run check:release`: passed locally on the reviewed source (version sync, sidecars, TypeScript, Rust check, 6 hotkey smoke tests and production frontend build).
- `bun test`: 285 passed, 0 failed, 0 skipped, 41 files. Includes five real Store/IPC persistence/error checks and four background activity lifetime checks, including late acquisition after cleanup and unavailable browser APIs.
- Native workspace tests: `cargo test --manifest-path src-tauri/Cargo.toml --workspace --all-targets --no-run --message-format=json -j 2`, then all five generated test executables with `--test-threads=1`: 140 passed, 0 failed, 3 ignored. The ignored child crash probe is exercised by its passing parent. Hardware microphone smoke and model-dependent NLLB integration were not rerun for this window/settings change.
- Windows test environment: static MSVC runtime (`RUSTFLAGS=-C target-feature=+crt-static`, `TRANSCRIBE_CMAKE_ARGS=-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`); compilation limited to two jobs and tests run sequentially. Generated test EXEs need the existing Common Controls v6 manifest embedded with SDK `mt.exe`; only ignored build artifacts are adjusted.
- `bun run build:release:windows`: application, sidecars and `Talkis_0.4.10_x64-setup.exe` built locally. The command exited 1 only at updater signing because this workstation has no private signing key. This is not a successful local signing check; GitHub preflight must build signed updater bundles with the repository secret.
- `bun run verify:windows-release`: passed for the NSIS cleanup hook, application, all four bundled sidecars and the new installer. The application reports file/product version 0.4.10.
- `bun run build:release:macos` / `bun run build:release:linux`: unavailable on this Windows workstation. Native builds, updater signatures and bundle checks are required in Release Preflight.
- GitHub Release Preflight: build evidence for the reviewed source is in [run 36981335908](https://github.com/SerTimBerrners-Lee/talkis/actions/runs/36981335908). The final documentation revision must repeat `Preflight macos`, `Preflight windows` and `Preflight linux`; exact-commit results are available in [PR #22 checks](https://github.com/SerTimBerrners-Lee/talkis/pull/22/checks).
- Additional manual checks: Windows development startup registered the tray and both global shortcuts, logged normal startup without onboarding, and warmed the local STT runtime. Actual macOS interaction and extended hidden-window idle behavior have not been manually verified on this Windows host. `git diff --check` passed.
- Repository updater signing secret is configured. No local updater private key is available.

## Manual review

- Hotkey flow: the hidden widget remains mounted, native shortcuts and event payloads are preserved, and every restore path checks the saved visibility. Show/hide operations are serialized on the UI thread; WebView2 creation remains on the async worker.
- Onboarding permissions: startup prepares a hidden settings WebView and reveals it for normal launch, onboarding, missing required permissions or a startup error. Manual tray/open actions always reveal the window. Late startup checks never hide a manually opened window or recreate one the user closed.
- Widget position and notice behavior: existing size/position/overlay contracts are preserved. Native preferences use strict booleans and default to visible. Save/apply failures restore the previous widget preference.
- Background activity: both widget and settings request a shared Web Lock for their mounted lifetime, releasing/cancelling it on cleanup. macOS 14+ also disables native WebView suspension; the platform library guards that API on older macOS. Other systems use the browser Locks API when available. This requests browser activity, not an OS wake lock.
- Settings persistence: saves merge changed fields with the latest saved settings; model settings no longer overwrite unrelated window preferences. Store reload is explicitly permitted. The start-minimized error path reloads the saved value and uses the existing error color token.
- Transcription quality and short-utterance handling: recording, conversion, STT routing and hallucination filters are unchanged; existing short/silent/noisy input and hotkey tests pass.
- README refreshed: yes, English and Russian documentation describes both preferences, defaults, onboarding exceptions and v0.4.10 changes.

## Findings

- Blockers: none in the reviewed implementation. Main and tag remain gated on all three successful preflight checks for the final release revision.
- Resolved during review: missing store-reload permission and start-minimized save-error reload; invalid error color token; background WebView suspension protection needed for deliberately hidden windows.
- Non-blocking issues: native macOS interaction and extended idle after hiding still need verification on a Mac. This host limitation was disclosed before the user approved release. Native WebView suspension control requires macOS 14+; browser activity protection is best effort when the browser lacks or denies Web Locks.
- Follow-ups after release: verify long idle and hotkey dictation with the widget hidden on affected macOS versions. Beads CLI/workspace is unavailable on this workstation, so task updates/sync could not be performed; no alternate tracker was created.

## Decision

- Ready for `main` merge: yes, after exact-commit preflight passes. The user explicitly approved review and release after removal of both descriptions; no additional product decision is required.
- Release preflight green on exact tag commit: required. Confirm all three successful check-runs in PR #22 on the final release commit before tagging.
- Ready for tag publish: yes, after the preflight gate succeeds and main points to that same commit. Use fast-forward promotion to preserve the verified SHA.
