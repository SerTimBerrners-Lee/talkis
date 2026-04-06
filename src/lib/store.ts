import { load } from "@tauri-apps/plugin-store";

export interface HistoryEntry {
  id: string;
  timestamp: string;
  duration: number;
  raw: string;
  cleaned: string;
  status?: "completed" | "failed";
  errorMessage?: string;
  audioBase64?: string;
  language?: string;
  style?: AppSettings["style"];
}

export type ApiProvider = "openai" | "custom";

export interface AppSettings {
  apiKey: string;
  /** API provider preset: 'openai' uses default endpoints, 'custom' lets user configure everything */
  provider: ApiProvider;
  /** Model name for STT (e.g. "whisper-1", "whisper-large-v3-turbo") */
  whisperModel: string;
  /** Model name for LLM cleanup (e.g. "gpt-4o-mini", "deepseek-chat") */
  llmModel: string;
  hotkey: string;
  language: string;
  doubleTapTimeout: number;
  style: "classic" | "business" | "tech";
  micId: string;
  /** Custom Whisper-compatible endpoint URL (leave empty for OpenAI) */
  whisperEndpoint: string;
  /** Custom LLM endpoint URL (leave empty for OpenAI) */
  llmEndpoint: string;
  /** If true, user provides their own API key. If false, uses subscription */
  useOwnKey: boolean;
  /** Device auth token for Talkis Cloud */
  deviceToken: string;
}

export interface WidgetPosition {
  x: number;
  y: number;
}

const MODIFIER_ORDER = ["Control", "Alt", "Shift", "Command"] as const;
const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  cmd: "Command",
  command: "Command",
  meta: "Command",
};
const MAIN_KEY_ALIASES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  spacebar: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "Up",
  up: "Up",
  arrowdown: "Down",
  down: "Down",
  arrowleft: "Left",
  left: "Left",
  arrowright: "Right",
  right: "Right",
};
const FUNCTION_KEY_PATTERN = /^F(?:[1-9]|1[0-2])$/;
export const DEFAULT_HOTKEY = "Command+Shift+Space";

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function formatHotkeyLabel(hotkey: string): string {
  const parts = hotkey.split("+").map((part) => part.trim());
  const isMac = isMacPlatform();

  const formatted = parts.map((part) => {
    const lower = part.toLowerCase();

    if (lower === "ctrl" || lower === "control") {
      return isMac ? "Control" : "Ctrl";
    }

    if (lower === "alt" || lower === "option") {
      return isMac ? "Option" : "Alt";
    }

    if (lower === "cmd" || lower === "command" || lower === "meta") {
      return isMac ? "Command" : "Cmd";
    }

    return part;
  });

  return formatted.join(" + ");
}

function normalizeHotkeyPart(part: string): string | null {
  const trimmed = part.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  const modifier = MODIFIER_ALIASES[lower];
  if (modifier) {
    return modifier;
  }

  const aliasedMainKey = MAIN_KEY_ALIASES[lower];
  if (aliasedMainKey) {
    return aliasedMainKey;
  }

  const upper = trimmed.toUpperCase();
  if (FUNCTION_KEY_PATTERN.test(upper)) {
    return upper;
  }

  if (/^[A-Z0-9]$/i.test(trimmed)) {
    return upper;
  }

  return null;
}

function isModifier(part: string): part is (typeof MODIFIER_ORDER)[number] {
  return MODIFIER_ORDER.includes(part as (typeof MODIFIER_ORDER)[number]);
}

function isFunctionKey(part: string): boolean {
  return FUNCTION_KEY_PATTERN.test(part);
}

export function validateHotkey(hotkey: string): { valid: boolean; error?: string } {
  const parts = hotkey.split("+").map((part) => normalizeHotkeyPart(part));
  if (parts.some((part) => part === null)) {
    return {
      valid: false,
      error: "Поддерживаются буквы, цифры, Space, F-клавиши и стандартные модификаторы",
    };
  }

  const normalizedParts = parts.filter((part): part is string => part !== null);
  const modifiers = normalizedParts.filter(isModifier);
  const mainKeys = normalizedParts.filter((part) => !isModifier(part));

  if (normalizedParts.length === 0) {
    return {
      valid: false,
      error: "Нажмите хотя бы одну клавишу",
    };
  }

  if (mainKeys.length === 0) {
    return {
      valid: false,
      error: "Добавьте основную клавишу: Space, букву, цифру или F-клавишу",
    };
  }

  if (mainKeys.length > 1) {
    return {
      valid: false,
      error: "Только одна основная клавиша",
    };
  }

  if (new Set(modifiers).size !== modifiers.length) {
    return {
      valid: false,
      error: "Один и тот же модификатор нельзя использовать дважды",
    };
  }

  if (isMacPlatform() && modifiers.includes("Control") && modifiers.includes("Alt")) {
    return {
      valid: false,
      error: "На macOS сочетания Control + Option часто перехватываются VoiceOver. Выберите другое сочетание.",
    };
  }

  if (modifiers.length === 0 && !isFunctionKey(mainKeys[0])) {
    return {
      valid: false,
      error: "Без модификатора разрешены только F-клавиши",
    };
  }

  return { valid: true };
}

export function normalizeHotkey(hotkey: string): { valid: boolean; normalized?: string; error?: string } {
  const validation = validateHotkey(hotkey);
  if (!validation.valid) {
    return validation;
  }

  const parts = hotkey
    .split("+")
    .map((part) => normalizeHotkeyPart(part))
    .filter((part): part is string => part !== null);
  const modifiers = MODIFIER_ORDER.filter((modifier) => parts.includes(modifier));
  const mainKey = parts.find((part) => !isModifier(part));

  if (!mainKey) {
    return {
      valid: false,
      error: "Добавьте основную клавишу: Space, букву, цифру или F-клавишу",
    };
  }

  return {
    valid: true,
    normalized: [...modifiers, mainKey].join("+"),
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  provider: "openai",
  whisperModel: "whisper-1",
  llmModel: "gpt-4o-mini",
  hotkey: DEFAULT_HOTKEY,
  language: "ru",
  doubleTapTimeout: 400,
  style: "classic",
  micId: "",
  whisperEndpoint: "",
  llmEndpoint: "",
  useOwnKey: true,
  deviceToken: "",
};

function parseStyle(value: unknown): AppSettings["style"] | undefined {
  if (value === "classic" || value === "business" || value === "tech") {
    return value;
  }

  return undefined;
}

function parseProvider(value: unknown): ApiProvider | undefined {
  if (value === "openai" || value === "custom") {
    return value;
  }
  return undefined;
}

function normalizeSavedSettings(saved: unknown): Partial<AppSettings> {
  if (!saved || typeof saved !== "object") {
    return {};
  }

  const raw = saved as Record<string, unknown>;

  return {
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    provider: parseProvider(raw.provider),
    whisperModel: typeof raw.whisperModel === "string" ? raw.whisperModel : undefined,
    llmModel: typeof raw.llmModel === "string" ? raw.llmModel : undefined,
    hotkey: typeof raw.hotkey === "string" ? normalizeHotkey(raw.hotkey).normalized : undefined,
    language: typeof raw.language === "string" ? raw.language : undefined,
    doubleTapTimeout: typeof raw.doubleTapTimeout === "number" ? raw.doubleTapTimeout : undefined,
    style: parseStyle(raw.style),
    micId: typeof raw.micId === "string" ? raw.micId : undefined,
    whisperEndpoint: typeof raw.whisperEndpoint === "string" ? raw.whisperEndpoint : undefined,
    llmEndpoint: typeof raw.llmEndpoint === "string" ? raw.llmEndpoint : undefined,
    useOwnKey: typeof raw.useOwnKey === "boolean" ? raw.useOwnKey : undefined,
  };
}

let _store: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!_store) {
    _store = await load("talkis.json");
  }
  return _store;
}

export async function getSettings(): Promise<AppSettings> {
  const store = await getStore();
  const saved = await store.get<unknown>("settings");
  const result = { ...DEFAULT_SETTINGS, ...normalizeSavedSettings(saved) };
  return result;
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const store = await getStore();
  const current = await getSettings();
  const nextSettings = { ...current, ...settings };

  if (typeof settings.hotkey === "string") {
    const normalized = normalizeHotkey(settings.hotkey);
    if (!normalized.valid || !normalized.normalized) {
      throw new Error(normalized.error || "Неверный формат горячей клавиши");
    }

    nextSettings.hotkey = normalized.normalized;
  }

  await store.set("settings", nextSettings);
  await store.save();
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const store = await getStore();
  return (await store.get<HistoryEntry[]>("history")) || [];
}

export async function addHistoryEntry(entry: HistoryEntry): Promise<void> {
  const store = await getStore();
  const history = await getHistory();
  const updated = [entry, ...history].slice(0, 500); // max 500 entries
  await store.set("history", updated);
  await store.save();
}

export async function updateHistoryEntry(entry: HistoryEntry): Promise<void> {
  const store = await getStore();
  const history = await getHistory();
  const updated = history.map((item) => (item.id === entry.id ? entry : item));
  await store.set("history", updated);
  await store.save();
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const store = await getStore();
  const history = await getHistory();
  await store.set("history", history.filter((e) => e.id !== id));
  await store.save();
}

export async function clearHistory(): Promise<void> {
  const store = await getStore();
  await store.set("history", []);
  await store.save();
}

const PERMISSIONS_PASSED_KEY = "permissions_passed";
const WIDGET_POSITION_KEY = "widget_position";

export async function getPermissionsPassed(): Promise<boolean> {
  const store = await getStore();
  return (await store.get<boolean>(PERMISSIONS_PASSED_KEY)) ?? false;
}

export async function setPermissionsPassed(value: boolean): Promise<void> {
  const store = await getStore();
  await store.set(PERMISSIONS_PASSED_KEY, value);
  await store.save();
}

export async function getWidgetPosition(): Promise<WidgetPosition | null> {
  const store = await getStore();
  const saved = await store.get<unknown>(WIDGET_POSITION_KEY);

  if (!saved || typeof saved !== "object") {
    return null;
  }

  const raw = saved as Record<string, unknown>;
  if (typeof raw.x !== "number" || typeof raw.y !== "number") {
    return null;
  }

  return { x: raw.x, y: raw.y };
}

export async function saveWidgetPosition(position: WidgetPosition): Promise<void> {
  const store = await getStore();
  await store.set(WIDGET_POSITION_KEY, position);
  await store.save();
}
