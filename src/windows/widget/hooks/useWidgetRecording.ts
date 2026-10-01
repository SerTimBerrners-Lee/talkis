import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";

import { AppSettings, getSettings } from "../../../lib/store";
import { logError, logInfo } from "../../../lib/logger";
import { useI18n } from "../../../lib/i18n";
import { formatErrorMessage } from "../../../lib/utils";
import {
  MAX_RECORDING_DURATION_MS,
  MIN_AUDIO_BLOB_BYTES,
  MIN_RECORDING_DURATION_MS,
  widgetStackHeight,
  widgetStackWidth,
} from "../widgetConstants";
import type { WidgetNoticeTone } from "../widgetConstants";
import { createRecordingRuntimeController } from "../services/recordingRuntime";
import { startRecoveringPoll } from "../services/recoveringPoll";
import {
  processRecordingBlob,
  startDictationStreamOverlaySession,
  type DictationStreamOverlaySession,
} from "../services/transcriptionPipeline";
import {
  getVoiceAudioConstraints,
  resolveSelectedMicLabel,
} from "../services/recordingDevice";
import {
  createNativeLiveDictationOptions,
  isLocalSttStreamingEnabled,
  isSttStreamingEnabled,
  warmUpLiveDictationRuntime,
} from "../services/dictationStreamOverlay";
import { waitForRuntimeWarmUpWithinBudget } from "../services/runtimeWarmup";
import type {
  WidgetAction,
  WidgetMachineState,
} from "../services/widgetMachine";

const LOW_MIC_GRACE_MS = 1800;
const LOW_MIC_SUSTAINED_MS = 2600;
const LOW_MIC_RMS_THRESHOLD = 0.012;
const LOW_MIC_SAMPLE_INTERVAL_MS = 250;
const LOCAL_RUNTIME_RECORDING_START_BUDGET_MS = 750;

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

async function waitForTrackReady(
  stream: MediaStream,
  timeoutMs: number,
): Promise<void> {
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
  const { t } = useI18n();
  const runtimeRef = useRef(createRecordingRuntimeController());
  const lowMicMonitorCleanupRef = useRef<(() => void) | null>(null);
  const recordingLimitTimerRef = useRef<number | null>(null);
  const recordingSettingsRef = useRef<AppSettings | null>(null);
  const interruptionMonitorCleanupRef = useRef<(() => void) | null>(null);

  const stopInterruptionMonitor = useCallback((): void => {
    interruptionMonitorCleanupRef.current?.();
    interruptionMonitorCleanupRef.current = null;
  }, []);

  const startInterruptionMonitor = useCallback((): void => {
    stopInterruptionMonitor();
    interruptionMonitorCleanupRef.current = startRecoveringPoll(async (isCurrent): Promise<void> => {
      if (!machineRef.current.recordingActive) {
        return;
      }

      const interrupted = await runtimeRef.current.isInterrupted();
      if (!isCurrent() || !interrupted || !machineRef.current.recordingActive) {
        return;
      }

      stopInterruptionMonitor();
      void logError("RECORDING", "Microphone interrupted; processing the captured audio prefix");
      await stopAndProcessRef.current();

      if (machineRef.current.widgetState !== "recording") {
        showNotice(t("widget.recording.microphoneInterrupted"), "error");
      }
    }, {
      intervalMs: 500,
      onError: (error): void => {
        void logError("RECORDING", `Recorder health check failed: ${formatErrorMessage(error)}`);
      },
    });
  }, [machineRef, showNotice, stopAndProcessRef, stopInterruptionMonitor, t]);

  const resizeForSettings = useCallback(
    (currentSettings: AppSettings): Promise<void> =>
      resizeWidget(
        widgetStackWidth(false, currentSettings.translation.liveWidgetEnabled),
        widgetStackHeight(false),
      ),
    [resizeWidget],
  );
  const dictationStreamRef = useRef<DictationStreamOverlaySession | null>(null);

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

  const clearRecordingLimitTimer = useCallback(() => {
    if (recordingLimitTimerRef.current === null) {
      return;
    }

    window.clearTimeout(recordingLimitTimerRef.current);
    recordingLimitTimerRef.current = null;
  }, []);

  const clearDictationStreamSession = useCallback(
    async (hideOverlay: boolean) => {
      const session = dictationStreamRef.current;
      dictationStreamRef.current = null;
      if (!session) {
        return;
      }

      if (hideOverlay) {
        await session.hide().catch((error) => {
          logError(
            "DICTATION_STREAM",
            `Failed to hide live dictation overlay: ${formatErrorMessage(error)}`,
          );
        });
      }
      session.dispose();
    },
    [],
  );

  const scheduleRecordingLimitTimer = useCallback(() => {
    clearRecordingLimitTimer();
    recordingLimitTimerRef.current = window.setTimeout(() => {
      recordingLimitTimerRef.current = null;
      logInfo(
        "RECORDING",
        `Maximum voice recording duration reached: ${MAX_RECORDING_DURATION_MS}ms`,
      );
      showNotice(t("widget.recording.maxDurationReached"), "info");
      void stopAndProcessRef.current();
    }, MAX_RECORDING_DURATION_MS);
  }, [clearRecordingLimitTimer, showNotice, stopAndProcessRef, t]);

  const startLowMicMonitor = useCallback(
    (recordingStream: MediaStream) => {
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

          if (
            now - startedAt < LOW_MIC_GRACE_MS ||
            noticeShown ||
            normalSignalSamples >= 3
          ) {
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
            showNotice(t("widget.recording.lowMic"), "info");
          }
        }, LOW_MIC_SAMPLE_INTERVAL_MS);

        void audioContext.resume().catch(() => {});

        lowMicMonitorCleanupRef.current = () => {
          window.clearInterval(interval);
          source.disconnect();
          void audioContext.close();
        };
      } catch (error) {
        logError(
          "RECORDING",
          `Low mic monitor failed: ${formatErrorMessage(error)}`,
        );
      }
    },
    [showNotice, stopLowMicMonitor, t],
  );

  // ── Start recording ─────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    const startRequestedAt = Date.now();
    logInfo("RECORDING", "startRecording called");
    hideNotice();
    const clearTextOverlayPromise = (async () => {
      await invoke("hide_widget_text_overlay").catch((error) => {
        logError(
          "DICTATION_STREAM",
          `Failed to clear text overlay before recording: ${formatErrorMessage(error)}`,
        );
      });
      await clearDictationStreamSession(true);
    })();

    let activeSettings = settings;
    try {
      activeSettings = await getSettings({ reload: true });
    } catch (error) {
      logError(
        "SETTINGS",
        `Failed to refresh settings before recording: ${formatErrorMessage(error)}`,
      );
    }

    if (!activeSettings) {
      logError("RECORDING", "Settings not loaded");
      showError(t("widget.recording.settingsNotLoaded"));
      return;
    }

    // Cloud mode must have a device token. Do not silently fall back to direct OpenAI.
    const isCloudMode = !activeSettings.useOwnKey;
    const isSubscriptionMode =
      isCloudMode && (activeSettings.deviceToken || "").trim().length > 0;
    const hasKey =
      activeSettings.apiKey.trim().length > 0 ||
      activeSettings.whisperApiKey.trim().length > 0 ||
      (activeSettings.llmApiKey || "").trim().length > 0;

    // In local STT mode the whisper server runs on localhost and requires no API key.
    // Detect this case by the local-looking endpoint; provider can be stale after upgrades.
    const isLocalSttMode =
      activeSettings.useOwnKey &&
      (activeSettings.whisperEndpoint || "").match(
        /127\.0\.0\.1|localhost/i,
      ) !== null &&
      (activeSettings.whisperApiKey || "").trim().length === 0;

    if (isCloudMode && !isSubscriptionMode) {
      logError("RECORDING", "Cloud mode selected but device token is missing");
      showError(t("widget.recording.cloudSignInRequired"));
      return;
    }

    if (!isSubscriptionMode && !hasKey && !isLocalSttMode) {
      logError("RECORDING", "No transcription model configured");
      showError(t("widget.recording.noModelConfigured"));
      return;
    }

    try {
      onRecordingStart?.();
      // Update widget state to recording (via dispatch)
      machineRef.current = { ...machineRef.current, widgetState: "recording" };
      void resizeForSettings(activeSettings);

      recordingSettingsRef.current = activeSettings;
      await clearTextOverlayPromise;

      const liveStreamingEnabled = isSttStreamingEnabled(activeSettings);
      const localLiveStreamingEnabled =
        isLocalSttStreamingEnabled(activeSettings);
      const startLiveOverlay =
        (): Promise<DictationStreamOverlaySession | null> =>
          startDictationStreamOverlaySession(activeSettings)
            .then((session) => {
              if (session) {
                logInfo(
                  "DICTATION_STREAM",
                  `Live dictation overlay ready after ${Date.now() - startRequestedAt}ms`,
                );
              }
              return session;
            })
            .catch((error) => {
              logError(
                "DICTATION_STREAM",
                `Failed to start live dictation overlay session: ${formatErrorMessage(error)}`,
              );
              return null;
            });
      const warmUpLiveRuntime = (): Promise<string | null | false> =>
        warmUpLiveDictationRuntime(activeSettings)
          .then((runtimeEndpoint) => {
            logInfo(
              "DICTATION_STREAM",
              `Local STT runtime warm-up finished after ${Date.now() - startRequestedAt}ms`,
            );
            return runtimeEndpoint;
          })
          .catch((warmUpError) => {
            logError(
              "DICTATION_STREAM",
              `Local STT runtime warm-up failed, using post-stop transcription fallback: ${formatErrorMessage(warmUpError)}`,
            );
            return false;
          });

      let dictationStreamPromise: Promise<DictationStreamOverlaySession | null> | null =
        null;
      const liveWarmUpPromise = localLiveStreamingEnabled
        ? warmUpLiveRuntime()
        : null;
      if (liveStreamingEnabled && !activeSettings.micId) {
        dictationStreamPromise = startLiveOverlay();
      }

      const nativeMicLabel = await resolveSelectedMicLabel(
        activeSettings.micId,
      );
      if (activeSettings.micId && nativeMicLabel) {
        logInfo(
          "RECORDING",
          `Using preferred native mic label: ${nativeMicLabel}`,
        );
      } else if (activeSettings.micId) {
        logInfo(
          "RECORDING",
          "Selected mic is unavailable; using the system default mic so realtime transcription remains active",
        );
      }

      if (liveStreamingEnabled && !dictationStreamPromise) {
        dictationStreamPromise = startLiveOverlay();
      }

      let dictationStream = dictationStreamPromise
        ? await dictationStreamPromise
        : null;
      let liveDictation = dictationStream
        ? createNativeLiveDictationOptions(
            activeSettings,
            dictationStream.requestId,
          )
        : null;

      try {
        if (dictationStream && liveDictation) {
          const warmUpResult = liveWarmUpPromise
            ? await waitForRuntimeWarmUpWithinBudget(
                liveWarmUpPromise,
                LOCAL_RUNTIME_RECORDING_START_BUDGET_MS,
              )
            : { value: null, timedOut: false };
          if (warmUpResult.timedOut) {
            logInfo(
              "DICTATION_STREAM",
              `Local STT warm-up exceeded ${LOCAL_RUNTIME_RECORDING_START_BUDGET_MS}ms; recording will start with post-stop transcription fallback`,
            );
          }
          if (warmUpResult.value === false || warmUpResult.timedOut) {
            await dictationStream.hide().catch(() => {});
            dictationStream.dispose();
            dictationStream = null;
            liveDictation = null;
          } else if (
            warmUpResult.value &&
            liveDictation.provider === "local"
          ) {
            liveDictation = {
              ...liveDictation,
              endpoint: warmUpResult.value,
            };
          }
        }

        const codec = await runtimeRef.current.startNative({
          deviceLabel: nativeMicLabel,
          liveDictation,
        });
        logInfo(
          "RECORDING",
          `Native recording start completed after ${Date.now() - startRequestedAt}ms`,
        );
        if (dictationStream && liveDictation) {
          dictationStreamRef.current = dictationStream;
        } else if (dictationStream) {
          await dictationStream.hide().catch(() => {});
          dictationStream.dispose();
        }
        logInfo(
          "RECORDING",
          codec === "native-wav"
            ? "Using native wav recorder"
            : "Using native recorder",
        );
        setStream(null);
        logInfo("RECORDING", "Recording started successfully");
        dispatch({ type: "RECORDING_STARTED", timestamp: Date.now() });
        scheduleRecordingLimitTimer();
        startInterruptionMonitor();
        return;
      } catch (nativeError) {
        runtimeRef.current.reset();
        if (dictationStream) {
          await dictationStream.hide().catch(() => {});
          dictationStream.dispose();
        }
        logError(
          "RECORDING",
          `Native recorder start failed, falling back to WebView recorder: ${formatErrorMessage(nativeError)}`,
        );
      }

      const audioConstraints = getVoiceAudioConstraints(activeSettings.micId);
      if (activeSettings.micId) {
        logInfo("RECORDING", `Using preferred mic: ${activeSettings.micId}`);
      } else {
        logInfo("RECORDING", "Using system default mic");
      }

      let recordingStream: MediaStream;
      try {
        logInfo("RECORDING", "Requesting microphone access...");
        recordingStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
        });
      } catch (micError) {
        logInfo(
          "RECORDING",
          `Requested mic failed, trying default: ${micError instanceof Error ? micError.message : String(micError)}`,
        );

        try {
          recordingStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
        } catch (fallbackError) {
          logError(
            "RECORDING",
            `Mic access denied: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
          );
          onRecordingStartFailed?.();
          showError(t("widget.recording.micAccessDenied"));
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
      scheduleRecordingLimitTimer();
      startInterruptionMonitor();
    } catch (error) {
      onRecordingStartFailed?.();
      stopLowMicMonitor();
      clearRecordingLimitTimer();
      stopInterruptionMonitor();
      runtimeRef.current.dispose();
      void clearDictationStreamSession(true);
      recordingSettingsRef.current = null;
      setStream(null);
      logError(
        "RECORDING",
        `Start error: ${error instanceof Error ? error.message : "unknown"}`,
      );
      showError(
        t("widget.recording.startError", {
          error:
            error instanceof Error
              ? error.message
              : t("widget.recording.unknownError"),
        }),
      );
    }
  }, [
    clearDictationStreamSession,
    clearRecordingLimitTimer,
    dispatch,
    hideNotice,
    machineRef,
    onRecordingStart,
    onRecordingStartFailed,
    resizeForSettings,
    scheduleRecordingLimitTimer,
    startInterruptionMonitor,
    stopInterruptionMonitor,
    setStream,
    settings,
    showError,
    startLowMicMonitor,
    stopLowMicMonitor,
    t,
  ]);

  // ── Stop and process ────────────────────────────────────────────────────
  const stopAndProcess = useCallback(async () => {
    logInfo("RECORDING", "stopAndProcess called");

    const machine = machineRef.current;
    const activeSettings = recordingSettingsRef.current ?? settings;
    if (
      !runtimeRef.current.hasRecorder() ||
      !activeSettings ||
      !machine.recordingActive
    ) {
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

    clearRecordingLimitTimer();
    stopInterruptionMonitor();
    stopLowMicMonitor();
    setStream(null);
    onRecordingProcessing?.();
    dispatch({ type: "SET_PROCESSING" });
    void resizeForSettings(activeSettings);
    await waitForWidgetPaint();

    try {
      await runtimeRef.current.stop();
      const dictationStream = dictationStreamRef.current;
      dictationStreamRef.current = null;
      const liveTranscription = runtimeRef.current.getLiveTranscription();

      if (!runtimeRef.current.hasAudioChunks()) {
        if (dictationStream) {
          await dictationStream.hide().catch(() => {});
          dictationStream.dispose();
        }
        logError("RECORDING", "No audio chunks recorded");
        throw new Error(t("widget.recording.noAudioRecorded"));
      }

      const blob = await runtimeRef.current.getAudioBlob();
      const audioStats = runtimeRef.current.getAudioStats();
      logInfo(
        "RECORDING",
        `Recorded audio blob: type=${blob.type || "[unknown]"}, size=${blob.size}`,
      );
      const durationMs = Date.now() - machine.recordingStartTimestamp;

      if (
        durationMs < MIN_RECORDING_DURATION_MS ||
        blob.size < MIN_AUDIO_BLOB_BYTES
      ) {
        logInfo(
          "RECORDING",
          `Recording too short, skipping API request. duration_ms=${durationMs}, blob_size=${blob.size}`,
        );
        recordingSettingsRef.current = null;
        runtimeRef.current.reset();
        if (dictationStream) {
          await dictationStream.hide().catch(() => {});
          dictationStream.dispose();
        }
        dispatch({ type: "PROCESSING_COMPLETE" });
        await resizeForSettings(activeSettings);
        return;
      }

      const pipelineResult = await processRecordingBlob({
        blob,
        settings: activeSettings,
        recordingStartTimestamp: machine.recordingStartTimestamp,
        liveTranscription,
        dictationStream,
        audioStats,
      });

      if (!pipelineResult.hasTranscription) {
        recordingSettingsRef.current = null;
        runtimeRef.current.reset();
        showNotice(t("widget.recording.speechNotRecognized"), "info");
        dispatch({ type: "PROCESSING_COMPLETE" });
        await resizeForSettings(activeSettings);
        return;
      }

      recordingSettingsRef.current = null;
      runtimeRef.current.reset();
      dispatch({ type: "PROCESSING_COMPLETE" });
      await resizeForSettings(activeSettings);
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      logError("API", `Processing error: ${errorMessage}`);

      const message =
        errorMessage && errorMessage !== "{}"
          ? errorMessage
          : t("widget.recording.processingError");

      recordingSettingsRef.current = null;
      runtimeRef.current.reset();
      await clearDictationStreamSession(true);
      showError(message);
    }
  }, [
    clearDictationStreamSession,
    clearRecordingLimitTimer,
    dispatch,
    machineRef,
    onRecordingProcessing,
    resizeForSettings,
    setStream,
    settings,
    showError,
    showNotice,
    stopLowMicMonitor,
    stopInterruptionMonitor,
    t,
  ]);

  // ── Keep stopAndProcessRef current ──────────────────────────────────────
  useEffect(() => {
    stopAndProcessRef.current = stopAndProcess;
  }, [stopAndProcess, stopAndProcessRef]);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopLowMicMonitor();
      clearRecordingLimitTimer();
      stopInterruptionMonitor();
      runtimeRef.current.dispose();
      void clearDictationStreamSession(true);
    };
  }, [
    clearDictationStreamSession,
    clearRecordingLimitTimer,
    stopLowMicMonitor,
    stopInterruptionMonitor,
  ]);

  return { startRecording, stopAndProcess };
}
