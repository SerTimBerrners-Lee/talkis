import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";

import { NOTICE_TIMEOUT_MS, WidgetNoticeTone, WidgetState } from "../widgetConstants";

interface UseWidgetNoticeParams {
  stateRef: MutableRefObject<WidgetState>;
}

interface UseWidgetNoticeResult {
  showNotice: (message: string, tone?: WidgetNoticeTone) => void;
  hideNotice: () => void;
}

export function useWidgetNotice({ stateRef }: UseWidgetNoticeParams): UseWidgetNoticeResult {
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hideNotice = useCallback(() => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }

    void invoke("hide_widget_notice");
  }, []);

  const showNotice = useCallback(
    (message: string, tone: WidgetNoticeTone = "error") => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }

      void invoke("show_widget_notice", {
        message,
        tone,
        anchorState: stateRef.current,
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
