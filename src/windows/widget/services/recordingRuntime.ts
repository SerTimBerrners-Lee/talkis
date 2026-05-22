import { invoke } from "@tauri-apps/api/core";

import { logError, logInfo } from "../../../lib/logger";

type RecorderCodec = "native-wav" | "webm" | "default" | "wav";

const PCM_TARGET_PEAK = 0.82;
const PCM_NORMALIZE_BELOW_PEAK = 0.35;
const PCM_MIN_SIGNAL_PEAK = 0.001;
const PCM_MAX_GAIN = 8;

interface PcmRecorderState {
  audioContext: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  processor: ScriptProcessorNode | null;
  sink: GainNode | null;
  chunks: Float32Array[];
  sampleRate: number;
  paused: boolean;
}

interface RecordingRuntimeState {
  active: boolean;
  nativeActive: boolean;
  nativeResult: NativeVoiceRecordingResult | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  stream: MediaStream | null;
  pcm: PcmRecorderState;
  pcmOnly: boolean;
}

interface PcmAudioStats {
  sampleCount: number;
  sampleRate: number;
  durationMs: number;
  mean: number;
  peak: number;
  rms: number;
  gain: number;
}

interface EncodedWavResult {
  blob: Blob;
  stats: PcmAudioStats;
}

interface NativeRecordingOptions {
  deviceLabel?: string | null;
}

interface NativeVoiceRecordingResult {
  audioBase64: string;
  mimeType: string;
  fileName: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  peak: number;
  rms: number;
}

export interface RecordingRuntimeController {
  startNative(options?: NativeRecordingOptions): Promise<RecorderCodec>;
  start(stream: MediaStream): RecorderCodec;
  pause(): boolean;
  resume(): boolean;
  stop(): Promise<void>;
  hasRecorder(): boolean;
  hasAudioChunks(): boolean;
  getAudioBlob(): Promise<Blob>;
  reset(): void;
  dispose(): void;
}

function waitForRecorderStop(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleStop = () => {
      cleanup();
      resolve();
    };

    const handleError = (event: Event) => {
      cleanup();
      const recorderError =
        event instanceof ErrorEvent ? event.error?.message || event.message : "MediaRecorder error";
      reject(new Error(recorderError));
    };

    const cleanup = () => {
      recorder.removeEventListener("stop", handleStop);
      recorder.removeEventListener("error", handleError);
    };

    recorder.addEventListener("stop", handleStop, { once: true });
    recorder.addEventListener("error", handleError, { once: true });
  });
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function shouldUsePcmOnlyRecorder(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  return platform.includes("linux") || platform.includes("x11");
}

function createEmptyPcmState(): PcmRecorderState {
  return {
    audioContext: null,
    source: null,
    processor: null,
    sink: null,
    chunks: [],
    sampleRate: 48_000,
    paused: false,
  };
}

function startPcmRecorder(stream: MediaStream): PcmRecorderState {
  const audioContext = new AudioContext({ latencyHint: "interactive" });
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const sink = audioContext.createGain();
  sink.gain.value = 0;
  const chunks: Float32Array[] = [];

  processor.onaudioprocess = (event) => {
    if (pcmState.paused) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
  };

  const pcmState: PcmRecorderState = {
    audioContext,
    source,
    processor,
    sink,
    chunks,
    sampleRate: audioContext.sampleRate,
    paused: false,
  };

  source.connect(processor);
  processor.connect(sink);
  sink.connect(audioContext.destination);
  void audioContext.resume().catch(() => null);

  return pcmState;
}

function stopPcmRecorder(pcm: PcmRecorderState): void {
  pcm.processor?.disconnect();
  pcm.sink?.disconnect();
  pcm.source?.disconnect();
  if (pcm.audioContext && pcm.audioContext.state !== "closed") {
    void pcm.audioContext.close().catch(() => null);
  }
  pcm.processor = null;
  pcm.sink = null;
  pcm.source = null;
  pcm.audioContext = null;
  pcm.paused = false;
}

function pcmSampleCount(chunks: Float32Array[]): number {
  return chunks.reduce((total, chunk) => total + chunk.length, 0);
}

function getPcmStats(chunks: Float32Array[], sampleRate: number): PcmAudioStats {
  const sampleCount = pcmSampleCount(chunks);
  let sum = 0;

  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      sum += chunk[i];
    }
  }

  const mean = sampleCount > 0 ? sum / sampleCount : 0;
  let peak = 0;
  let sumSquares = 0;

  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = chunk[i] - mean;
      const abs = Math.abs(sample);
      peak = Math.max(peak, abs);
      sumSquares += sample * sample;
    }
  }

  const gain = peak > PCM_MIN_SIGNAL_PEAK && peak < PCM_NORMALIZE_BELOW_PEAK
    ? Math.min(PCM_MAX_GAIN, PCM_TARGET_PEAK / peak)
    : 1;

  return {
    sampleCount,
    sampleRate,
    durationMs: sampleRate > 0 ? Math.round((sampleCount / sampleRate) * 1000) : 0,
    mean,
    peak,
    rms: sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0,
    gain,
  };
}

function encodeWav(chunks: Float32Array[], sampleRate: number): EncodedWavResult {
  const stats = getPcmStats(chunks, sampleRate);
  const buffer = new ArrayBuffer(44 + stats.sampleCount * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + stats.sampleCount * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, stats.sampleCount * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, (chunk[i] - stats.mean) * stats.gain));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return {
    blob: new Blob([buffer], { type: "audio/wav" }),
    stats,
  };
}

function encodeWavInWorker(chunks: Float32Array[], sampleRate: number): Promise<EncodedWavResult> {
  if (typeof Worker === "undefined" || typeof URL === "undefined") {
    return Promise.resolve(encodeWav(chunks, sampleRate));
  }

  return new Promise((resolve, reject) => {
    const workerSource = `
      const PCM_TARGET_PEAK = ${PCM_TARGET_PEAK};
      const PCM_NORMALIZE_BELOW_PEAK = ${PCM_NORMALIZE_BELOW_PEAK};
      const PCM_MIN_SIGNAL_PEAK = ${PCM_MIN_SIGNAL_PEAK};
      const PCM_MAX_GAIN = ${PCM_MAX_GAIN};

      function sampleCount(chunks) {
        return chunks.reduce((total, chunk) => total + chunk.length, 0);
      }

      function getStats(chunks, sampleRate) {
        const count = sampleCount(chunks);
        let sum = 0;
        for (const chunk of chunks) {
          for (let i = 0; i < chunk.length; i += 1) {
            sum += chunk[i];
          }
        }

        const mean = count > 0 ? sum / count : 0;
        let peak = 0;
        let sumSquares = 0;
        for (const chunk of chunks) {
          for (let i = 0; i < chunk.length; i += 1) {
            const sample = chunk[i] - mean;
            const abs = Math.abs(sample);
            peak = Math.max(peak, abs);
            sumSquares += sample * sample;
          }
        }

        const gain = peak > PCM_MIN_SIGNAL_PEAK && peak < PCM_NORMALIZE_BELOW_PEAK
          ? Math.min(PCM_MAX_GAIN, PCM_TARGET_PEAK / peak)
          : 1;

        return {
          sampleCount: count,
          sampleRate,
          durationMs: sampleRate > 0 ? Math.round((count / sampleRate) * 1000) : 0,
          mean,
          peak,
          rms: count > 0 ? Math.sqrt(sumSquares / count) : 0,
          gain,
        };
      }

      self.onmessage = (event) => {
        const chunks = event.data.buffers.map((buffer) => new Float32Array(buffer));
        const sampleRate = event.data.sampleRate;
        const stats = getStats(chunks, sampleRate);
        const count = stats.sampleCount;
        const buffer = new ArrayBuffer(44 + count * 2);
        const view = new DataView(buffer);
        const writeString = (offset, value) => {
          for (let i = 0; i < value.length; i += 1) {
            view.setUint8(offset + i, value.charCodeAt(i));
          }
        };

        writeString(0, "RIFF");
        view.setUint32(4, 36 + count * 2, true);
        writeString(8, "WAVE");
        writeString(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(36, "data");
        view.setUint32(40, count * 2, true);

        let offset = 44;
        for (const chunk of chunks) {
          for (let i = 0; i < chunk.length; i += 1) {
            const sample = Math.max(-1, Math.min(1, (chunk[i] - stats.mean) * stats.gain));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
            offset += 2;
          }
        }

        self.postMessage({ buffer, stats }, [buffer]);
      };
    `;

    const url = URL.createObjectURL(new Blob([workerSource], { type: "application/javascript" }));
    const worker = new Worker(url);
    const cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };

    worker.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; stats: PcmAudioStats }>) => {
      cleanup();
      resolve({
        blob: new Blob([event.data.buffer], { type: "audio/wav" }),
        stats: event.data.stats,
      });
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "WAV encoder worker failed"));
    };

    const buffers = chunks.map((chunk) => chunk.slice().buffer);
    worker.postMessage({ buffers, sampleRate }, buffers);
  });
}

export function createRecordingRuntimeController(): RecordingRuntimeController {
  const state: RecordingRuntimeState = {
    active: false,
    nativeActive: false,
    nativeResult: null,
    recorder: null,
    chunks: [],
    stream: null,
    pcm: createEmptyPcmState(),
    pcmOnly: false,
  };

  return {
    async startNative(options) {
      state.chunks = [];
      state.nativeResult = null;
      state.stream = null;
      state.recorder = null;
      stopPcmRecorder(state.pcm);
      state.pcm = createEmptyPcmState();
      state.pcmOnly = false;

      try {
        await invoke("start_native_voice_recording", {
          req: {
            deviceLabel: options?.deviceLabel || null,
          },
        });
      } catch (error) {
        state.active = false;
        state.nativeActive = false;
        throw error;
      }

      state.active = true;
      state.nativeActive = true;
      return "native-wav";
    },
    start(stream) {
      state.stream = stream;
      state.chunks = [];
      state.nativeActive = false;
      state.nativeResult = null;
      state.pcm = startPcmRecorder(stream);
      state.active = true;
      state.pcmOnly = shouldUsePcmOnlyRecorder();

      if (state.pcmOnly) {
        return "wav";
      }

      let recorder: MediaRecorder;
      let codec: RecorderCodec = "webm";

      try {
        recorder = new MediaRecorder(stream, {
          mimeType: "audio/webm",
          audioBitsPerSecond: 24_000,
        });
      } catch {
        recorder = new MediaRecorder(stream);
        codec = "default";
      }

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          state.chunks.push(event.data);
        }
      };

      recorder.start(100);
      state.recorder = recorder;

      return codec;
    },
    pause() {
      if (state.nativeActive && state.active) {
        void invoke("pause_native_voice_recording").catch((error) => {
          logError("RECORDING", `Native recorder pause failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        return true;
      }

      if (state.pcmOnly && state.active) {
        state.pcm.paused = true;
        return true;
      }

      if (!state.recorder || state.recorder.state !== "recording") {
        return false;
      }

      try {
        state.recorder.requestData();
        state.recorder.pause();
        state.pcm.paused = true;
        return true;
      } catch {
        return false;
      }
    },
    resume() {
      if (state.nativeActive && state.active) {
        void invoke("resume_native_voice_recording").catch((error) => {
          logError("RECORDING", `Native recorder resume failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        return true;
      }

      if (state.pcmOnly && state.active) {
        state.pcm.paused = false;
        return true;
      }

      if (!state.recorder || state.recorder.state !== "paused") {
        return false;
      }

      try {
        state.recorder.resume();
        state.pcm.paused = false;
        return true;
      } catch {
        return false;
      }
    },
    async stop() {
      if (!state.active) {
        return;
      }

      if (state.nativeActive) {
        state.nativeResult = await invoke<NativeVoiceRecordingResult>("stop_native_voice_recording");
        state.active = false;
        state.nativeActive = false;
        return;
      }

      if (state.pcmOnly || !state.recorder) {
        stopTracks(state.stream);
        state.stream = null;
        stopPcmRecorder(state.pcm);
        state.active = false;
        state.pcmOnly = false;
        return;
      }

      const activeRecorder = state.recorder;
      const stopped = waitForRecorderStop(activeRecorder);
      activeRecorder.stop();
      stopTracks(state.stream);
      state.stream = null;
      await stopped;
      stopPcmRecorder(state.pcm);
      state.recorder = null;
      state.active = false;
    },
    hasRecorder() {
      return state.active;
    },
    hasAudioChunks() {
      if (state.nativeResult) {
        return state.nativeResult.audioBase64.length > 0;
      }

      return state.chunks.length > 0 || pcmSampleCount(state.pcm.chunks) > 0;
    },
    async getAudioBlob() {
      if (state.nativeResult) {
        const result = state.nativeResult;
        logInfo(
          "RECORDING",
          `Native audio stats: duration_ms=${result.durationMs}, sample_rate=${result.sampleRate}, channels=${result.channels}, peak=${result.peak.toFixed(4)}, rms=${result.rms.toFixed(4)}`,
        );
        return base64ToBlob(result.audioBase64, result.mimeType || "audio/wav");
      }

      if (state.chunks.length > 0) {
        const type = state.chunks[0]?.type || "audio/webm";
        return new Blob(state.chunks, { type });
      }

      const { blob, stats } = await encodeWavInWorker(state.pcm.chunks, state.pcm.sampleRate);
      logInfo(
        "RECORDING",
        `PCM audio stats: samples=${stats.sampleCount}, sample_rate=${stats.sampleRate}, duration_ms=${stats.durationMs}, peak=${stats.peak.toFixed(4)}, rms=${stats.rms.toFixed(4)}, gain=${stats.gain.toFixed(2)}`,
      );
      return blob;
    },
    reset() {
      state.active = false;
      state.nativeActive = false;
      state.nativeResult = null;
      state.recorder = null;
      state.chunks = [];
      state.pcm = createEmptyPcmState();
      state.pcmOnly = false;
    },
    dispose() {
      if (state.nativeActive) {
        void invoke("stop_native_voice_recording").catch(() => null);
      }
      stopPcmRecorder(state.pcm);
      stopTracks(state.stream);
      state.stream = null;
      state.active = false;
      state.nativeActive = false;
      state.nativeResult = null;
      state.recorder = null;
      state.chunks = [];
      state.pcm = createEmptyPcmState();
      state.pcmOnly = false;
    },
  };
}
