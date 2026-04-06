# Release Rule

This file defines the mandatory release workflow for Talkis. Follow it for every release without skipping steps.

## Naming

- Release branch: `release/vX.Y.Z`
- Release review file: `docs/release/review-vX.Y.Z.md`
- Git tag: `vX.Y.Z`

## Mandatory sequence

1. Collect all local changes and push them to the release branch first.
2. Update version numbers consistently in:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
3. Refresh `README.md` before every release so the documented behavior, supported platforms, commands, and release notes are current.
4. Run the release checks locally:
   - `bun run check:release`
   - `bun run build:release:macos`
5. Perform a detailed self-review of the full release diff.
6. Write the review results to `docs/release/review-vX.Y.Z.md` using the review template.
7. If there are blockers, risks, or recommendations that need a decision, ask the user before merging to `main`.
8. Only after review is complete and questions are resolved, merge or push the approved changes to `main`.
9. Create and push the release tag `vX.Y.Z` from `main`.
10. Let GitHub Actions build and publish the release for all currently supported release platforms.

## Review checklist

- Working tree is clean and the release branch diff is intentional.
- README reflects the current product behavior and release process.
- Hotkey flow works, including capture, apply-without-restart, and onboarding interactions.
- Widget position, notices, and onboarding permissions behave correctly.
- Short or noisy recordings do not paste obvious hallucinated text.
- `bun run check:release` passes.
- Local production build passes via `bun run build:release:macos`.
- Version numbers and release tag match.
- The GitHub Actions release workflow still matches the documented process.

## GitHub Actions release source of truth

- Workflow file: `.github/workflows/release.yml`
- Tag push is the canonical release trigger.
- Build all platforms that are actually ready in the workflow. Do not claim unsupported platforms in release notes.

## Output expectations

For each release, produce:

- release branch `release/vX.Y.Z`
- review file `docs/release/review-vX.Y.Z.md`
- updated `README.md`
- updated version files
- pushed `main`
- pushed tag `vX.Y.Z`
- GitHub Release artifacts created by Actions
