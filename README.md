<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="Talkis app icon">
</p>

<h1 align="center">Talkis</h1>

<p align="center">
  Open desktop voice input for people who write in real apps all day.
</p>

<p align="center">
  <a href="README.ru.md">Read in Russian</a>
  ·
  <a href="https://talkis.ru">Website</a>
  ·
  <a href="https://github.com/SerTimBerrners-Lee/talkis/releases/latest">Latest release</a>
</p>

<p align="center">
  <img src="docs/demo/demo-1.gif" alt="Talkis dictating a development request into a code editor" width="860">
</p>

## What Is Talkis?

Talkis is a desktop voice-to-text app built with Tauri, React, TypeScript, and Rust. It stays as a small floating widget, records while you hold a hotkey, transcribes your speech, optionally cleans the text with an LLM, and pastes the final result into the app you were using.

It is designed for practical daily work: IDEs, chats, notes, CRM fields, email, files, and meeting transcripts.

To work without the floating widget, turn off **Show the desktop widget** in Settings. Talkis keeps running via hotkeys and remembers this choice after restart. Open settings from the Talkis menu bar or tray icon to show the widget again.

Enable **Start minimized** in Settings to keep the main Talkis window hidden on the next launch. Hotkeys and the menu bar or tray icon stay available; widget visibility is a separate choice. The window still opens when initial setup or required permissions need attention. This option is off by default.

## Highlights

- Dictate into any active text field with a global hotkey.
- Use locked recording mode for longer speech without holding the keys.
- Paste cleaned text automatically after transcription.
- Choose cloud mode, your own API key, or local STT and text LLM models.
- Translate system audio in real time through Talkis Cloud or a verified Realtime API connection, with optional spoken translation on macOS.
- Translate selected text with a separate configurable global hotkey.
- Transcribe audio and video files from the Files tab or by dropping files onto the widget.
- Record calls with separate microphone and system-audio tracks on macOS, Windows, and Linux.
- Keep local history for voice recordings, file transcriptions, calls, and live translations.
- Chat with the configured text model to search and analyze Talkis records, summarize calls, find tasks, and translate text.
- Run managed local STT through one native `transcribe.cpp` runtime for Whisper, GigaAM, Qwen ASR, NVIDIA Parakeet, plus local text summaries through a managed GGUF LLM runtime.
- Build native bundles for macOS, Windows, and Linux.

## Latest Changes

### v0.4.10

- Settings can hide the floating desktop widget while keeping dictation hotkeys active. The choice survives restarts and is respected by the watchdog, tray actions and repeated launches.
- Added **Start minimized** (off by default): the main window stays hidden on the next launch, while the tray/menu bar and hotkeys remain available. Initial setup, required permission recovery and startup errors still reveal the window.
- Both new settings use compact switch rows without explanatory descriptions. Failed saves keep the previous choice; changing model settings preserves window preferences.

### v0.4.9

- Microphone startup has a three-second budget and native dictation start/stop runs outside the interface thread, keeping Talkis responsive when an audio driver stalls after idle or sleep. Dictation and call recording retain their WebView fallback; live translation reports a startup timeout.
- Ordinary dictation detects driver errors or missing audio callbacks, transcribes the audio captured before the interruption, and warns that later speech was not recorded. A driver stop timeout also preserves the captured audio, and the next recording opens the microphone again.
- Late native microphone startup releases its stream and live transcription session. Call recording uses a separate native track file so a late response cannot overwrite the fallback recording.
- Windows native crashes and Rust panics now leave build and process details in `~/.talkis/talkis.log`; startup and exit events help distinguish an application exit from interrupted recording. The reported Windows 10 exit after sleep still needs verification on affected machines.
- Restored the widget's manual record button on Windows, reduced repeated polling errors while the desktop is unavailable, and reduced the local text model's default context to 4096 tokens to lower memory use alongside speech recognition.

### v0.4.8

- Windows upgrades now stop Talkis and every bundled local-model process before replacing files, preventing `Error opening file for writing ... talkis-stt.exe` and partially installed application/runtime combinations.
- Talkis cleans up orphaned Windows sidecars on startup and terminates incompatible or timed-out managed STT runtimes, preventing stale processes from accumulating across ports and blocking future updates.
- Local transcription now always sends the active local model to the managed runtime, even when a previously selected API adapter still stores a remote model such as `gpt-4o-transcribe`; the backend also falls back to an actually installed local model for migrated settings.
- Voice capture no longer waits up to 15 seconds for a cold local streaming runtime: after a short warm-up budget it starts recording immediately and keeps the normal post-stop transcription fallback available.
- The Windows release verifier now requires the NSIS install/uninstall cleanup hook and every bundled process name, so this upgrade protection is checked in release builds.

### v0.4.7

- Local STT setup on Windows now starts the model download before launching the runtime, reads installed models directly from disk, warms the runtime in the background, bypasses system proxies for loopback requests, and records sidecar output for diagnostics.
- Windows development commands now discover Rust and the Visual Studio C++ toolchain automatically and keep the application and local-model sidecars on the same static runtime, avoiding missing `rustc` and linker failures during `bun run tauri dev`.
- Clicking the floating widget on Windows opens Talkis, recognition/translation mode changes persist correctly, and the Settings window uses a native Windows caption with Talkis styling and reliable system buttons.
- Widget errors now appear in one expandable status bar below the controls, with copy and expand actions; Windows clipboard shortcuts use physical keys so automatic paste also works with non-Latin keyboard layouts.
- The floating widget is now persistent: Talkis prevents accidental closure and automatically restores a hidden, minimized, destroyed, or off-screen widget without stealing focus from the active application.
- macOS call recording no longer adds the output device to the capture aggregate or opens a competing WebView microphone when native capture is available, preventing call volume and microphone routing changes.
- Fixed the Windows onboarding offset that exposed content from the main screen above the setup flow, and clarified model activation progress after a download finishes.

### v0.4.6

- Fixed a Windows crash that could close Talkis without an error on the first dictation after a long idle period or system sleep.
- Native microphone capture now keeps one process-long `cpal`/WASAPI owner thread across recording sessions, preventing reuse of a COM audio-device enumerator after its owning thread has ended.
- Native recorder lifecycle failures are logged and returned to the existing WebView microphone fallback instead of leaving the dictation flow without a recoverable error path.

### v0.4.5

- Cloud dictation now waits for the accurate full-audio batch transcript instead of showing a lower-quality realtime text overlay that could differ from the pasted result.
- Short, silent, or noisy recordings are rejected before paste when the cloud model returns stock refusal text, unrelated foreign-language fragments, or other low-confidence hallucinations.
- Talkis Cloud remains selected after sign-in and when revisiting Models: stale local STT endpoints and keys are cleared instead of silently switching the app back to another mode.
- Cloud balances, usage, and reservations are displayed as whole tokens throughout the desktop app.
- Cloud file transcription with speaker separation now supports long meetings through the upgraded server route, while the desktop distinguishes real timeouts from other diarization failures and records the raw diagnostic error.

### v0.4.4

- Promoted the existing model chat from development mode to the product navigation on macOS, Windows, and Linux.
- Added direct Chat access from the desktop tray and production-safe `?tab=chat` navigation.
- The chat can search local Talkis records with cited sources, summarize recent calls and transcripts, extract tasks, translate text, and use the configured Cloud, API, or local text model.
- Chat messages remain stored locally, and existing development chat history is preserved during the product upgrade.

### v0.4.3

- Restored the standard compact hotkey field in Settings, matching the selected-text translator control, while keeping the large live keycap visualization exclusive to onboarding.

### v0.4.2

- Added a guided first-run flow that grants permissions, downloads and activates a local STT model, and verifies dictation with the configured global hotkey before setup completes.
- Unified dictation hotkey capture logic across onboarding and Settings, while keeping live key previews in onboarding, apply-without-restart behavior, and conflict handling.
- Reused one local-model card pattern across onboarding and Settings, and added a way to deselect the active local text model without deleting its downloaded file.
- Added managed OPUS-MT English-to-Russian translation, reverse-pair fallback selection, and removal of model reasoning blocks from selected-text translation results.
- Hardened microphone routing for voice and call capture, prevented batch-only local STT models from inheriting API streaming capability, and fixed onboarding when an empty recording produces no transcript.

### v0.4.1

- Added GigaAM v3 E2E RNNT as a managed local Russian speech-recognition model, with short file-transcription chunks matched to the model's 25-second window.
- Fixed local selected-text translation dropping everything after the first sentence by translating multi-sentence input as a checked CTranslate2 batch.
- Improved local model installation with automatic retries for transient Hugging Face transport failures and stable installed-state UI while the local runtime refreshes.
- Added live call transcription directly in the Transcription result view while separate microphone and system-audio tracks continue to be saved for recovery and final refinement.
- Added a persistent desktop system tray with explicit Open Talkis and Quit actions; Quit also terminates managed local sidecar processes.
- Added a native Windows release gate that verifies the main application and every bundled sidecar as x86-64 PE executables, plus a published SHA-256 checksum for the stable Windows installer.

### v0.4.0

- Added synchronous system-audio translation through Talkis Cloud or verified OpenAI/Gemini Realtime API adapters; local models remain available for the rest of the app, while live translation requires Cloud or API.
- Added optional translated voice playback on macOS, with Talkis audio excluded from capture and the original source ducked to prevent feedback loops.
- Added realtime streaming dictation for supported local and API STT models, including live partial text and a batch fallback for the final result.
- Reworked dictation and selected-text hotkey capture into one release-on-complete transaction with conflict checks, rollback, stale-request protection, and runtime registration without restart.
- Improved the floating text overlay: wider streaming layout, compact speaker turns, dark-theme support, drag-to-move, immediate replacement by a new request, and automatic dismissal ten seconds after terminal results.
- Fixed selected-text translation, permission recovery after relaunch, widget edge clipping, history action menus near the viewport edge, live-translation audio playback, and persisted widget/streaming settings.
- File transcripts now present the first detected speaker as `You` and the others as `Guest N`; stable inline renaming updates every segment without moving the caret.
- Call history now keeps and synchronously plays separate microphone and system-audio tracks so both sides of a conversation remain audible.
- The experimental development chat now searches local history with general lexical and offline-semantic ranking, while a compatible embedding backend can optionally improve recall.
- Added a stable signed macOS development app runner so TCC permissions survive local rebuilds when an Apple Development identity is available.

### v0.3.12

- Fixed the Windows frontend release build by invoking Vite through its package JavaScript entrypoint instead of the platform-specific `.cmd` shim.
- Fixed Windows release bundle linking by using the static MSVC CRT expected by the bundled C++ translation runtime.
- This release candidate must pass Release Preflight on macOS, Windows, and Linux before a tag is created.

### v0.3.11

- Fixed the Windows release workflow by reusing sidecars prepared during release checks instead of running the sidecar preparation step twice.
- Made sidecar preparation idempotent by skipping copies when the source and destination binaries are already identical.

### v0.3.10

- Hardened the Windows Vite wrapper path normalization used by release builds.
- Split the GitHub Actions release bundle phase into explicit sidecar, frontend, and native bundle steps so Windows packaging failures are visible without raw log access.

### v0.3.9

- Fixed Windows release builds by resolving the Vite wrapper root path with `fileURLToPath`, avoiding malformed `/D:/...` paths on GitHub Actions Windows runners.
- Re-publishing the v0.3.8 app changes with the Windows bundle fix so macOS, Windows, and Linux artifacts can be produced by the release workflow.

### v0.3.8

- Added live local dictation for streaming STT models: the text overlay opens when recording starts, shows partial results while speaking, and still pastes only after stop.
- Improved the text overlay lifecycle so live dictation, translation, and paste errors do not overwrite each other; first-show startup races are handled through an explicit ready handshake.
- Added local selected-text translation with managed local translator options and selection hotkey settings.
- Improved local file transcription for WebM/video inputs and local streaming models by routing files through native preparation and streaming-compatible chunks.
- Reduced voice-history memory pressure by storing completed recording audio through the history audio store instead of keeping large base64 payloads in live history entries.
- Refreshed settings/model UI for local STT, local LLM, local translation, and development chat workflows.

### v0.3.7

- Migrated managed local file transcription to a unified native `transcribe.cpp` runtime for Whisper, Qwen ASR, and NVIDIA Parakeet.
- Removed the old Qwen/Parakeet MLX/Python sidecars from the desktop bundle and release build.
- Fixed local STT settings migration so old Qwen/Parakeet endpoints move to `http://127.0.0.1:8000` and do not require an API key.
- Fixed selecting a local transcription model so it no longer clears the selected text model used for summarization.

### v0.3.6

- Fixed permissions onboarding recovery for existing installs so updates do not reopen the full permissions screen when required macOS access is already granted.
- Switched the app icon set from Lucide to Phosphor through a local icon facade for softer, more consistent product UI icons.
- Added a macOS Vite/esbuild runner workaround for development and release builds from external drives.
- Kept local STT failures separate from API-key authentication errors when a local model is selected.

### v0.3.5

- Fixed local STT mode so managed localhost runtimes are called without a stale API bearer token and no longer show an API-key error for local runtime failures.
- Improved widget notice layout so the status icon stays visually centered next to long messages.
- Prevented call-capture startup errors from resetting the completed permissions onboarding state after restart.

### v0.3.4

- Fixed repeated permission prompts after restarting macOS: startup checks no longer trigger a microphone request, and Accessibility is not reset before re-requesting access.
- Updated the transcription statistics card to show words today, words this month, and words per minute instead of the less useful all-time words metric.

## Demo

The repository includes the same GIF demos used on the Talkis website.

| Demo | What it shows |
| --- | --- |
| [Dictating code](docs/demo/demo-1.gif) | A short development request inserted into an editor |
| [Dictating an email](docs/demo/demo-2.gif) | Business-style speech-to-email flow |
| [Dictating a note](docs/demo/demo-3.gif) | Everyday notes and task capture |
| [Recording a call](docs/demo/demo-4.gif) | Separate call-recording flow from the widget |
| [Transcribing a file](docs/demo/demo-5.gif) | Audio/video file transcription |
| [Choosing models](docs/demo/demo-6.gif) | Local models and own API configuration |

<details>
<summary>Show more demos inline</summary>

### Email Dictation

<img src="docs/demo/demo-2.gif" alt="Talkis dictating an email" width="860">

### Notes

<img src="docs/demo/demo-3.gif" alt="Talkis dictating a note" width="860">

### Call Recording

<img src="docs/demo/demo-4.gif" alt="Talkis recording a call transcript" width="860">

### File Transcription

<img src="docs/demo/demo-5.gif" alt="Talkis transcribing an audio or video file" width="860">

### Local Models And API Keys

<img src="docs/demo/demo-6.gif" alt="Talkis choosing a local model or own API key" width="860">

</details>

## How It Works

1. Focus the text field where you want the result to appear.
2. Hold `Shift + Command + Space` on macOS.
3. Speak naturally.
4. Release the hotkey.
5. Talkis transcribes, cleans, and pastes the text.

The hotkey, microphone, language, model source, cleanup style, and app appearance are configurable in Settings.

## Access Modes

| Capability | Cloud | API | Local |
| --- | --- | --- | --- |
| Dictation, files, and local history | Yes | Yes | Yes |
| Streaming dictation | No; final batch only | Verified models | Streaming-capable models |
| Selected-text translation | Yes | Yes | Yes |
| Speaker diarization | When the capability is available | Local diarization kit | Local diarization kit |
| Synchronous translation | Yes | Verified OpenAI/Gemini Realtime | No |
| Summaries and prompt processing | Yes | With a configured LLM | With a selected local LLM |

The complete data routing, runtime processes, limitations, and failure boundaries are documented in the Russian-language [Cloud/API/Local mode architecture](docs/architecture/processing-modes.md). Verifiable user behavior is collected in the [product business requirements](docs/business-requirements.md).

### Talkis Cloud

Sign in to [Talkis Cloud](https://talkis.ru) and use transcription without managing API keys. Requests go through `proxy.talkis.ru`. Cloud dictation shows recording and processing states, then pastes only the final full-audio batch transcript; the realtime text overlay is intentionally unavailable in Cloud mode. Synchronous translation still uses a short-lived Realtime credential issued by the authenticated proxy; the provider key is never stored in the desktop app.

### Own API Key

Use an OpenAI-compatible STT endpoint and a separate LLM endpoint for text cleanup. The Models tab also contains API adapter cards for supported providers.

Realtime dictation and synchronous translation are enabled only after the exact provider, model, endpoint, and key configuration passes its connection check.

Supported STT model names include:

- `whisper-1`
- `gpt-4o-transcribe`
- `gpt-4o-mini-transcribe`

### Local Models

Install and run Talkis-managed local models from Settings. Local mode can keep both transcription and transcript summaries on your machine: STT models handle audio, and a separate local text LLM handles summary and prompt-based processing.

Managed local runtimes:

- Whisper, GigaAM GGUF, NVIDIA Parakeet GGUF, and Qwen ASR GGUF through the unified `transcribe.cpp` runtime, default endpoint `http://127.0.0.1:8000`
- Text LLM summaries through the bundled OpenAI-compatible `talkis-llm` runtime backed by GGUF models such as Qwen2.5 Instruct
- Speaker diarization, default endpoint `http://127.0.0.1:8003`

If a default port is busy, Talkis starts the managed runtime on a fallback port and saves the actual endpoint in settings.

## Installation

Download the latest build from GitHub Releases:

- [macOS DMG](https://github.com/SerTimBerrners-Lee/talkis/releases/latest/download/Talkis-macos.dmg)
- [Windows x64 installer](https://github.com/SerTimBerrners-Lee/talkis/releases/latest/download/Talkis-windows-x64-setup.exe)
- [Linux x64 AppImage](https://github.com/SerTimBerrners-Lee/talkis/releases/latest/download/Talkis-linux-x64.AppImage)

### If your OS blocks the first launch

Talkis is currently distributed **without paid code signing**, so Gatekeeper (macOS) and SmartScreen (Windows) show an "unverified app" warning. This is **not malware**: the source is open (AGPL-3.0) and the builds are produced by the public GitHub Actions workflow in this repo. How to open it:

**macOS** — "Apple could not verify Talkis is free of malware":

1. In the dialog click **Done** (not "Move to Trash").
2. Open **System Settings → Privacy & Security**, scroll down to *"Talkis was blocked…"* and click **Open Anyway**.
3. Confirm with your password or Touch ID and click **Open** again.

Or, in one command in Terminal (after moving it to Applications):

```bash
xattr -dr com.apple.quarantine /Applications/Talkis.app
```

**Windows** — the blue *"Windows protected your PC"* dialog:

1. Click **More info**.
2. Click **Run anyway**.

On first launch, grant the permissions Talkis needs:

- Microphone access for recording.
- Accessibility permission on macOS for automatic paste.
- Screen and System Audio Recording permission on macOS for call recording.

After permissions are granted, Talkis stores the completed onboarding state and
does not reopen native permission prompts on every launch. If an OS permission is
reset or denied later, Talkis asks again only when that access is needed.

## File Transcription

The Files tab supports audio and video transcription up to 8 GB. Files are processed through a native path-based pipeline, so large files do not need to be loaded into WebView memory.

Talkis uses the bundled ffmpeg sidecar for video, unsupported audio formats, chunking, and diarization preparation. Ready `16 kHz` mono PCM WAV files can skip conversion for local STT.

Speaker diarization is available through Talkis Cloud or through local Whisper plus the local diarization runtime, depending on the selected access mode.

## Call Recording

Call recording captures two tracks:

- `You` from the microphone.
- `Call` from system audio.

System-audio capture is implemented with Core Audio on macOS, WASAPI loopback on
Windows, and PipeWire monitor streams on Linux. Linux requires a running PipeWire
daemon with an active output device.

The call appears in history as soon as recording starts. Talkis checkpoints
both audio tracks and the transcript draft while the call is active. Streaming
STT models show live text in the Transcription tab, then the saved tracks refine
the result after stop. After an unexpected shutdown, Talkis restores available
audio and the latest durable draft on the next launch. GigaAM and other
batch-only models transcribe the call after recording stops.

## Synchronous Translation

Enable the translation button in Settings -> Translation, choose the target language, and start it from the floating widget. Cloud mode uses the Talkis proxy; API mode uses a verified OpenAI or Gemini Realtime adapter. Local mode does not provide synchronous translation, but local dictation, selected-text translation, file transcription, summaries, and other local features remain available.

The live text overlay keeps consecutive chunks from the same source together and stores the finished session in local history. On macOS, OpenAI-backed sessions can also play translated speech while reducing the original source volume.

## Privacy

- In cloud mode, requests go through `proxy.talkis.ru`.
- In own-key mode, requests go directly to the endpoints you configure.
- In local mode, transcription stays on your machine.
- API keys and device tokens are stored locally in app settings.
- Voice history and file transcription history are stored locally.
- Talkis does not keep audio on its own servers beyond the API call.

## Troubleshooting

- Nothing is pasted: check macOS System Settings -> Privacy & Security -> Accessibility and make sure Talkis is enabled.
- Transcription contains unexpected foreign characters: choose a fixed recognition language such as `ru` or `en` instead of auto.
- Local STT returns model errors: open `Модели` -> `Локально`, make sure the model is installed and selected, then reinstall it if the runtime reports missing files.
- Call recording cannot start: grant Microphone and the OS system-audio permission, then start the call recording again. On Linux, also make sure PipeWire is running and an output device is active.
- Need deeper diagnostics: open `~/.talkis/talkis.log` or run `bun run logs` during development.

## Product And Architecture Documentation

- [Cloud/API/Local mode architecture](docs/architecture/processing-modes.md) — technical routing for dictation, files, calls, translation, LLM processing, and history.
- [Talkis business requirements](docs/business-requirements.md) — user capabilities, expected behavior, limitations, and acceptance criteria.
- [Audio pipeline principles](docs/audio-pipeline-principles.md) — mandatory engineering rules for recording, STT, files, and call capture.
- [Local STT runtime](docs/local-stt-runtime.md) — managed local recognition architecture and contract.

## Development

Requirements:

- Bun `1.2.x`
- Rust stable
- Tauri v2 system dependencies

Install dependencies and start the app:

```bash
bun install
bun run prepare:sidecars
bun run tauri dev
```

Useful commands:

```bash
bun x tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
bun run check:release
bun run tauri build
bun run build:release:macos
bun run logs
```

On Ubuntu/Debian, install native Tauri and sidecar build dependencies first:

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev libxdo-dev libasound2-dev librsvg2-dev patchelf clang libclang-dev cmake
```

## Project Structure

```text
src/                  React and TypeScript frontend
src/windows/widget/   Floating widget window
src/windows/settings/ Settings window and tabs
src/lib/              Store, auth, permissions, logging, shared clients
src-tauri/src/        Rust backend, Tauri commands, audio, paste, STT
src-tauri/icons/      App icons
docs/                 Architecture, business requirements, release docs, audio rules, demo media
scripts/              Release and sidecar preparation scripts
```

For audio, transcription, local STT, file transcription, or call-capture changes, read [docs/audio-pipeline-principles.md](docs/audio-pipeline-principles.md) before editing code.

## Tech Stack

- Tauri v2
- React 19
- TypeScript
- Rust
- cpal native microphone recording
- OpenAI-compatible STT and LLM APIs
- Managed local STT sidecars
- Bundled ffmpeg sidecar

## Contributing

Issues and pull requests are welcome. Before changing audio behavior, read the audio pipeline document and keep enough logging to debug recorder stats, ffmpeg timing, STT endpoint selection, chunk progress, and call-capture levels.

Project conventions:

- UI text is Russian.
- Code and comments are English.
- Package manager is Bun.
- Settings are persisted immediately after change.
- Release workflow is documented in [rules/release.rule.md](rules/release.rule.md).

## License

Talkis is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE) (`AGPL-3.0-or-later`).

This license keeps the desktop app open-source and also requires source availability for modified versions that are offered to users over a network, which matters for the Talkis Cloud/API companion surface.
