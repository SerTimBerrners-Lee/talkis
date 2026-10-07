import { describe, expect, test } from "bun:test";

import { holdBackgroundActivity } from "./backgroundActivity";

describe("background activity lifetime", () => {
  test("keeps both hidden notification windows eligible to receive updates", async () => {
    for (const label of ["widget-notice", "widget-text"] as const) {
      let settled = false;
      let request = Promise.resolve();
      const release = holdBackgroundActivity(label, {
        request: (name, options, callback): Promise<void> => {
          expect(name).toBe(`talkis:${label}:background`);
          request = callback({ name, mode: options.mode ?? "exclusive" }).then(() => {
            settled = true;
          });

          return request;
        },
      });

      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await request;
      expect(settled).toBe(true);
    }
  });

  test("keeps a granted shared lock pending until the window unmounts", async () => {
    let settled = false;
    let signal: AbortSignal | undefined;
    let request: Promise<void> = Promise.resolve();
    const release = holdBackgroundActivity("widget", {
      request: (name, options, callback): Promise<void> => {
        expect(name).toBe("talkis:widget:background");
        expect(options.mode).toBe("shared");
        signal = options.signal;
        request = callback({ name, mode: "shared" }).then(() => {
          settled = true;
        });

        return request;
      },
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);

    release();
    release();
    await request;

    expect(settled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  test("releases a late grant when cleanup precedes acquisition", async () => {
    let grant: (() => Promise<void>) | undefined;
    let signal: AbortSignal | undefined;
    const release = holdBackgroundActivity("settings", {
      request: (name, options, callback): Promise<void> => {
        signal = options.signal;
        grant = (): Promise<void> => callback({ name, mode: "shared" });

        return Promise.resolve();
      },
    });

    release();
    expect(signal?.aborted).toBe(true);
    expect(grant).toBeDefined();
    await grant?.();
  });

  test("does not block window startup if the browser rejects the request", async () => {
    const release = holdBackgroundActivity("widget", {
      request: (): Promise<void> => Promise.reject(new Error("locks disabled")),
    });

    await Promise.resolve();
    expect(release).toBeFunction();
    release();
  });

  test("supports browsers without the Locks API", () => {
    const release = holdBackgroundActivity("settings");

    expect(release).toBeFunction();
    release();
  });
});
