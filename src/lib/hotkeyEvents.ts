export const SETTINGS_UPDATED_EVENT = "settings-updated";
export const HISTORY_UPDATED_EVENT = "history-updated";
export const HOTKEY_CHANGE_REQUEST_EVENT = "hotkey-change-request";
export const HOTKEY_REGISTRATION_RESULT_EVENT = "hotkey-registration-result";
export const NATIVE_HOTKEY_CAPTURE_EVENT = "native-hotkey-capture";
export const HOTKEY_CAPTURE_STATE_EVENT = "hotkey-capture-state";
export const SETTINGS_NAVIGATE_EVENT = "settings-navigate";

export interface HotkeyChangeRequestPayload {
  hotkey: string;
}

export interface HotkeyRegistrationResultPayload {
  success: boolean;
  requestedHotkey: string;
  activeHotkey: string;
  message?: string;
}

export interface NativeHotkeyCapturePayload {
  status: "listening" | "preview" | "completed" | "cancelled" | "stopped";
  hotkey?: string | null;
  message?: string | null;
}

export interface HotkeyCaptureStatePayload {
  active: boolean;
}

export interface SettingsNavigatePayload {
  tab: "main" | "settings" | "model" | "style";
}
