export type WidgetState = "idle" | "recording" | "processing";
export type WidgetNoticeTone = "error" | "info";

export interface WidgetNoticeState {
  message: string;
  tone: WidgetNoticeTone;
}

export const MIN_RECORDING_DURATION_MS = 350;
export const MIN_AUDIO_BLOB_BYTES = 1024;
export const NOTICE_TIMEOUT_MS = 5000;
export const WIDGET_SHELL_WIDTH = 62;
export const WIDGET_SHELL_HEIGHT = 62;
export const IDLE_WIDGET_WIDTH = WIDGET_SHELL_WIDTH;
export const IDLE_WIDGET_HEIGHT = WIDGET_SHELL_HEIGHT;
export const RECORDING_WIDGET_WIDTH = WIDGET_SHELL_WIDTH;
export const RECORDING_WIDGET_HEIGHT = WIDGET_SHELL_HEIGHT;
export const NOTICE_WIDGET_WIDTH = 228;
export const NOTICE_AREA_HEIGHT = 68;
export const NOTICE_WIDGET_GAP = 8;
export const WIDGET_NOTICE_EVENT = "widget-notice:update";
