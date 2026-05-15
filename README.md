# Talkis

Talkis is a lightweight desktop voice-to-text app built with Tauri.

It sits in a small floating widget, listens while you hold a hotkey, sends audio for transcription, cleans up the text with an LLM, and pastes the result into the active app.

## What it does

- Hold `Shift + Command + Space` to start recording
- Release the hotkey to stop and process the audio
- The recognized text is pasted automatically into the current app
- A second press during recording locks the recording mode
- The floating widget can start/stop recording with a mouse click, copy the latest result, and show a low microphone signal notice
- Autostart can be enabled from settings
- The settings window lets you choose language, microphone, model source, API adapter, text cleanup style, and transcribe audio/video files
- The settings window supports system, light, and dark appearance modes; system mode follows macOS
- The settings window lets you change the local models directory and reset it to the default app data directory
- Recent voice recordings and file transcriptions are saved in local history with processing time
- The app checks for updates after startup and then periodically in the background; available updates can be installed from the settings sidebar
- Local STT can install and run Talkis-managed Whisper, Qwen, NVIDIA Parakeet, and speaker-diarization runtimes without requiring the user to install Python or Docker manually
- Linux builds use non-transparent utility windows on X11/Cinnamon to avoid unsupported GDK/X11 window operations during startup

## Access modes

Talkis supports three modes of operation:

### Cloud subscription (Talkis Cloud)

Sign in to [Talkis Cloud](https://talkis.ru) and use the service without managing your own API keys. All requests go through `proxy.talkis.ru`.

### API adapters — own API key

Bring your own API key. In the `Модели` tab, choose API mode and expand an adapter card to enter the API key, model name, and optional custom host such as `http://localhost:8000`. Save or test the adapter, then click `Выбрать` to make it the active transcription mode. Opening the API section alone does not switch away from the currently selected local model or cloud mode.

OpenAI can be tested from the app. Other adapters save the key and model now, and their saved connection state is remembered across app restarts while backend integrations are added.

You can still configure separate custom endpoints and keys for STT (transcription) and LLM (text cleanup) independently in local/custom mode.

Supported STT models:
- `whisper-1` — classic OpenAI Whisper
- `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` — newer transcribe models

### Local model

Open `Модели` → `Локально`, choose a supported local STT model, and click `Скачать`. Talkis starts the matching OpenAI-compatible local runtime and downloads the selected model into the configured local models directory. Downloaded local models show as ready, and the active model shows `Выбрана`; selecting a local model requires clicking `Выбрать`.

The local models directory is configurable in `Настройки` → `Директория моделей`. Click `Изменить` to pick a folder. The `По умолчанию` reset appears only after a custom directory has been selected.

Managed local runtimes:

- Whisper runtime, default endpoint `http://127.0.0.1:8000`
- NVIDIA Parakeet MLX runtime, default endpoint `http://127.0.0.1:8001`
- Qwen ASR runtime, default endpoint `http://127.0.0.1:8002`
- Speaker diarization runtime, default endpoint `http://127.0.0.1:8003`

If one of these ports is already occupied by another app, Talkis automatically starts the managed runtime on a free fallback port and saves the actual endpoint in settings. Fallback ranges are `18000-18049` for Whisper, `18050-18099` for NVIDIA, `18100-18149` for Qwen, and `18150-18199` for speaker diarization.

Supported managed local models include:

- `whisper-large-v3-turbo`
- `whisper-small`, `whisper-medium`, `whisper-large-v2`, `whisper-large-v3`, `whisper-base`, `whisper-tiny`
- `Qwen/Qwen3-ASR-0.6B`
- `mlx-community/parakeet-tdt-0.6b-v3`
- `mlx-community/parakeet-tdt-0.6b-v2`

Local STT is transcription-only. Talkis does not run LLM/style cleanup for local STT mode unless a separate LLM endpoint is configured in custom mode.

## Supported platforms

Talkis release automation builds native bundles for:

- macOS
- Windows
- Linux

The app relies on:

- microphone access
- accessibility permission on macOS for automatic text pasting (via CGEvent)
- best-effort paste simulation on Windows/Linux
- a global hotkey

On Linux X11 sessions such as Cinnamon, Talkis disables transparent widget and settings windows while keeping the same compact window layout. This avoids known GDK/X11 crashes from unsupported compositor/window-manager operations.

## Setup

Before first use, make sure you have:

1. macOS, Windows, or Linux
2. One of the access modes configured (subscription, own key, or local model)
3. Microphone access enabled
4. Accessibility access enabled for Talkis on macOS

### 1. Open the settings window

When the app starts, it opens the settings window automatically.

If it is hidden, click the floating widget to open it again.

### 2. Grant permissions

On first launch, Talkis asks for:

- Microphone access — required for recording
- Accessibility access — required to paste the final text into other apps

Without accessibility permission, speech can still be processed, but automatic paste will not work.

### 3. Configure your access mode

Open the `Модели` tab and choose between:

- **Облако** — sign in to Talkis Cloud, then click `Выбрать` when PRO is active
- **API** — expand an adapter, enter your API key, model name, and optional host, then test/save and click `Выбрать`
- **Локально** — install or select a Talkis-managed local STT model with `Выбрать`

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
- Appearance mode (system, light, dark)
- Input microphone
- Text cleanup style
- API adapters and saved API keys/model names
- Optional custom API adapter hosts
- STT / LLM endpoints and API keys (custom/local mode)
- STT / LLM model names
- Global hotkey
- Autostart at system login

### Updates

Talkis checks for a new app version in the background after startup and then periodically. When an update is available, the settings sidebar shows `Установить обновление vN.N.N` above the current app version. Installation starts only after clicking that button; recording and transcription are not interrupted by an automatic restart.

### File transcription

The `Файлы` tab can transcribe audio or video files without LLM cleanup. File selection and drag-and-drop use a native path-based pipeline, so large files do not need to be loaded into the webview memory.

Talkis supports file transcription up to 1 GB. Video files, long recordings, and less common formats are converted inside the app with the bundled ffmpeg sidecar, split into safe audio chunks, and transcribed sequentially. The UI shows chunk progress while processing.

File transcription can optionally split the transcript by speakers. In Talkis Cloud mode, `Разделить по говорящим` sends that file job to the cloud diarization endpoint on `proxy.talkis.ru`, backed by AssemblyAI, and does not use the installed local Whisper runtime. If cloud diarization is unavailable, Talkis stops with an error instead of silently falling back to local processing. In API or local mode, Talkis uses a downloaded local Whisper model with timestamps plus the speaker-diarization components for that file job. The global API or local model selection is not overwritten by this background diarization flow.

File transcription uses the same access mode as voice recording:

- Talkis Cloud sends files to `proxy.talkis.ru/api/transcribe-only`
- Talkis Cloud sends speaker diarization files to `proxy.talkis.ru/api/transcribe-diarized`
- Custom provider mode sends files to the configured OpenAI-compatible STT endpoint
- Local mode sends chunks to the active managed local STT runtime
- Speaker diarization mode uses local Whisper and the local diarization runtime only outside Talkis Cloud mode

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
- File transcription in subscription mode uses raw transcription endpoints and skips text cleanup; speaker diarization files are processed through the cloud diarization provider
- In custom mode, requests go directly to your configured endpoints
- In local mode, all processing stays on your machine
- Your API key and device token are stored locally in the app settings
- Talkis does not collect or store audio on its servers beyond the API call

## Advanced configuration

Talkis supports custom OpenAI-compatible endpoints for:

- STT (Whisper transcription) — separate endpoint, API key, and model
- LLM (text cleanup) — separate endpoint, API key, and model
- API adapters — optional host field inside each adapter card

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

### Local STT model returns errors

- Open `Модели` → `Локально` and make sure the model shows `Выбрать` or is currently selected
- If a default port is busy, Talkis will try a fallback managed port automatically and save it in settings
- If the managed runtime is still using a stale models directory, Talkis restarts it against the currently configured directory
- Delete and reinstall the model if the runtime reports missing model files
- For custom localhost STT servers on non-managed ports, Talkis treats the endpoint as an external OpenAI-compatible server and does not try to start or stop it

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

On Ubuntu/Debian, install the native Tauri and bindgen dependencies first:

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev libxdo-dev librsvg2-dev patchelf clang libclang-dev
```

`libclang-dev` is required by `whisper-rs-sys` while building the local STT sidecars. If libclang is installed in a non-standard location, set `LIBCLANG_PATH` to the directory that contains `libclang.so`.

```bash
bun install
bun run prepare:sidecars
bun run tauri dev
```

Useful commands:

```bash
bunx tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
bun run check:release
bun run tauri build
bun run build:release
bun run build:release:macos
bun run build:release:windows
bun run build:release:linux
bun run logs
bun run logs:clear
```

## GitHub releases

The repository includes a GitHub Actions workflow at `.github/workflows/release.yml`.

- The canonical release process is documented in `docs/release/rule.md`
- Before every release, refresh `README.md` and create a release review file from `docs/release/review-template.md`
- Push a tag like `v0.1.19` to build and publish a GitHub Release
- Or run the workflow manually and provide a tag
- The current workflow publishes macOS, Windows, and Linux release artifacts plus updater metadata
- For macOS release builds, move `Talkis.app` to `Applications` before granting Accessibility access

Optional macOS signing/notarization secrets:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

Without Apple secrets, the workflow can still produce unsigned macOS release artifacts. Windows and Linux builds are currently unsigned.

## Tech stack

- Tauri v2
- React + TypeScript
- Rust (backend, CGEvent paste, prompt engine)
- OpenAI Whisper / gpt-4o-transcribe
- OpenAI GPT-4o mini (text cleanup)
- Talkis-managed local STT runtimes for Whisper, Qwen ASR, NVIDIA Parakeet MLX, and speaker diarization
- Bundled ffmpeg sidecar for media conversion and file transcription chunking

## Status

Talkis is an active work in progress. Current version: **0.1.21**.
