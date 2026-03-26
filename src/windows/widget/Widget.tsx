import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertCircle, Bell } from "lucide-react";

import { saveWidgetPosition } from "../../lib/store";
import { Waveform } from "../../components/Waveform";
import { useWidgetController } from "./hooks/useWidgetController";
import { NOTICE_AREA_HEIGHT, WIDGET_SHELL_HEIGHT, WIDGET_SHELL_WIDTH, WidgetNoticeState } from "./widgetConstants";

export function Widget() {
  const widgetWindow = getCurrentWindow();
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragTriggeredRef = useRef(false);
  const { state, stream, notice, lockedRecording } = useWidgetController();

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
      const position = await widgetWindow.outerPosition();
      await saveWidgetPosition({ x: position.x, y: position.y });
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
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: NOTICE_AREA_HEIGHT,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          overflow: "visible",
        }}
      >
        {notice && <WidgetNotice message={notice.message} tone={notice.tone} />}
      </div>
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 0,
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "visible",
        }}
      >
        {state === "idle" && (
          <IdlePill
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
    </div>
  );
}

function WidgetNotice({ message, tone }: WidgetNoticeState) {
  const Icon = tone === "error" ? AlertCircle : Bell;

  return (
    <div
      style={{
        marginTop: 2,
        width: 212,
        minHeight: 52,
        padding: "10px 34px 10px 14px",
        borderRadius: 16,
        fontSize: 11,
        lineHeight: 1.4,
        letterSpacing: "0.01em",
        color: "rgba(0,0,0,0.82)",
        background: "linear-gradient(180deg, rgba(252,251,248,0.98) 0%, rgba(244,239,231,0.96) 100%)",
        border: "1px solid rgba(0,0,0,0.08)",
        boxShadow: "0 14px 28px rgba(0,0,0,0.12)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        pointerEvents: "none",
        animation: "widget-notice-in 0.22s cubic-bezier(0.22, 1, 0.36, 1)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          width: 18,
          height: 18,
          borderRadius: 999,
          background: tone === "error" ? "rgba(0,0,0,0.88)" : "rgba(0,0,0,0.72)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={11} strokeWidth={2.2} />
      </div>
      <div
        style={{
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          textOverflow: "ellipsis",
          paddingRight: 4,
        }}
      >
        {message}
      </div>
    </div>
  );
}

interface DragHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

function IdlePill({ onClick, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: DragHandlers & { onClick: () => void }) {
  return (
    <ActiveWidgetShell
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      cursor="pointer"
      onClick={() => {
        void onClick();
      }}
    >
      <WidgetCoreShell />
    </ActiveWidgetShell>
  );
}

function WidgetCoreShell({ children }: { children?: ReactNode }) {
  return (
    <div
      style={{
        width: 50,
        height: 18,
        borderRadius: 999,
        background: "linear-gradient(180deg, rgba(252,251,248,0.98) 0%, rgba(245,241,234,0.98) 100%)",
        border: "1px solid rgba(0,0,0,0.1)",
        boxShadow: "0 10px 24px rgba(0,0,0,0.12)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

interface RecordingPillProps {
  stream: MediaStream | null;
  locked: boolean;
}

function ActiveWidgetShell({ children, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick, cursor = "grab" }: { children: ReactNode; onClick?: () => void; cursor?: string } & DragHandlers) {
  return (
    <div
      style={{
        width: WIDGET_SHELL_WIDTH,
        height: WIDGET_SHELL_HEIGHT,
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
    >
      {children}
    </div>
  );
}

function RecordingPill({ stream, locked, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: RecordingPillProps & DragHandlers) {
  return (
    <ActiveWidgetShell
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <WidgetCoreShell>
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: locked ? "0 10px 0 3px" : "0 3px",
          }}
        >
          <Waveform stream={stream} isActive={true} />
          {locked && (
            <span
              style={{
                position: "absolute",
                top: "50%",
                right: 4,
                width: 4,
                height: 4,
                borderRadius: 999,
                background: "#d92d20",
                boxShadow: "0 0 0 2px rgba(217,45,32,0.14)",
                transform: "translateY(-50%)",
              }}
            />
          )}
        </div>
      </WidgetCoreShell>
    </ActiveWidgetShell>
  );
}

function ProcessingPill({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: DragHandlers) {
  return (
    <ActiveWidgetShell
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <WidgetCoreShell>
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
