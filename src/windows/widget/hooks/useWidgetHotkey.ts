import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { register, unregister, ShortcutEvent } from "@tauri-apps/plugin-global-shortcut";

import { AppSettings, DEFAULT_HOTKEY, getSettings, normalizeHotkey, saveSettings } from "../../../lib/store";
import { logError, logInfo } from "../../../lib/logger";
import {
  HOTKEY_CAPTURE_STATE_EVENT,
  HOTKEY_CHANGE_REQUEST_EVENT,
  HotkeyCaptureStatePayload,
  HOTKEY_REGISTRATION_RESULT_EVENT,
  HotkeyChangeRequestPayload,
  HotkeyRegistrationResultPayload,
  SETTINGS_UPDATED_EVENT,
} from "../../../lib/hotkeyEvents";
import { WidgetState } from "../widgetConstants";
import { evaluateHotkeyFsm, HotkeyShortcutState } from "../services/hotkeyFsm";

interface UseWidgetHotkeyParams {
  settingsLoaded: boolean;
  settings: AppSettings | null;
  setSettings: Dispatch<SetStateAction<AppSettings | null>>;
  settingsRef: MutableRefObject<AppSettings | null>;
  stateRef: MutableRefObject<WidgetState>;
  registeredHotkeyRef: MutableRefObject<string | null>;
  hotkeyHeldRef: MutableRefObject<boolean>;
  recordingActiveRef: MutableRefObject<boolean>;
  pendingStopAfterStartRef: MutableRefObject<boolean>;
  lockedRecordingRef: MutableRefObject<boolean>;
  suppressNextReleaseRef: MutableRefObject<boolean>;
  releaseStopTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  stopAndProcessRef: MutableRefObject<() => Promise<void>>;
  clearReleaseStopTimer: () => void;
  setLockedRecordingMode: (value: boolean) => void;
  startRecording: () => Promise<void>;
  stopAndProcess: () => Promise<void>;
  showError: (message: string) => void;
}

export function useWidgetHotkey({
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
}: UseWidgetHotkeyParams): void {
  const attemptHotkeyRegistrationRef = useRef<(rawHotkey: string) => Promise<HotkeyRegistrationResultPayload>>(
    attemptHotkeyRegistrationPlaceholder,
  );
  const isHotkeyCaptureActiveRef = useRef(false);

  const unregisterCurrentHotkey = useCallback(async () => {
    const currentHotkey = registeredHotkeyRef.current;
    if (!currentHotkey) {
      return;
    }

    logInfo("HOTKEY", `Unregistering: ${currentHotkey}`);
    await unregister(currentHotkey).catch(() => {});
    registeredHotkeyRef.current = null;
  }, [registeredHotkeyRef]);

  const handleHotkeyPress = useCallback(
    (event: ShortcutEvent) => {
      if (isHotkeyCaptureActiveRef.current) {
        clearReleaseStopTimer();
        hotkeyHeldRef.current = false;
        pendingStopAfterStartRef.current = false;
        suppressNextReleaseRef.current = false;
        return;
      }

      const currentState = stateRef.current;
      logInfo("HOTKEY", `Triggered! state=${currentState}, shortcutState=${event.state}`);

      if (event.state !== "Pressed" && event.state !== "Released") {
        return;
      }

      const shortcutState: HotkeyShortcutState = event.state;

      const doubleTapTimeout = settingsRef.current?.doubleTapTimeout ?? 400;

      const scheduleStopAfterRelease = () => {
        clearReleaseStopTimer();
        releaseStopTimerRef.current = setTimeout(() => {
          releaseStopTimerRef.current = null;
          if (stateRef.current !== "recording" || lockedRecordingRef.current) {
            return;
          }

          if (recordingActiveRef.current) {
            logInfo("HOTKEY", "Release grace window ended, stopping recording");
            void stopAndProcessRef.current();
          } else {
            logInfo("HOTKEY", "Release grace window ended before recorder startup completed");
            pendingStopAfterStartRef.current = true;
          }
        }, doubleTapTimeout);
      };

      const decision = evaluateHotkeyFsm(
        {
          widgetState: currentState,
          hotkeyHeld: hotkeyHeldRef.current,
          lockedRecording: lockedRecordingRef.current,
          suppressNextRelease: suppressNextReleaseRef.current,
          pendingStopAfterStart: pendingStopAfterStartRef.current,
          releaseStopTimerActive: releaseStopTimerRef.current !== null,
        },
        shortcutState,
      );

      hotkeyHeldRef.current = decision.nextState.hotkeyHeld;
      suppressNextReleaseRef.current = decision.nextState.suppressNextRelease;
      pendingStopAfterStartRef.current = decision.nextState.pendingStopAfterStart;

      if (decision.nextState.lockedRecording !== lockedRecordingRef.current) {
        setLockedRecordingMode(decision.nextState.lockedRecording);
      }

      for (const command of decision.commands) {
        if (command === "clear_release_stop_timer") {
          clearReleaseStopTimer();
          continue;
        }

        if (command === "schedule_stop_after_release") {
          if (recordingActiveRef.current) {
            logInfo("HOTKEY", "Shortcut released, waiting for possible lock gesture");
          } else {
            logInfo(
              "HOTKEY",
              "Shortcut released before startup completed, waiting for possible lock gesture",
            );
          }
          scheduleStopAfterRelease();
          continue;
        }

        if (command === "start_recording") {
          void startRecording();
          continue;
        }

        if (command === "stop_recording") {
          logInfo("HOTKEY", "Locked recording pressed again, stopping recording");
          void stopAndProcess();
        }
      }
    },
    [
      clearReleaseStopTimer,
      hotkeyHeldRef,
      lockedRecordingRef,
      pendingStopAfterStartRef,
      recordingActiveRef,
      releaseStopTimerRef,
      setLockedRecordingMode,
      settingsRef,
      startRecording,
      stateRef,
      stopAndProcess,
      stopAndProcessRef,
      suppressNextReleaseRef,
    ],
  );

  const attemptHotkeyRegistration = useCallback(async (rawHotkey: string): Promise<HotkeyRegistrationResultPayload> => {
    const normalized = normalizeHotkey(rawHotkey);
    if (!normalized.valid || !normalized.normalized) {
      return {
        success: false,
        requestedHotkey: rawHotkey,
        activeHotkey: registeredHotkeyRef.current ?? settingsRef.current?.hotkey ?? DEFAULT_HOTKEY,
        message: normalized.error || "Неверный формат горячей клавиши",
      };
    }

    const nextHotkey = normalized.normalized;
    const currentHotkey = registeredHotkeyRef.current;
    if (currentHotkey === nextHotkey) {
      return {
        success: true,
        requestedHotkey: nextHotkey,
        activeHotkey: nextHotkey,
      };
    }

    logInfo("HOTKEY", `Attempting to register: ${nextHotkey}`);

    try {
      await register(nextHotkey, handleHotkeyPress);

      if (currentHotkey && currentHotkey !== nextHotkey) {
        logInfo("HOTKEY", `Unregistering previous hotkey: ${currentHotkey}`);
        await unregister(currentHotkey).catch((error) => {
          logError("HOTKEY", `Failed to unregister previous hotkey: ${error}`);
        });
      }

      registeredHotkeyRef.current = nextHotkey;
      logInfo("HOTKEY", `Registered successfully: ${nextHotkey}`);

      return {
        success: true,
        requestedHotkey: nextHotkey,
        activeHotkey: nextHotkey,
      };
    } catch (error) {
      logError("HOTKEY", `Failed to register ${nextHotkey}: ${error}`);
      return {
        success: false,
        requestedHotkey: nextHotkey,
        activeHotkey: currentHotkey ?? settingsRef.current?.hotkey ?? DEFAULT_HOTKEY,
        message: `Не удалось зарегистрировать горячую клавишу "${nextHotkey}". Возможно, сочетание занято другим приложением.`,
      };
    }
  }, [handleHotkeyPress, registeredHotkeyRef, settingsRef]);

  const registerCurrentHotkey = useCallback(async () => {
    const activeSettings = settingsRef.current;
    if (!settingsLoaded || !activeSettings) {
      logInfo("HOTKEY", `Skipping registration: loaded=${settingsLoaded}, settings=${!!activeSettings}`);
      return;
    }

    const result = await attemptHotkeyRegistration(activeSettings.hotkey || DEFAULT_HOTKEY);
    if (!result.success) {
      showError(result.message || "Не удалось зарегистрировать горячую клавишу.");
    }
  }, [
    attemptHotkeyRegistration,
    settingsLoaded,
    settingsRef,
    showError,
  ]);

  useEffect(() => {
    void registerCurrentHotkey();
  }, [registerCurrentHotkey, settings?.hotkey]);

  useEffect(() => {
    attemptHotkeyRegistrationRef.current = attemptHotkeyRegistration;
  }, [attemptHotkeyRegistration]);

  useEffect(() => {
    const unlistenSettings = listen(SETTINGS_UPDATED_EVENT, async () => {
      const latestSettings = await getSettings();
      setSettings(latestSettings);
      settingsRef.current = latestSettings;
    });

    const unlistenCaptureState = listen<HotkeyCaptureStatePayload>(HOTKEY_CAPTURE_STATE_EVENT, ({ payload }) => {
      isHotkeyCaptureActiveRef.current = payload.active;

      if (!payload.active) {
        return;
      }

      clearReleaseStopTimer();
      hotkeyHeldRef.current = false;
      pendingStopAfterStartRef.current = false;
      suppressNextReleaseRef.current = false;
    });

    const unlistenHotkeyRequests = listen<HotkeyChangeRequestPayload>(HOTKEY_CHANGE_REQUEST_EVENT, async ({ payload }) => {
      const result = await attemptHotkeyRegistrationRef.current(payload.hotkey);

      if (result.success) {
        const updatedSettings = {
          ...(settingsRef.current ?? (await getSettings())),
          hotkey: result.activeHotkey,
        };

        await saveSettings({ hotkey: result.activeHotkey });
        settingsRef.current = updatedSettings;
        setSettings(updatedSettings);

        emit(SETTINGS_UPDATED_EVENT).catch((error) => {
          logError("HOTKEY", `Failed to emit settings update event: ${error}`);
        });
      }

      emit(HOTKEY_REGISTRATION_RESULT_EVENT, result).catch((error) => {
        logError("HOTKEY", `Failed to emit hotkey registration result: ${error}`);
      });
    });

    return () => {
      unlistenSettings.then((unlisten) => unlisten());
      unlistenCaptureState.then((unlisten) => unlisten());
      unlistenHotkeyRequests.then((unlisten) => unlisten());
      void unregisterCurrentHotkey();
    };
  }, [clearReleaseStopTimer, hotkeyHeldRef, pendingStopAfterStartRef, setSettings, settingsRef, suppressNextReleaseRef, unregisterCurrentHotkey]);
}

async function attemptHotkeyRegistrationPlaceholder(): Promise<HotkeyRegistrationResultPayload> {
  throw new Error("attemptHotkeyRegistration called before initialization");
}
