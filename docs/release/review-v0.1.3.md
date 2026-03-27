# Release Review

## Release

- Version: `0.1.3`
- Release branch: `release/v0.1.3`
- Target tag: `v0.1.3`
- Reviewer: OpenCode
- Date: 2026-03-27

## Scope

- Key changes included in this release:
  - improved accessibility permission detection for bundled macOS builds
  - added runtime detection for mounted-volume and App Translocation launches
  - added a release post-processing step that re-signs the built macOS app with a stable bundle identifier and rebuilds the DMG from the signed app
  - refreshed release docs and README for the new release version
- User-facing changes:
  - first-launch permissions screen now explains when the release build must be moved to `Applications`
  - release artifacts now use a stable ad-hoc signing identifier (`com.trixter.talkflow`) instead of a hash-based identifier
- Risky areas:
  - macOS packaging and accessibility behavior for unsigned/ad-hoc-signed bundles
  - DMG post-processing step in local and GitHub release flow

## Checks run

- `bun run check:release` - passed
- `bun run build:release:macos` - passed
- Additional manual checks:
  - verified the post-processed app signature reports `Identifier=com.trixter.talkflow`
  - verified the final DMG exists at `/tmp/talk-flow-target/release/bundle/dmg/Talk Flow_0.1.3_aarch64.dmg`

## Manual review

- Hotkey flow: unchanged in this release branch
- Onboarding permissions: reviewed; the screen now surfaces install-location guidance for mounted/translocated release builds and still refreshes permission state automatically
- Widget position and notice behavior: unchanged in this release branch
- Transcription quality and short-utterance handling: unchanged in this release branch
- README refreshed: yes

## Findings

- Blockers: none
- Non-blocking issues:
  - the root cause is inferred from release behavior and signing metadata; full end-to-end verification should be done on the published `v0.1.3` artifact after download and launch from a normal user path
- Follow-ups after release:
  - if accessibility still misbehaves for some users, consider adding an explicit `Applications` install flow or notarized signing path

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
