interface RecoveringPollOptions {
  intervalMs: number;
  retryIntervalMs?: number;
  maxRetryIntervalMs?: number;
  onError: (error: unknown) => void;
  onRecovery?: () => void;
}

/** Serialize polling, back off while the desktop is unavailable, and log once
 * per failure episode. Cancellation also suppresses an in-flight result. */
export function startRecoveringPoll(
  poll: (isCurrent: () => boolean) => Promise<void>,
  options: RecoveringPollOptions,
): () => void {
  let disposed = false;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const firstRetryMs = options.retryIntervalMs ?? Math.max(1000, options.intervalMs);
  const maxRetryMs = options.maxRetryIntervalMs ?? Math.max(5000, firstRetryMs);
  let retryMs = firstRetryMs;

  const run = async (): Promise<void> => {
    if (disposed) {
      return;
    }

    let nextDelayMs = options.intervalMs;

    try {
      await poll((): boolean => !disposed);

      if (disposed) {
        return;
      }

      if (failed) {
        options.onRecovery?.();
      }

      failed = false;
      retryMs = firstRetryMs;
    } catch (error) {
      if (disposed) {
        return;
      }

      if (!failed) {
        options.onError(error);
      }

      failed = true;
      nextDelayMs = retryMs;
      retryMs = Math.min(retryMs * 2, maxRetryMs);
    }

    if (!disposed) {
      timer = setTimeout(() => { void run(); }, nextDelayMs);
    }
  };

  void run();

  return (): void => {
    disposed = true;

    if (timer !== null) {
      clearTimeout(timer);
    }
  };
}
