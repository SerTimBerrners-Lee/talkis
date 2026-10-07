import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";

import { logError, logInfo } from "../../../lib/logger";

import {
  NOTICE_TIMEOUT_MS,
  WidgetNoticeTone,
  WidgetState,
} from "../widgetConstants";
import { showWidgetErrorOverlay } from "../services/widgetErrorOverlay";

interface UseWidgetNoticeParams {
  stateRef: MutableRefObject<WidgetState>;
}

interface UseWidgetNoticeResult {
  showNotice: (message: string, tone?: WidgetNoticeTone) => void;
  hideNotice: () => void;
}

export function useWidgetNotice({ stateRef }: UseWidgetNoticeParams): UseWidgetNoticeResult {
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hideNotice = useCallback((): void => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }

    void invoke("hide_widget_notice").catch((error: unknown) => {
      void logError("WIDGET_NOTICE", `Failed to hide notice: ${String(error)}`);
    });
  }, []);

  const showNotice = useCallback(
    (message: string, tone: WidgetNoticeTone = "error"): void => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }

      if (tone === "error") {
        void logInfo("WIDGET_NOTICE", "Showing persistent recording/error notice");
        showWidgetErrorOverlay(message);
        return;
      }

      void invoke("show_widget_notice", {
        message,
        tone,
        anchorState: stateRef.current,
      }).catch((error: unknown) => {
        void logError("WIDGET_NOTICE", `Failed to show notice: ${String(error)}`);
        showWidgetErrorOverlay(message);
      });

      noticeTimerRef.current = setTimeout(() => {
        hideNotice();
      }, NOTICE_TIMEOUT_MS);
    },
    [hideNotice, stateRef],
  );

  useEffect(() => {
    return () => {
      hideNotice();
    };
  }, [hideNotice]);

  return {
    showNotice,
    hideNotice,
  };
}
