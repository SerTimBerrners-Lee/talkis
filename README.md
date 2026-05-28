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

## Highlights

- Dictate into any active text field with a global hotkey.
- Use locked recording mode for longer speech without holding the keys.
- Paste cleaned text automatically after transcription.
- Choose cloud mode, your own API key, or local STT models.
- Transcribe audio and video files from the Files tab or by dropping files onto the widget.
- Record macOS calls with separate microphone and system-audio tracks.
- Keep local history for voice recordings and file transcriptions.
- Run managed local runtimes for Whisper, Qwen ASR, NVIDIA Parakeet, and speaker diarization.
- Build native bundles for macOS, Windows, and Linux.

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

### Talkis Cloud

Sign in to [Talkis Cloud](https://talkis.ru) and use transcription without managing API keys. Requests go through `proxy.talkis.ru`.

### Own API Key

Use an OpenAI-compatible STT endpoint and a separate LLM endpoint for text cleanup. The Models tab also contains API adapter cards for supported providers.

Supported STT model names include:

- `whisper-1`
- `gpt-4o-transcribe`
- `gpt-4o-mini-transcribe`

### Local Models

Install and run Talkis-managed local runtimes from Settings. Local mode is transcription-only unless you also configure a separate LLM endpoint.

Managed local runtimes:

- Whisper, default endpoint `http://127.0.0.1:8000`
- NVIDIA Parakeet MLX, default endpoint `http://127.0.0.1:8001`
- Qwen ASR, default endpoint `http://127.0.0.1:8002`
- Speaker diarization, default endpoint `http://127.0.0.1:8003`

If a default port is busy, Talkis starts the managed runtime on a fallback port and saves the actual endpoint in settings.

## Installation

Download the latest build from GitHub Releases:

- [macOS DMG](https://github.com/SerTimBerrners-Lee/talkis/releases/latest/download/Talkis-macos.dmg)
- [Windows x64 installer](https://github.com/SerTimBerrners-Lee/talkis/releases/latest/download/Talkis-windows-x64-setup.exe)
- [Linux x64 AppImage](https://github.com/SerTimBerrners-Lee/talkis/releases/latest/download/Talkis-linux-x64.AppImage)

On first launch, grant the permissions Talkis needs:

- Microphone access for recording.
- Accessibility permission on macOS for automatic paste.
- Screen and System Audio Recording permission on macOS for call recording.

## File Transcription

The Files tab supports audio and video transcription up to 8 GB. Files are processed through a native path-based pipeline, so large files do not need to be loaded into WebView memory.

Talkis uses the bundled ffmpeg sidecar for video, unsupported audio formats, chunking, and diarization preparation. Ready `16 kHz` mono PCM WAV files can skip conversion for local STT.

Speaker diarization is available through Talkis Cloud or through local Whisper plus the local diarization runtime, depending on the selected access mode.

## Call Recording

macOS call recording captures two tracks:

- `You` from the microphone.
- `Call` from system audio.

Windows and Linux system-audio call capture are explicit unsupported placeholders until WASAPI loopback and PipeWire monitor capture are implemented.

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
- Call recording cannot start on macOS: grant both Microphone and Screen and System Audio Recording permissions, then restart Talkis.
- Need deeper diagnostics: open `~/.talkis/talkis.log` or run `bun run logs` during development.

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
bunx tsc --noEmit
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
docs/                 Release docs, audio rules, demo media
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
- Release workflow is documented in [docs/release/rule.md](docs/release/rule.md).

## License

No license file is included in this checkout yet. Add a `LICENSE` file before publishing the repository as a fully open-source project or accepting external contributions.

## Status

Talkis is an active work in progress. Current version: `0.1.24`.
