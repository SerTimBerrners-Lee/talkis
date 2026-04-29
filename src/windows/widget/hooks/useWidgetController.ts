import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { AppSettings, getSettings, getWidgetPosition, saveWidgetPosition } from "../../../lib/store";
import { logError, logInfo } from "../../../lib/logger";
import { formatErrorMessage } from "../../../lib/utils";
import { IDLE_WIDGET_HEIGHT, IDLE_WIDGET_WIDTH, WidgetNoticeState, WidgetState } from "../widgetConstants";
import { resolveInitialWidgetPosition } from "../widgetPositioning";
import { useWidgetHotkey } from "./useWidgetHotkey";
import { useWidgetNotice } from "./useWidgetNotice";
import { useWidgetRecording } from "./useWidgetRecording";
import {
  initialWidgetMachineState,
  widgetReducer,
  WidgetAction,
  WidgetEffect,
  WidgetMachineState,
} from "../services/widgetMachine";

interface WidgetControllerState {
  state: WidgetState;
  stream: MediaStream | null;
  notice: WidgetNoticeState | null;
  lockedRecording: boolean;
  toggleManualRecording: () => void;
}

export function useWidgetController(): WidgetControllerState {
  const widgetWindow = getCurrentWindow();

  // ── Centralized machine state ───────────────────────────────────────────
  const machineRef = useRef<WidgetMachineState>(initialWidgetMachineState);

  // React render state (derived from machine)
  const [widgetState, setWidgetState] = useState<WidgetState>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [lockedRecording, setLockedRecording] = useState(false);

  // Settings
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const settingsRef = useRef<AppSettings | null>(null);

  // Imperative refs (truly need ref semantics)
  const registeredHotkeyRef = useRef<string | null>(null);
  const releaseStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moveSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionReadyRef = useRef(false);
  const widgetSizeRef = useRef<{ width: number; height: number }>({
    width: IDLE_WIDGET_WIDTH,
    height: IDLE_WIDGET_HEIGHT,
  });
  const stopAndProcessRef = useRef<() => Promise<void>>(async () => {});

  // ── Dispatch: apply action → update machine state → execute effects ─────
  const dispatch = useCallback((action: WidgetAction) => {
    const { state: nextState, effects } = widgetReducer(machineRef.current, action);
    machineRef.current = nextState;

    // Sync React render state
    setWidgetState(nextState.widgetState);
    setLockedRecording(nextState.lockedRecording);

    // Execute effects (processed in executeEffect below)
    for (const effect of effects) {
      executeEffect(effect);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Effect executor ─────────────────────────────────────────────────────
  const executeEffect = useCallback((effect: WidgetEffect) => {
    switch (effect.type) {
      case "start_recording":
        void startRecordingRef.current();
        break;
      case "stop_and_process":
        void stopAndProcessRef.current();
        break;
      case "schedule_release_stop_timer":
        scheduleReleaseStopTimer();
        break;
      case "clear_release_stop_timer":
        clearReleaseStopTimer();
        break;
      case "resize_widget":
        void resizeWidget(effect.width, effect.height);
        break;
      case "set_stream":
        setStream(effect.stream);
        break;
      case "show_notice":
        showNotice(effect.message, effect.tone);
        break;
      case "set_locked_recording_ui":
        setLockedRecording(effect.value);
        break;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Timer helpers ───────────────────────────────────────────────────────
  const clearReleaseStopTimer = useCallback(() => {
    if (!releaseStopTimerRef.current) return;
    clearTimeout(releaseStopTimerRef.current);
    releaseStopTimerRef.current = null;
  }, []);

  const scheduleReleaseStopTimer = useCallback(() => {
    clearReleaseStopTimer();
    const doubleTapTimeout = settingsRef.current?.doubleTapTimeout ?? 400;
    releaseStopTimerRef.current = setTimeout(() => {
      releaseStopTimerRef.current = null;
      dispatch({ type: "RELEASE_STOP_TIMER_FIRED" });
    }, doubleTapTimeout);
  }, [clearReleaseStopTimer, dispatch]);

  const clearMoveSaveTimer = useCallback(() => {
    if (!moveSaveTimerRef.current) return;
    clearTimeout(moveSaveTimerRef.current);
    moveSaveTimerRef.current = null;
  }, []);

  // ── Settings loading ────────────────────────────────────────────────────
  useEffect(() => {
    logInfo("SETTINGS", "Loading settings...");
    getSettings()
      .then((loadedSettings) => {
        logInfo(
          "SETTINGS",
          `Loaded: apiKey=${loadedSettings.apiKey ? "[set]" : "[empty]"}, hotkey=${loadedSettings.hotkey}`,
        );
        setSettings(loadedSettings);
        settingsRef.current = loadedSettings;
        setSettingsLoaded(true);
      })
      .catch((error) => {
        logError("SETTINGS", `Failed to load: ${error}`);
        setSettingsLoaded(true);
      });
  }, []);

  // ── Position tracking ───────────────────────────────────────────────────
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    widgetWindow
      .onMoved(({ payload }) => {
        if (!positionReadyRef.current) return;
        clearMoveSaveTimer();
        moveSaveTimerRef.current = setTimeout(() => {
          moveSaveTimerRef.current = null;
          void saveWidgetPosition({ x: payload.x, y: payload.y }).catch((error) => {
            if (!disposed) {
              logError("WIDGET", `Failed to save widget position: ${formatErrorMessage(error)}`);
            }
          });
        }, 120);
      })
      .then((removeListener) => {
        if (disposed) {
          removeListener();
          return;
        }
        unlisten = removeListener;
      })
      .catch((error) => {
        if (!disposed) {
          logError("WIDGET", `Failed to track widget movement: ${formatErrorMessage(error)}`);
        }
      });

    return () => {
      disposed = true;
      clearMoveSaveTimer();
      unlisten?.();
    };
  }, [clearMoveSaveTimer, widgetWindow]);

  useEffect(() => {
    let cancelled = false;

    const restoreWidgetPosition = async () => {
      try {
        const savedPosition = await getWidgetPosition();
        const targetPosition = await resolveInitialWidgetPosition(widgetWindow, savedPosition);
        if (!targetPosition || cancelled) return;

        await widgetWindow.setPosition(new PhysicalPosition(targetPosition.x, targetPosition.y));

        if (!savedPosition) {
          await saveWidgetPosition(targetPosition);
        }
      } catch (error) {
        if (!cancelled) {
          logError("WIDGET", `Failed to restore widget position: ${formatErrorMessage(error)}`);
        }
      } finally {
        if (!cancelled) {
          positionReadyRef.current = true;
        }
      }
    };

    void restoreWidgetPosition();
    return () => { cancelled = true; };
  }, [widgetWindow]);

  // ── Widget resize ───────────────────────────────────────────────────────
  const resizeWidget = useCallback(async (width: number, height: number) => {
    try {
      const currentSize = widgetSizeRef.current;

      if (currentSize.width === width && currentSize.height === height) {
        return;
      }

      await invoke("widget_resize", { width, height });
      widgetSizeRef.current = { width, height };
    } catch (error) {
      logError("WIDGET", `Resize failed: ${formatErrorMessage(error)}`);
    }
  }, [widgetWindow]);

  // ── Notice ──────────────────────────────────────────────────────────────
  const machineStateRefForNotice = useRef(machineRef);
  machineStateRefForNotice.current = machineRef;

  const stateRefForNotice = useRef<WidgetState>("idle");
  useEffect(() => {
    stateRefForNotice.current = widgetState;
  }, [widgetState]);

  const { showNotice, hideNotice } = useWidgetNotice({ stateRef: stateRefForNotice });

  // ── Error handler ───────────────────────────────────────────────────────
  const showError = useCallback(
    (message: string) => {
      logError("WIDGET", message);
      dispatch({ type: "ERROR", message });
    },
    [dispatch],
  );

  // ── Recording ───────────────────────────────────────────────────────────
  const startRecordingRef = useRef<() => Promise<void>>(async () => {});

  const { startRecording } = useWidgetRecording({
    settings,
    machineRef,
    dispatch,
    setStream,
    resizeWidget,
    showError,
    showNotice,
    hideNotice,
    stopAndProcessRef,
  });

  useEffect(() => {
    startRecordingRef.current = startRecording;
  }, [startRecording]);

  // ── Hotkey ──────────────────────────────────────────────────────────────
  useWidgetHotkey({
    settingsLoaded,
    settings,
    setSettings,
    settingsRef,
    machineRef,
    dispatch,
    registeredHotkeyRef,
    clearReleaseStopTimer,
    showError,
  });

  const toggleManualRecording = useCallback(() => {
    const currentState = machineRef.current.widgetState;

    if (currentState === "idle") {
      dispatch({ type: "MANUAL_RECORDING_START" });
      return;
    }

    if (currentState === "recording") {
      dispatch({ type: "MANUAL_RECORDING_STOP" });
    }
  }, [dispatch]);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearReleaseStopTimer();
      clearMoveSaveTimer();
    };
  }, [clearMoveSaveTimer, clearReleaseStopTimer]);

  return {
    state: widgetState,
    stream,
    notice: null,
    lockedRecording,
    toggleManualRecording,
  };
}
