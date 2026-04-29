/**
 * Centralized widget state machine.
 *
 * Replaces the 11+ scattered useRef objects with a single typed state object
 * managed by useReducer. The hotkeyFsm is kept as a separate pure function
 * and called from within this reducer for hotkey-specific transitions.
 *
 * All mutable "ref-like" boolean flags are now fields of WidgetMachineState.
 * Side effects are communicated via the `effects` array returned alongside
 * the next state (Elm-style).
 */

import type { WidgetState } from "../widgetConstants";

// ── State ───────────────────────────────────────────────────────────────────

export interface WidgetMachineState {
  /** High-level UI state */
  widgetState: WidgetState;
  /** Whether the hotkey is currently physically held down */
  hotkeyHeld: boolean;
  /** Whether the user is in locked-recording mode (double-tap) */
  lockedRecording: boolean;
  /** If true, ignore the next Release event */
  suppressNextRelease: boolean;
  /** If true, recording finished startup after user already released */
  pendingStopAfterStart: boolean;
  /** Whether the release-stop grace timer is ticking */
  releaseStopTimerActive: boolean;
  /** Whether the recorder.start() has actually completed */
  recordingActive: boolean;
  /** Timestamp of when recording started (ms) */
  recordingStartTimestamp: number;
}

export const initialWidgetMachineState: WidgetMachineState = {
  widgetState: "idle",
  hotkeyHeld: false,
  lockedRecording: false,
  suppressNextRelease: false,
  pendingStopAfterStart: false,
  releaseStopTimerActive: false,
  recordingActive: false,
  recordingStartTimestamp: 0,
};

// ── Effects ─────────────────────────────────────────────────────────────────

export type WidgetEffect =
  | { type: "start_recording" }
  | { type: "stop_and_process" }
  | { type: "schedule_release_stop_timer" }
  | { type: "clear_release_stop_timer" }
  | { type: "resize_widget"; width: number; height: number }
  | { type: "set_stream"; stream: MediaStream | null }
  | { type: "show_notice"; message: string; tone: "error" | "info" }
  | { type: "set_locked_recording_ui"; value: boolean };

// ── Actions ─────────────────────────────────────────────────────────────────

export type WidgetAction =
  // Hotkey events
  | { type: "HOTKEY_PRESSED" }
  | { type: "HOTKEY_RELEASED" }
  // Recording lifecycle
  | { type: "RECORDING_STARTED"; timestamp: number }
  | { type: "RECORDING_FAILED" }
  | { type: "PROCESSING_COMPLETE" }
  | { type: "PROCESSING_FAILED"; message: string }
  // Timer events
  | { type: "RELEASE_STOP_TIMER_FIRED" }
  // State transitions
  | { type: "SET_PROCESSING" }
  | { type: "MANUAL_RECORDING_START" }
  | { type: "MANUAL_RECORDING_STOP" }
  // Error
  | { type: "ERROR"; message: string }
  // Direct state transitions for hotkey capture interference
  | { type: "RESET_HOTKEY_STATE" };

// ── Reducer result ──────────────────────────────────────────────────────────

export interface ReducerResult {
  state: WidgetMachineState;
  effects: WidgetEffect[];
}

// ── Pure reducer ────────────────────────────────────────────────────────────

export function widgetReducer(
  state: WidgetMachineState,
  action: WidgetAction,
): ReducerResult {
  switch (action.type) {
    case "HOTKEY_PRESSED":
      return handleHotkeyPressed(state);
    case "HOTKEY_RELEASED":
      return handleHotkeyReleased(state);
    case "RECORDING_STARTED":
      return handleRecordingStarted(state, action.timestamp);
    case "RECORDING_FAILED":
      return handleRecordingFailed(state);
    case "PROCESSING_COMPLETE":
      return handleProcessingComplete(state);
    case "PROCESSING_FAILED":
      return handleProcessingFailed(state, action.message);
    case "RELEASE_STOP_TIMER_FIRED":
      return handleReleaseStopTimerFired(state);
    case "SET_PROCESSING":
      return handleSetProcessing(state);
    case "MANUAL_RECORDING_START":
      return handleManualRecordingStart(state);
    case "MANUAL_RECORDING_STOP":
      return handleManualRecordingStop(state);
    case "ERROR":
      return handleError(state, action.message);
    case "RESET_HOTKEY_STATE":
      return handleResetHotkeyState(state);
  }
}

// ── Transition handlers ─────────────────────────────────────────────────────

function handleHotkeyPressed(state: WidgetMachineState): ReducerResult {
  // Locked recording + already recording → stop
  if (state.lockedRecording && state.widgetState === "recording") {
    return result({
      ...state,
      hotkeyHeld: true,
      suppressNextRelease: true,
    }, [{ type: "stop_and_process" }]);
  }

  // Recording + release timer active → user double-tapped → lock mode
  if (state.widgetState === "recording" && state.releaseStopTimerActive) {
    return result({
      ...state,
      hotkeyHeld: true,
      lockedRecording: true,
      pendingStopAfterStart: false,
      releaseStopTimerActive: false,
    }, [
      { type: "clear_release_stop_timer" },
      { type: "set_locked_recording_ui", value: true },
    ]);
  }

  // Already held or not idle → ignore
  if (state.hotkeyHeld || state.widgetState !== "idle") {
    return result(state, []);
  }

  // Fresh press from idle → start recording
  return result({
    ...state,
    widgetState: "recording",
    hotkeyHeld: true,
    lockedRecording: false,
    recordingActive: false,
    pendingStopAfterStart: false,
  }, [{ type: "start_recording" }]);
}

function handleHotkeyReleased(state: WidgetMachineState): ReducerResult {
  const next = { ...state, hotkeyHeld: false };

  // Was suppressed (after locked stop) → consume silently
  if (state.suppressNextRelease) {
    next.suppressNextRelease = false;
    return result(next, []);
  }

  // Released while recording → schedule grace window
  if (state.widgetState === "recording") {
    if (state.lockedRecording) {
      return result(next, []);
    }

    next.releaseStopTimerActive = true;
    return result(next, [{ type: "schedule_release_stop_timer" }]);
  }

  next.pendingStopAfterStart = false;
  return result(next, []);
}

function handleRecordingStarted(state: WidgetMachineState, timestamp: number): ReducerResult {
  const next: WidgetMachineState = {
    ...state,
    recordingActive: true,
    recordingStartTimestamp: timestamp,
  };

  // If user requested stop while recorder was starting up → immediate stop.
  if (state.pendingStopAfterStart) {
    next.pendingStopAfterStart = false;
    return result(next, [{ type: "stop_and_process" }]);
  }

  // If user released while we were starting up → immediate stop.
  if (!state.hotkeyHeld && !state.lockedRecording) {
    next.pendingStopAfterStart = false;
    return result(next, [{ type: "stop_and_process" }]);
  }

  return result(next, []);
}

function handleRecordingFailed(_state: WidgetMachineState): ReducerResult {
  return result({
    ...initialWidgetMachineState,
  }, []);
}

function handleProcessingComplete(state: WidgetMachineState): ReducerResult {
  return result({
    ...state,
    widgetState: "idle",
    recordingActive: false,
    lockedRecording: false,
  }, [
    { type: "set_locked_recording_ui", value: false },
  ]);
}

function handleProcessingFailed(_state: WidgetMachineState, message: string): ReducerResult {
  return result({
    ...initialWidgetMachineState,
  }, [
    { type: "show_notice", message, tone: "error" },
  ]);
}

function handleSetProcessing(state: WidgetMachineState): ReducerResult {
  return result({
    ...state,
    widgetState: "processing",
    recordingActive: false,
    pendingStopAfterStart: false,
    lockedRecording: false,
    releaseStopTimerActive: false,
  }, []);
}

function handleManualRecordingStart(state: WidgetMachineState): ReducerResult {
  if (state.widgetState !== "idle") {
    return result(state, []);
  }

  return result({
    ...state,
    widgetState: "recording",
    hotkeyHeld: false,
    lockedRecording: true,
    recordingActive: false,
    pendingStopAfterStart: false,
    releaseStopTimerActive: false,
    suppressNextRelease: false,
  }, [
    { type: "set_locked_recording_ui", value: true },
    { type: "start_recording" },
  ]);
}

function handleManualRecordingStop(state: WidgetMachineState): ReducerResult {
  if (state.widgetState !== "recording") {
    return result(state, []);
  }

  if (!state.recordingActive) {
    return result({
      ...state,
      pendingStopAfterStart: true,
    }, []);
  }

  return result(state, [{ type: "stop_and_process" }]);
}

function handleReleaseStopTimerFired(state: WidgetMachineState): ReducerResult {
  const next = { ...state, releaseStopTimerActive: false };

  if (state.widgetState !== "recording" || state.lockedRecording) {
    return result(next, []);
  }

  if (state.recordingActive) {
    return result(next, [{ type: "stop_and_process" }]);
  }

  // Recording not yet started up → mark pending
  next.pendingStopAfterStart = true;
  return result(next, []);
}

function handleError(_state: WidgetMachineState, message: string): ReducerResult {
  return result({
    ...initialWidgetMachineState,
  }, [
    { type: "show_notice", message, tone: "error" },
    { type: "set_locked_recording_ui", value: false },
    { type: "clear_release_stop_timer" },
    { type: "set_stream", stream: null },
  ]);
}

function handleResetHotkeyState(state: WidgetMachineState): ReducerResult {
  return result({
    ...state,
    hotkeyHeld: false,
    pendingStopAfterStart: false,
    suppressNextRelease: false,
    releaseStopTimerActive: false,
  }, [{ type: "clear_release_stop_timer" }]);
}

// ── Helper ──────────────────────────────────────────────────────────────────

function result(state: WidgetMachineState, effects: WidgetEffect[]): ReducerResult {
  return { state, effects };
}
