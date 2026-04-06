# Release Review

## Release

- Version: `0.1.4`
- Release branch: `release/v0.1.4`
- Target tag: `v0.1.4`
- Reviewer: OpenCode
- Date: 2026-03-27

## Scope

- Key changes included in this release:
  - fixed the GitHub Actions release workflow syntax that prevented the post-processing step from running
  - bumped the app version from `0.1.3` to `0.1.4`
  - refreshed README release examples for the new version
- User-facing changes:
  - restores macOS release artifact publishing via GitHub Actions
- Risky areas:
  - release automation only; no runtime code changes in this release branch

## Checks run

- `bun run check:release` - passed
- `bun run build:release:macos` - passed
- Additional manual checks:
  - confirmed the invalid expression in `.github/workflows/release.yml` was replaced with shell expansion
  - verified the local post-processed app still builds and signs with `Identifier=com.trixter.talkis`

## Manual review

- Hotkey flow: unchanged in this release branch
- Onboarding permissions: unchanged in this release branch
- Widget position and notice behavior: unchanged in this release branch
- Transcription quality and short-utterance handling: unchanged in this release branch
- README refreshed: yes

## Findings

- Blockers: none
- Non-blocking issues:
  - `v0.1.3` remains a bad release because its workflow failed before publishing assets
- Follow-ups after release:
  - if needed, mark `v0.1.3` as superseded by `v0.1.4` in release notes

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
