import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { AppSettings, DEFAULT_HOTKEY, getSettings, getWidgetPosition } from "../../../lib/store";
import { logError, logInfo } from "../../../lib/logger";
import { WidgetNoticeState, WidgetState } from "../widgetConstants";
import { useWidgetHotkey } from "./useWidgetHotkey";
import { useWidgetNotice } from "./useWidgetNotice";
import { useWidgetRecording } from "./useWidgetRecording";

interface WidgetControllerState {
  state: WidgetState;
  stream: MediaStream | null;
  notice: WidgetNoticeState | null;
  lockedRecording: boolean;
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

export function useWidgetController(): WidgetControllerState {
  const widgetWindow = getCurrentWindow();
  const [state, setState] = useState<WidgetState>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [lockedRecording, setLockedRecording] = useState(false);

  const recordingStartRef = useRef<number>(0);
  const stateRef = useRef<WidgetState>("idle");
  const settingsRef = useRef<AppSettings | null>(null);
  const registeredHotkeyRef = useRef<string | null>(null);
  const hotkeyHeldRef = useRef(false);
  const recordingActiveRef = useRef(false);
  const pendingStopAfterStartRef = useRef(false);
  const lockedRecordingRef = useRef(false);
  const suppressNextReleaseRef = useRef(false);
  const releaseStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopAndProcessRef = useRef<() => Promise<void>>(async () => {});

  const clearReleaseStopTimer = useCallback(() => {
    if (!releaseStopTimerRef.current) {
      return;
    }

    clearTimeout(releaseStopTimerRef.current);
    releaseStopTimerRef.current = null;
  }, []);

  const setLockedRecordingMode = useCallback((value: boolean) => {
    lockedRecordingRef.current = value;
    setLockedRecording(value);
  }, []);

  useEffect(() => {
    logInfo("SETTINGS", "Loading settings...");
    getSettings()
      .then((loadedSettings) => {
        logInfo(
          "SETTINGS",
          `Loaded: apiKey=${loadedSettings.apiKey ? "[set]" : "[empty]"}, hotkey=${DEFAULT_HOTKEY} [fixed]`,
        );
        setSettings(loadedSettings);
        setSettingsLoaded(true);
      })
      .catch((error) => {
        logError("SETTINGS", `Failed to load: ${error}`);
        setSettingsLoaded(true);
      });
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    let cancelled = false;

    const restoreWidgetPosition = async () => {
      try {
        const savedPosition = await getWidgetPosition();
        if (!savedPosition || cancelled) {
          return;
        }

        await widgetWindow.setPosition(new PhysicalPosition(savedPosition.x, savedPosition.y));
      } catch (error) {
        if (!cancelled) {
          logError("WIDGET", `Failed to restore widget position: ${formatErrorMessage(error)}`);
        }
      }
    };

    void restoreWidgetPosition();

    return () => {
      cancelled = true;
    };
  }, [widgetWindow]);

  const resizeWidget = useCallback(async (width: number, height: number) => {
    try {
      await invoke("widget_resize", { width, height });
    } catch (error) {
      logError("WIDGET", `Resize failed: ${formatErrorMessage(error)}`);
    }
  }, []);

  const { showNotice } = useWidgetNotice({ stateRef });

  const showError = useCallback(
    (message: string) => {
      logError("WIDGET", message);
      hotkeyHeldRef.current = false;
      recordingActiveRef.current = false;
      pendingStopAfterStartRef.current = false;
      suppressNextReleaseRef.current = false;
      clearReleaseStopTimer();
      setLockedRecordingMode(false);
      setState("idle");
      setStream(null);
      showNotice(message, "error");
    },
    [clearReleaseStopTimer, resizeWidget, setLockedRecordingMode, showNotice],
  );

  const { startRecording, stopAndProcess } = useWidgetRecording({
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
  });

  useWidgetHotkey({
    settingsLoaded,
    settings,
    setSettings,
    settingsRef,
    stateRef,
    registeredHotkeyRef,
    hotkeyHeldRef,
    recordingActiveRef,
    pendingStopAfterStartRef,
    lockedRecordingRef,
    suppressNextReleaseRef,
    releaseStopTimerRef,
    stopAndProcessRef,
    clearReleaseStopTimer,
    setLockedRecordingMode,
    startRecording,
    stopAndProcess,
    showError,
  });

  useEffect(() => {
    return () => {
      clearReleaseStopTimer();
    };
  }, [clearReleaseStopTimer]);

  return {
    state,
    stream,
    notice: null,
    lockedRecording,
  };
}
