import type { Monitor, Window } from "@tauri-apps/api/window";
import { availableMonitors, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";

import type { WidgetPosition } from "../../lib/store";

const DEFAULT_BOTTOM_MARGIN_PX = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getDefaultPositionForMonitor(
  monitor: Monitor,
  windowSize: { width: number; height: number },
): WidgetPosition {
  const { position, size } = monitor.workArea;
  const bottomMargin = Math.round(DEFAULT_BOTTOM_MARGIN_PX * monitor.scaleFactor);

  return {
    x: Math.round(position.x + (size.width - windowSize.width) / 2),
    y: Math.round(position.y + size.height - windowSize.height - bottomMargin),
  };
}

function clampPositionToMonitor(
  position: WidgetPosition,
  monitor: Monitor,
  windowSize: { width: number; height: number },
): WidgetPosition {
  const { position: workAreaPosition, size } = monitor.workArea;
  const maxX = workAreaPosition.x + Math.max(0, size.width - windowSize.width);
  const maxY = workAreaPosition.y + Math.max(0, size.height - windowSize.height);

  return {
    x: Math.round(clamp(position.x, workAreaPosition.x, maxX)),
    y: Math.round(clamp(position.y, workAreaPosition.y, maxY)),
  };
}

function getDistanceToMonitorWorkArea(
  point: { x: number; y: number },
  monitor: Monitor,
): number {
  const { position, size } = monitor.workArea;
  const maxX = position.x + size.width;
  const maxY = position.y + size.height;
  const dx = point.x < position.x ? position.x - point.x : point.x > maxX ? point.x - maxX : 0;
  const dy = point.y < position.y ? position.y - point.y : point.y > maxY ? point.y - maxY : 0;

  return dx * dx + dy * dy;
}

function pickMonitorForSavedPosition(
  monitors: Monitor[],
  savedPosition: WidgetPosition,
  windowSize: { width: number; height: number },
): Monitor | null {
  if (monitors.length === 0) {
    return null;
  }

  const centerPoint = {
    x: savedPosition.x + windowSize.width / 2,
    y: savedPosition.y + windowSize.height / 2,
  };

  return monitors.reduce((closestMonitor, monitor) => {
    if (!closestMonitor) {
      return monitor;
    }

    const currentDistance = getDistanceToMonitorWorkArea(centerPoint, closestMonitor);
    const nextDistance = getDistanceToMonitorWorkArea(centerPoint, monitor);

    return nextDistance < currentDistance ? monitor : closestMonitor;
  }, monitors[0] ?? null);
}

export async function resolveInitialWidgetPosition(
  widgetWindow: Window,
  savedPosition: WidgetPosition | null,
): Promise<WidgetPosition | null> {
  const windowSize = await widgetWindow.outerSize();
  const monitors = await availableMonitors();
  const fallbackMonitor = (await primaryMonitor()) ?? (await currentMonitor()) ?? monitors[0] ?? null;

  if (!fallbackMonitor) {
    return savedPosition;
  }

  if (!savedPosition) {
    return getDefaultPositionForMonitor(fallbackMonitor, windowSize);
  }

  const targetMonitor = pickMonitorForSavedPosition(monitors, savedPosition, windowSize) ?? fallbackMonitor;
  return clampPositionToMonitor(savedPosition, targetMonitor, windowSize);
}
