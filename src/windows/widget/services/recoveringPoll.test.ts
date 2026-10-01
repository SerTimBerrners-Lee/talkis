import { describe, expect, test } from "bun:test";

import { startRecoveringPoll } from "./recoveringPoll";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = (): void => {};
  const promise = new Promise<void>((done) => { resolve = done; });

  return { promise, resolve };
}

describe("recovering polling", () => {
  test("keeps only one request in flight and invalidates it on cancellation", async () => {
    const pending = deferred();
    const completed = deferred();
    let calls = 0;
    let applied = false;
    const stop = startRecoveringPoll(async (isCurrent): Promise<void> => {
      calls += 1;
      await pending.promise;
      applied = isCurrent();
      completed.resolve();
    }, { intervalMs: 1, onError: (): void => {} });

    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    expect(calls).toBe(1);
    stop();
    pending.resolve();
    await completed.promise;
    expect(applied).toBe(false);
    expect(calls).toBe(1);
  });

  test("reports a failure episode once and resumes after recovery", async () => {
    const recovered = deferred();
    let calls = 0;
    let errors = 0;
    let recoveries = 0;
    const stop = startRecoveringPoll(async (): Promise<void> => {
      calls += 1;
      if (calls < 4) {
        throw new Error("desktop unavailable");
      }
    }, {
      intervalMs: 1,
      retryIntervalMs: 1,
      maxRetryIntervalMs: 4,
      onError: (): void => { errors += 1; },
      onRecovery: (): void => { recoveries += 1; recovered.resolve(); },
    });

    try {
      await recovered.promise;
      expect(calls).toBe(4);
      expect(errors).toBe(1);
      expect(recoveries).toBe(1);
    } finally {
      stop();
    }
  });

  test("does not report an error from an obsolete request", async () => {
    const pending = deferred();
    let errors = 0;
    const stop = startRecoveringPoll(async (): Promise<void> => {
      await pending.promise;
      throw new Error("old desktop request");
    }, { intervalMs: 1, onError: (): void => { errors += 1; } });

    stop();
    pending.resolve();
    await pending.promise;
    await Promise.resolve();
    expect(errors).toBe(0);
  });
});
