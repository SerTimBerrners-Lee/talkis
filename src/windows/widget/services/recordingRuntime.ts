type RecorderCodec = "webm" | "default";

interface RecordingRuntimeState {
  recorder: MediaRecorder | null;
  chunks: Blob[];
  stream: MediaStream | null;
}

export interface RecordingRuntimeController {
  start(stream: MediaStream): RecorderCodec;
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

export function createRecordingRuntimeController(): RecordingRuntimeController {
  const state: RecordingRuntimeState = {
    recorder: null,
    chunks: [],
    stream: null,
  };

  return {
    start(stream) {
      state.stream = stream;
      state.chunks = [];

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
    async stop() {
      if (!state.recorder) {
        return;
      }

      const activeRecorder = state.recorder;
      const stopped = waitForRecorderStop(activeRecorder);
      activeRecorder.stop();
      stopTracks(state.stream);
      state.stream = null;
      await stopped;
      state.recorder = null;
    },
    hasRecorder() {
      return state.recorder !== null;
    },
    hasAudioChunks() {
      return state.chunks.length > 0;
    },
    getAudioBlob() {
      return new Blob(state.chunks, { type: "audio/webm" });
    },
    reset() {
      state.recorder = null;
      state.chunks = [];
    },
    dispose() {
      stopTracks(state.stream);
      state.stream = null;
      state.recorder = null;
      state.chunks = [];
    },
  };
}
