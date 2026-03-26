import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

import {
  IDLE_WIDGET_HEIGHT,
  IDLE_WIDGET_WIDTH,
  NOTICE_TIMEOUT_MS,
  RECORDING_WIDGET_HEIGHT,
  RECORDING_WIDGET_WIDTH,
  WidgetNoticeState,
  WidgetNoticeTone,
  WidgetState,
} from "../widgetConstants";

interface UseWidgetNoticeParams {
  noticeVisibleRef: MutableRefObject<boolean>;
  stateRef: MutableRefObject<WidgetState>;
  resizeWidget: (width: number, height: number) => Promise<void>;
}

interface UseWidgetNoticeResult {
  notice: WidgetNoticeState | null;
  showNotice: (message: string, tone?: WidgetNoticeTone) => void;
}

function getBaseDimensionsForState(state: WidgetState): { width: number; height: number } {
  if (state === "recording") {
    return { width: RECORDING_WIDGET_WIDTH, height: RECORDING_WIDGET_HEIGHT };
  }

  if (state === "processing") {
    return { width: RECORDING_WIDGET_WIDTH, height: RECORDING_WIDGET_HEIGHT };
  }

  return { width: IDLE_WIDGET_WIDTH, height: IDLE_WIDGET_HEIGHT };
}

export function useWidgetNotice({ noticeVisibleRef, stateRef, resizeWidget }: UseWidgetNoticeParams): UseWidgetNoticeResult {
  const [notice, setNotice] = useState<WidgetNoticeState | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback(
    (message: string, tone: WidgetNoticeTone = "error") => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }

      noticeVisibleRef.current = true;
      const baseDimensions = getBaseDimensionsForState(stateRef.current);
      void resizeWidget(baseDimensions.width, baseDimensions.height);

      setNotice({ message, tone });
      noticeTimerRef.current = setTimeout(() => {
        setNotice(null);
        noticeTimerRef.current = null;

        noticeVisibleRef.current = false;
        const baseDimensions = getBaseDimensionsForState(stateRef.current);
        void resizeWidget(baseDimensions.width, baseDimensions.height);
      }, NOTICE_TIMEOUT_MS);
    },
    [noticeVisibleRef, resizeWidget, stateRef],
  );

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }

      noticeVisibleRef.current = false;
    };
  }, [noticeVisibleRef]);

  return {
    notice,
    showNotice,
  };
}
