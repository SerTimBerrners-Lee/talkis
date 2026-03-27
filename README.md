# Talk Flow

Talk Flow is a lightweight macOS voice-to-text app built with Tauri.

It sits in a small floating widget, listens while you hold a hotkey, sends audio to Whisper for transcription, cleans up the text with GPT-4o mini, and pastes the result into the active app.

## What it does

- Hold `Command + Space` to start recording
- Release the hotkey to stop and process the audio
- The recognized text is pasted automatically into the current app
- A second press during recording locks the recording mode
- The settings window lets you choose language, microphone, API key, and text cleanup style
- Recent recordings are saved in local history

## macOS only

Talk Flow is currently designed for macOS.

The app relies on:

- microphone access
- accessibility permission for automatic text pasting
- a global hotkey

## Setup

Before first use, make sure you have:

1. macOS
2. an OpenAI API key
3. microphone access enabled
4. accessibility access enabled for Talk Flow

### 1. Open the settings window

When the app starts, it opens the settings window automatically.

If it is hidden, click the floating widget to open it again.

### 2. Grant permissions

On first launch, Talk Flow asks for:

- Microphone access - required for recording
- Accessibility access - required to paste the final text into other apps

Without accessibility permission, speech can still be processed, but automatic paste may not work correctly.

### 3. Add your OpenAI API key

Open the `Subscription` tab and paste your OpenAI API key.

Right now Talk Flow works with your own API key only.

The key is used for:

- `whisper-1` for speech recognition
- `gpt-4o-mini` for text cleanup

## How to use

### Basic flow

1. Focus any app or text field where you want to insert text
2. Hold `Command + Space`
3. Start speaking
4. Release the hotkey when finished
5. Wait a moment while Talk Flow processes the audio
6. The cleaned text is pasted automatically

### Locked recording mode

If you want to speak longer without holding the keys:

1. Press and hold `Command + Space`
2. While recording is active, press the hotkey again
3. Recording becomes locked
4. Press the hotkey once more to stop and process

### Settings you can change

- Recognition language
- Input microphone
- Text cleanup style
- OpenAI API key

## Text styles

Talk Flow supports several cleanup styles for the final text. The exact labels may evolve, but the idea is simple:

- `Classic` - neutral cleanup for everyday dictation
- `Business` - cleaner and more formal phrasing
- `Tech` - better suited for technical language and terms

## History

The `Main` tab stores recent recordings locally so you can:

- review previous results
- copy text again
- delete individual entries
- clear the full history

History is stored locally on your machine.

## Privacy

- Audio is sent to the API endpoints you configure for transcription and cleanup
- By default, Talk Flow uses OpenAI endpoints
- Your API key is stored locally in the app settings
- Talk Flow does not require a Talk Flow account

## Advanced configuration

Talk Flow supports custom compatible endpoints for:

- Whisper transcription
- chat completion / cleanup

If these fields are left empty, the app uses the standard OpenAI API.

## Troubleshooting

### Nothing gets pasted

- Check that Talk Flow has Accessibility permission in macOS System Settings
- Make sure the target app allows normal paste input
- Try again in a standard text field like Notes

### The microphone list is empty

- Grant microphone permission in macOS
- Reopen the settings window
- Reconnect your audio device if you use an external microphone

### The hotkey does not trigger

- Make sure another app is not using the same shortcut
- Restart Talk Flow after changing macOS permissions

### Build fails on external drives with `._*` files

macOS can create AppleDouble metadata files on some external volumes. If Tauri fails while reading files like `._default.json` or `._default.toml`, remove them:

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
bun run build:release:macos
bun run logs
bun run logs:clear
```

## GitHub releases

The repository includes a GitHub Actions workflow at `.github/workflows/release.yml`.

- The canonical release process is documented in `docs/release/rule.md`
- Before every release, refresh `README.md` and create a release review file from `docs/release/review-template.md`
- Push a tag like `v0.1.6` to build and publish a GitHub Release
- Or run the workflow manually and provide a tag like `v0.1.6`
- The current workflow publishes all currently supported release artifacts, which is macOS only right now
- Windows and Linux are listed in the matrix but intentionally disabled until platform-specific support is added
- For macOS release builds, move `Talk Flow.app` to `Applications` before granting Accessibility access

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
- React
- TypeScript
- Rust
- OpenAI Whisper
- OpenAI GPT-4o mini

## Status

Talk Flow is an active work in progress. Expect rough edges while the interaction model and onboarding continue to improve.
