# Audio Pipeline Principles

This document is the working contract for Talkis audio changes. Future agents should update it when the audio architecture changes.

## Goals

- Keep ordinary voice dictation fast.
- Keep transcription quality stable.
- Avoid moving expensive conversion into hot paths.
- Keep local, cloud, file, and call behavior explicit instead of relying on hidden fallbacks.
- Preserve enough logs to diagnose audio quality and runtime behavior from `~/.talkis/talkis.log`.

## Pipeline Map

Voice dictation:

```text
Widget hotkey/button
-> useWidgetRecording.ts
-> recordingRuntime.ts
-> native_voice_recorder.rs first
-> processRecordingBlob()
-> ai::transcribe_and_clean()
-> paste_text
```

File transcription:

```text
Files tab / widget file drop
-> src/lib/fileTranscription.ts
-> ai::transcribe_file_path()
-> media.rs preparation/chunking
-> local, custom, or cloud STT
```

Call transcription:

```text
Widget call mode
-> src/lib/callCapture.ts
-> call_capture.rs for system track
-> recordingRuntime.ts for mic track
-> transcribeCallCaptureSession()
-> file transcription pipeline
```

## Voice Dictation

The primary voice path is native Rust capture:

- `src-tauri/src/native_voice_recorder.rs`
- Tauri commands:
  - `start_native_voice_recording`
  - `pause_native_voice_recording`
  - `resume_native_voice_recording`
  - `stop_native_voice_recording`
- Output contract:
  - `audio_base64`
  - `mime_type: "audio/wav"`
  - `file_name: "recording.wav"`
  - `duration_ms`
  - `sample_rate: 16000`
  - `channels: 1`
  - `peak`
  - `rms`

The recorder uses `cpal`, stores microphone samples in memory, converts to mono, resamples to `16 kHz`, writes PCM16 WAV, and logs stats on stop.

Important implementation detail: on macOS, `cpal::Stream` is not safe to keep in a global static. Keep the stream alive on its own recorder thread and store only thread-safe control handles in global state.

## Voice Fallback

Keep WebView `MediaRecorder` fallback in `recordingRuntime.ts`.

Fallback is required when:

- native recorder fails to start;
- a selected microphone exists, but only WebView `deviceId` can identify it reliably;
- platform-specific microphone permissions or device routing behave differently than `cpal`.

Do not remove the fallback unless selected-microphone parity is proven on macOS, Windows, and Linux.

## Local STT Input Format

Managed local Whisper expects:

```text
WAV, 16 kHz, mono, PCM 16-bit
```

Rules:

- Native voice recording should already produce this format.
- `media::convert_audio_to_local_stt_wav()` must skip ffmpeg when input is already ready.
- File transcription should also skip ffmpeg for ready WAV files that fit into one STT request.
- ffmpeg remains the correct path for arbitrary audio/video, WebM/Opus, MP3/M4A/MP4, diarization prep, and chunking.

When editing conversion code, preserve the logs:

- `Running bundled ffmpeg sidecar`
- `Bundled ffmpeg sidecar finished in ...ms`
- `System ffmpeg fallback finished in ...ms`
- `Skipping ffmpeg for local STT...`
- `Skipping ffmpeg for file transcription...`

## Local Whisper Hallucination Guardrails

Long local Whisper jobs can produce repeated caption-like text on silence, for example:

- `Спасибо. Спасибо. Спасибо.`
- `Продолжение следует...`
- repeated copies of the last real phrase

This is not a UI recursion bug. It usually means Whisper received a long low-signal or silent region and reused context across internal windows.

Preserve these safeguards:

- `src-tauri/src/bin/talkis-stt.rs`
  - `params.set_no_context(true)`
  - `params.set_suppress_nst(true)`
  - low temperature / no temperature increment
  - entropy threshold
- `src-tauri/src/ai.rs`
  - known hallucination detection
  - repetitive transcript text sanitizer
  - repetitive timestamped segment filter before diarization assembly

If changing these filters, test against:

- short real voice dictation;
- long meeting/call recording with pauses;
- mostly silent audio;
- file transcription with speaker diarization enabled.

## File Transcription

File transcription is path-based. Do not load large files into WebView memory.

Rules:

- Keep `src/lib/fileTranscription.ts` as the frontend entry point.
- Keep native path invocation through `transcribe_file_path`.
- Keep chunk progress events and per-chunk logs.
- Use ffmpeg for video and unsupported formats.
- For local mode, each chunk must be converted to the local STT WAV contract before hitting the runtime.
- For cloud mode, use the existing proxy endpoints and do not silently switch to local diarization.

Chunking currently protects API limits and long recordings. Do not remove chunking unless the target endpoint is proven to handle the full file size and duration.

## Call Capture

Call capture has two different tracks:

- mic track: user microphone, handled through the existing recording runtime / file pipeline;
- system track: platform-specific system audio capture.

Current system-audio support:

- macOS: implemented via Core Audio process tap / aggregate device in `call_capture.rs`;
- Windows: intentionally unsupported placeholder until WASAPI loopback is implemented;
- Linux: intentionally unsupported placeholder until PipeWire monitor capture is implemented.

Do not present Windows/Linux system-call capture as working until platform capture is implemented and manually verified.

For macOS system track diagnostics, rely on stop-time logs:

```text
System audio capture level: max=... dBFS, frames_above_noise_floor=...
```

If `max=-120.0 dBFS` and `frames_above_noise_floor=0`, the system track is silent. The transcript should not treat that as usable remote-speaker audio.

## Speaker Diarization

Local speaker diarization uses:

- local Whisper segments with timestamps;
- local diarization runtime segments;
- overlap/nearest matching in `ai.rs`;
- final formatting in `format_speaker_transcript()`.

Rules:

- Do not assemble speaker transcripts from STT text without timestamps.
- Filter known repeated/hallucinated STT segments before assigning speakers.
- If the system track has no diarizable speech, the existing mic fallback is acceptable, but logs must make that explicit.
- Speaker labels shown to users should stay product-facing: `Вы`, `Гость N`.

## Logging Contract

Audio bugs are usually runtime bugs, not static type bugs. Keep logs specific.

Required evidence:

- recorder path used: native WAV, WebView WAV, WebM, or fallback;
- selected mic and active device label when available;
- audio stats: duration, sample rate, channels, peak, RMS;
- ffmpeg start and finish timing;
- STT endpoint and response status;
- file chunk index, total chunks, and chunk size;
- call system capture level and source/stored format.

Do not log API keys, device tokens, or full local model paths if they include sensitive user names.

## Verification

Minimum checks after audio pipeline edits:

```bash
bunx tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

For Rust logic in `ai.rs`, run targeted tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml ai::tests --lib
```

Manual checks when behavior changes:

- macOS voice dictation recognizes a real phrase and logs native recorder stats.
- Local voice dictation does not run bundled ffmpeg when native WAV is used.
- WebView fallback still records when native capture fails or selected mic cannot be mapped.
- Ready `16 kHz mono PCM WAV` file skips ffmpeg.
- MP3/MP4/WebM files still go through ffmpeg.
- Long local call/file transcription with pauses does not produce repeated `Спасибо` / `Продолжение следует`.
- macOS call capture does not regress; Windows/Linux call system capture remains clearly unsupported.

## Release Notes For Audio Dependencies

`cpal` pulls platform audio backends.

Linux release jobs need `libasound2-dev` for ALSA builds. If changing `cpal` features or replacing the recorder backend, re-check `.github/workflows/release.yml` and Linux Tauri dependency installation.
