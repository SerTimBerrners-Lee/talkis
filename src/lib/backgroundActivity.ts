import { logError, logInfo } from "./logger";

interface BackgroundLockManager {
  request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<void>,
  ): Promise<void>;
}

/** Keep event-driven background windows eligible to receive hotkeys and IPC. */
export function holdBackgroundActivity(
  windowLabel: "widget" | "settings" | "widget-notice" | "widget-text",
  locks: BackgroundLockManager | undefined =
    typeof navigator === "undefined" ? undefined : navigator.locks,
): () => void {
  if (!locks) {
    return (): void => {};
  }

  const controller = new AbortController();
  let released = false;
  let finish: () => void = (): void => {};
  const lifetime = new Promise<void>((resolve) => {
    finish = resolve;
  });

  try {
    void locks.request(
      `talkis:${windowLabel}:background`,
      { mode: "shared", signal: controller.signal },
      async (): Promise<void> => {
        if (released) return;

        void logInfo("BACKGROUND", `Activity lock acquired: ${windowLabel}`);
        await lifetime;
      },
    ).catch((error: unknown) => {
      if (!released) {
        void logError(
          "BACKGROUND",
          `Activity lock unavailable (${windowLabel}): ${String(error)}`,
        );
      }
    });
  } catch (error) {
    void logError(
      "BACKGROUND",
      `Failed to request activity lock (${windowLabel}): ${String(error)}`,
    );
  }

  return (): void => {
    released = true;
    finish();
    controller.abort();
  };
}
