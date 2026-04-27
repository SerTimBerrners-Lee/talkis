## Release

- Version: 0.1.11
- Release branch: release/v0.1.11
- Target tag: v0.1.11
- Reviewer: Codex
- Date: 2026-04-27

## Scope

- Key changes included in this release:
  - Added autostart setting backed by `tauri-plugin-autostart`.
  - Added hover controls to the floating widget: click-to-record, click-to-stop, and copy latest successful result.
  - Refined widget active/idle sizing, recording controls, waveform rendering, and visual edge treatment.
  - Added Accessibility preflight for automatic paste attempts.
  - Fixed latest-copy cache invalidation when history entries are deleted or history is cleared.
  - Adjusted release packaging so Tauri builds the `.app` and the project postprocess script creates the DMG.
- User-facing changes:
  - Users can enable launch-at-login in Settings.
  - Users can start and stop a locked recording with the widget mouse control.
  - Users can copy the latest successful transcription directly from the idle widget.
  - Widget hover/recording states are larger and easier to target.
- Risky areas:
  - Floating widget hit testing and hover polling on macOS transparent always-on-top windows.
  - Manual recording start/stop interactions sharing the same state machine as hotkeys.
  - Release packaging target changed from Tauri `all` to `.app` plus project DMG postprocess.

## Checks run

- `bun run check:release` - passed
- `bun run build:release:macos` - passed
- Additional manual checks:
  - Confirmed generated macOS app bundle at `src-tauri/target/release/bundle/macos/Talkis.app`.
  - Confirmed generated DMG at `src-tauri/target/release/bundle/dmg/Talkis_0.1.11_aarch64.dmg`.
  - Reviewed release diff for version, README, widget controls, autostart permissions, and history-clear copy-cache handling.

## Manual review

- Hotkey flow:
  - Existing hotkey FSM smoke tests passed.
  - Manual recording actions were added as separate state-machine actions and do not bypass the existing recording pipeline.
- Onboarding permissions:
  - Existing permission flow remains in place.
  - `paste_text` now checks macOS Accessibility permission before simulating Cmd+V.
- Widget position and notice behavior:
  - Widget resize constants now use a stable active hit-test area to avoid hover clipping.
  - Notice window behavior is unchanged after reverting the earlier fallback-copy notice.
- Transcription quality and short-utterance handling:
  - Existing short-recording guards remain unchanged.
  - Waveform rendering changes are visual only.
- README refreshed:
  - README documents autostart, widget mouse controls, latest-copy behavior, and version 0.1.11.

## Findings

- Blockers:
  - None remaining.
- Non-blocking issues:
  - Hover detection relies on polling cursor position relative to the Tauri window because React hover events are unreliable for this transparent widget before activation.
  - macOS release artifacts are ad-hoc signed unless signing/notarization secrets are configured.
- Follow-ups after release:
  - Consider adding automated tests for history deletion/clear events and latest-copy cache behavior.
  - Consider manual QA on a clean macOS account for autostart and Accessibility paste preflight.

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
