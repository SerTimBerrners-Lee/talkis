import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { AppSettings } from "../../../lib/store";
import { logError, logInfo } from "../../../lib/logger";
import {
  IDLE_WIDGET_HEIGHT,
  IDLE_WIDGET_WIDTH,
  MIN_AUDIO_BLOB_BYTES,
  MIN_RECORDING_DURATION_MS,
  RECORDING_WIDGET_HEIGHT,
  RECORDING_WIDGET_WIDTH,
  WidgetNoticeTone,
  WidgetState,
} from "../widgetConstants";
import { createRecordingRuntimeController } from "../services/recordingRuntime";
import { processRecordingBlob } from "../services/transcriptionPipeline";

interface UseWidgetRecordingParams {
  settings: AppSettings | null;
  setState: Dispatch<SetStateAction<WidgetState>>;
  setStream: Dispatch<SetStateAction<MediaStream | null>>;
  setLockedRecordingMode: (value: boolean) => void;
  lockedRecordingRef: MutableRefObject<boolean>;
  hotkeyHeldRef: MutableRefObject<boolean>;
  recordingActiveRef: MutableRefObject<boolean>;
  pendingStopAfterStartRef: MutableRefObject<boolean>;
  recordingStartRef: MutableRefObject<number>;
  clearReleaseStopTimer: () => void;
  resizeWidget: (width: number, height: number) => Promise<void>;
  showError: (message: string) => void;
  showNotice: (message: string, tone?: WidgetNoticeTone) => void;
  stopAndProcessRef: MutableRefObject<() => Promise<void>>;
}

interface UseWidgetRecordingResult {
  startRecording: () => Promise<void>;
  stopAndProcess: () => Promise<void>;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getAudioConstraints(micId: string): MediaTrackConstraints | true {
  const constraints: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 1 },
  };

  if (micId) {
    constraints.deviceId = { ideal: micId };
  }

  return constraints;
}

function stopStreamTracks(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

async function waitForTrackReady(stream: MediaStream, timeoutMs: number): Promise<void> {
  const [track] = stream.getAudioTracks();
  if (!track || (!track.muted && track.readyState === "live")) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      track.removeEventListener("unmute", finish);
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    track.addEventListener("unmute", finish, { once: true });
  });
}

export function useWidgetRecording({
  settings,
  setState,
  setStream,
  setLockedRecordingMode,
  lockedRecordingRef,
  hotkeyHeldRef,
  recordingActiveRef,
  pendingStopAfterStartRef,
  recordingStartRef,
  clearReleaseStopTimer,
  resizeWidget,
  showError,
  showNotice,
  stopAndProcessRef,
}: UseWidgetRecordingParams): UseWidgetRecordingResult {
  const runtimeRef = useRef(createRecordingRuntimeController());

  useEffect(() => {
    const micId = settings?.micId;
    if (micId === undefined) {
      return;
    }

    let disposed = false;

    const prewarmMicrophone = async () => {
      try {
        const warmupStream = await navigator.mediaDevices.getUserMedia({
          audio: getAudioConstraints(micId),
        });

        stopStreamTracks(warmupStream);

        if (!disposed) {
          logInfo("RECORDING", "Microphone pre-initialized");
        }
      } catch (error) {
        if (!disposed) {
          logInfo("RECORDING", `Microphone pre-initialization skipped: ${formatErrorMessage(error)}`);
        }
      }
    };

    void prewarmMicrophone();

    return () => {
      disposed = true;
    };
  }, [settings?.micId]);

  const startRecording = useCallback(async () => {
    logInfo("RECORDING", "startRecording called");
    recordingActiveRef.current = false;
    pendingStopAfterStartRef.current = false;

    if (!settings) {
      logError("RECORDING", "Settings not loaded");
      showError("Настройки не загружены. Перезапустите приложение.");
      return;
    }

    const hasKey = settings.apiKey.trim().length > 0;
    if (!hasKey) {
      logError("RECORDING", "API key not set");
      showError("Добавьте OpenAI API ключ в настройках -> Подписка.");
      return;
    }

    try {
      setState("recording");
      void resizeWidget(RECORDING_WIDGET_WIDTH, RECORDING_WIDGET_HEIGHT);

      const audioConstraints = getAudioConstraints(settings.micId);
      if (settings.micId) {
        logInfo("RECORDING", `Using preferred mic: ${settings.micId}`);
      }

      let recordingStream: MediaStream;
      try {
        logInfo("RECORDING", "Requesting microphone access...");
        recordingStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      } catch (micError) {
        logInfo(
          "RECORDING",
          `Requested mic failed, trying default: ${
            micError instanceof Error ? micError.message : String(micError)
          }`,
        );

        try {
          recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (fallbackError) {
          logError(
            "RECORDING",
            `Mic access denied: ${
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
            }`,
          );
          showError("Нет доступа к микрофону. Разрешите доступ в настройках macOS.");
          return;
        }
      }

      await waitForTrackReady(recordingStream, 250);
      setStream(recordingStream);
      const codec = runtimeRef.current.start(recordingStream);
      if (codec === "webm") {
        logInfo("RECORDING", "Using webm codec");
      } else {
        logInfo("RECORDING", "Webm not supported, using default codec");
      }

      recordingActiveRef.current = true;
      recordingStartRef.current = Date.now();
      logInfo("RECORDING", "Recording started successfully");

      if ((!hotkeyHeldRef.current || pendingStopAfterStartRef.current) && !lockedRecordingRef.current) {
        pendingStopAfterStartRef.current = false;
        logInfo("HOTKEY", "Shortcut released during startup, stopping recording immediately");
        void stopAndProcessRef.current();
      }
    } catch (error) {
      runtimeRef.current.dispose();
      setStream(null);
      logError("RECORDING", `Start error: ${error instanceof Error ? error.message : "unknown"}`);
      showError(
        `Ошибка запуска записи: ${error instanceof Error ? error.message : "Неизвестная ошибка"}`,
      );
    }
  }, [
    hotkeyHeldRef,
    lockedRecordingRef,
    pendingStopAfterStartRef,
    recordingActiveRef,
    recordingStartRef,
    resizeWidget,
    setState,
    setStream,
    settings,
    showError,
    stopAndProcessRef,
  ]);

  const stopAndProcess = useCallback(async () => {
    logInfo("RECORDING", "stopAndProcess called");

    if (!runtimeRef.current.hasRecorder() || !settings || !recordingActiveRef.current) {
      logError("RECORDING", "No active recording");
      return;
    }

    recordingActiveRef.current = false;
    pendingStopAfterStartRef.current = false;
    clearReleaseStopTimer();
    setLockedRecordingMode(false);
    await runtimeRef.current.stop();
    setStream(null);

    await resizeWidget(RECORDING_WIDGET_WIDTH, RECORDING_WIDGET_HEIGHT);
    setState("processing");

    try {
      if (!runtimeRef.current.hasAudioChunks()) {
        logError("RECORDING", "No audio chunks recorded");
        throw new Error("Аудио не записано. Попробуйте еще раз.");
      }

      const blob = runtimeRef.current.getAudioBlob();
      const durationMs = Date.now() - recordingStartRef.current;

      if (durationMs < MIN_RECORDING_DURATION_MS || blob.size < MIN_AUDIO_BLOB_BYTES) {
        logInfo(
          "RECORDING",
          `Recording too short, skipping API request. duration_ms=${durationMs}, blob_size=${blob.size}`,
        );
        runtimeRef.current.reset();
        setState("idle");
        await resizeWidget(IDLE_WIDGET_WIDTH, IDLE_WIDGET_HEIGHT);
        return;
      }

      const pipelineResult = await processRecordingBlob({
        blob,
        settings,
        recordingStartTimestamp: recordingStartRef.current,
      });

      if (!pipelineResult.hasTranscription) {
        runtimeRef.current.reset();
        setState("idle");
        await resizeWidget(IDLE_WIDGET_WIDTH, IDLE_WIDGET_HEIGHT);
        return;
      }

      runtimeRef.current.reset();
      setState("idle");
      await resizeWidget(IDLE_WIDGET_WIDTH, IDLE_WIDGET_HEIGHT);

      if (pipelineResult.pasteErrorMessage) {
        showNotice(pipelineResult.pasteErrorMessage, "info");
      }

      return;
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      logError("API", `Processing error: ${errorMessage}`);

      const message = errorMessage && errorMessage !== "{}" ? errorMessage : "Ошибка обработки";

      runtimeRef.current.reset();
      showError(message);
      return;
    }
  }, [
    clearReleaseStopTimer,
    pendingStopAfterStartRef,
    recordingActiveRef,
    recordingStartRef,
    resizeWidget,
    setLockedRecordingMode,
    setState,
    setStream,
    settings,
    showError,
    showNotice,
  ]);

  useEffect(() => {
    stopAndProcessRef.current = stopAndProcess;
  }, [stopAndProcess, stopAndProcessRef]);

  useEffect(() => {
    return () => {
      runtimeRef.current.dispose();
    };
  }, []);

  return {
    startRecording,
    stopAndProcess,
  };
}
