# Release Review

## Release

- Version: `0.1.7`
- Release branch: `release/v0.1.7`
- Target tag: `v0.1.7`
- Reviewer: OpenCode
- Date: 2026-03-27

## Scope

- Key changes included in this release:
  - reset the stale macOS Accessibility permission entry before sending the user to System Settings
  - explain the reset behavior in the onboarding permission screen
  - bump version metadata to `0.1.7`
- User-facing changes:
  - users upgrading from an older deleted build should be able to re-request Accessibility access without getting stuck behind an old stale permission entry
- Risky areas:
  - onboarding Accessibility flow for existing users upgrading across versions

## Checks run

- `bun run check:release` - passed
- `bun run build:release:macos` - passed
- Additional manual checks:
  - confirmed the app now calls `tccutil reset Accessibility com.trixter.talkflow` before opening Accessibility settings

## Manual review

- Hotkey flow: unchanged in this release branch
- Onboarding permissions: updated to reset stale Accessibility permission state before re-requesting access
- Widget position and notice behavior: unchanged in this release branch
- Transcription quality and short-utterance handling: unchanged in this release branch
- README refreshed: yes

## Findings

- Blockers: none yet
- Non-blocking issues: none yet
- Follow-ups after release:
  - verify the downloaded `v0.1.7` build against the exact stale-permission-upgrade scenario

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
