export type WidgetState = "idle" | "recording" | "processing";
export type WidgetNoticeTone = "error" | "info";

export interface WidgetNoticeState {
  message: string;
  tone: WidgetNoticeTone;
}

export const MIN_RECORDING_DURATION_MS = 500;
export const MIN_AUDIO_BLOB_BYTES = 1024;
export const NOTICE_TIMEOUT_MS = 5000;
export const WIDGET_SHELL_WIDTH = 74;
export const WIDGET_SHELL_HEIGHT = 22;
export const IDLE_HOVER_SCALE = 1;
export const ACTIVE_WIDGET_SHELL_WIDTH = WIDGET_SHELL_WIDTH * IDLE_HOVER_SCALE;
export const ACTIVE_WIDGET_SHELL_HEIGHT = WIDGET_SHELL_HEIGHT * IDLE_HOVER_SCALE;
export const IDLE_HOVER_WIDGET_WIDTH = ACTIVE_WIDGET_SHELL_WIDTH + 12;
export const IDLE_HOVER_WIDGET_HEIGHT = ACTIVE_WIDGET_SHELL_HEIGHT + 12;
export const IDLE_WIDGET_WIDTH = IDLE_HOVER_WIDGET_WIDTH;
export const IDLE_WIDGET_HEIGHT = IDLE_HOVER_WIDGET_HEIGHT;
export const RECORDING_WIDGET_WIDTH = IDLE_HOVER_WIDGET_WIDTH;
export const RECORDING_WIDGET_HEIGHT = IDLE_HOVER_WIDGET_HEIGHT;
export const NOTICE_WIDGET_WIDTH = 212;
export const NOTICE_AREA_HEIGHT = 52;
/** Must match NOTICE_GAP in src-tauri/src/lib.rs (logical pixels). */
export const NOTICE_WIDGET_GAP = 2;
export const WIDGET_NOTICE_EVENT = "widget-notice:update";
