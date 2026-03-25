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

export interface AppSettings {
  apiKey: string;
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
}

const MODIFIERS = ["Ctrl", "Alt", "Option", "Shift", "Command", "Cmd", "Meta", "Control"];
export const DEFAULT_HOTKEY = "Command+Space";

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

export function validateHotkey(hotkey: string): { valid: boolean; error?: string } {
  const parts = hotkey.split("+").map(p => p.trim());
  const modifiers = parts.filter(p => MODIFIERS.includes(p));
  const mainKeys = parts.filter(p => !MODIFIERS.includes(p));
  
  if (parts.length < 2) {
    return { 
      valid: false, 
      error: "Минимум 2 клавиши: модификатор + основная клавиша" 
    };
  }
  
  if (mainKeys.length === 0) {
    return { 
      valid: false, 
      error: "Добавьте основную клавишу (Space, A, F1 и т.д.)" 
    };
  }
  
  if (mainKeys.length > 1) {
    return { 
      valid: false, 
      error: "Только одна основная клавиша" 
    };
  }

  if (modifiers.length === 0) {
    return {
      valid: false,
      error: "Добавьте хотя бы один модификатор: Ctrl, Alt/Option, Shift или Cmd"
    };
  }
  
  return { valid: true };
}

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  language: "ru",
  doubleTapTimeout: 400,
  style: "classic",
  micId: "",
  whisperEndpoint: "",
  llmEndpoint: "",
  useOwnKey: true,
};

function parseStyle(value: unknown): AppSettings["style"] | undefined {
  if (value === "classic" || value === "business" || value === "tech") {
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
    _store = await load("talkflow.json");
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
  await store.set("settings", { ...current, ...settings });
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

export async function getPermissionsPassed(): Promise<boolean> {
  const store = await getStore();
  return (await store.get<boolean>(PERMISSIONS_PASSED_KEY)) ?? false;
}

export async function setPermissionsPassed(value: boolean): Promise<void> {
  const store = await getStore();
  await store.set(PERMISSIONS_PASSED_KEY, value);
  await store.save();
}
