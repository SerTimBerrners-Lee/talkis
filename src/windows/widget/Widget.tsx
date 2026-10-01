import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  IconCheck,
  IconCopy,
  IconFileMusic,
  IconLanguage,
  IconLoader2,
  IconPhoneCall,
} from "../../lib/icons";

import {
  CALL_CAPTURE_STOP_REQUEST_EVENT,
  HISTORY_CLEARED_EVENT,
  HISTORY_DELETED_EVENT,
  HISTORY_UPDATED_EVENT,
  DICTATION_STREAM_UPDATE_EVENT,
  PROCESSING_CANCEL_REQUEST_EVENT,
  SETTINGS_UPDATED_EVENT,
  WIDGET_RETRY_PROCESSING_EVENT,
  type DictationStreamUpdatePayload,
  type CallCaptureStopRequestPayload,
  type ProcessingCancelRequestPayload,
  type WidgetRetryProcessingPayload,
} from "../../lib/hotkeyEvents";
import {
  DEFAULT_SELECTION_TRANSLATION_HOTKEY,
  getHistory,
  getSettings,
  isMacPlatform,
  addHistoryEntry,
  reconcileInterruptedProcessing,
  type HistoryEntry,
  type TranslationSettings,
  updateHistoryEntry,
} from "../../lib/store";
import {
  beginProcessing,
  cancelProcessing,
  finishProcessing,
  isAbortError,
} from "../../lib/processingControl";
import {
  fileNameFromPath,
  type FileTranscriptionProgress,
  type FileTranscriptionStatus,
  getFileTranscriptionPercent,
  toFileTranscriptionErrorMessage,
  transcribeFilePathOnly,
} from "../../lib/fileTranscription";
import { logError, logInfo } from "../../lib/logger";
import { tn, useI18n } from "../../lib/i18n";
import {
  requestSystemAudioPermission,
  requiresSystemAudioPermission,
} from "../../lib/permissions";
import { startAppUpdateScheduler } from "../../lib/updater";
import { scaleWidgetDimension } from "../../lib/widgetScale";
import {
  buildCallLiveSpeakerTranscript,
  checkpointCallTranscription,
  formatCallLiveTranscript,
  pauseCallCaptureMic,
  restoreInterruptedCallCaptureHistory,
  resumeCallCaptureMic,
  saveFailedCallCaptureEntry,
  saveCallCaptureMicTrack,
  startCallCapture,
  stopCallCapture,
  transcribeCallCaptureSession,
  type CallCaptureSession,
} from "../../lib/callCapture";
import { useWidgetController } from "./hooks/useWidgetController";
import { WidgetRecordButton } from "./WidgetRecordButton";
import { createRecordingRuntimeController } from "./services/recordingRuntime";
import { startRecoveringPoll } from "./services/recoveringPoll";
import {
  applyLiveTranslationEvent,
  buildLiveTranslationHistoryEntry,
  createLiveTranslationOverlayState,
  liveTranslationVisibleSegments,
  resolveLiveTranslationConnection,
  type LiveTranslationEventPayload,
  type LiveTranslationOverlayState,
} from "./services/liveTranslation";
import {
  createCallLiveDictationOptions,
  warmUpLiveDictationRuntime,
} from "./services/dictationStreamOverlay";
import {
  requestCallMicrophoneStream,
  resolveCallMicrophoneLabel,
} from "./services/callMicrophone";
import { showWidgetErrorOverlay } from "./services/widgetErrorOverlay";
import {
  createLiveTranslationOverlayRenderer,
  type LiveTranslationOverlayRenderer,
} from "./services/liveTranslationOverlayRenderer";
import {
  ACTIVE_WIDGET_SHELL_HEIGHT,
  ACTIVE_WIDGET_SHELL_WIDTH,
  CALL_BUBBLE_SIZE,
  FILE_DROP_WIDGET_HEIGHT,
  FILE_DROP_WIDGET_WIDTH,
  IDLE_HOVER_WIDGET_HEIGHT,
  IDLE_HOVER_WIDGET_WIDTH,
  IDLE_HOVER_SCALE,
  WIDGET_CONTROL_GAP,
  WIDGET_PRIMARY_INLINE_INSET,
  WIDGET_SHELL_HEIGHT,
  WIDGET_SHELL_WIDTH,
  widgetStackHeight,
  widgetStackWidth,
} from "./widgetConstants";

const WIDGET_RECORD_BUTTON_LEFT = 10;
const FILE_DROP_LEAVE_GRACE_MS = 260;
const FILE_DROP_CLOSE_ANIMATION_MS = 160;

type WidgetFileDropState =
  "idle" | "drag-over" | "processing" | "success" | "error" | "closing";
type WidgetCallState =
  "idle" | "starting" | "recording" | "processing" | "success" | "error";
type WidgetLiveTranslationState =
  "idle" | "starting" | "recording" | "stopping" | "error";
type WidgetRetryProcessingSource = WidgetRetryProcessingPayload["source"];

interface CallTranscriptRuntime {
  entry: HistoryEntry;
  sessionId: string | null;
  micRequestId: string | null;
  systemRequestId: string | null;
  micText: string;
  systemText: string;
  channelStartedAt: Record<"mic" | "system", number | null>;
  lastCheckpointAt: Record<"mic" | "system", number>;
  lastUiEmitAt: number;
}

const CALL_DRAFT_CHECKPOINT_MS = 5_000;

const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  widgetEnabled: false,
  active: false,
  targetLanguage: "en",
  selectionTargetLanguage: "en",
  selectionTargetMigrationVersion: 1,
  selectionEnabled: false,
  selectionHotkey: DEFAULT_SELECTION_TRANSLATION_HOTKEY,
  selectionLocalTranslatorProvider: "",
  selectionEnableMigrationVersion: 1,
  liveWidgetEnabled: false,
  liveMicrophoneEnabled: false,
  liveTargetLanguage: "en",
  liveVoiceEnabled: false,
  liveVoice: "marin",
  liveVoiceVolume: 0.8,
  liveVoiceSpeed: 1.05,
  liveMuteOriginalEnabled: true,
};
class CallCaptureStartError extends Error {
  readonly permissionRelated: boolean;
  readonly rawCause: unknown;

  constructor(message: string, permissionRelated = false, rawCause?: unknown) {
    super(message);
    this.name = "CallCaptureStartError";
    this.permissionRelated = permissionRelated;
    this.rawCause = rawCause;
  }
}

const WIDGET_WAVES = [
  {
    className: "widget-wave-line-1",
    dur: "2.8s",
    values: [
      "M0 17 C 24 16, 42 16, 58 17 S 82 5, 96 6 S 122 28, 140 17 S 174 16, 190 17",
      "M0 17 C 24 17, 42 16, 58 17 S 82 8, 96 9 S 122 25, 140 17 S 174 17, 190 17",
      "M0 17 C 24 16, 42 16, 58 17 S 82 5, 96 6 S 122 28, 140 17 S 174 16, 190 17",
    ],
  },
  {
    className: "widget-wave-line-2",
    dur: "3.4s",
    values: [
      "M0 17 C 20 18, 42 18, 58 17 S 78 30, 96 29 S 118 4, 138 17 S 170 18, 190 17",
      "M0 17 C 22 17, 42 18, 58 17 S 80 26, 96 25 S 118 8, 138 17 S 170 17, 190 17",
      "M0 17 C 20 18, 42 18, 58 17 S 78 30, 96 29 S 118 4, 138 17 S 170 18, 190 17",
    ],
  },
  {
    className: "widget-wave-line-3",
    dur: "3.1s",
    values: [
      "M0 17 C 22 17, 44 16, 60 17 S 84 11, 96 12 S 116 23, 136 17 S 170 16, 190 17",
      "M0 17 C 22 16, 44 17, 60 17 S 84 13, 96 14 S 116 21, 136 17 S 170 17, 190 17",
      "M0 17 C 22 17, 44 16, 60 17 S 84 11, 96 12 S 116 23, 136 17 S 170 16, 190 17",
    ],
  },
] as const;

function getCopyableText(
  entry: HistoryEntry | null | undefined,
): string | null {
  if (!entry || entry.status === "failed") {
    return null;
  }

  const cleaned = entry.cleaned.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function stopMediaStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function isPermissionDeniedError(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false;
  }

  return error.name === "NotAllowedError" || error.name === "SecurityError";
}

function isSelectedMicUnavailableError(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false;
  }

  return (
    error.name === "NotFoundError" || error.name === "OverconstrainedError"
  );
}

function microphoneStartErrorMessage(error: unknown): string {
  if (isPermissionDeniedError(error)) {
    return tn("widget.mic.permissionDenied");
  }

  if (error instanceof DOMException && error.name === "NotReadableError") {
    return tn("widget.mic.busy");
  }

  if (isSelectedMicUnavailableError(error)) {
    return tn("widget.mic.unavailable");
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return tn("widget.mic.startTimeout");
  }

  return tn("widget.mic.accessFailed");
}

function formatCallCaptureRawError(error: unknown): string {
  const source =
    error instanceof CallCaptureStartError && error.rawCause
      ? error.rawCause
      : error;

  if (source instanceof DOMException) {
    const constraint =
      "constraint" in source && typeof source.constraint === "string"
        ? `, constraint=${source.constraint}`
        : "";
    return `${source.name}: ${source.message || "[no message]"}${constraint}`;
  }

  if (source instanceof Error) {
    return `${source.name}: ${source.message}`;
  }

  return String(source);
}

function callCaptureStartErrorMessage(error: unknown): string {
  if (error instanceof CallCaptureStartError) {
    return error.message;
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const normalized = rawMessage.toLowerCase();

  if (normalized.includes("pipewire")) {
    return tn("widget.call.pipewireFailed");
  }

  if (normalized.includes("не поддерживается")) {
    return tn("widget.call.systemAudioUnsupported");
  }

  if (normalized.includes("устройство вывода windows")) {
    return tn("widget.call.windowsOutputMissing");
  }

  if (
    normalized.includes("wasapi") ||
    normalized.includes("windows loopback") ||
    normalized.includes("запись системного звука windows")
  ) {
    return tn("widget.call.windowsCaptureFailed");
  }

  if (
    normalized.includes("audiohardwarecreateprocesstap") ||
    normalized.includes("audiodevicestart") ||
    normalized.includes("звука системы") ||
    normalized.includes("system audio")
  ) {
    return tn("widget.call.systemAudioPermission");
  }

  return tn("widget.call.startFailed");
}

function isCallCapturePermissionError(error: unknown): boolean {
  if (error instanceof CallCaptureStartError) {
    return error.permissionRelated;
  }

  if (isPermissionDeniedError(error)) {
    return true;
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const normalized = rawMessage.toLowerCase();
  return (
    normalized.includes("audiohardwarecreateprocesstap") ||
    normalized.includes("audiodevicestart") ||
    normalized.includes("звука системы") ||
    normalized.includes("system audio")
  );
}

export function Widget() {
  const { t } = useI18n();
  const widgetWindow = getCurrentWindow();
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragTriggeredRef = useRef(false);
  const callMicRuntimeRef = useRef(createRecordingRuntimeController());
  const callSessionRef = useRef<CallCaptureSession | null>(null);
  const callTranscriptRuntimeRef = useRef<CallTranscriptRuntime | null>(null);
  const callTranscriptPersistQueueRef = useRef<Promise<void>>(
    Promise.resolve(),
  );
  // Ids of the entries currently being processed in this window, so a stop
  // request from the table can reset the matching widget UI immediately (a local
  // `invoke` keeps running and would otherwise leave the spinner going).
  const callProcessingIdRef = useRef<string | null>(null);
  const fileProcessingIdRef = useRef<string | null>(null);
  const callMicPausedForVoiceRef = useRef(false);
  const callSystemAudioPermissionReadyRef = useRef(false);
  const callStateRef = useRef<WidgetCallState>("idle");
  const liveTranslationStateRef = useRef<WidgetLiveTranslationState>("idle");
  const liveOverlayRef = useRef<LiveTranslationOverlayState | null>(null);
  const pendingLiveEventsRef = useRef<LiveTranslationEventPayload[]>([]);
  const liveOverlayRendererRef = useRef<LiveTranslationOverlayRenderer | null>(
    null,
  );
  const liveStartedAtRef = useRef(0);
  const liveAdapterIdRef = useRef("unknown");
  const liveAudioWatchdogTimerRef = useRef<number | null>(null);
  const stopLiveTranslationRef = useRef<() => Promise<void>>(async () => {});
  const stopCallListeningRef = useRef<() => Promise<void>>(async () => {});
  const pauseCallMicForVoice = useCallback(() => {
    if (callStateRef.current !== "recording") {
      return;
    }

    callMicPausedForVoiceRef.current = true;
    const callSession = callSessionRef.current;
    if (callSession?.nativeMicActive) {
      void pauseCallCaptureMic(callSession.id)
        .then((paused) => {
          if (paused) {
            logInfo(
              "CALL_CAPTURE",
              "Paused native call mic while voice recording",
            );
          }
        })
        .catch((error) => {
          logError(
            "CALL_CAPTURE",
            `Failed to pause native call mic: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      return;
    }
    if (callMicRuntimeRef.current.pause()) {
      logInfo("CALL_CAPTURE", "Paused call mic while voice recording");
    }
  }, []);
  const resumeCallMicForVoice = useCallback(() => {
    if (!callMicPausedForVoiceRef.current) {
      return;
    }

    callMicPausedForVoiceRef.current = false;
    const callSession = callSessionRef.current;
    if (callSession?.nativeMicActive) {
      void resumeCallCaptureMic(callSession.id)
        .then((resumed) => {
          if (resumed) {
            logInfo(
              "CALL_CAPTURE",
              "Resumed native call mic after voice recording",
            );
          }
        })
        .catch((error) => {
          logError(
            "CALL_CAPTURE",
            `Failed to resume native call mic: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      return;
    }
    if (callMicRuntimeRef.current.resume()) {
      logInfo("CALL_CAPTURE", "Resumed call mic after voice recording");
    }
  }, []);
  const {
    state,
    stream,
    lockedRecording,
    widgetScale,
    resizeWidget,
    toggleManualRecording,
  } = useWidgetController({
    onVoiceRecordingProcessing: resumeCallMicForVoice,
    onVoiceRecordingStart: pauseCallMicForVoice,
    onVoiceRecordingStartFailed: resumeCallMicForVoice,
  });
  const stateRef = useRef(state);
  const fileDropStateRef = useRef<WidgetFileDropState>("idle");
  const retryProcessingSourceRef = useRef<WidgetRetryProcessingSource | null>(
    null,
  );
  const fileResetTimerRef = useRef<number | null>(null);
  const fileDragLeaveTimerRef = useRef<number | null>(null);
  const fileCloseTimerRef = useRef<number | null>(null);
  const fileDragDepthRef = useRef(0);
  const fileDropExpandedRef = useRef(false);
  const translationSettingsRef = useRef<TranslationSettings>(
    DEFAULT_TRANSLATION_SETTINGS,
  );
  if (!liveOverlayRendererRef.current) {
    liveOverlayRendererRef.current = createLiveTranslationOverlayRenderer({
      isActive: (sessionId) => liveOverlayRef.current?.sessionId === sessionId,
      render: async (next) => {
        await invoke("show_widget_text_overlay", {
          payload: {
            status: "liveTranslation",
            sourceText: "",
            translatedText: "",
            targetLanguage: translationSettingsRef.current.liveTargetLanguage,
            requestId: next.sessionId,
            message: next.error,
            liveSegments: liveTranslationVisibleSegments(next),
          },
        });
      },
      onError: (error) => {
        logError("LIVE_TRANSLATION", `Failed to update overlay: ${error}`);
      },
    });
  }
  const fileProcessRef = useRef<(filePath: string) => Promise<void>>(
    async () => {},
  );
  const [latestCopyText, setLatestCopyText] = useState<string | null>(null);
  const [pendingFileResultId, setPendingFileResultId] = useState<string | null>(
    null,
  );
  const [fileDropState, setFileDropState] =
    useState<WidgetFileDropState>("idle");
  const [fileDropName, setFileDropName] = useState("");
  const [fileStatus, setFileStatus] = useState<FileTranscriptionStatus | null>(
    null,
  );
  const [fileProgress, setFileProgress] =
    useState<FileTranscriptionProgress | null>(null);
  const [callState, setCallState] = useState<WidgetCallState>("idle");
  const [callSession, setCallSession] = useState<CallCaptureSession | null>(
    null,
  );
  const [callStartedAt, setCallStartedAt] = useState<number>(0);
  const [callError, setCallError] = useState<string>("");
  const [callSettings, setCallSettings] = useState<Awaited<
    ReturnType<typeof getSettings>
  > | null>(null);
  const [translationSettings, setTranslationSettings] =
    useState<TranslationSettings>(DEFAULT_TRANSLATION_SETTINGS);
  const [liveTranslationState, setLiveTranslationState] =
    useState<WidgetLiveTranslationState>("idle");
  const updateLiveTranslationState = (
    nextState: WidgetLiveTranslationState,
  ): void => {
    liveTranslationStateRef.current = nextState;
    setLiveTranslationState(nextState);
  };
  const [retryProcessingSource, setRetryProcessingSource] =
    useState<WidgetRetryProcessingSource | null>(null);

  const clearLiveAudioWatchdog = (): void => {
    if (liveAudioWatchdogTimerRef.current === null) return;
    window.clearTimeout(liveAudioWatchdogTimerRef.current);
    liveAudioWatchdogTimerRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (liveAudioWatchdogTimerRef.current !== null) {
        window.clearTimeout(liveAudioWatchdogTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const startedAt = Date.now();

    void getSettings({ reload: true })
      .then(async (settings) => {
        const runtimeEndpoint = await warmUpLiveDictationRuntime(settings);
        if (!runtimeEndpoint) return;

        await logInfo(
          "LOCAL_STT",
          `Startup warm-up ready at ${runtimeEndpoint} after ${Date.now() - startedAt}ms`,
        );
      })
      .catch(async (error) => {
        await logError(
          "LOCAL_STT",
          `Startup warm-up failed; recording fallback remains available: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }, []);

  useEffect(() => {
    liveTranslationStateRef.current = liveTranslationState;
  }, [liveTranslationState]);

  useEffect(() => {
    const unlistenPromise = listen<DictationStreamUpdatePayload>(
      DICTATION_STREAM_UPDATE_EVENT,
      ({ payload }) => {
        const runtime = callTranscriptRuntimeRef.current;
        if (!runtime) return;
        const channel =
          payload.requestId === runtime.micRequestId
            ? "mic"
            : payload.requestId === runtime.systemRequestId
              ? "system"
              : null;
        if (!channel || payload.status === "started") {
          return;
        }

        const now = Date.now();
        const startedAt = Date.parse(runtime.entry.timestamp);
        const duration = Number.isFinite(startedAt)
          ? Math.max(0, Math.round((now - startedAt) / 1000))
          : runtime.entry.duration;
        const nextText = payload.text.trim();
        if (nextText) {
          if (
            !runtime[channel === "mic" ? "micText" : "systemText"] &&
            runtime.channelStartedAt[channel] === null
          ) {
            runtime.channelStartedAt[channel] = duration;
          }
          if (channel === "mic") {
            runtime.micText = nextText;
          } else {
            runtime.systemText = nextText;
          }
        }
        const transcript = formatCallLiveTranscript(
          runtime.micText,
          runtime.systemText,
        );
        runtime.entry = {
          ...runtime.entry,
          duration,
          raw: transcript || runtime.entry.raw,
          cleaned: transcript || runtime.entry.cleaned,
          ...buildCallLiveSpeakerTranscript({
            micText: runtime.micText,
            systemText: runtime.systemText,
            micStartedAt: runtime.channelStartedAt.mic,
            systemStartedAt: runtime.channelStartedAt.system,
            duration,
          }),
          errorMessage:
            payload.status === "error"
              ? tn("callCapture.liveUnavailable")
              : runtime.entry.errorMessage,
        };

        if (payload.status !== "partial" || now - runtime.lastUiEmitAt >= 150) {
          runtime.lastUiEmitAt = now;
          void emit(HISTORY_UPDATED_EVENT, runtime.entry);
        }

        const shouldCheckpointDraft =
          payload.status === "partial" &&
          now - runtime.lastCheckpointAt[channel] >= CALL_DRAFT_CHECKPOINT_MS;
        const durableStatus =
          payload.status === "final"
            ? "final"
            : payload.status === "error"
              ? "error"
              : shouldCheckpointDraft
                ? "draft"
                : null;
        if (!durableStatus || !runtime.sessionId) {
          return;
        }
        runtime.lastCheckpointAt[channel] = now;
        const entrySnapshot = { ...runtime.entry };
        const sessionId = runtime.sessionId;
        callTranscriptPersistQueueRef.current =
          callTranscriptPersistQueueRef.current
            .catch(() => {})
            .then(async () => {
              await checkpointCallTranscription({
                sessionId,
                channel,
                status: durableStatus,
                text: channel === "mic" ? runtime.micText : runtime.systemText,
                startedAtMs: now,
                message: payload.message,
              });
              await updateHistoryEntry(entrySnapshot);
              await emit(HISTORY_UPDATED_EVENT, entrySnapshot);
            })
            .catch((error) => {
              logError(
                "CALL_CAPTURE",
                `Failed to checkpoint live transcript: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
      },
    );
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<LiveTranslationEventPayload>(
      "live-translation:update",
      ({ payload }) => {
        const current = liveOverlayRef.current;
        if (!current) {
          pendingLiveEventsRef.current = [
            ...pendingLiveEventsRef.current.slice(-15),
            payload,
          ];
          return;
        }
        const next = applyLiveTranslationEvent(current, payload);
        if (next === current) return;
        liveOverlayRef.current = next;
        liveOverlayRendererRef.current?.schedule(
          next,
          payload.status === "final" || payload.status === "error",
        );
      },
    );
    return () => {
      liveOverlayRendererRef.current?.cancel();
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    fileDropStateRef.current = fileDropState;
  }, [fileDropState]);

  useEffect(() => {
    retryProcessingSourceRef.current = retryProcessingSource;
  }, [retryProcessingSource]);

  useEffect(() => {
    translationSettingsRef.current = translationSettings;
  }, [translationSettings]);

  useEffect(() => {
    let mounted = true;

    const loadTranslationSettings = async (): Promise<void> => {
      try {
        const settings = await getSettings({ reload: true });
        if (!mounted) return;
        if (
          !settings.translation.liveWidgetEnabled &&
          liveTranslationStateRef.current === "recording"
        ) {
          void stopLiveTranslationRef.current();
        }
        setTranslationSettings(settings.translation);
      } catch (error) {
        logError(
          "TRANSLATION",
          `Failed to load translation settings: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    void loadTranslationSettings();
    const unlistenPromise = listen(SETTINGS_UPDATED_EVENT, () => {
      void loadTranslationSettings();
    });

    return () => {
      mounted = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const unlistenPromise = listen<WidgetRetryProcessingPayload>(
      WIDGET_RETRY_PROCESSING_EVENT,
      ({ payload }) => {
        if (!mounted) {
          return;
        }

        setRetryProcessingSource(payload.active ? payload.source : null);
      },
    );

    return () => {
      mounted = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    // Recover durable call manifests and transcript checkpoints before the
    // generic processing reconciliation updates any remaining orphan rows.
    void restoreInterruptedCallCaptureHistory()
      .then((restored) => {
        if (restored.length > 0) {
          logInfo(
            "CALL_CAPTURE",
            `Recovered interrupted call sessions: ${restored.length}`,
          );
        }
      })
      .catch((error) => {
        logError(
          "CALL_CAPTURE",
          `Failed to recover interrupted calls: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        void reconcileInterruptedProcessing();
      });

    // Allow the history table (Settings window) to stop an in-flight job here.
    const unlistenPromise = listen<ProcessingCancelRequestPayload>(
      PROCESSING_CANCEL_REQUEST_EVENT,
      ({ payload }) => {
        if (!payload?.entryId) {
          return;
        }
        void cancelProcessing(payload.entryId);
        // Stop the widget spinner right away for the job it owns.
        if (payload.entryId === callProcessingIdRef.current) {
          resetCallProcessingUi();
        } else if (payload.entryId === fileProcessingIdRef.current) {
          resetFileProcessingUi();
        }
      },
    );

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<CallCaptureStopRequestPayload>(
      CALL_CAPTURE_STOP_REQUEST_EVENT,
      ({ payload }) => {
        const runtime = callTranscriptRuntimeRef.current;
        if (!payload?.entryId || payload.entryId !== runtime?.entry.id) {
          return;
        }
        void stopCallListeningRef.current();
      },
    );

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);

  useEffect(() => {
    return startAppUpdateScheduler({
      canRunUpdate: () =>
        stateRef.current === "idle" &&
        callStateRef.current === "idle" &&
        retryProcessingSourceRef.current === null,
    });
  }, []);

  const showCallNotice = useCallback((message: string): void => {
    showWidgetErrorOverlay(message);
  }, []);

  const clearFileResetTimer = () => {
    if (!fileResetTimerRef.current) return;
    window.clearTimeout(fileResetTimerRef.current);
    fileResetTimerRef.current = null;
  };

  const clearFileDragLeaveTimer = () => {
    if (!fileDragLeaveTimerRef.current) return;
    window.clearTimeout(fileDragLeaveTimerRef.current);
    fileDragLeaveTimerRef.current = null;
  };

  const clearFileCloseTimer = () => {
    if (!fileCloseTimerRef.current) return;
    window.clearTimeout(fileCloseTimerRef.current);
    fileCloseTimerRef.current = null;
  };

  const resizeWidgetForFileDrop = async (active: boolean): Promise<void> => {
    if (fileDropExpandedRef.current === active) {
      return;
    }

    fileDropExpandedRef.current = active;
    await resizeWidget(
      widgetStackWidth(
        active,
        translationSettingsRef.current.liveWidgetEnabled,
      ),
      widgetStackHeight(active),
    ).catch((error) => {
      logError(
        "WIDGET_FILE",
        `Resize failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const resetFileDropUi = async (): Promise<void> => {
    clearFileResetTimer();
    clearFileDragLeaveTimer();
    clearFileCloseTimer();
    fileDragDepthRef.current = 0;
    setFileDropState("idle");
    setFileDropName("");
    setFileStatus(null);
    setFileProgress(null);
    await resizeWidgetForFileDrop(false);
  };

  const closeFileDropUi = (): void => {
    clearFileResetTimer();
    clearFileDragLeaveTimer();
    clearFileCloseTimer();

    if (fileDropStateRef.current === "idle") {
      return;
    }

    setFileDropState("closing");
    fileCloseTimerRef.current = window.setTimeout(() => {
      fileCloseTimerRef.current = null;
      void resetFileDropUi();
    }, FILE_DROP_CLOSE_ANIMATION_MS);
  };

  const scheduleFileDropReset = () => {
    clearFileResetTimer();
    fileResetTimerRef.current = window.setTimeout(() => {
      fileResetTimerRef.current = null;
      void resetFileDropUi();
    }, 1800);
  };

  // Immediately drop the widget out of its processing UI when a stop request
  // arrives for the entry it is working on — without waiting for the (possibly
  // long-running, non-abortable local) job to settle.
  const resetCallProcessingUi = (): void => {
    callProcessingIdRef.current = null;
    callMicRuntimeRef.current.dispose();
    callSessionRef.current = null;
    callTranscriptRuntimeRef.current = null;
    callMicPausedForVoiceRef.current = false;
    setCallSession(null);
    setCallSettings(null);
    setCallError("");
    setCallState("idle");
    setFileStatus(null);
    setFileProgress(null);
  };

  const resetFileProcessingUi = (): void => {
    fileProcessingIdRef.current = null;
    setFileStatus(null);
    setFileProgress(null);
    closeFileDropUi();
  };

  const canAcceptFileDrop = () =>
    stateRef.current === "idle" && fileDropStateRef.current !== "processing";

  const startCallListening = async (): Promise<void> => {
    if (
      stateRef.current !== "idle" ||
      fileDropStateRef.current !== "idle" ||
      callState !== "idle"
    ) {
      return;
    }

    let micStream: MediaStream | null = null;
    let startedSession: CallCaptureSession | null = null;

    try {
      setCallError("");
      setCallState("starting");
      const settings = await getSettings({ reload: true });
      setCallSettings(settings);

      let micDeviceLabel: string | null = null;
      try {
        micDeviceLabel = await resolveCallMicrophoneLabel(settings.micId);
        logInfo(
          "CALL_CAPTURE",
          micDeviceLabel
            ? `Resolved selected call mic without opening WebView audio: ${micDeviceLabel}`
            : "Using native system default call mic",
        );
      } catch (error) {
        logError(
          "CALL_CAPTURE",
          settings.micId
            ? `Selected call mic unavailable; refusing default fallback to keep mic and system tracks separate: ${formatCallCaptureRawError(error)}`
            : `Default call mic unavailable: ${formatCallCaptureRawError(error)}`,
        );
        if (error instanceof CallCaptureStartError) {
          throw error;
        }

        throw new CallCaptureStartError(
          microphoneStartErrorMessage(error),
          isPermissionDeniedError(error),
          error,
        );
      }

      if (
        requiresSystemAudioPermission() &&
        !callSystemAudioPermissionReadyRef.current
      ) {
        await requestSystemAudioPermission();

        callSystemAudioPermissionReadyRef.current = true;
      }

      const startedAt = Date.now();
      const entryId = crypto.randomUUID();
      const micRequestId = `${entryId}:mic`;
      const systemRequestId = `${entryId}:system`;
      let micLiveOptions = createCallLiveDictationOptions(
        settings,
        micRequestId,
      );
      let systemLiveOptions = createCallLiveDictationOptions(
        settings,
        systemRequestId,
      );
      let liveStreamingReady = true;
      if (micLiveOptions?.provider === "local") {
        try {
          const runtimeEndpoint = await warmUpLiveDictationRuntime(
            settings,
            micLiveOptions.model,
          );
          if (runtimeEndpoint) {
            micLiveOptions = {
              ...micLiveOptions,
              endpoint: runtimeEndpoint,
            };
            if (systemLiveOptions?.provider === "local") {
              systemLiveOptions = {
                ...systemLiveOptions,
                endpoint: runtimeEndpoint,
              };
            }
          }
          if (micLiveOptions.model !== settings.whisperModel) {
            logInfo(
              "CALL_CAPTURE",
              `Using local live preview model=${micLiveOptions.model}; final_model=${settings.whisperModel}`,
            );
          }
        } catch (error) {
          liveStreamingReady = false;
          logError(
            "CALL_CAPTURE",
            `Local live STT warm-up failed; audio recording and stop-time transcription remain active: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (!liveStreamingReady) {
        micLiveOptions = null;
        systemLiveOptions = null;
      }
      const baseEntry: HistoryEntry = {
        id: entryId,
        timestamp: new Date(startedAt).toISOString(),
        duration: 0,
        raw: "",
        cleaned: "",
        source: "call",
        fileName: tn("callCapture.fileName"),
        status: "recording",
        callCapturePhase: "recording",
        ...buildCallLiveSpeakerTranscript({}),
      };
      callTranscriptRuntimeRef.current = {
        entry: baseEntry,
        sessionId: null,
        micRequestId: micLiveOptions ? micRequestId : null,
        systemRequestId: systemLiveOptions ? systemRequestId : null,
        micText: "",
        systemText: "",
        channelStartedAt: { mic: null, system: null },
        lastCheckpointAt: { mic: 0, system: 0 },
        lastUiEmitAt: 0,
      };
      const session = await startCallCapture({
        targetId: "system-output",
        includeMic: true,
        includeSystem: true,
        micDeviceId: settings.micId || null,
        micDeviceLabel,
        storageDir: settings.transcriptionStorageDir || null,
        liveTranscription:
          micLiveOptions && systemLiveOptions
            ? { mic: micLiveOptions, system: systemLiveOptions }
            : null,
      });
      startedSession = session;

      if (session.nativeMicActive) {
        logInfo(
          "CALL_CAPTURE",
          "Native call mic started without a competing WebView audio session",
        );
      } else {
        logInfo(
          "CALL_CAPTURE",
          "Native call mic unavailable; requesting WebView fallback",
        );
        micStream = await requestCallMicrophoneStream(settings.micId);
        callMicRuntimeRef.current.start(micStream);
      }
      micStream = null;
      if (callMicPausedForVoiceRef.current) {
        if (session.nativeMicActive) {
          await pauseCallCaptureMic(session.id);
        } else {
          callMicRuntimeRef.current.pause();
        }
      }

      const runtime = callTranscriptRuntimeRef.current;
      const recordingEntry: HistoryEntry = {
        ...(runtime?.entry || baseEntry),
        callSessionId: session.id,
        callTracks: session.tracks.map((track) => ({
          kind: track.kind,
          label: track.label,
          path: track.path,
        })),
        errorMessage: session.liveTranscription?.errors.length
          ? tn("callCapture.liveUnavailable")
          : undefined,
      };
      if (runtime) {
        runtime.entry = recordingEntry;
        runtime.sessionId = session.id;
      }
      callTranscriptPersistQueueRef.current =
        callTranscriptPersistQueueRef.current
          .catch(() => {})
          .then(async () => {
            await addHistoryEntry(recordingEntry);
            await emit(HISTORY_UPDATED_EVENT, recordingEntry);
          });
      try {
        await callTranscriptPersistQueueRef.current;
      } catch (error) {
        logError(
          "CALL_CAPTURE",
          `Failed to persist live call row: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      callSessionRef.current = session;
      setCallStartedAt(startedAt);
      setCallSession(session);
      setCallState("recording");
    } catch (error) {
      stopMediaStream(micStream);
      if (startedSession) {
        await stopCallCapture(startedSession.id).catch((stopError) => {
          logError(
            "CALL_CAPTURE",
            `Failed to stop partially started call: ${
              stopError instanceof Error ? stopError.message : String(stopError)
            }`,
          );
        });
      }
      const message = callCaptureStartErrorMessage(error);
      logError(
        "CALL_CAPTURE",
        `Call capture start failed: ${formatCallCaptureRawError(error)}`,
      );
      callMicRuntimeRef.current.dispose();
      callSessionRef.current = null;
      callTranscriptRuntimeRef.current = null;
      callMicPausedForVoiceRef.current = false;
      if (isCallCapturePermissionError(error)) {
        callSystemAudioPermissionReadyRef.current = false;
      }
      setCallError(message);
      setCallSession(null);
      setCallSettings(null);
      setCallState("error");
      showCallNotice(message);
      window.setTimeout(() => {
        setCallState("idle");
        setCallError("");
      }, 2600);
    }
  };

  const stopCallListening = async (): Promise<void> => {
    if (!callSession || callState !== "recording") {
      return;
    }

    let stoppedSession: CallCaptureSession | null = null;
    let sessionForFailure: CallCaptureSession = callSession;
    try {
      setCallState("processing");
      setFileStatus("preparing");
      setFileProgress(null);
      const runtime = callTranscriptRuntimeRef.current;
      if (runtime) {
        runtime.entry = {
          ...runtime.entry,
          status: "processing",
          callCapturePhase: "finalizing",
          duration: Math.max(
            runtime.entry.duration,
            Math.round((Date.now() - callStartedAt) / 1000),
          ),
        };
        callProcessingIdRef.current = runtime.entry.id;
        const finalizingEntry = { ...runtime.entry };
        callTranscriptPersistQueueRef.current =
          callTranscriptPersistQueueRef.current
            .catch(() => {})
            .then(async () => {
              await updateHistoryEntry(finalizingEntry);
              await emit(HISTORY_UPDATED_EVENT, finalizingEntry);
            });
        try {
          await callTranscriptPersistQueueRef.current;
        } catch (error) {
          logError(
            "CALL_CAPTURE",
            `Failed to persist finalizing call state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (!callSession.nativeMicActive) {
        await callMicRuntimeRef.current.stop();
      }
      const micBlob =
        !callSession.nativeMicActive &&
        callMicRuntimeRef.current.hasAudioChunks()
          ? await callMicRuntimeRef.current.getAudioBlob()
          : null;
      const micFileName = micBlob?.type.includes("wav")
        ? "call-mic.wav"
        : "call-mic.webm";
      const micFile = micBlob
        ? new File([micBlob], micFileName, {
            type: micBlob.type || "audio/webm",
          })
        : null;
      let micFileForTranscription = micFile;
      if (micBlob) {
        try {
          const micTrack = await saveCallCaptureMicTrack(
            callSession.id,
            micBlob,
          );
          micFileForTranscription = null;
          sessionForFailure = {
            ...sessionForFailure,
            tracks: [
              micTrack,
              ...sessionForFailure.tracks.filter(
                (track) => track.kind !== "mic",
              ),
            ],
          };
        } catch (saveError) {
          logError(
            "CALL_CAPTURE",
            `Failed to persist call mic track: ${
              saveError instanceof Error ? saveError.message : String(saveError)
            }`,
          );
        }
      }
      stoppedSession = await stopCallCapture(callSession.id);
      callSessionRef.current = null;
      if (runtime) {
        runtime.micRequestId = null;
        runtime.systemRequestId = null;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      await callTranscriptPersistQueueRef.current.catch(() => {});
      if (runtime && stoppedSession.liveTranscription) {
        runtime.micText =
          stoppedSession.liveTranscription.micText || runtime.micText;
        runtime.systemText =
          stoppedSession.liveTranscription.systemText || runtime.systemText;
        const liveText = formatCallLiveTranscript(
          runtime.micText,
          runtime.systemText,
        );
        runtime.entry = {
          ...runtime.entry,
          raw: liveText || runtime.entry.raw,
          cleaned: liveText || runtime.entry.cleaned,
          ...buildCallLiveSpeakerTranscript({
            micText: runtime.micText,
            systemText: runtime.systemText,
            micStartedAt: runtime.channelStartedAt.mic,
            systemStartedAt: runtime.channelStartedAt.system,
            duration: runtime.entry.duration,
          }),
          callTracks: stoppedSession.tracks.map((track) => ({
            kind: track.kind,
            label: track.label,
            path: track.path,
          })),
          errorMessage: stoppedSession.liveTranscription.errors.length
            ? tn("callCapture.liveUnavailable")
            : runtime.entry.errorMessage,
        };
        try {
          await updateHistoryEntry(runtime.entry);
          await emit(HISTORY_UPDATED_EVENT, runtime.entry);
        } catch (error) {
          logError(
            "CALL_CAPTURE",
            `Failed to persist final live call draft: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const settings = callSettings ?? (await getSettings({ reload: true }));
      const entry = await transcribeCallCaptureSession({
        session: stoppedSession,
        settings,
        micFile: micFileForTranscription,
        startedAt: callStartedAt,
        entryId: runtime?.entry.id,
        baseEntry: runtime?.entry,
        onStatus: setFileStatus,
        onProgress: setFileProgress,
        onStarted: (entryId) => {
          callProcessingIdRef.current = entryId;
        },
      });

      // A stop request already reset the UI (and possibly started a new call) —
      // ignore this now-stale result so we don't clobber the fresh state.
      if (callProcessingIdRef.current !== entry.id) {
        return;
      }
      callProcessingIdRef.current = null;

      callMicPausedForVoiceRef.current = false;
      callTranscriptRuntimeRef.current = null;
      setCallSession(null);
      setCallSettings(null);
      setFileProgress(null);

      if (entry.status === "completed") {
        callMicRuntimeRef.current.reset();
        setLatestCopyText(getCopyableText(entry));
        setCallState("success");
        setFileStatus("done");
        window.setTimeout(() => {
          setCallState("idle");
        }, 1800);
      } else {
        // interrupted (user stop) or failed — the entry is already persisted to
        // history with a retry option; return the widget to idle quietly.
        callMicRuntimeRef.current.dispose();
        setCallError("");
        setCallState("idle");
        setFileStatus(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("CALL_CAPTURE", `Call capture stop/process failed: ${message}`);
      const userFacingMessage = t("widget.call.processFailed");

      const failedRuntime = callTranscriptRuntimeRef.current;
      if (failedRuntime) {
        failedRuntime.micRequestId = null;
        failedRuntime.systemRequestId = null;
      }
      if (!stoppedSession && callSessionRef.current?.id === callSession.id) {
        try {
          stoppedSession = await stopCallCapture(callSession.id);
          sessionForFailure = stoppedSession;
        } catch (stopError) {
          logError(
            "CALL_CAPTURE",
            `Failed to stop call capture during error cleanup: ${
              stopError instanceof Error ? stopError.message : String(stopError)
            }`,
          );
        } finally {
          callSessionRef.current = null;
        }
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      await callTranscriptPersistQueueRef.current.catch(() => {});

      try {
        const runtime = callTranscriptRuntimeRef.current;
        if (runtime) {
          if (stoppedSession?.liveTranscription) {
            runtime.micText =
              stoppedSession.liveTranscription.micText || runtime.micText;
            runtime.systemText =
              stoppedSession.liveTranscription.systemText || runtime.systemText;
          }
          const preservedLiveText = formatCallLiveTranscript(
            runtime.micText,
            runtime.systemText,
          );
          const failed: HistoryEntry = {
            ...runtime.entry,
            raw: preservedLiveText || runtime.entry.raw,
            cleaned: preservedLiveText || runtime.entry.cleaned,
            ...buildCallLiveSpeakerTranscript({
              micText: runtime.micText,
              systemText: runtime.systemText,
              micStartedAt: runtime.channelStartedAt.mic,
              systemStartedAt: runtime.channelStartedAt.system,
              duration: runtime.entry.duration,
            }),
            status: "failed",
            callCapturePhase: undefined,
            errorMessage: userFacingMessage,
            callTracks: (stoppedSession ?? sessionForFailure).tracks.map(
              (track) => ({
                kind: track.kind,
                label: track.label,
                path: track.path,
              }),
            ),
          };
          await updateHistoryEntry(failed);
          await emit(HISTORY_UPDATED_EVENT, failed);
        } else {
          await saveFailedCallCaptureEntry({
            session: stoppedSession ?? sessionForFailure,
            errorMessage: userFacingMessage,
            startedAt: callStartedAt,
          });
        }
      } catch (historyError) {
        logError(
          "CALL_CAPTURE",
          `Failed to save failed call history entry: ${
            historyError instanceof Error
              ? historyError.message
              : String(historyError)
          }`,
        );
      }

      callMicRuntimeRef.current.dispose();
      callSessionRef.current = null;
      callTranscriptRuntimeRef.current = null;
      callMicPausedForVoiceRef.current = false;
      setCallError("");
      setCallState("idle");
      setFileStatus(null);
      setFileProgress(null);
      setCallSession(null);
      setCallSettings(null);
    }
  };
  stopCallListeningRef.current = stopCallListening;

  fileProcessRef.current = async (filePath: string): Promise<void> => {
    if (!filePath || !canAcceptFileDrop()) {
      return;
    }

    clearFileResetTimer();
    clearFileDragLeaveTimer();
    clearFileCloseTimer();
    const fileName = fileNameFromPath(filePath);
    setFileDropState("processing");
    setFileDropName(fileName);
    setFileStatus("preparing");
    setFileProgress(null);
    await resizeWidgetForFileDrop(true);

    const settings = await getSettings({ reload: true });
    const startedAt = Date.now();
    // Persist a "processing" row up front (keeping the source path for re-runs).
    const baseEntry: HistoryEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      duration: 0,
      raw: "",
      cleaned: "",
      source: "file",
      fileName,
      status: "processing",
      filePath,
    };
    const handle = await beginProcessing(baseEntry, "add");
    fileProcessingIdRef.current = baseEntry.id;

    try {
      const transcription = await transcribeFilePathOnly({
        filePath,
        settings,
        onStatus: setFileStatus,
        onProgress: setFileProgress,
        speakerDiarization: settings.fileSpeakerDiarization === true,
        identifyFirstSpeakerAsUser: true,
      });

      if (handle.isCancelled()) {
        // UI was already reset by the stop handler; just record the outcome.
        await finishProcessing({
          ...baseEntry,
          status: "interrupted",
          errorMessage: t("widget.processing.interrupted"),
        });
        return;
      }
      fileProcessingIdRef.current = null;

      const entry: HistoryEntry = {
        ...baseEntry,
        raw: transcription.text,
        cleaned: transcription.text,
        status: "completed",
        errorMessage: undefined,
        processingTime: Date.now() - startedAt,
        mode: transcription.mode,
        speakers: transcription.speakers,
        segments: transcription.segments,
      };

      await finishProcessing(entry);
      setLatestCopyText(getCopyableText(entry));
      setPendingFileResultId(entry.id);
      setFileDropState("success");
      setFileStatus("done");
      setFileProgress(null);
      scheduleFileDropReset();
    } catch (error) {
      if (handle.isCancelled() || isAbortError(error)) {
        // UI was already reset by the stop handler; just record the outcome.
        await finishProcessing({
          ...baseEntry,
          status: "interrupted",
          errorMessage: t("widget.processing.interrupted"),
        });
        return;
      }
      fileProcessingIdRef.current = null;

      logError(
        "WIDGET_FILE",
        `File transcription failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await finishProcessing({
        ...baseEntry,
        status: "failed",
        errorMessage: toFileTranscriptionErrorMessage(error, { settings }),
      });
      setFileDropState("error");
      setFileStatus(null);
      setFileProgress(null);
      setFileDropName(toFileTranscriptionErrorMessage(error, { settings }));
      scheduleFileDropReset();
    } finally {
      handle.finish();
    }
  };

  useEffect(() => {
    let disposed = false;

    const unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
      if (disposed) return;

      if (event.payload.type === "enter") {
        if (!canAcceptFileDrop()) return;
        clearFileDragLeaveTimer();
        clearFileCloseTimer();
        fileDragDepthRef.current += 1;
        clearFileResetTimer();
        setFileDropState("drag-over");
        setFileDropName(t("widget.fileDrop.release"));
        void resizeWidgetForFileDrop(true);
        return;
      }

      if (event.payload.type === "over") {
        if (!canAcceptFileDrop()) return;
        clearFileDragLeaveTimer();
        clearFileCloseTimer();
        fileDragDepthRef.current = Math.max(1, fileDragDepthRef.current);
        setFileDropState("drag-over");
        setFileDropName(t("widget.fileDrop.release"));
        return;
      }

      if (event.payload.type === "leave") {
        fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
        clearFileDragLeaveTimer();
        fileDragLeaveTimerRef.current = window.setTimeout(() => {
          fileDragLeaveTimerRef.current = null;
          if (
            fileDragDepthRef.current === 0 &&
            fileDropStateRef.current === "drag-over"
          ) {
            closeFileDropUi();
          }
        }, FILE_DROP_LEAVE_GRACE_MS);
        return;
      }

      if (event.payload.type !== "drop") {
        return;
      }

      fileDragDepthRef.current = 0;
      clearFileDragLeaveTimer();
      const filePath = event.payload.paths[0];
      if (!filePath) {
        void resetFileDropUi();
        return;
      }

      void fileProcessRef.current(filePath);
    });

    return () => {
      disposed = true;
      clearFileResetTimer();
      clearFileDragLeaveTimer();
      clearFileCloseTimer();
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    const refreshLatestCopyText = async () => {
      try {
        const history = await getHistory();
        if (!mounted) {
          return;
        }

        const latestCompleted = history.find(
          (entry) => getCopyableText(entry) !== null,
        );
        setLatestCopyText(getCopyableText(latestCompleted));
      } catch (error) {
        logError(
          "WIDGET",
          `Failed to load latest history entry: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    void refreshLatestCopyText();

    const unlistenUpdatedPromise = listen<HistoryEntry>(
      HISTORY_UPDATED_EVENT,
      ({ payload }) => {
        const text = getCopyableText(payload);
        if (text) {
          setLatestCopyText(text);
        }
      },
    );
    const unlistenDeletedPromise = listen<{ id: string }>(
      HISTORY_DELETED_EVENT,
      () => {
        void refreshLatestCopyText();
      },
    );
    const unlistenClearedPromise = listen(HISTORY_CLEARED_EVENT, () => {
      setLatestCopyText(null);
    });
    const unlistenSettingsPromise = listen(SETTINGS_UPDATED_EVENT, () => {
      void refreshLatestCopyText();
    });

    return () => {
      mounted = false;
      void unlistenUpdatedPromise.then((unlisten) => unlisten());
      void unlistenDeletedPromise.then((unlisten) => unlisten());
      void unlistenClearedPromise.then((unlisten) => unlisten());
      void unlistenSettingsPromise.then((unlisten) => unlisten());
    };
  }, []);

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    dragStartRef.current = { x: event.clientX, y: event.clientY };
    dragTriggeredRef.current = false;
  };

  const handleDragPointerMove = async (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (
      !dragStartRef.current ||
      dragTriggeredRef.current ||
      (event.buttons & 1) === 0
    ) {
      return;
    }

    const deltaX = Math.abs(event.clientX - dragStartRef.current.x);
    const deltaY = Math.abs(event.clientY - dragStartRef.current.y);

    if (deltaX < 4 && deltaY < 4) {
      return;
    }

    dragTriggeredRef.current = true;

    try {
      await widgetWindow.startDragging();
    } catch {
      dragTriggeredRef.current = false;
    }
  };

  const handleDragPointerUp = () => {
    window.setTimeout(() => {
      dragStartRef.current = null;
      dragTriggeredRef.current = false;
    }, 0);
  };

  const openLatestFileResult = async () => {
    if (dragTriggeredRef.current) {
      return;
    }

    if (pendingFileResultId) {
      await invoke("open_settings_tab", {
        tab: "file",
        resultId: pendingFileResultId,
      });
      setPendingFileResultId(null);
      return;
    }

    await invoke("open_settings");
  };

  const fileDropActive = fileDropState !== "idle";
  const liveTranslationVisible = translationSettings.liveWidgetEnabled;
  const stackWidth = widgetStackWidth(fileDropActive, liveTranslationVisible);
  const stackHeight = widgetStackHeight(fileDropActive);
  const scaledStackWidth = scaleWidgetDimension(stackWidth, widgetScale);
  const scaledStackHeight = scaleWidgetDimension(stackHeight, widgetScale);
  const displayCallState: WidgetCallState =
    retryProcessingSource === "call" && callState === "idle"
      ? "processing"
      : callState;
  const displayWidgetState =
    retryProcessingSource === "voice" && state === "idle" && !fileDropActive
      ? "processing"
      : state;
  const callBubbleDisabled =
    displayCallState === "idle" &&
    (displayWidgetState !== "idle" ||
      fileDropActive ||
      liveTranslationState !== "idle");
  const liveTranslationBubbleDisabled =
    liveTranslationState === "starting" ||
    liveTranslationState === "stopping" ||
    (liveTranslationState === "idle" &&
      (displayWidgetState !== "idle" ||
        fileDropActive ||
        displayCallState !== "idle"));

  useEffect(() => {
    void resizeWidget(
      widgetStackWidth(
        fileDropStateRef.current !== "idle",
        translationSettings.liveWidgetEnabled,
      ),
      widgetStackHeight(fileDropStateRef.current !== "idle"),
    ).catch((error) => {
      logError(
        "TRANSLATION",
        `Resize after translation visibility change failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, [resizeWidget, translationSettings.liveWidgetEnabled]);

  const startLiveTranslation = async (): Promise<void> => {
    if (
      stateRef.current !== "idle" ||
      callStateRef.current !== "idle" ||
      fileDropStateRef.current !== "idle" ||
      liveTranslationStateRef.current !== "idle"
    ) {
      return;
    }
    clearLiveAudioWatchdog();
    updateLiveTranslationState("starting");
    try {
      const settings = await getSettings({ reload: true });
      const connection = resolveLiveTranslationConnection(settings);
      if (
        requiresSystemAudioPermission() &&
        !callSystemAudioPermissionReadyRef.current
      ) {
        await requestSystemAudioPermission();
        callSystemAudioPermissionReadyRef.current = true;
      }
      let micLabel: string | null = null;
      if (
        settings.translation.liveMicrophoneEnabled ||
        settings.saveRecordingAudio
      ) {
        const devices = await navigator.mediaDevices
          .enumerateDevices()
          .catch(() => []);
        micLabel =
          devices.find(
            (device) =>
              device.kind === "audioinput" &&
              device.deviceId === settings.micId,
          )?.label || null;
      }
      const session = await invoke<{ sessionId: string; startedAt: string }>(
        "start_live_translation",
        {
          req: {
            provider: connection.provider,
            apiKey: connection.apiKey,
            model: connection.model,
            endpoint: connection.endpoint,
            targetLanguage: settings.translation.liveTargetLanguage,
            voiceEnabled:
              isMacPlatform() &&
              settings.translation.liveVoiceEnabled &&
              connection.supportsVoice,
            voice: settings.translation.liveVoice,
            voiceVolume: settings.translation.liveVoiceVolume,
            voiceSpeed: settings.translation.liveVoiceSpeed,
            muteOriginal:
              isMacPlatform() &&
              settings.translation.liveVoiceEnabled &&
              settings.translation.liveMuteOriginalEnabled,
            includeMicrophone: settings.translation.liveMicrophoneEnabled,
            micDeviceLabel: micLabel,
            saveAudio: settings.saveRecordingAudio,
            storageDir: settings.transcriptionStorageDir || null,
          },
        },
      );
      liveAdapterIdRef.current = connection.adapterId;
      liveStartedAtRef.current = Date.now();
      let overlay = createLiveTranslationOverlayState(session.sessionId);
      for (const event of pendingLiveEventsRef.current) {
        overlay = applyLiveTranslationEvent(overlay, event);
      }
      pendingLiveEventsRef.current = [];
      liveOverlayRef.current = overlay;
      updateLiveTranslationState("recording");
      await liveOverlayRendererRef.current?.renderNow(overlay);
      liveAudioWatchdogTimerRef.current = window.setTimeout(() => {
        liveAudioWatchdogTimerRef.current = null;
        if (liveTranslationStateRef.current !== "recording") return;

        void invoke<{
          maxDbfs: number;
          framesAboveNoiseFloor: number;
          outputFramesWritten: number;
        }>("get_live_translation_audio_level")
          .then((level) => {
            if (liveTranslationStateRef.current !== "recording") return;
            logInfo(
              "LIVE_TRANSLATION",
              `System audio watchdog: max=${level.maxDbfs.toFixed(1)} dBFS, frames_above_noise_floor=${level.framesAboveNoiseFloor}, output_frames=${level.outputFramesWritten}`,
            );
            if (level.framesAboveNoiseFloor > 0) return;

            const message =
              "Системный звук не поступает. Проверьте воспроизведение видео и разрешение Talkis на запись системного звука.";
            logError("LIVE_TRANSLATION", message);
            liveOverlayRef.current = null;
            pendingLiveEventsRef.current = [];
            showCallNotice(message);
            void stopLiveTranslationRef.current();
          })
          .catch((error) => {
            logError(
              "LIVE_TRANSLATION",
              `System audio watchdog failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }, 8_000);
    } catch (error) {
      clearLiveAudioWatchdog();
      const message = error instanceof Error ? error.message : String(error);
      pendingLiveEventsRef.current = [];
      logError("LIVE_TRANSLATION", `Failed to start: ${message}`);
      updateLiveTranslationState("error");
      showCallNotice(message);
      window.setTimeout(() => updateLiveTranslationState("idle"), 2200);
    }
  };

  const stopLiveTranslation = async (): Promise<void> => {
    if (liveTranslationStateRef.current !== "recording") return;
    clearLiveAudioWatchdog();
    updateLiveTranslationState("stopping");
    try {
      const settings = await getSettings({ reload: true });
      const result = await invoke<{
        sessionId: string;
        callCapture: CallCaptureSession;
      }>("stop_live_translation");
      const overlay = liveOverlayRef.current;
      if (overlay && overlay.sessionId === result.sessionId) {
        const entry = buildLiveTranslationHistoryEntry({
          state: overlay,
          adapterId: liveAdapterIdRef.current,
          targetLanguage: settings.translation.liveTargetLanguage,
          startedAt: liveStartedAtRef.current || Date.now(),
          callTracks: settings.saveRecordingAudio
            ? result.callCapture.tracks.map((track) => ({
                kind: track.kind,
                label: track.label,
                path: track.path,
              }))
            : undefined,
        });
        await addHistoryEntry(entry);
        await emit(HISTORY_UPDATED_EVENT, entry);
        setLatestCopyText(entry.cleaned || entry.raw || null);
      }
      liveOverlayRef.current = null;
      liveAdapterIdRef.current = "unknown";
      pendingLiveEventsRef.current = [];
      liveOverlayRendererRef.current?.cancel();
      await liveOverlayRendererRef.current
        ?.runAfterPending(() => invoke("hide_widget_text_overlay"))
        .catch(() => {});
      updateLiveTranslationState("idle");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("LIVE_TRANSLATION", `Failed to stop: ${message}`);
      if (liveOverlayRef.current) {
        liveOverlayRef.current = { ...liveOverlayRef.current, error: message };
      }
      updateLiveTranslationState("error");
      showCallNotice(message);
      window.setTimeout(() => updateLiveTranslationState("idle"), 2200);
    }
  };
  stopLiveTranslationRef.current = stopLiveTranslation;

  const handleLiveTranslationBubbleClick = (): void => {
    if (dragTriggeredRef.current) return;
    if (liveTranslationState === "recording") {
      void stopLiveTranslation();
    } else if (liveTranslationState === "idle") {
      void startLiveTranslation();
    }
  };
  const handleCallBubbleClick = () => {
    if (dragTriggeredRef.current) {
      return;
    }

    if (callState === "recording") {
      void stopCallListening();
      return;
    }

    if (displayCallState !== "idle") {
      return;
    }

    if (!callBubbleDisabled && callState === "idle") {
      void startCallListening();
    }
  };
  const rememberPasteTargetWindow = useCallback(() => {
    invoke("remember_paste_target_window").catch((error) => {
      logError("PASTE", `Failed to remember paste target window: ${error}`);
    });
  }, []);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "transparent",
        overflow: "visible",
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: scaledStackWidth,
          height: scaledStackHeight,
          display: "grid",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            width: stackWidth,
            height: stackHeight,
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: WIDGET_CONTROL_GAP,
            pointerEvents: "none",
            zoom: widgetScale,
          }}
        >
          {fileDropActive && (
            <FileDropPill
              state={fileDropState}
              fileName={fileDropName}
              status={fileStatus}
              progress={fileProgress}
              onOpenResult={openLatestFileResult}
              onPointerDown={handleDragPointerDown}
              onPointerMove={handleDragPointerMove}
              onPointerUp={handleDragPointerUp}
              onPointerCancel={handleDragPointerUp}
            />
          )}
          {!fileDropActive && (
            <div
              style={{
                marginInlineEnd: -WIDGET_PRIMARY_INLINE_INSET,
                pointerEvents: "none",
              }}
            >
              {displayWidgetState === "idle" && (
                <IdlePill
                  latestCopyText={latestCopyText}
                  onToggleRecording={toggleManualRecording}
                  onClick={openLatestFileResult}
                  onRememberPasteTarget={rememberPasteTargetWindow}
                  onPointerDown={handleDragPointerDown}
                  onPointerMove={handleDragPointerMove}
                  onPointerUp={handleDragPointerUp}
                  onPointerCancel={handleDragPointerUp}
                />
              )}
              {displayWidgetState === "recording" && (
                <RecordingPill
                  stream={stream}
                  locked={lockedRecording}
                  onToggleRecording={toggleManualRecording}
                  onPointerDown={handleDragPointerDown}
                  onPointerMove={handleDragPointerMove}
                  onPointerUp={handleDragPointerUp}
                  onPointerCancel={handleDragPointerUp}
                />
              )}
              {displayWidgetState === "processing" && (
                <ProcessingPill
                  onPointerDown={handleDragPointerDown}
                  onPointerMove={handleDragPointerMove}
                  onPointerUp={handleDragPointerUp}
                  onPointerCancel={handleDragPointerUp}
                />
              )}
            </div>
          )}
          <div
            style={{
              pointerEvents: "none",
            }}
          >
            <CallBubble
              state={displayCallState}
              error={callError}
              disabled={callBubbleDisabled}
              onClick={handleCallBubbleClick}
              onPointerDown={handleDragPointerDown}
              onPointerMove={handleDragPointerMove}
              onPointerUp={handleDragPointerUp}
              onPointerCancel={handleDragPointerUp}
            />
          </div>
          {liveTranslationVisible && (
            <div style={{ pointerEvents: "none" }}>
              <LiveTranslationBubble
                state={liveTranslationState}
                disabled={liveTranslationBubbleDisabled}
                onClick={handleLiveTranslationBubbleClick}
                onPointerDown={handleDragPointerDown}
                onPointerMove={handleDragPointerMove}
                onPointerUp={handleDragPointerUp}
                onPointerCancel={handleDragPointerUp}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileDropPill({
  state,
  status,
  progress,
  onOpenResult,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: DragHandlers & {
  state: WidgetFileDropState;
  fileName: string;
  status: FileTranscriptionStatus | null;
  progress: FileTranscriptionProgress | null;
  onOpenResult: () => void;
}) {
  const { t } = useI18n();
  const isProcessing = state === "processing";
  const isSuccess = state === "success";
  const isError = state === "error";
  const isClosing = state === "closing";
  const progressPercent = getFileTranscriptionPercent(
    isSuccess ? "done" : isError ? "error" : (status ?? "idle"),
    progress,
  );
  const showPercent = isProcessing && progressPercent > 0;

  return (
    <ActiveWidgetShell
      width={FILE_DROP_WIDGET_WIDTH}
      height={FILE_DROP_WIDGET_HEIGHT}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      cursor={isSuccess ? "pointer" : "grab"}
      onClick={() => {
        if (isSuccess) {
          onOpenResult();
        }
      }}
    >
      <div
        style={{
          width: FILE_DROP_WIDGET_WIDTH,
          height: FILE_DROP_WIDGET_HEIGHT,
          borderRadius: 18,
          background: isError ? "rgba(42, 9, 9, 0.98)" : "rgba(5, 5, 5, 0.98)",
          border: "1.5px dashed rgba(255,255,255,0.34)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: "0 18px",
          boxShadow: "none",
          WebkitFontSmoothing: "antialiased",
          opacity: isClosing ? 0 : 1,
          transform: isClosing ? "scale(0.94)" : "scale(1)",
          transformOrigin: "center center",
          transition:
            "opacity 0.16s ease, transform 0.16s cubic-bezier(0.22, 1, 0.36, 1)",
          animation: isClosing
            ? undefined
            : "widget-file-drop-in 0.18s cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            display: "grid",
            placeItems: "center",
            color: isError ? "#ff8f8f" : "rgba(255,255,255,0.86)",
            background: "rgba(255,255,255,0.08)",
          }}
        >
          {isProcessing ? (
            <IconLoader2 className="loading-soft-icon" size={20} stroke={2} />
          ) : isSuccess ? (
            <IconCheck size={20} stroke={2.4} />
          ) : (
            <IconFileMusic size={20} stroke={2} />
          )}
        </span>
        <span
          style={{
            minWidth: 0,
            overflow: "visible",
            whiteSpace: "nowrap",
            fontSize: 14,
            lineHeight: 1.2,
            fontWeight: 750,
            color: isError ? "#ffb4b4" : "rgba(255,255,255,0.94)",
          }}
        >
          {showPercent
            ? t("widget.fileDrop.transcribingPercent", {
                percent: progressPercent,
              })
            : t("widget.fileDrop.transcribing")}
        </span>
      </div>
    </ActiveWidgetShell>
  );
}

function CallBubble({
  state,
  error,
  disabled,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: DragHandlers & {
  state: WidgetCallState;
  error: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const isStarting = state === "starting";
  const isRecording = state === "recording";
  const isProcessing = state === "processing";
  const isSuccess = state === "success";
  const isError = state === "error";
  const copyIconColor = "rgba(255,255,255,0.72)";
  const title = isError
    ? error || t("widget.callBubble.error")
    : isStarting
      ? t("widget.callBubble.requestingAccess")
      : isProcessing
        ? t("widget.callBubble.transcribing")
        : isSuccess
          ? t("widget.callBubble.ready")
          : isRecording
            ? t("widget.callBubble.stopAndTranscribe")
            : t("widget.callBubble.record");
  const iconColor = disabled
    ? "rgba(255,255,255,0.28)"
    : isRecording || isError
      ? "#ff4d4d"
      : isSuccess
        ? "#fff"
        : copyIconColor;
  const background = "#050505";
  const iconSize = 12;

  return (
    <ActiveWidgetShell
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      cursor={disabled ? "grab" : "pointer"}
      width={CALL_BUBBLE_SIZE}
      height={CALL_BUBBLE_SIZE}
    >
      <div
        aria-label={title}
        title={title}
        role="button"
        style={{
          width: CALL_BUBBLE_SIZE,
          height: CALL_BUBBLE_SIZE,
          borderRadius: 999,
          background,
          border: "none",
          color: iconColor,
          display: "grid",
          placeItems: "center",
          boxShadow: "none",
          opacity: disabled ? 0.72 : 1,
          transform: isRecording ? "scale(1.02)" : "scale(1)",
          transition:
            "background 0.16s ease, border-color 0.16s ease, color 0.16s ease, opacity 0.16s ease, transform 0.16s ease",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        {isStarting || isProcessing ? (
          <IconLoader2
            className="loading-soft-icon"
            size={iconSize}
            stroke={2.2}
          />
        ) : isSuccess ? (
          <IconCheck size={iconSize} stroke={2.6} />
        ) : isError ? (
          <span
            style={{
              fontSize: 12,
              fontWeight: 800,
              lineHeight: 1,
            }}
          >
            !
          </span>
        ) : (
          <IconPhoneCall size={iconSize} stroke={isRecording ? 2.4 : 2} />
        )}
      </div>
    </ActiveWidgetShell>
  );
}

function LiveTranslationBubble({
  state,
  disabled,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: DragHandlers & {
  state: WidgetLiveTranslationState;
  disabled: boolean;
  onClick: () => void;
}) {
  const isActive = state === "recording";
  const isBusy = state === "starting" || state === "stopping";
  const title = isActive
    ? "Остановить синхронный перевод"
    : isBusy
      ? "Подключаем синхронный перевод"
      : "Начать синхронный перевод";

  return (
    <ActiveWidgetShell
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      cursor={disabled ? "grab" : "pointer"}
      width={CALL_BUBBLE_SIZE}
      height={CALL_BUBBLE_SIZE}
    >
      <div
        role="button"
        aria-label={title}
        aria-pressed={isActive}
        aria-disabled={disabled}
        title={title}
        style={{
          width: CALL_BUBBLE_SIZE,
          height: CALL_BUBBLE_SIZE,
          borderRadius: 999,
          background: "#050505",
          color: disabled
            ? "rgba(255,255,255,0.28)"
            : isActive
              ? "#ff4d4d"
              : "rgba(255,255,255,0.72)",
          display: "grid",
          placeItems: "center",
          opacity: disabled ? 0.72 : 1,
        }}
      >
        {isBusy ? (
          <IconLoader2 className="loading-soft-icon" size={12} stroke={2.2} />
        ) : (
          <IconLanguage size={12} stroke={isActive ? 2.5 : 2} />
        )}
      </div>
    </ActiveWidgetShell>
  );
}

interface DragHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

function IdlePill({
  latestCopyText,
  onToggleRecording,
  onClick,
  onRememberPasteTarget,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: DragHandlers & {
  latestCopyText: string | null;
  onToggleRecording: () => void;
  onClick: () => void;
  onRememberPasteTarget: () => void;
}) {
  const { t } = useI18n();
  const widgetWindow = getCurrentWindow();
  const [isHovered, setIsHovered] = useState(false);
  const [copySucceeded, setCopySucceeded] = useState(false);
  const canCopy = Boolean(latestCopyText);
  const controlsVisible = isHovered;

  useEffect(() => {
    let disposed = false;
    const enterMarginPx = 8;
    const leaveMarginPx = 16;

    const updateHoverState = async (): Promise<void> => {
      const [cursor, position, size] = await Promise.all([
        cursorPosition(),
        widgetWindow.outerPosition(),
        widgetWindow.outerSize(),
      ]);

      if (disposed) {
        return;
      }

      const margin = isHovered ? leaveMarginPx : enterMarginPx;
      const hovered =
        cursor.x >= position.x - margin &&
        cursor.x <= position.x + size.width + margin &&
        cursor.y >= position.y - margin &&
        cursor.y <= position.y + size.height + margin;

      setIsHovered(hovered);
    };

    const stopPolling = startRecoveringPoll(updateHoverState, {
      intervalMs: 80,
      onError: (error): void => {
        void logError(
          "WIDGET",
          `Widget hover polling paused: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
      onRecovery: (): void => {
        void logInfo("WIDGET", "Widget hover polling recovered");
      },
    });

    return () => {
      disposed = true;
      stopPolling();
    };
  }, [isHovered, widgetWindow]);

  const copyLatestText = async () => {
    if (!latestCopyText) {
      return;
    }

    await writeText(latestCopyText);
    setCopySucceeded(true);
    window.setTimeout(() => {
      setCopySucceeded(false);
    }, 1400);
  };

  return (
    <ActiveWidgetShell
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerEnter={() => {
        onRememberPasteTarget();
        setIsHovered(true);
      }}
      onPointerLeave={() => setIsHovered(false)}
      width={IDLE_HOVER_WIDGET_WIDTH}
      height={IDLE_HOVER_WIDGET_HEIGHT}
      cursor="pointer"
      onClick={() => {
        void onClick();
      }}
    >
      <WidgetCoreShell
        width={WIDGET_SHELL_WIDTH}
        height={WIDGET_SHELL_HEIGHT}
        scale={isHovered ? IDLE_HOVER_SCALE : 1}
      >
        <FlowRecordingWidget state="idle" controlsVisible={controlsVisible} />
      </WidgetCoreShell>
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
        }}
      >
        <WidgetRecordButton
          label={t("widget.idle.startRecording")}
          left={WIDGET_RECORD_BUTTON_LEFT}
          visible={controlsVisible}
          onActivate={onToggleRecording}
        />
        {canCopy && (
          <button
            type="button"
            aria-label={t("widget.idle.copyLatest")}
            title={
              copySucceeded ? t("widget.idle.copied") : t("widget.idle.copy")
            }
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              void copyLatestText();
            }}
            style={{
              position: "absolute",
              right: 10,
              top: "50%",
              width: 12,
              height: 12,
              minWidth: 12,
              border: "none",
              borderRadius: 999,
              padding: 0,
              background: "transparent",
              color: "rgba(255,255,255,0.72)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: controlsVisible ? 1 : 0,
              transform: controlsVisible
                ? "translateY(-50%) scale(1)"
                : "translateY(-50%) scale(0.84)",
              transition:
                "opacity 0.14s ease, transform 0.14s ease, background 0.14s ease, color 0.14s ease",
              pointerEvents: controlsVisible ? "auto" : "none",
              cursor: "pointer",
              WebkitFontSmoothing: "antialiased",
            }}
          >
            {copySucceeded ? (
              <IconCheck size={12} stroke={2.4} />
            ) : (
              <IconCopy size={12} stroke={2} />
            )}
          </button>
        )}
      </div>
    </ActiveWidgetShell>
  );
}

function WidgetCoreShell({
  children,
  width = "100%",
  height = "100%",
  scale = 1,
}: {
  children?: ReactNode;
  width?: number | string;
  height?: number | string;
  scale?: number;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 999,
        background: "transparent",
        border: "none",
        boxShadow: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "visible",
        transform: `scale(${scale})`,
        transformOrigin: "center center",
        transition: "transform 0.18s cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      {children}
    </div>
  );
}

interface RecordingPillProps {
  stream: MediaStream | null;
  locked: boolean;
  onToggleRecording: () => void;
}

function FlowRecordingWidget({
  state,
  stream = null,
  controlsVisible = false,
  longMark = "record",
}: {
  state: "idle" | "recording" | "processing" | "long";
  stream?: MediaStream | null;
  controlsVisible?: boolean;
  longMark?: "record" | "phone" | "success" | "error";
}) {
  const showWave = state !== "idle";
  const widgetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!stream || (state !== "recording" && state !== "long")) {
      widgetRef.current?.style.setProperty("--widget-wave-scale", "1");
      widgetRef.current?.style.setProperty("--widget-wave-opacity", "1");
      return;
    }

    const audioContext = new AudioContext({ latencyHint: "interactive" });
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.32;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.fftSize);
    let animationFrame = 0;
    let smoothedLevel = 0;

    const draw = () => {
      animationFrame = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);

      let sumSquares = 0;
      for (let index = 0; index < dataArray.length; index += 1) {
        const normalized = (dataArray[index] - 128) / 128;
        sumSquares += normalized * normalized;
      }

      const rms = Math.sqrt(sumSquares / dataArray.length);
      const boostedLevel = Math.pow(Math.min(1, rms * 15), 0.58);
      const quietFloor = rms > 0.003 ? 0.1 : 0.025;
      smoothedLevel =
        smoothedLevel * 0.48 + Math.max(quietFloor, boostedLevel) * 0.52;

      widgetRef.current?.style.setProperty(
        "--widget-wave-scale",
        String(1 + smoothedLevel * 0.42),
      );
      widgetRef.current?.style.setProperty(
        "--widget-wave-opacity",
        String(0.82 + smoothedLevel * 0.18),
      );
    };

    void audioContext.resume().catch(() => {});
    draw();

    return () => {
      cancelAnimationFrame(animationFrame);
      source.disconnect();
      void audioContext.close();
    };
  }, [state, stream]);

  return (
    <div
      ref={widgetRef}
      className={`flow-recording-widget is-${state}${controlsVisible ? " is-controls-visible" : ""}`}
      aria-hidden="true"
    >
      {state === "idle" && (
        <div className="flow-widget-idle">
          <span />
          <span />
        </div>
      )}
      {showWave && (
        <svg viewBox="0 0 190 34" preserveAspectRatio="none">
          {WIDGET_WAVES.map((wave) => (
            <path
              key={wave.className}
              className={`widget-wave-line ${wave.className}`}
              d={wave.values[0]}
            >
              <animate
                attributeName="d"
                dur={wave.dur}
                values={wave.values.join("; ")}
                keyTimes="0; 0.5; 1"
                calcMode="spline"
                keySplines="0.45 0 0.55 1; 0.45 0 0.55 1"
                repeatCount="indefinite"
              />
            </path>
          ))}
        </svg>
      )}
      {state === "long" && (
        <span className={`flow-widget-long-mark is-${longMark}`}>
          {longMark === "phone" && <IconPhoneCall size={9} stroke={2.2} />}
          {longMark === "success" && <IconCheck size={9} stroke={2.6} />}
          {longMark === "error" && "!"}
        </span>
      )}
    </div>
  );
}

function ActiveWidgetShell({
  children,
  width = WIDGET_SHELL_WIDTH,
  height = WIDGET_SHELL_HEIGHT,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerEnter,
  onPointerLeave,
  onClick,
  cursor = "grab",
}: {
  children: ReactNode;
  width?: number;
  height?: number;
  onClick?: () => void;
  cursor?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
} & DragHandlers) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 999,
        background: "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        pointerEvents: "auto",
        transformOrigin: "center center",
        transition: "transform 0.18s ease",
        overflow: "visible",
        cursor,
      }}
      onClick={() => {
        onClick?.();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        void onPointerMove(event);
      }}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>
  );
}

function RecordingPill({
  stream,
  locked,
  onToggleRecording,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: RecordingPillProps & DragHandlers) {
  const { t } = useI18n();
  return (
    <ActiveWidgetShell
      width={IDLE_HOVER_WIDGET_WIDTH}
      height={IDLE_HOVER_WIDGET_HEIGHT}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <WidgetCoreShell
        width={ACTIVE_WIDGET_SHELL_WIDTH}
        height={ACTIVE_WIDGET_SHELL_HEIGHT}
      >
        <FlowRecordingWidget
          state={locked ? "long" : "recording"}
          stream={stream}
        />
      </WidgetCoreShell>
      {locked && (
        <button
          type="button"
          aria-label={t("widget.recording.stopRecording")}
          title={t("widget.recording.stopRecording")}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onToggleRecording();
          }}
          style={{
            position: "absolute",
            top: "50%",
            left: WIDGET_RECORD_BUTTON_LEFT,
            width: 12,
            height: 12,
            border: "none",
            borderRadius: 999,
            padding: 0,
            background: "transparent",
            transform: "translateY(-50%)",
            pointerEvents: "auto",
            cursor: "pointer",
          }}
        />
      )}
    </ActiveWidgetShell>
  );
}

function ProcessingPill({
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: DragHandlers) {
  return (
    <ActiveWidgetShell
      width={IDLE_HOVER_WIDGET_WIDTH}
      height={IDLE_HOVER_WIDGET_HEIGHT}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <WidgetCoreShell
        width={ACTIVE_WIDGET_SHELL_WIDTH}
        height={ACTIVE_WIDGET_SHELL_HEIGHT}
      >
        <FlowRecordingWidget state="processing" />
      </WidgetCoreShell>
    </ActiveWidgetShell>
  );
}
