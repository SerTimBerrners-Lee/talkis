# Release Review v0.1.14

## Release

- Version: 0.1.14
- Release branch: release/v0.1.14
- Target tag: v0.1.14
- Reviewer: Codex
- Date: 2026-05-08

## Scope

- Key changes included in this release:
  - Settings sidebar section `Подписка` renamed to `Модели`.
  - The model section now offers `Облако`, `API`, and `Локально` modes.
  - API mode shows expandable adapter cards for OpenAI, Deepgram, Cartesia, Mistral AI, ElevenLabs, Fireworks AI, Groq, AssemblyAI, Volcengine, and xAI.
  - API adapter cards use provider avatars and compact key/model inputs.
  - API adapter connection state is persisted after testing/saving and restored after app restart.
  - Local model mode includes a model install action for the configured Speaches endpoint.
- User-facing changes:
  - Users configure models and API adapters from `Модели`.
  - A previously saved and matching API key/model shows `Подключено` instead of repeatedly showing the save/test button.
  - Changing the API key or model invalidates the saved connection state.
- Risky areas:
  - Only OpenAI uses the existing real `test_api_connection` backend command today.
  - Other provider cards persist credentials and model names, but real provider-specific backend calls still need follow-up integration.
  - The model settings UI changed substantially, so layout regressions are the main release risk.

## Checks run

- `bun run check:release`: passed
- `TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/talkis-updater.key bun run build:release:macos`: failed at updater signing because the local private key is password-protected and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is not available in this shell. Frontend build, Rust release build, app bundle, and updater archive were created before signing failed.
- Additional manual checks:
  - Release diff reviewed for settings model/API adapter UI, adapter persistence, README, and version metadata.
  - `git diff --check`: passed.

## Manual review

- Hotkey flow: unchanged.
- Onboarding permissions: unchanged.
- Widget position and notice behavior: unchanged.
- Transcription quality and short-utterance handling: unchanged.
- README refreshed: yes.

## Findings

- Blockers:
  - None.
- Non-blocking issues:
  - Non-OpenAI API adapters are UI/storage-ready but do not yet perform real provider-specific connection tests.
  - Local updater signing may require `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if using the password-protected local key.
- Follow-ups after release:
  - Add backend provider implementations for non-OpenAI API adapters.

## Decision

- Ready for `main` merge: yes
- Ready for tag publish: yes
