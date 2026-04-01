import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { AppSettings } from "../../../lib/store";
import { logError, logInfo } from "../../../lib/logger";
import { formatErrorMessage } from "../../../lib/utils";
import {
  IDLE_WIDGET_HEIGHT,
  IDLE_WIDGET_WIDTH,
  MIN_AUDIO_BLOB_BYTES,
  MIN_RECORDING_DURATION_MS,
  RECORDING_WIDGET_HEIGHT,
  RECORDING_WIDGET_WIDTH,
  WidgetNoticeTone,
} from "../widgetConstants";
import { createRecordingRuntimeController } from "../services/recordingRuntime";
import { processRecordingBlob } from "../services/transcriptionPipeline";
import type { WidgetAction, WidgetMachineState } from "../services/widgetMachine";

interface UseWidgetRecordingParams {
  settings: AppSettings | null;
  machineRef: MutableRefObject<WidgetMachineState>;
  dispatch: (action: WidgetAction) => void;
  setStream: Dispatch<SetStateAction<MediaStream | null>>;
  resizeWidget: (width: number, height: number) => Promise<void>;
  showError: (message: string) => void;
  showNotice: (message: string, tone?: WidgetNoticeTone) => void;
  stopAndProcessRef: MutableRefObject<() => Promise<void>>;
}

interface UseWidgetRecordingResult {
  startRecording: () => Promise<void>;
  stopAndProcess: () => Promise<void>;
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

async function waitForTrackReady(stream: MediaStream, timeoutMs: number): Promise<void> {
  const [track] = stream.getAudioTracks();
  if (!track || (!track.muted && track.readyState === "live")) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
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
  machineRef,
  dispatch,
  setStream,
  resizeWidget,
  showError,
  showNotice,
  stopAndProcessRef,
}: UseWidgetRecordingParams): UseWidgetRecordingResult {
  const runtimeRef = useRef(createRecordingRuntimeController());

  // NOTE: Microphone pre-warm was removed because on macOS, calling
  // getUserMedia activates an audio session that ducks other app volumes.
  // The mic is now acquired only when recording actually starts.

  // ── Start recording ─────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    logInfo("RECORDING", "startRecording called");

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
      // Update widget state to recording (via dispatch)
      machineRef.current = { ...machineRef.current, widgetState: "recording" };
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
          `Requested mic failed, trying default: ${micError instanceof Error ? micError.message : String(micError)}`,
        );

        try {
          recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (fallbackError) {
          logError(
            "RECORDING",
            `Mic access denied: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
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

      logInfo("RECORDING", "Recording started successfully");
      dispatch({ type: "RECORDING_STARTED", timestamp: Date.now() });
    } catch (error) {
      runtimeRef.current.dispose();
      setStream(null);
      logError("RECORDING", `Start error: ${error instanceof Error ? error.message : "unknown"}`);
      showError(
        `Ошибка запуска записи: ${error instanceof Error ? error.message : "Неизвестная ошибка"}`,
      );
    }
  }, [dispatch, machineRef, resizeWidget, setStream, settings, showError]);

  // ── Stop and process ────────────────────────────────────────────────────
  const stopAndProcess = useCallback(async () => {
    logInfo("RECORDING", "stopAndProcess called");

    const machine = machineRef.current;
    if (!runtimeRef.current.hasRecorder() || !settings || !machine.recordingActive) {
      logError("RECORDING", "No active recording");
      return;
    }

    // Update machine state
    machineRef.current = {
      ...machineRef.current,
      recordingActive: false,
      pendingStopAfterStart: false,
      lockedRecording: false,
      releaseStopTimerActive: false,
    };

    await runtimeRef.current.stop();
    setStream(null);

    await resizeWidget(RECORDING_WIDGET_WIDTH, RECORDING_WIDGET_HEIGHT);
    dispatch({ type: "SET_PROCESSING" });

    try {
      if (!runtimeRef.current.hasAudioChunks()) {
        logError("RECORDING", "No audio chunks recorded");
        throw new Error("Аудио не записано. Попробуйте еще раз.");
      }

      const blob = runtimeRef.current.getAudioBlob();
      const durationMs = Date.now() - machine.recordingStartTimestamp;

      if (durationMs < MIN_RECORDING_DURATION_MS || blob.size < MIN_AUDIO_BLOB_BYTES) {
        logInfo(
          "RECORDING",
          `Recording too short, skipping API request. duration_ms=${durationMs}, blob_size=${blob.size}`,
        );
        runtimeRef.current.reset();
        dispatch({ type: "PROCESSING_COMPLETE" });
        await resizeWidget(IDLE_WIDGET_WIDTH, IDLE_WIDGET_HEIGHT);
        return;
      }

      const pipelineResult = await processRecordingBlob({
        blob,
        settings,
        recordingStartTimestamp: machine.recordingStartTimestamp,
      });

      if (!pipelineResult.hasTranscription) {
        runtimeRef.current.reset();
        dispatch({ type: "PROCESSING_COMPLETE" });
        await resizeWidget(IDLE_WIDGET_WIDTH, IDLE_WIDGET_HEIGHT);
        return;
      }

      runtimeRef.current.reset();
      dispatch({ type: "PROCESSING_COMPLETE" });
      await resizeWidget(IDLE_WIDGET_WIDTH, IDLE_WIDGET_HEIGHT);

      if (pipelineResult.pasteErrorMessage) {
        showNotice(pipelineResult.pasteErrorMessage, "info");
      }
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      logError("API", `Processing error: ${errorMessage}`);

      const message = errorMessage && errorMessage !== "{}" ? errorMessage : "Ошибка обработки";

      runtimeRef.current.reset();
      showError(message);
    }
  }, [dispatch, machineRef, resizeWidget, setStream, settings, showError, showNotice]);

  // ── Keep stopAndProcessRef current ──────────────────────────────────────
  useEffect(() => {
    stopAndProcessRef.current = stopAndProcess;
  }, [stopAndProcess, stopAndProcessRef]);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      runtimeRef.current.dispose();
    };
  }, []);

  return { startRecording, stopAndProcess };
}
