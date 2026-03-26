import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";

import { NOTICE_TIMEOUT_MS, WidgetNoticeTone, WidgetState } from "../widgetConstants";

interface UseWidgetNoticeParams {
  stateRef: MutableRefObject<WidgetState>;
}

interface UseWidgetNoticeResult {
  showNotice: (message: string, tone?: WidgetNoticeTone) => void;
}

export function useWidgetNotice({ stateRef }: UseWidgetNoticeParams): UseWidgetNoticeResult {
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback(
    (message: string, tone: WidgetNoticeTone = "error") => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }

      void invoke("show_widget_notice", {
        message,
        tone,
        anchorState: stateRef.current,
      });

      noticeTimerRef.current = setTimeout(() => {
        void invoke("hide_widget_notice");
        noticeTimerRef.current = null;
      }, NOTICE_TIMEOUT_MS);
    },
    [stateRef],
  );

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }

      void invoke("hide_widget_notice");
    };
  }, []);

  return {
    showNotice,
  };
}
