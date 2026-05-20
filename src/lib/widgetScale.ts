export const DEFAULT_WIDGET_SCALE = 1;
export const WIDGET_SCALE_MIN = 1;
export const WIDGET_SCALE_MAX = 1.8;
export const WIDGET_SCALE_STEP = 0.05;
const WIDGET_SCALE_EDGE_PADDING = 3;

export function normalizeWidgetScale(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numeric)) {
    return DEFAULT_WIDGET_SCALE;
  }

  const clamped = Math.min(WIDGET_SCALE_MAX, Math.max(WIDGET_SCALE_MIN, numeric));
  return Math.round(clamped * 100) / 100;
}

export function scaleWidgetDimension(value: number, scale: number): number {
  const normalizedScale = normalizeWidgetScale(scale);
  const edgePadding = normalizedScale > DEFAULT_WIDGET_SCALE
    ? WIDGET_SCALE_EDGE_PADDING
    : 0;

  return Math.max(1, Math.ceil(value * normalizedScale + edgePadding));
}

export function formatWidgetScalePercent(scale: number): string {
  return `${Math.round(normalizeWidgetScale(scale) * 100)}%`;
}
