type RecorderCodec = "webm" | "default";

interface PcmRecorderState {
  audioContext: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  processor: ScriptProcessorNode | null;
  chunks: Float32Array[];
  sampleRate: number;
  paused: boolean;
}

interface RecordingRuntimeState {
  recorder: MediaRecorder | null;
  chunks: Blob[];
  stream: MediaStream | null;
  pcm: PcmRecorderState;
}

export interface RecordingRuntimeController {
  start(stream: MediaStream): RecorderCodec;
  pause(): boolean;
  resume(): boolean;
  stop(): Promise<void>;
  hasRecorder(): boolean;
  hasAudioChunks(): boolean;
  getAudioBlob(): Blob;
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

function createEmptyPcmState(): PcmRecorderState {
  return {
    audioContext: null,
    source: null,
    processor: null,
    chunks: [],
    sampleRate: 48_000,
    paused: false,
  };
}

function startPcmRecorder(stream: MediaStream): PcmRecorderState {
  const audioContext = new AudioContext({ latencyHint: "interactive" });
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
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
    chunks,
    sampleRate: audioContext.sampleRate,
    paused: false,
  };

  source.connect(processor);
  processor.connect(audioContext.destination);
  void audioContext.resume().catch(() => null);

  return pcmState;
}

function stopPcmRecorder(pcm: PcmRecorderState): void {
  pcm.processor?.disconnect();
  pcm.source?.disconnect();
  if (pcm.audioContext && pcm.audioContext.state !== "closed") {
    void pcm.audioContext.close().catch(() => null);
  }
  pcm.processor = null;
  pcm.source = null;
  pcm.audioContext = null;
  pcm.paused = false;
}

function pcmSampleCount(chunks: Float32Array[]): number {
  return chunks.reduce((total, chunk) => total + chunk.length, 0);
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const sampleCount = pcmSampleCount(chunks);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
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
  view.setUint32(40, sampleCount * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export function createRecordingRuntimeController(): RecordingRuntimeController {
  const state: RecordingRuntimeState = {
    recorder: null,
    chunks: [],
    stream: null,
    pcm: createEmptyPcmState(),
  };

  return {
    start(stream) {
      state.stream = stream;
      state.chunks = [];
      state.pcm = startPcmRecorder(stream);

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
      if (!state.recorder) {
        return;
      }

      const activeRecorder = state.recorder;
      const stopped = waitForRecorderStop(activeRecorder);
      activeRecorder.requestData();
      activeRecorder.stop();
      stopTracks(state.stream);
      state.stream = null;
      await stopped;
      stopPcmRecorder(state.pcm);
      state.recorder = null;
    },
    hasRecorder() {
      return state.recorder !== null;
    },
    hasAudioChunks() {
      return state.chunks.length > 0 || pcmSampleCount(state.pcm.chunks) > 0;
    },
    getAudioBlob() {
      if (state.chunks.length > 0) {
        const type = state.chunks[0]?.type || "audio/webm";
        return new Blob(state.chunks, { type });
      }

      return encodeWav(state.pcm.chunks, state.pcm.sampleRate);
    },
    reset() {
      state.recorder = null;
      state.chunks = [];
      state.pcm = createEmptyPcmState();
    },
    dispose() {
      stopPcmRecorder(state.pcm);
      stopTracks(state.stream);
      state.stream = null;
      state.recorder = null;
      state.chunks = [];
      state.pcm = createEmptyPcmState();
    },
  };
}
