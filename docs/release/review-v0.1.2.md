# Release Review

## Release

- Version: `0.1.2`
- Release branch: `release/v0.1.2`
- Target tag: `v0.1.2`
- Reviewer: OpenCode
- Date: 2026-03-27

## Scope

- Key changes included in this release:
  - formalized the release workflow and templates under `docs/release/`
  - refreshed release documentation references in `README.md` and `AGENTS.md`
  - bumped app version from `0.1.1` to `0.1.2`
  - aligned the GitHub release workflow with `bun run check:release`
- User-facing changes:
  - no new product behavior in this release package beyond the previously merged fixes already present on `main`
  - release metadata and docs now match the actual process
- Risky areas:
  - release automation wording and version synchronization across package metadata

## Checks run

- `bun run check:release` - passed
- `bun run tauri build` - passed
- Additional manual checks:
  - verified the release branch is based on current `main`
  - verified the final DMG path exists at `/tmp/talkis-target/release/bundle/dmg/Talkis_0.1.2_aarch64.dmg`

## Manual review

- Hotkey flow: no code changes in this release branch; previous hotkey fixes remain included from `main`
- Onboarding permissions: no code changes in this release branch; previously merged permission refresh fix remains included from `main`
- Widget position and notice behavior: no code changes in this release branch; previously merged fixes remain included from `main`
- Transcription quality and short-utterance handling: no code changes in this release branch; previously merged filtering remains included from `main`
- README refreshed: yes

## Findings

- Blockers: none
- Non-blocking issues:
  - the first local `tauri build` attempt failed because a stale intermediate DMG mount remained attached; after detaching `/dev/disk10` and rerunning, the build succeeded
- Follow-ups after release:
  - if the stale DMG issue repeats often, add a cleanup note or preflight step to the release rule

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
