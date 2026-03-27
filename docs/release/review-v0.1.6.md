# Release Review

## Release

- Version: `0.1.6`
- Release branch: `release/v0.1.6`
- Target tag: `v0.1.6`
- Reviewer: OpenCode
- Date: 2026-03-27

## Scope

- Key changes included in this release:
  - fixed the packaged widget window URL so the production app renders the widget instead of pointing at the dev server
  - replaced the broken browser `confirm()` flow on history clearing with an in-app two-step confirmation button
  - bumped version metadata to `0.1.6`
- User-facing changes:
  - the widget should appear again in bundled builds
  - the `Очистить` history action works inside the packaged app
- Risky areas:
  - release-only widget startup path from `tauri.conf.json`
  - settings history UX

## Checks run

- `bun run check:release` - passed
- `bun run build:release:macos` - passed
- Additional manual checks:
  - verified the local macOS DMG exists at `/tmp/talk-flow-target/release/bundle/dmg/Talk Flow_0.1.6_aarch64.dmg`
  - verified the widget window config now targets `index.html?window=widget`

## Manual review

- Hotkey flow: unchanged in this release branch
- Onboarding permissions: unchanged in this release branch
- Widget position and notice behavior: widget startup path fixed for packaged builds
- Transcription quality and short-utterance handling: unchanged in this release branch
- README refreshed: yes

## Findings

- Blockers: none
- Non-blocking issues:
  - end-to-end manual test of the downloaded GitHub artifact is still recommended immediately after publish
- Follow-ups after release:
  - confirm that `v0.1.6` GitHub Release contains the macOS DMG and zip assets before sharing widely

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
