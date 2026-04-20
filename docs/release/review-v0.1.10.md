# Release Review

## Release

- Version: `0.1.10`
- Target tag: `v0.1.10`
- Reviewer: Antigravity
- Date: 2026-04-20

## Scope

### Talk-Flow (desktop app)

- **Paste race condition fix** (`paste.rs`): replaced `enigo` key simulation with direct `CGEvent` + `CGEventSetFlags(kCGEventFlagMaskCommand)` — Command modifier is now baked into the V key event itself, eliminating the intermittent bug where bare `v` was typed instead of `Cmd+V`
- **Modifier key clear** (`paste.rs`): removed — no longer needed with CGEvent approach
- **Local STT mode** (`useWidgetRecording.ts`): bypass API key validation when custom provider + localhost endpoint + empty `whisperApiKey`; local Speaches server requires no auth
- **Speaches `verbose_json` fix** (`ai.rs`): local Speaches (faster-whisper) returns HTTP 500 on `verbose_json`; now detects localhost/127.0.0.1 endpoint and sends `response_format=json` instead
- **Language param for Speaches** (`ai.rs`): `language=ru` is now correctly included in the multipart form for local endpoints — prevents hallucinations in foreign scripts
- **Business style filler removal** (`ru.business.json`): explicit rule + examples to strip `ну вот`, `слушай`, `ну ладно`, `как бы`, `это самое`, `типа` in business mode; semantic words (`также`, `тоже`) explicitly preserved
- **Local model instructions** (`SettingsTabs.tsx`): verbose inline Docker instructions replaced with a collapsible `<details>` element — shows only a header by default, expands to full steps on click
- **GitHub link fix** (`SettingsTabs.tsx`): corrected wrong placeholder GitHub URL to `github.com/SerTimBerrners-Lee/talkis`
- **CSS for collapsible** (`index.css`): `details[open] summary svg` rotates chevron on expand; marker hidden

### talkis-proxy

- **Language constraint** (`transcribe.go`): `language` param now forwarded to OpenAI STT API — constrains model output to selected language, eliminates foreign-script hallucinations on short/noisy audio
- **Subscription middleware** (`subscription.go`): updated
- **CORS** (`cors.go`): new middleware added

## User-facing changes

- Paste is now reliable — no more stray `v` characters appearing in target apps
- Local Docker STT model (Speaches) works end-to-end without API key
- Business style now cleans filler openers: «Ну вот, слушай...» → content only
- Local model setup instructions are hidden by default — settings screen is less cluttered

## Risky areas

- `CGEvent`-based paste (macOS only): requires Accessibility permission — existing permission grant is preserved
- Local STT detection is URL-based (`localhost`/`127.0.0.1`) — users with non-standard local proxy addresses won't auto-detect; they can manually enter an empty API key
- Business filler removal is LLM-driven — edge cases with ambiguous fillers may occasionally over-clean

## Checks

- [ ] `bun run check:versions`
- [ ] `bun run check:release`
- [ ] `bun run build:release:macos`

## Manual review

- [ ] Paste test: VS Code, Telegram, browser input — no bare `v` inserted
- [ ] Local STT: connect Speaches on `127.0.0.1:8000` — no API key error, transcription succeeds
- [ ] Business style: «Ну вот, слушай, созвон назначить» → cleaned
- [ ] Classic style: «Ну вот, я думаю...» → `ну вот` preserved
- [ ] Proxy: short silent audio clip → no hallucinations in wrong script
- [ ] Settings: local model instructions collapsed by default, expand on click
- [ ] GitHub link in settings → opens correct repo

## Decision

- Ready for tag publish: pending checks
