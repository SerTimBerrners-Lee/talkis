# Release Review

## Release

- Version: `0.1.9`
- Release branch: `release/v0.1.9`
- Target tag: `v0.1.9`
- Reviewer: Antigravity
- Date: 2026-04-07

## Scope

- Key changes included in this release:
  - **Audio compression**: `audioBitsPerSecond: 24000` in MediaRecorder — reduces audio size ~4× for faster uploads
  - **Custom provider redesign**: two independent key fields — STT (`whisperApiKey`) and LLM (`llmApiKey`) — fully isolated from OpenAI mode
  - **`gpt-4o-transcribe` / `gpt-4o-mini-transcribe` support**: detects transcribe models and uses `json` instead of `verbose_json`, `instructions` instead of `prompt`, skips `language` param
  - **Transcribe model in LLM dropdown**: auto-selects the transcribe model as LLM option when picked as STT, maps to chat equivalent on backend (`gpt-4o-mini-transcribe` → `gpt-4o-mini`)
  - **"Без обработки" mode**: `llmModel = "none"` bypasses LLM step entirely; shown as option in LLM dropdown
  - **Processing time in history**: `processingTime` field added to `HistoryEntry`, shown as tiny badge in history table
  - **Settings persistence fix**: `deviceToken` added to `normalizeSavedSettings`, undefined values filtered before merge with defaults (no more fields reset to defaults after restart)
  - **Settings crash fix**: crash on Подписка tab when `llmApiKey` was `undefined` (old saved settings)
  - **Test connection isolation**: uses correct key per mode — `whisperApiKey`/`llmApiKey` in custom mode, `apiKey` in OpenAI mode; shows error when both custom keys empty
  - **Tech style prompt rewrite**: no longer compresses normal speech into code; preserves sentence structure, only normalizes tech term spelling
  - **Transcription uncertainty check**: skipped for transcribe models (no segments/duration in response)

- User-facing changes:
  - Custom provider settings now clearly show two sections: **Транскрипция (STT)** and **Обработка текста (LLM)** with independent API keys
  - Leaving LLM key empty disables LLM processing for custom mode
  - History shows how long each request took (e.g. `2.4с`)
  - Selecting a transcribe STT model auto-selects it in LLM dropdown as well

- Risky areas:
  - Users with old `talkis.json` lacking `llmApiKey`/`whisperApiKey` — handled with `|| ""` fallback
  - `audioBitsPerSecond: 24000` — some browsers/platforms may not support; MediaRecorder falls back gracefully
  - Transcribe model detection is name-based (`contains("transcribe")`) — third-party providers with non-standard naming won't benefit

## Checks run

- `bun run check:versions` — to run
- `bun run check:release` — to run
- `bun run build:release:macos` — to run

## Manual review

- [ ] Verify custom provider: STT key and LLM key are truly independent
- [ ] Verify settings persist across restart (whisperModel, llmModel, apiKey)
- [ ] Test `gpt-4o-mini-transcribe` as STT model — should return text without error
- [ ] Test `gpt-4o-mini-transcribe` as both STT and LLM — LLM should receive cleaned text
- [ ] Test "Без обработки" (llmModel = "none") — raw whisper text inserted
- [ ] Verify history table shows processing time on new entries
- [ ] Test connection button: custom mode with empty keys shows error

## Decision

- Ready for tag publish: pending checks
