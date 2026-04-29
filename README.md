# Talkis

Talkis is a lightweight macOS voice-to-text app built with Tauri.

It sits in a small floating widget, listens while you hold a hotkey, sends audio for transcription, cleans up the text with an LLM, and pastes the result into the active app.

## What it does

- Hold `Shift + Command + Space` to start recording
- Release the hotkey to stop and process the audio
- The recognized text is pasted automatically into the current app
- A second press during recording locks the recording mode
- The floating widget can start/stop recording with a mouse click, copy the latest result, and show a low microphone signal notice
- Autostart can be enabled from settings
- The settings window lets you choose language, microphone, API key, text cleanup style, and transcribe audio/video files
- Recent voice recordings and file transcriptions are saved in local history with processing time
- The app checks for updates after startup and then periodically in the background

## Access modes

Talkis supports three modes of operation:

### Subscription (Talkis Cloud)

Sign in to [Talkis Cloud](https://talkis.ru) and use the service without managing your own API keys. All requests go through `proxy.talkis.ru`.

### Custom provider — own API key

Bring your own OpenAI-compatible API key. Configure separate keys and endpoints for STT (transcription) and LLM (text cleanup) independently.

Supported STT models:
- `whisper-1` — classic OpenAI Whisper
- `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` — newer transcribe models

### Custom provider — local model

Run a local [Speaches](https://speaches.ai) (faster-whisper) server via Docker. No API key needed.

```bash
# 1. Download the Docker config
curl -O https://raw.githubusercontent.com/speaches-ai/speaches/master/compose.yaml
curl -O https://raw.githubusercontent.com/speaches-ai/speaches/master/compose.cpu.yaml

# 2. Start the local server
docker compose -f compose.cpu.yaml up -d

# 3. Install a model
curl http://127.0.0.1:8000/v1/models/Systran%2Ffaster-whisper-large-v3 -X POST

# 4. In Talkis settings, set STT endpoint to http://127.0.0.1:8000
```

LLM cleanup can be skipped entirely ("Без обработки") or pointed at a local LLM.

## macOS only

Talkis is currently designed for macOS.

The app relies on:

- microphone access
- accessibility permission for automatic text pasting (via CGEvent)
- a global hotkey

## Setup

Before first use, make sure you have:

1. macOS
2. One of the access modes configured (subscription, own key, or local model)
3. Microphone access enabled
4. Accessibility access enabled for Talkis

### 1. Open the settings window

When the app starts, it opens the settings window automatically.

If it is hidden, click the floating widget to open it again.

### 2. Grant permissions

On first launch, Talkis asks for:

- Microphone access — required for recording
- Accessibility access — required to paste the final text into other apps

Without accessibility permission, speech can still be processed, but automatic paste will not work.

### 3. Configure your access mode

Open the `Subscription` tab and choose between:

- **Подписка** — sign in to Talkis Cloud
- **Своя конфигурация** — enter your own API key or set up a local model

## How to use

### Basic flow

1. Focus any app or text field where you want to insert text
2. Hold `Shift + Command + Space`
3. Start speaking
4. Release the hotkey when finished
5. Wait a moment while Talkis processes the audio
6. The cleaned text is pasted automatically

### Locked recording mode

If you want to speak longer without holding the keys:

1. Press and hold `Shift + Command + Space`
2. While recording is active, press the hotkey again
3. Recording becomes locked
4. Press the hotkey once more to stop and process

### Floating widget controls

When the widget is idle, hover it to show quick controls:

- click the red record button to start a locked recording
- click the stop button during recording to finish and process
- click the copy button to copy the latest successful result from local history

The copy shortcut is cleared when history is cleared, and it refreshes after entries are deleted.

### Settings you can change

- Recognition language (`ru`, `en`, or auto)
- Input microphone
- Text cleanup style
- STT / LLM endpoints and API keys (custom mode)
- STT / LLM model names
- Global hotkey
- Autostart at system login

### File transcription

The `Файлы` tab can transcribe audio or video files without LLM cleanup. Supported audio files under 25 MB are sent directly. Larger files, video files, and less common formats are converted inside the app with a bundled ffmpeg sidecar before upload.

File transcription uses the same access mode as voice recording:

- Talkis Cloud sends files to `proxy.talkis.ru/api/transcribe-only`
- Custom provider mode sends files to the configured OpenAI-compatible STT endpoint

## Text styles

Talkis supports several cleanup styles for the final text:

- **Classic** — minimal cleanup, preserves the speaker's wording as closely as possible. Removes only obvious fillers. Keeps expressions like "ну вот" that may be the speaker's manner.
- **Business** — cleaner and more formal phrasing. Strips filler openers ("ну вот", "слушай", "как бы"), smooths hesitation artifacts. Suitable for emails, tasks, and work chats.
- **Tech** — code-aware processing. Normalizes technical terms ("юз стейт" → `useState`, "гит пуш" → `git push`), converts code dictation to canonical form, preserves natural-language descriptions about technology.

## History

The `Main` tab stores recent recordings locally so you can:

- review previous results (raw and cleaned text)
- filter entries by all, voice, or file
- see processing time for each entry
- retry failed entries
- copy text again
- copy the latest successful result from the floating widget
- delete individual entries
- clear the full history

History is stored locally on your machine. The app keeps the newest 1000 voice entries and 200 file entries, capped by a combined JSON payload of 50 MB.

## Privacy

- Audio is sent to the API endpoints you configure for transcription and cleanup
- In subscription mode, requests go through `proxy.talkis.ru`
- File transcription in subscription mode uses the raw transcription endpoint and skips text cleanup
- In custom mode, requests go directly to your configured endpoints
- In local mode, all processing stays on your machine
- Your API key and device token are stored locally in the app settings
- Talkis does not collect or store audio on its servers beyond the API call

## Advanced configuration

Talkis supports custom OpenAI-compatible endpoints for:

- STT (Whisper transcription) — separate endpoint, API key, and model
- LLM (text cleanup) — separate endpoint, API key, and model

If STT fields are left empty, the app uses the standard OpenAI API.
If LLM model is set to "Без обработки", the raw transcription is pasted without cleanup.

## Troubleshooting

### Nothing gets pasted / a stray "v" character appears

- Check that Talkis has Accessibility permission in macOS System Settings → Privacy & Security → Accessibility
- Make sure the Talkis binary is checked in the list
- Try again in a standard text field like Notes

### Foreign characters (Chinese, Arabic) in transcription

- Make sure a specific language is selected in settings (e.g. `ru`) instead of `auto`
- The `language` parameter constrains the STT model to the selected language

### Local Speaches model returns errors

- Verify the Docker container is running: `curl http://127.0.0.1:8000/health`
- Reinstall the model if you get 500 errors: delete and re-POST the model
- Speaches does not support `verbose_json` — Talkis handles this automatically for local endpoints

### The microphone list is empty

- Grant microphone permission in macOS
- Reopen the settings window
- Reconnect your audio device if you use an external microphone

### The hotkey does not trigger

- Make sure another app is not using the same shortcut
- Restart Talkis after changing macOS permissions

### Build fails on external drives with `._*` files

macOS can create AppleDouble metadata files on some external volumes. If Tauri fails while reading files like `._default.json`, remove them:

```bash
find . -name '._*' -delete
```

This repository also uses `.cargo/config.toml` to keep Cargo build artifacts off the external drive.

## Development

If you want to run the project locally:

```bash
bun install
bun run tauri dev
```

Useful commands:

```bash
bunx tsc --noEmit
bun run tauri build
bun run logs
bun run logs:clear
```

## GitHub releases

The repository includes a GitHub Actions workflow at `.github/workflows/release.yml`.

- The canonical release process is documented in `docs/release/rule.md`
- Before every release, refresh `README.md` and create a release review file from `docs/release/review-template.md`
- Push a tag like `v0.1.12` to build and publish a GitHub Release
- Or run the workflow manually and provide a tag
- The current workflow publishes macOS release artifacts and updater metadata
- For macOS release builds, move `Talkis.app` to `Applications` before granting Accessibility access

Optional macOS signing/notarization secrets:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

Without these secrets, the workflow can still produce unsigned macOS release artifacts.

## Tech stack

- Tauri v2
- React + TypeScript
- Rust (backend, CGEvent paste, prompt engine)
- OpenAI Whisper / gpt-4o-transcribe
- OpenAI GPT-4o mini (text cleanup)
- Speaches / faster-whisper (optional local STT)

## Status

Talkis is an active work in progress. Current version: **0.1.11**.
