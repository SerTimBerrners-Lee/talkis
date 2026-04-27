import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Circle, Copy, Square } from "lucide-react";

import { Waveform } from "../../components/Waveform";
import { HISTORY_CLEARED_EVENT, HISTORY_DELETED_EVENT, HISTORY_UPDATED_EVENT } from "../../lib/hotkeyEvents";
import { getHistory, type HistoryEntry } from "../../lib/store";
import { logError } from "../../lib/logger";
import { useWidgetController } from "./hooks/useWidgetController";
import {
  ACTIVE_WIDGET_SHELL_HEIGHT,
  ACTIVE_WIDGET_SHELL_WIDTH,
  IDLE_HOVER_WIDGET_HEIGHT,
  IDLE_HOVER_WIDGET_WIDTH,
  IDLE_HOVER_SCALE,
  WIDGET_SHELL_HEIGHT,
  WIDGET_SHELL_WIDTH,
} from "./widgetConstants";

const WIDGET_RECORD_BUTTON_LEFT = 10;
const WIDGET_RECORD_BUTTON_SIZE = 18;

function getCopyableText(entry: HistoryEntry | null | undefined): string | null {
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
  const { state, stream, lockedRecording, toggleManualRecording } = useWidgetController();
  const [latestCopyText, setLatestCopyText] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const refreshLatestCopyText = async () => {
      try {
        const history = await getHistory();
        if (!mounted) {
          return;
        }

        const latestCompleted = history.find((entry) => getCopyableText(entry) !== null);
        setLatestCopyText(getCopyableText(latestCompleted));
      } catch (error) {
        logError("WIDGET", `Failed to load latest history entry: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    void refreshLatestCopyText();

    const unlistenUpdatedPromise = listen<HistoryEntry>(HISTORY_UPDATED_EVENT, ({ payload }) => {
      const text = getCopyableText(payload);
      if (text) {
        setLatestCopyText(text);
      }
    });
    const unlistenDeletedPromise = listen<{ id: string }>(HISTORY_DELETED_EVENT, () => {
      void refreshLatestCopyText();
    });
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

  const handleDragPointerMove = async (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current || dragTriggeredRef.current || (event.buttons & 1) === 0) {
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

  const handleIdleClick = async () => {
    if (dragTriggeredRef.current) {
      return;
    }

    await invoke("open_settings");
  };

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
      {state === "idle" && (
        <IdlePill
          latestCopyText={latestCopyText}
          onToggleRecording={toggleManualRecording}
          onClick={handleIdleClick}
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          onPointerCancel={handleDragPointerUp}
        />
      )}
      {state === "recording" && (
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
      {state === "processing" && (
        <ProcessingPill
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          onPointerCancel={handleDragPointerUp}
        />
      )}
    </div>
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
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: DragHandlers & { latestCopyText: string | null; onToggleRecording: () => void; onClick: () => void }) {
  const widgetWindow = getCurrentWindow();
  const [isHovered, setIsHovered] = useState(false);
  const canCopy = Boolean(latestCopyText);
  const controlsVisible = isHovered;

  useEffect(() => {
    let disposed = false;
    const hoverMarginPx = 2;

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

        const hovered =
          cursor.x >= position.x - hoverMarginPx &&
          cursor.x <= position.x + size.width + hoverMarginPx &&
          cursor.y >= position.y - hoverMarginPx &&
          cursor.y <= position.y + size.height + hoverMarginPx;

        setIsHovered(hovered);
      } catch (error) {
        logError("WIDGET", `Failed to poll widget hover state: ${error instanceof Error ? error.message : String(error)}`);
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
  }, [widgetWindow]);

  const copyLatestText = async () => {
    if (!latestCopyText) {
      return;
    }

    await writeText(latestCopyText);
  };

  return (
    <ActiveWidgetShell
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      width={IDLE_HOVER_WIDGET_WIDTH}
      height={IDLE_HOVER_WIDGET_HEIGHT}
      cursor="pointer"
      onClick={() => {
        void onClick();
      }}
    >
      <WidgetCoreShell width={WIDGET_SHELL_WIDTH} height={WIDGET_SHELL_HEIGHT} scale={isHovered ? IDLE_HOVER_SCALE : 1} />
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
            width: WIDGET_RECORD_BUTTON_SIZE,
            height: WIDGET_RECORD_BUTTON_SIZE,
            border: "none",
            borderRadius: 999,
            padding: 0,
            background: "rgba(217,45,32,0.12)",
            color: "#d92d20",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: controlsVisible ? 1 : 0,
            transform: controlsVisible ? "translateY(-50%) scale(1)" : "translateY(-50%) scale(0.84)",
            transition: "opacity 0.14s ease, transform 0.14s ease, background 0.14s ease",
            pointerEvents: controlsVisible ? "auto" : "none",
            cursor: "pointer",
            WebkitFontSmoothing: "antialiased",
          }}
        >
          <Circle size={10} strokeWidth={2.4} fill="currentColor" />
        </button>
        {canCopy && (
          <button
            type="button"
            aria-label="Скопировать последнюю запись"
            title="Скопировать"
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
              width: 18,
              height: 18,
              minWidth: 18,
              border: "none",
              borderRadius: 999,
              padding: 0,
              background: "rgba(0,0,0,0.06)",
              color: "rgba(0,0,0,0.7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: controlsVisible ? 1 : 0,
              transform: controlsVisible ? "translateY(-50%) scale(1)" : "translateY(-50%) scale(0.84)",
              transition: "opacity 0.14s ease, transform 0.14s ease, background 0.14s ease, color 0.14s ease",
              pointerEvents: controlsVisible ? "auto" : "none",
              cursor: "pointer",
              WebkitFontSmoothing: "antialiased",
            }}
          >
            <Copy size={12} strokeWidth={2} />
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
        background: "linear-gradient(180deg, #fcfbf8 0%, #f6f2eb 100%)",
        border: "1px solid rgba(0,0,0,0.13)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
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

function RecordingPill({ stream, locked, onToggleRecording, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: RecordingPillProps & DragHandlers) {
  return (
    <ActiveWidgetShell
      width={IDLE_HOVER_WIDGET_WIDTH}
      height={IDLE_HOVER_WIDGET_HEIGHT}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <WidgetCoreShell width={ACTIVE_WIDGET_SHELL_WIDTH} height={ACTIVE_WIDGET_SHELL_HEIGHT}>
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 4px 0 24px",
          }}
        >
          <Waveform stream={stream} isActive={true} />
        </div>
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
            width: WIDGET_RECORD_BUTTON_SIZE,
            height: WIDGET_RECORD_BUTTON_SIZE,
            border: "none",
            borderRadius: 999,
            padding: 0,
            background: locked ? "rgba(217,45,32,0.14)" : "rgba(217,45,32,0.1)",
            color: "#d92d20",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: "translateY(-50%)",
            pointerEvents: "auto",
            cursor: "pointer",
          }}
        >
          <Square size={8} strokeWidth={2.4} fill="currentColor" />
        </button>
      </div>
    </ActiveWidgetShell>
  );
}

function ProcessingPill({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: DragHandlers) {
  return (
    <ActiveWidgetShell
      width={IDLE_HOVER_WIDGET_WIDTH}
      height={IDLE_HOVER_WIDGET_HEIGHT}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <WidgetCoreShell width={ACTIVE_WIDGET_SHELL_WIDTH} height={ACTIVE_WIDGET_SHELL_HEIGHT}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            gap: 3,
            width: 20,
            height: 9,
          }}
        >
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              style={{
                width: 3,
                height: 3,
                borderRadius: 999,
                background: index === 1 ? "rgba(0,0,0,0.82)" : "rgba(0,0,0,0.46)",
                animation: `widget-processing-dot 0.72s ease-in-out ${index * 0.12}s infinite`,
                boxShadow: index === 1 ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
              }}
            />
          ))}
        </div>
      </WidgetCoreShell>
    </ActiveWidgetShell>
  );
}
