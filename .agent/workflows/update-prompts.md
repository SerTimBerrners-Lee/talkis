---
description: How to update transcription prompts (styles, languages, overrides) — must sync both repos
---

# Updating Transcription Prompts

Prompts are stored in **two locations** and must be kept in sync:

1. **Client (Tauri app):** `Talk-Flow/src/config/transcription-prompts/`
   - Used when the user provides their own API key
   - Loaded by Rust backend (`prompt_config.rs`)

2. **Server (Go proxy):** `talkis-proxy/internal/prompt/prompts/`
   - Used for subscription users (proxied through the Go service)
   - Embedded into the Go binary via `embed.FS`

## Steps to update prompts

1. **Make your changes** in `Talk-Flow/src/config/transcription-prompts/`
2. **Copy all changed files** to the proxy:
   ```bash
   cp -r /Volumes/KINGSTON/project/talkflow/Talk-Flow/src/config/transcription-prompts/* \
         /Volumes/KINGSTON/project/talkflow/talkis-proxy/internal/prompt/prompts/
   ```
3. **Verify the Go build** still compiles:
   ```bash
   cd /Volumes/KINGSTON/project/talkflow/talkis-proxy && go build ./...
   ```
4. **Commit in both repositories**

## File structure

```
manifest.json          — registry of all languages, styles, overrides
base/common.json       — core rules (shared across all styles)
languages/default.json — fallback language config
languages/ru.json      — Russian language rules + filler words
languages/en.json      — English language rules
styles/classic.json    — Классический style
styles/business.json   — Деловой style
styles/tech.json       — Разработка style
overrides/ru.classic.json  — Russian × Classic overrides
overrides/ru.business.json — Russian × Business overrides
overrides/ru.tech.json     — Russian × Tech overrides
```

## Adding a new style

1. Create `styles/newstyle.json` with `promptTitle`, `rules`, `temperature`, `examples`
2. Add entry to `manifest.json` under `styles` and `styleOrder`
3. Optionally create `overrides/ru.newstyle.json` for language-specific overrides
4. Add the override key to `manifest.json` under `overrides`
5. Update the UI dropdown in `SettingsTabs.tsx` (Tauri app)
6. **Copy to proxy repo** (step 2 above)
