# Local STT Runtime

Talkis supports a managed local STT runtime named `talkis-stt`. The app uses it for local models without requiring Docker.

## Runtime Lookup

When a local model is installed, Talkis:

1. Checks whether the local OpenAI-compatible endpoint is already available at `http://127.0.0.1:8000`.
2. Tries to start a bundled Tauri sidecar named `talkis-stt`.
3. If the sidecar is not bundled, downloads a platform-specific runtime from a manifest.
4. Starts the downloaded runtime and waits for `/health`.
5. Calls `POST /v1/models/:model` to install the selected model.

The runtime manifest URL defaults to:

```text
https://talkis.ru/downloads/talkis-stt/manifest.json
```

For development it can be overridden with:

```text
TALKIS_STT_RUNTIME_MANIFEST=https://example.test/manifest.json
```

## Manifest Format

```json
{
  "version": "0.1.0",
  "macos-aarch64": {
    "url": "https://talkis.ru/downloads/talkis-stt/0.1.0/talkis-stt-aarch64-apple-darwin",
    "sha256": "..."
  },
  "macos-x86_64": {
    "url": "https://talkis.ru/downloads/talkis-stt/0.1.0/talkis-stt-x86_64-apple-darwin",
    "sha256": "..."
  }
}
```

## Runtime API

The runtime must bind to localhost only.

```text
GET  /health
GET  /v1/models
POST /v1/models/:model
POST /v1/audio/transcriptions
```

`GET /v1/models` should return:

```json
{
  "data": [
    { "id": "Systran/faster-whisper-large-v3-turbo" }
  ]
}
```

`POST /v1/audio/transcriptions` should accept OpenAI-compatible multipart form data and return:

```json
{
  "text": "Recognized text"
}
```
