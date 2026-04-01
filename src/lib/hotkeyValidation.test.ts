import { describe, test, expect } from "bun:test";
import { validateHotkey, normalizeHotkey, formatHotkeyLabel } from "./store";

describe("validateHotkey", () => {
  test("accepts modifier + letter", () => {
    expect(validateHotkey("Ctrl+A").valid).toBe(true);
    expect(validateHotkey("Command+Shift+Space").valid).toBe(true);
    expect(validateHotkey("Alt+Z").valid).toBe(true);
  });

  test("accepts F-key without modifier", () => {
    expect(validateHotkey("F1").valid).toBe(true);
    expect(validateHotkey("F12").valid).toBe(true);
  });

  test("rejects letter without modifier", () => {
    const result = validateHotkey("A");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("F-клавиш");
  });

  test("rejects modifier-only", () => {
    const result = validateHotkey("Ctrl");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("основную клавишу");
  });

  test("rejects multiple main keys", () => {
    const result = validateHotkey("Ctrl+A+B");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("одна основная");
  });

  test("rejects duplicate modifiers", () => {
    const result = validateHotkey("Ctrl+Control+A");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("дважды");
  });

  test("rejects unknown keys", () => {
    const result = validateHotkey("Ctrl+???");
    expect(result.valid).toBe(false);
  });

  test("rejects empty string parts", () => {
    const result = validateHotkey("");
    expect(result.valid).toBe(false);
  });
});

describe("normalizeHotkey", () => {
  test("normalizes modifier aliases", () => {
    const result = normalizeHotkey("cmd+shift+a");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("Shift+Command+A");
  });

  test("normalizes option to Alt", () => {
    const result = normalizeHotkey("option+space");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("Alt+Space");
  });

  test("orders modifiers consistently", () => {
    const result = normalizeHotkey("Command+Shift+X");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("Shift+Command+X");
  });

  test("normalizes meta to Command", () => {
    const result = normalizeHotkey("meta+K");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("Command+K");
  });

  test("uppercases single letter keys", () => {
    const result = normalizeHotkey("Ctrl+b");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("Control+B");
  });

  test("preserves F-key format", () => {
    const result = normalizeHotkey("f5");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("F5");
  });

  test("returns error for invalid input", () => {
    const result = normalizeHotkey("not-a-hotkey");
    expect(result.valid).toBe(false);
    expect(result.normalized).toBeUndefined();
  });

  test("handles Space key alias", () => {
    const result = normalizeHotkey("cmd+shift+space");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("Shift+Command+Space");
  });
});

describe("formatHotkeyLabel", () => {
  test("formats for display", () => {
    const label = formatHotkeyLabel("Command+Shift+Space");
    // On non-mac (test env), Command stays as Cmd
    expect(label).toContain("Space");
    expect(label).toContain(" + ");
  });

  test("handles single key", () => {
    const label = formatHotkeyLabel("F5");
    expect(label).toBe("F5");
  });
});
