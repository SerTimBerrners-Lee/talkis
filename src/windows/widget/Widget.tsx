import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy, FileAudio, Loader2, PhoneCall } from "lucide-react";

import {
  HISTORY_CLEARED_EVENT,
  HISTORY_DELETED_EVENT,
  HISTORY_UPDATED_EVENT,
  WIDGET_RETRY_PROCESSING_EVENT,
  type WidgetRetryProcessingPayload,
} from "../../lib/hotkeyEvents";
import {
  addHistoryEntry,
  getHistory,
  getSettings,
  type HistoryEntry,
} from "../../lib/store";
import {
  fileNameFromPath,
  type FileTranscriptionProgress,
  type FileTranscriptionStatus,
  getFileTranscriptionPercent,
  toFileTranscriptionErrorMessage,
  transcribeFilePathOnly,
} from "../../lib/fileTranscription";
import { logError, logInfo } from "../../lib/logger";
import { startAppUpdateScheduler } from "../../lib/updater";
import { scaleWidgetDimension } from "../../lib/widgetScale";
import {
  saveFailedCallCaptureEntry,
  saveCallCaptureMicTrack,
  startCallCapture,
  stopCallCapture,
  transcribeCallCaptureSession,
  type CallCaptureSession,
} from "../../lib/callCapture";
import { useWidgetController } from "./hooks/useWidgetController";
import { createRecordingRuntimeController } from "./services/recordingRuntime";
import {
  ACTIVE_WIDGET_SHELL_HEIGHT,
  ACTIVE_WIDGET_SHELL_WIDTH,
  CALL_BUBBLE_GAP,
  CALL_BUBBLE_SIZE,
  CALL_STACK_WIDGET_HEIGHT,
  CALL_STACK_WIDGET_WIDTH,
  FILE_DROP_STACK_WIDGET_HEIGHT,
  FILE_DROP_STACK_WIDGET_WIDTH,
  FILE_DROP_WIDGET_HEIGHT,
  FILE_DROP_WIDGET_WIDTH,
  IDLE_HOVER_WIDGET_HEIGHT,
  IDLE_HOVER_WIDGET_WIDTH,
  IDLE_HOVER_SCALE,
  WIDGET_SHELL_HEIGHT,
  WIDGET_SHELL_WIDTH,
} from "./widgetConstants";

const WIDGET_RECORD_BUTTON_LEFT = 10;
const FILE_DROP_LEAVE_GRACE_MS = 260;
const FILE_DROP_CLOSE_ANIMATION_MS = 160;
type WidgetFileDropState =
  | "idle"
  | "drag-over"
  | "processing"
  | "success"
  | "error"
  | "closing";
type WidgetCallState =
  | "idle"
  | "recording"
  | "processing"
  | "success"
  | "error";
type WidgetRetryProcessingSource = WidgetRetryProcessingPayload["source"];

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

export function Widget() {
  const widgetWindow = getCurrentWindow();
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragTriggeredRef = useRef(false);
  const callMicRuntimeRef = useRef(createRecordingRuntimeController());
  const callMicPausedForVoiceRef = useRef(false);
  const callStateRef = useRef<WidgetCallState>("idle");
  const pauseCallMicForVoice = useCallback(() => {
    if (callStateRef.current !== "recording") {
      return;
    }

    callMicPausedForVoiceRef.current = true;
    if (callMicRuntimeRef.current.pause()) {
      logInfo("CALL_CAPTURE", "Paused call mic while voice recording");
    }
  }, []);
  const resumeCallMicForVoice = useCallback(() => {
    if (!callMicPausedForVoiceRef.current) {
      return;
    }

    callMicPausedForVoiceRef.current = false;
    if (callMicRuntimeRef.current.resume()) {
      logInfo("CALL_CAPTURE", "Resumed call mic after voice recording");
    }
  }, []);
  const { state, stream, lockedRecording, widgetScale, resizeWidget, toggleManualRecording } =
    useWidgetController({
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
  const [retryProcessingSource, setRetryProcessingSource] =
    useState<WidgetRetryProcessingSource | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    fileDropStateRef.current = fileDropState;
  }, [fileDropState]);

  useEffect(() => {
    retryProcessingSourceRef.current = retryProcessingSource;
  }, [retryProcessingSource]);

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
      active ? FILE_DROP_STACK_WIDGET_WIDTH : CALL_STACK_WIDGET_WIDTH,
      active ? FILE_DROP_STACK_WIDGET_HEIGHT : CALL_STACK_WIDGET_HEIGHT,
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

    try {
      setCallError("");
      setCallState("recording");
      const settings = await getSettings({ reload: true });
      setCallSettings(settings);

      const micConstraints = settings.micId
        ? { deviceId: { exact: settings.micId } }
        : true;
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints,
      });
      callMicRuntimeRef.current.start(micStream);
      if (callMicPausedForVoiceRef.current) {
        callMicRuntimeRef.current.pause();
      }

      const session = await startCallCapture({
        targetId: "system-output",
        includeMic: false,
        includeSystem: true,
      });
      setCallStartedAt(Date.now());
      setCallSession(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("CALL_CAPTURE", `Call capture start failed: ${message}`);
      callMicRuntimeRef.current.dispose();
      callMicPausedForVoiceRef.current = false;
      setCallError(message);
      setCallState("error");
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
      await callMicRuntimeRef.current.stop();
      const micBlob = callMicRuntimeRef.current.hasAudioChunks()
        ? await callMicRuntimeRef.current.getAudioBlob()
        : null;
      const micFileName = micBlob?.type.includes("wav") ? "call-mic.wav" : "call-mic.webm";
      const micFile = micBlob
        ? new File([micBlob], micFileName, {
            type: micBlob.type || "audio/webm",
          })
        : null;
      let micFileForTranscription = micFile;
      if (micBlob) {
        try {
          const micTrack = await saveCallCaptureMicTrack(callSession.id, micBlob);
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
      const settings = callSettings ?? (await getSettings({ reload: true }));
      const entry = await transcribeCallCaptureSession({
        session: stoppedSession,
        settings,
        micFile: micFileForTranscription,
        startedAt: callStartedAt,
        onStatus: setFileStatus,
        onProgress: setFileProgress,
      });
      callMicRuntimeRef.current.reset();
      callMicPausedForVoiceRef.current = false;
      setLatestCopyText(getCopyableText(entry));
      setCallSession(null);
      setCallSettings(null);
      setCallState("success");
      setFileStatus("done");
      setFileProgress(null);
      window.setTimeout(() => {
        setCallState("idle");
      }, 1800);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("CALL_CAPTURE", `Call capture stop/process failed: ${message}`);
      const userFacingMessage =
        "Не удалось обработать запись. Попробуйте повторить попытку.";

      try {
        await saveFailedCallCaptureEntry({
          session: stoppedSession ?? sessionForFailure,
          errorMessage: userFacingMessage,
          startedAt: callStartedAt,
        });
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
      callMicPausedForVoiceRef.current = false;
      setCallError("");
      setCallState("idle");
      setFileStatus(null);
      setFileProgress(null);
      setCallSession(null);
      setCallSettings(null);
    }
  };

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

    try {
      const settings = await getSettings({ reload: true });
      const startedAt = Date.now();
      const transcription = await transcribeFilePathOnly({
        filePath,
        settings,
        onStatus: setFileStatus,
        onProgress: setFileProgress,
        speakerDiarization: settings.fileSpeakerDiarization === true,
      });
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        duration: 0,
        raw: transcription.text,
        cleaned: transcription.text,
        source: "file",
        fileName,
        status: "completed",
        processingTime: Date.now() - startedAt,
        mode: transcription.mode,
        speakers: transcription.speakers,
        segments: transcription.segments,
      };

      await addHistoryEntry(entry);
      await emit(HISTORY_UPDATED_EVENT, entry);
      setLatestCopyText(getCopyableText(entry));
      setPendingFileResultId(entry.id);
      setFileDropState("success");
      setFileStatus("done");
      setFileProgress(null);
      scheduleFileDropReset();
    } catch (error) {
      logError(
        "WIDGET_FILE",
        `File transcription failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      setFileDropState("error");
      setFileStatus(null);
      setFileProgress(null);
      setFileDropName(toFileTranscriptionErrorMessage(error));
      scheduleFileDropReset();
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
        setFileDropName("Отпустите файл");
        void resizeWidgetForFileDrop(true);
        return;
      }

      if (event.payload.type === "over") {
        if (!canAcceptFileDrop()) return;
        clearFileDragLeaveTimer();
        clearFileCloseTimer();
        fileDragDepthRef.current = Math.max(1, fileDragDepthRef.current);
        setFileDropState("drag-over");
        setFileDropName("Отпустите файл");
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

    return () => {
      mounted = false;
      void unlistenUpdatedPromise.then((unlisten) => unlisten());
      void unlistenDeletedPromise.then((unlisten) => unlisten());
      void unlistenClearedPromise.then((unlisten) => unlisten());
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
  const stackWidth = fileDropActive
    ? FILE_DROP_STACK_WIDGET_WIDTH
    : CALL_STACK_WIDGET_WIDTH;
  const stackHeight = fileDropActive
    ? FILE_DROP_STACK_WIDGET_HEIGHT
    : CALL_STACK_WIDGET_HEIGHT;
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
    (displayWidgetState !== "idle" || fileDropActive);
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
            gap: CALL_BUBBLE_GAP,
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
          {!fileDropActive && displayWidgetState === "idle" && (
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
          {!fileDropActive && displayWidgetState === "recording" && (
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
          {!fileDropActive && displayWidgetState === "processing" && (
            <ProcessingPill
              onPointerDown={handleDragPointerDown}
              onPointerMove={handleDragPointerMove}
              onPointerUp={handleDragPointerUp}
              onPointerCancel={handleDragPointerUp}
            />
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
            <Loader2
              className="loading-soft-icon"
              size={20}
              strokeWidth={2}
            />
          ) : isSuccess ? (
            <Check size={20} strokeWidth={2.4} />
          ) : (
            <FileAudio size={20} strokeWidth={2} />
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
          {showPercent ? `Транскрибация ${progressPercent}%` : "Транскрибация"}
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
  const isRecording = state === "recording";
  const isProcessing = state === "processing";
  const isSuccess = state === "success";
  const isError = state === "error";
  const copyIconColor = "rgba(255,255,255,0.72)";
  const title = isError
    ? error || "Ошибка созвона"
    : isProcessing
      ? "Транскрибируем разговор"
      : isSuccess
        ? "Созвон готов"
        : isRecording
          ? "Завершить и транскрибировать"
          : "Запись разговора";
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
        {isProcessing ? (
          <Loader2
            className="loading-soft-icon"
            size={iconSize}
            strokeWidth={2.2}
          />
        ) : isSuccess ? (
          <Check size={iconSize} strokeWidth={2.6} />
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
          <PhoneCall size={iconSize} strokeWidth={isRecording ? 2.4 : 2} />
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
  const widgetWindow = getCurrentWindow();
  const [isHovered, setIsHovered] = useState(false);
  const [copySucceeded, setCopySucceeded] = useState(false);
  const canCopy = Boolean(latestCopyText);
  const controlsVisible = isHovered;

  useEffect(() => {
    let disposed = false;
    const enterMarginPx = 8;
    const leaveMarginPx = 16;

    const updateHoverState = async () => {
      try {
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
      } catch (error) {
        logError(
          "WIDGET",
          `Failed to poll widget hover state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    void updateHoverState();
    const interval = window.setInterval(() => {
      void updateHoverState();
    }, 80);

    return () => {
      disposed = true;
      window.clearInterval(interval);
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
        <button
          type="button"
          aria-label="Начать запись"
          title="Начать запись"
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onToggleRecording();
          }}
          style={{
            position: "absolute",
            left: WIDGET_RECORD_BUTTON_LEFT,
            top: "50%",
            width: 12,
            height: 12,
            border: "none",
            borderRadius: 999,
            padding: 0,
            background: "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: controlsVisible ? 1 : 0,
            transform: controlsVisible
              ? "translateY(-50%) scale(1)"
              : "translateY(-50%) scale(0.84)",
            transition: "opacity 0.14s ease, transform 0.14s ease",
            pointerEvents: controlsVisible ? "auto" : "none",
            cursor: "pointer",
            WebkitFontSmoothing: "antialiased",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: "#ff4d4d",
              boxShadow: "none",
            }}
          />
        </button>
        {canCopy && (
          <button
            type="button"
            aria-label="Скопировать последнюю запись"
            title={copySucceeded ? "Скопировано" : "Скопировать"}
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
              <Check size={12} strokeWidth={2.4} />
            ) : (
              <Copy size={12} strokeWidth={2} />
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
          {longMark === "phone" && <PhoneCall size={9} strokeWidth={2.2} />}
          {longMark === "success" && <Check size={9} strokeWidth={2.6} />}
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
          aria-label="Закончить запись"
          title="Закончить запись"
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
