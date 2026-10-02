import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { getSettings, saveSettings } from "./store";

describe("persisted widget visibility", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let persisted: Record<string, unknown>;
  let pending: Record<string, unknown>;
  let applied: unknown[];
  let failSave: boolean;
  let failApply: boolean;

  beforeAll(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { crypto: globalThis.crypto },
    });
  });

  afterAll(() => {
    clearMocks();
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  beforeEach(() => {
    persisted = { hotkey: "Control+Alt+Space", widgetVisible: true };
    pending = structuredClone(persisted);
    applied = [];
    failSave = false;
    failApply = false;

    mockIPC((command, args): unknown => {
      const payload = args && !(args instanceof ArrayBuffer) && !ArrayBuffer.isView(args)
        ? args
        : {};

      switch (command) {
        case "plugin:store|load":
          return 1;
        case "plugin:store|reload":
          pending = structuredClone(persisted);
          return;
        case "plugin:store|get":
          return payload.key === "settings" ? [pending, true] : [null, false];
        case "plugin:store|set":
          pending = structuredClone(payload.value as Record<string, unknown>);
          return;
        case "plugin:store|save":
          if (failSave) throw new Error("disk unavailable");
          persisted = structuredClone(pending);
          return;
        case "sync_widget_visibility":
          applied.push(persisted.widgetVisible);
          if (failApply) {
            failApply = false;
            throw new Error("window unavailable");
          }
          return;
        case "migrate_app_data_layout":
        case "log_event":
          return;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });
  });

  test("applies the saved choice and keeps it when another setting changes", async () => {
    await saveSettings({ widgetVisible: false });
    expect(applied).toEqual([false]);
    expect((await getSettings({ reload: true })).widgetVisible).toBe(false);

    await saveSettings({ theme: "dark" });
    expect((await getSettings({ reload: true })).widgetVisible).toBe(false);
    expect(applied).toEqual([false]);
  });

  test("does not hide the window when saving fails", async () => {
    failSave = true;
    await expect(saveSettings({ widgetVisible: false })).rejects.toThrow("disk unavailable");
    expect(applied).toEqual([]);
    expect(persisted.widgetVisible).toBe(true);
  });

  test("restores the previous choice after a native apply failure", async () => {
    failApply = true;
    await expect(saveSettings({ widgetVisible: false })).rejects.toThrow("window unavailable");
    expect(applied).toEqual([false, true]);
    expect((await getSettings({ reload: true })).widgetVisible).toBe(true);
  });
});
