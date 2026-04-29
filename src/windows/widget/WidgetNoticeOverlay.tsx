import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { NOTICE_AREA_HEIGHT, NOTICE_WIDGET_WIDTH, WIDGET_NOTICE_EVENT, type WidgetNoticeState } from "./widgetConstants";

export function WidgetNoticeOverlay(): ReactElement | null {
  const [notice, setNotice] = useState<WidgetNoticeState | null>(null);

  useEffect(() => {
    let mounted = true;

    const unlistenPromise = listen<WidgetNoticeState>(WIDGET_NOTICE_EVENT, (event) => {
      if (!mounted) {
        return;
      }

      setNotice(event.payload);
    });

    return () => {
      mounted = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  if (!notice) {
    return null;
  }

  const handleNoticeClick = async () => {
    await invoke("open_settings_tab", { tab: "main" });
    await invoke("hide_widget_notice");
  };

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          void handleNoticeClick();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }

          event.preventDefault();
          void handleNoticeClick();
        }}
        style={{
          position: "relative",
          width: NOTICE_WIDGET_WIDTH,
          minHeight: NOTICE_AREA_HEIGHT,
          padding: "10px 14px",
          borderRadius: 16,
          fontSize: 11,
          lineHeight: 1.4,
          letterSpacing: "0.01em",
          color: "rgba(0,0,0,0.82)",
          background: "linear-gradient(180deg, rgba(252,251,248,0.98) 0%, rgba(244,239,231,0.96) 100%)",
          border: "1px solid rgba(0,0,0,0.08)",
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
          animation: "widget-notice-in 0.22s cubic-bezier(0.22, 1, 0.36, 1)",
          overflow: "hidden",
          pointerEvents: "auto",
          cursor: "pointer",
        }}
      >
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
          {notice.message}
        </div>
      </div>
    </div>
  );
}
