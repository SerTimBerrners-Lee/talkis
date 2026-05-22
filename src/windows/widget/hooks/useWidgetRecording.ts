import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { AppSettings, getSettings } from "../../../lib/store";
import { logError, logInfo } from "../../../lib/logger";
import { formatErrorMessage } from "../../../lib/utils";
import {
  CALL_STACK_WIDGET_HEIGHT,
  CALL_STACK_WIDGET_WIDTH,
  MIN_AUDIO_BLOB_BYTES,
  MIN_RECORDING_DURATION_MS,
} from "../widgetConstants";
import type { WidgetNoticeTone } from "../widgetConstants";
import { createRecordingRuntimeController } from "../services/recordingRuntime";
import { processRecordingBlob } from "../services/transcriptionPipeline";
import type { WidgetAction, WidgetMachineState } from "../services/widgetMachine";

const LOW_MIC_GRACE_MS = 1800;
const LOW_MIC_SUSTAINED_MS = 2600;
const LOW_MIC_RMS_THRESHOLD = 0.012;
const LOW_MIC_SAMPLE_INTERVAL_MS = 250;

interface UseWidgetRecordingParams {
  settings: AppSettings | null;
  machineRef: MutableRefObject<WidgetMachineState>;
  dispatch: (action: WidgetAction) => void;
  setStream: Dispatch<SetStateAction<MediaStream | null>>;
  resizeWidget: (width: number, height: number) => Promise<void>;
  showError: (message: string) => void;
  showNotice: (message: string, tone?: WidgetNoticeTone) => void;
  hideNotice: () => void;
  stopAndProcessRef: MutableRefObject<() => Promise<void>>;
  onRecordingProcessing?: () => void;
  onRecordingStart?: () => void;
  onRecordingStartFailed?: () => void;
}

interface UseWidgetRecordingResult {
  startRecording: () => Promise<void>;
  stopAndProcess: () => Promise<void>;
}

function getAudioConstraints(micId: string): MediaTrackConstraints | true {
  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  const useMicProcessing = platform.includes("linux") || platform.includes("x11");
  const constraints: MediaTrackConstraints = {
    echoCancellation: useMicProcessing,
    noiseSuppression: useMicProcessing,
    autoGainControl: useMicProcessing,
    channelCount: { ideal: 1 },
  };

  if (micId) {
    constraints.deviceId = { exact: micId };
  }

  return constraints;
}

async function resolveSelectedMicLabel(micId: string): Promise<string | null> {
  if (!micId || !navigator.mediaDevices?.enumerateDevices) {
    return null;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const selected = devices.find((device) => device.kind === "audioinput" && device.deviceId === micId);
    return selected?.label?.trim() || null;
  } catch (error) {
    logError("RECORDING", `Failed to resolve selected mic label: ${formatErrorMessage(error)}`);
    return null;
  }
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

function waitForWidgetPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.setTimeout(resolve, 0);
      });
    });
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
  hideNotice,
  stopAndProcessRef,
  onRecordingProcessing,
  onRecordingStart,
  onRecordingStartFailed,
}: UseWidgetRecordingParams): UseWidgetRecordingResult {
  const runtimeRef = useRef(createRecordingRuntimeController());
  const lowMicMonitorCleanupRef = useRef<(() => void) | null>(null);
  const recordingSettingsRef = useRef<AppSettings | null>(null);

  // NOTE: Microphone pre-warm was removed because on macOS, calling
  // getUserMedia activates an audio session that ducks other app volumes.
  // The mic is now acquired only when recording actually starts.

  const stopLowMicMonitor = useCallback(() => {
    if (!lowMicMonitorCleanupRef.current) {
      return;
    }

    lowMicMonitorCleanupRef.current();
    lowMicMonitorCleanupRef.current = null;
  }, []);

  const startLowMicMonitor = useCallback((recordingStream: MediaStream) => {
    stopLowMicMonitor();

    try {
      const audioContext = new AudioContext({ latencyHint: "interactive" });
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.45;

      const source = audioContext.createMediaStreamSource(recordingStream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.fftSize);
      const startedAt = Date.now();
      let lowStartedAt: number | null = null;
      let noticeShown = false;
      let normalSignalSamples = 0;

      const interval = window.setInterval(() => {
        analyser.getByteTimeDomainData(dataArray);

        let sumSquares = 0;
        for (let index = 0; index < dataArray.length; index += 1) {
          const normalized = (dataArray[index] - 128) / 128;
          sumSquares += normalized * normalized;
        }

        const rms = Math.sqrt(sumSquares / dataArray.length);
        if (rms >= LOW_MIC_RMS_THRESHOLD) {
          normalSignalSamples += 1;
        }
        const now = Date.now();

        if (now - startedAt < LOW_MIC_GRACE_MS || noticeShown || normalSignalSamples >= 3) {
          if (rms >= LOW_MIC_RMS_THRESHOLD) {
            lowStartedAt = null;
          }
          return;
        }

        if (rms >= LOW_MIC_RMS_THRESHOLD) {
          lowStartedAt = null;
          return;
        }

        lowStartedAt ??= now;
        if (now - lowStartedAt >= LOW_MIC_SUSTAINED_MS) {
          noticeShown = true;
          showNotice("Микрофон слышит слишком тихо. Поднесите его ближе или проверьте выбранное устройство.", "info");
        }
      }, LOW_MIC_SAMPLE_INTERVAL_MS);

      void audioContext.resume().catch(() => {});

      lowMicMonitorCleanupRef.current = () => {
        window.clearInterval(interval);
        source.disconnect();
        void audioContext.close();
      };
    } catch (error) {
      logError("RECORDING", `Low mic monitor failed: ${formatErrorMessage(error)}`);
    }
  }, [showNotice, stopLowMicMonitor]);

  // ── Start recording ─────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    logInfo("RECORDING", "startRecording called");
    hideNotice();

    let activeSettings = settings;
    try {
      activeSettings = await getSettings({ reload: true });
    } catch (error) {
      logError("SETTINGS", `Failed to refresh settings before recording: ${formatErrorMessage(error)}`);
    }

    if (!activeSettings) {
      logError("RECORDING", "Settings not loaded");
      showError("Настройки не загружены. Перезапустите приложение.");
      return;
    }

    // Cloud mode must have a device token. Do not silently fall back to direct OpenAI.
    const isCloudMode = !activeSettings.useOwnKey;
    const isSubscriptionMode = isCloudMode && (activeSettings.deviceToken || "").trim().length > 0;
    const hasKey = activeSettings.apiKey.trim().length > 0 || activeSettings.whisperApiKey.trim().length > 0 || (activeSettings.llmApiKey || "").trim().length > 0;

    // In local STT mode the whisper server runs on localhost and requires no API key.
    // Detect this case: custom provider + local-looking endpoint + no whisperApiKey.
    const isLocalSttMode =
      activeSettings.useOwnKey &&
      activeSettings.provider === "custom" &&
      (activeSettings.whisperEndpoint || "").match(/127\.0\.0\.1|localhost/i) !== null &&
      (activeSettings.whisperApiKey || "").trim().length === 0;

    if (isCloudMode && !isSubscriptionMode) {
      logError("RECORDING", "Cloud mode selected but device token is missing");
      showError("Войдите в Talkis Cloud заново, чтобы использовать облачный режим.");
      return;
    }

    if (!isSubscriptionMode && !hasKey && !isLocalSttMode) {
      logError("RECORDING", "API key not set");
      showError("Добавьте API ключ в настройках → Модели.");
      return;
    }

    try {
      onRecordingStart?.();
      // Update widget state to recording (via dispatch)
      machineRef.current = { ...machineRef.current, widgetState: "recording" };
      void resizeWidget(CALL_STACK_WIDGET_WIDTH, CALL_STACK_WIDGET_HEIGHT);

      recordingSettingsRef.current = activeSettings;
      const nativeMicLabel = await resolveSelectedMicLabel(activeSettings.micId);
      if (activeSettings.micId && nativeMicLabel) {
        logInfo("RECORDING", `Using preferred native mic label: ${nativeMicLabel}`);
      } else if (activeSettings.micId) {
        logInfo("RECORDING", "Selected mic label is unavailable for native recorder; using WebView recorder to preserve selected mic");
      }

      if (!activeSettings.micId || nativeMicLabel) {
        try {
          const codec = await runtimeRef.current.startNative({ deviceLabel: nativeMicLabel });
          logInfo("RECORDING", codec === "native-wav" ? "Using native wav recorder" : "Using native recorder");
          setStream(null);
          logInfo("RECORDING", "Recording started successfully");
          dispatch({ type: "RECORDING_STARTED", timestamp: Date.now() });
          return;
        } catch (nativeError) {
          runtimeRef.current.reset();
          logError(
            "RECORDING",
            `Native recorder start failed, falling back to WebView recorder: ${formatErrorMessage(nativeError)}`,
          );
        }
      }

      const audioConstraints = getAudioConstraints(activeSettings.micId);
      if (activeSettings.micId) {
        logInfo("RECORDING", `Using preferred mic: ${activeSettings.micId}`);
      } else {
        logInfo("RECORDING", "Using system default mic");
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
          onRecordingStartFailed?.();
          showError("Нет доступа к микрофону. Разрешите доступ в системных настройках.");
          return;
        }
      }

      await waitForTrackReady(recordingStream, 250);
      const [audioTrack] = recordingStream.getAudioTracks();
      if (audioTrack) {
        const trackSettings = audioTrack.getSettings();
        logInfo(
          "RECORDING",
          `Active mic track: label=${audioTrack.label || "[unknown]"}, device=${trackSettings.deviceId || "[unknown]"}`,
        );
      }
      setStream(recordingStream);
      startLowMicMonitor(recordingStream);
      const codec = runtimeRef.current.start(recordingStream);
      if (codec === "webm") {
        logInfo("RECORDING", "Using webm codec");
      } else if (codec === "wav") {
        logInfo("RECORDING", "Using wav codec");
      } else {
        logInfo("RECORDING", "Webm not supported, using default codec");
      }

      logInfo("RECORDING", "Recording started successfully");
      dispatch({ type: "RECORDING_STARTED", timestamp: Date.now() });
    } catch (error) {
      onRecordingStartFailed?.();
      stopLowMicMonitor();
      runtimeRef.current.dispose();
      recordingSettingsRef.current = null;
      setStream(null);
      logError("RECORDING", `Start error: ${error instanceof Error ? error.message : "unknown"}`);
      showError(
        `Ошибка запуска записи: ${error instanceof Error ? error.message : "Неизвестная ошибка"}`,
      );
    }
  }, [dispatch, hideNotice, machineRef, onRecordingStart, onRecordingStartFailed, resizeWidget, setStream, settings, showError, startLowMicMonitor, stopLowMicMonitor]);

  // ── Stop and process ────────────────────────────────────────────────────
  const stopAndProcess = useCallback(async () => {
    logInfo("RECORDING", "stopAndProcess called");

    const machine = machineRef.current;
    const activeSettings = recordingSettingsRef.current ?? settings;
    if (!runtimeRef.current.hasRecorder() || !activeSettings || !machine.recordingActive) {
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

    stopLowMicMonitor();
    setStream(null);
    onRecordingProcessing?.();
    dispatch({ type: "SET_PROCESSING" });
    void resizeWidget(CALL_STACK_WIDGET_WIDTH, CALL_STACK_WIDGET_HEIGHT);
    await waitForWidgetPaint();

    try {
      await runtimeRef.current.stop();

      if (!runtimeRef.current.hasAudioChunks()) {
        logError("RECORDING", "No audio chunks recorded");
        throw new Error("Аудио не записано. Попробуйте еще раз.");
      }

      const blob = await runtimeRef.current.getAudioBlob();
      logInfo("RECORDING", `Recorded audio blob: type=${blob.type || "[unknown]"}, size=${blob.size}`);
      const durationMs = Date.now() - machine.recordingStartTimestamp;

      if (durationMs < MIN_RECORDING_DURATION_MS || blob.size < MIN_AUDIO_BLOB_BYTES) {
        logInfo(
          "RECORDING",
          `Recording too short, skipping API request. duration_ms=${durationMs}, blob_size=${blob.size}`,
        );
        recordingSettingsRef.current = null;
        runtimeRef.current.reset();
        dispatch({ type: "PROCESSING_COMPLETE" });
        await resizeWidget(CALL_STACK_WIDGET_WIDTH, CALL_STACK_WIDGET_HEIGHT);
        return;
      }

      const pipelineResult = await processRecordingBlob({
        blob,
        settings: activeSettings,
        recordingStartTimestamp: machine.recordingStartTimestamp,
      });

      if (!pipelineResult.hasTranscription) {
        recordingSettingsRef.current = null;
        runtimeRef.current.reset();
        showNotice("Речь не распознана. Попробуйте еще раз.", "info");
        dispatch({ type: "PROCESSING_COMPLETE" });
        await resizeWidget(CALL_STACK_WIDGET_WIDTH, CALL_STACK_WIDGET_HEIGHT);
        return;
      }

      recordingSettingsRef.current = null;
      runtimeRef.current.reset();
      dispatch({ type: "PROCESSING_COMPLETE" });
      await resizeWidget(CALL_STACK_WIDGET_WIDTH, CALL_STACK_WIDGET_HEIGHT);
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      logError("API", `Processing error: ${errorMessage}`);

      const message = errorMessage && errorMessage !== "{}" ? errorMessage : "Ошибка обработки";

      recordingSettingsRef.current = null;
      runtimeRef.current.reset();
      showError(message);
    }
  }, [dispatch, machineRef, onRecordingProcessing, resizeWidget, setStream, settings, showError, showNotice, stopLowMicMonitor]);

  // ── Keep stopAndProcessRef current ──────────────────────────────────────
  useEffect(() => {
    stopAndProcessRef.current = stopAndProcess;
  }, [stopAndProcess, stopAndProcessRef]);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopLowMicMonitor();
      runtimeRef.current.dispose();
    };
  }, [stopLowMicMonitor]);

  return { startRecording, stopAndProcess };
}
