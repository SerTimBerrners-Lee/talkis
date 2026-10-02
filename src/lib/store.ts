import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";

import { DEFAULT_WIDGET_SCALE, normalizeWidgetScale } from "./widgetScale";
import { recordTranscriptionStats } from "./stats";
import { logError, logInfo } from "./logger";
import { createSerialTaskQueue } from "./serialTaskQueue";

export interface SummaryEntry {
  id: string;
  /** ISO timestamp when this summary was generated. */
  createdAt: string;
  /** Generation time in milliseconds. */
  durationMs: number;
  /** Id of the summary prompt preset used. */
  promptId: string;
  /** Display name of the preset at generation time (so old summaries keep their label). */
  promptName: string;
  text: string;
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  duration: number;
  raw: string;
  cleaned: string;
  source?: "voice" | "file" | "call" | "liveTranslation";
  fileName?: string;
  fileSize?: number;
  callSessionId?: string;
  callTracks?: {
    kind: "mic" | "system";
    label: string;
    path: string;
  }[];
  callCapturePhase?: "recording" | "finalizing" | "recovered";
  status?: "recording" | "processing" | "completed" | "failed" | "interrupted";
  errorMessage?: string;
  audioPath?: string;
  audioBase64?: string;
  audioMimeType?: string;
  audioFileName?: string;
  /** Source file path kept for re-processing interrupted/failed file transcriptions. */
  filePath?: string;
  language?: string;
  style?: AppSettings["style"];
  /** Total processing time in milliseconds (STT + LLM) */
  processingTime?: number;
  mode?: "plain" | "speakers";
  speakers?: Speaker[];
  segments?: SpeakerTranscriptSegment[];
  dictationTranslation?: DictationTranslationMetadata;
  liveTranslation?: {
    targetLanguage: string;
    adapterId: string;
    segments: LiveTranslationSegment[];
  };
  /** Generated summaries for this record (newest first); persists across restarts. */
  summaries?: SummaryEntry[];
}

export interface HistoryListEntry {
  id: string;
  timestamp: string;
  duration: number;
  source: "voice" | "file" | "call" | "liveTranslation";
  status?: HistoryEntry["status"];
  errorMessage?: string;
  processingTime?: number;
  fileName?: string;
  mode?: HistoryEntry["mode"];
  textPreview: string;
  textLength: number;
  hasAudio: boolean;
  hasCallTracks: boolean;
  hasFilePath: boolean;
  callCapturePhase?: HistoryEntry["callCapturePhase"];
  summaryCount: number;
}

export interface Speaker {
  id: string;
  label: string;
}

export interface SpeakerTranscriptSegment {
  start: number;
  end: number;
  speakerId: string;
  speakerLabel: string;
  text: string;
}

export type ApiProvider = "openai" | "custom";
export type ThemePreference = "system" | "light" | "dark";

export interface ApiAdapterSettings {
  apiKey: string;
  model: string;
  endpoint?: string;
  connectionStatus?: "saved" | "verified";
  lastConnectedAt?: string;
  lastTestedApiKey?: string;
  lastTestedModel?: string;
  lastTestedEndpoint?: string;
  /** Result of a realtime handshake for the exact tested configuration. */
  streamingCapability?: "supported" | "unsupported";
  /** Stable, non-secret fingerprint of provider/model/endpoint/API-key configuration. */
  streamingCapabilityFingerprint?: string;
}

export type LiveTranslationChannel = "mic" | "system";
export type LiveTranslationSegmentState = "partial" | "final";

export interface LiveTranslationSegment {
  sessionId: string;
  channel: LiveTranslationChannel;
  speakerId?: string;
  startedAtMs: number;
  endedAtMs?: number;
  original: string;
  translated: string;
  state: LiveTranslationSegmentState;
  /** Number of translated characters already finalized by the provider. */
  stableTranslatedLength?: number;
}

export interface LocalModelSettings {
  status: "not_downloaded" | "downloading" | "downloaded" | "error";
  message?: string;
  downloadedAt?: string;
  lastCheckedAt?: string;
}

/** Kind of text processing a prompt performs. */
export type PromptKind = "cleanup" | "summary";

/**
 * A reusable prompt preset. Built-in presets ship with the app; user presets
 * are stored in settings. Both are merged at runtime via {@link getAllPrompts}.
 */
export interface PromptPreset {
  id: string;
  name: string;
  kind: PromptKind;
  /** Instruction applied to the transcript text. */
  prompt: string;
  /** Built-in presets cannot be deleted (only duplicated). */
  builtin?: boolean;
  /** Optional sampling temperature for this preset. */
  temperature?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface DictationTranslationMetadata {
  provider: "cloud" | "custom" | "local";
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  translatedText: string;
}

export interface TranslationSettings {
  /** Legacy persisted flag; the quick dictation-translation button was removed. */
  widgetEnabled: boolean;
  /** Translate ordinary dictation after recognition, before paste. */
  active: boolean;
  /** Target language code for translated dictation. */
  targetLanguage: string;
  /** Target language code for selected-text translation. */
  selectionTargetLanguage: string;
  /** One-time migration marker for the selected-text translation target. */
  selectionTargetMigrationVersion: number;
  /** Enable translating selected text from any app via a separate hotkey. */
  selectionEnabled: boolean;
  /** Global hotkey for translating the currently selected text. */
  selectionHotkey: string;
  /** Local translator provider selected for selected-text translation. Empty means LLM fallback only. */
  selectionLocalTranslatorProvider: string;
  /** One-time migration marker for the selected-text translation default. */
  selectionEnableMigrationVersion: number;
  /** Show the separate synchronous-translation button in the widget. */
  liveWidgetEnabled: boolean;
  /** Include microphone audio in synchronous translation. Off avoids speaker echo duplication. */
  liveMicrophoneEnabled: boolean;
  /** BCP-47 target language for synchronous microphone/system translation. */
  liveTargetLanguage: string;
  /** Speak synchronous OpenAI Realtime translation through the system output. */
  liveVoiceEnabled: boolean;
  /** OpenAI Realtime voice used for synchronous translation playback. */
  liveVoice: string;
  /** Playback gain for synchronous translation, from 0 to 1. */
  liveVoiceVolume: number;
  /** OpenAI Realtime output speech speed multiplier. */
  liveVoiceSpeed: number;
  /** Mute captured source playback while keeping its full-level tap signal. */
  liveMuteOriginalEnabled: boolean;
}

export interface AppSettings {
  apiKey: string;
  /** Saved API adapter credentials keyed by adapter id */
  apiAdapters: Record<string, ApiAdapterSettings>;
  /** API adapter selected for active API transcription mode */
  selectedApiAdapter: string;
  /** Realtime translation credentials keyed by adapter id. */
  translationAdapters: Record<string, ApiAdapterSettings>;
  /** Adapter used for synchronous translation. */
  selectedTranslationAdapter: string;
  /** Cached local model states keyed by local catalog id */
  localModels: Record<string, LocalModelSettings>;
  /** Optional custom directory for downloaded local STT models; empty means default app data path */
  localModelsDir: string;
  /** Optional custom directory for transcript history and call recordings; empty means default app storage */
  transcriptionStorageDir: string;
  /** Save audio files for completed voice history entries. */
  saveRecordingAudio: boolean;
  /** Use realtime transcription whenever the selected STT model supports streaming. */
  realtimeTranscriptionEnabled: boolean;
  /** Separate API key for Whisper/STT endpoint (used in custom mode) */
  whisperApiKey: string;
  /** Separate API key for LLM endpoint (used in custom mode; empty = skip LLM) */
  llmApiKey: string;
  /** API provider preset: 'openai' uses default endpoints, 'custom' lets user configure everything */
  provider: ApiProvider;
  /** Model name for STT (e.g. "whisper-1", "whisper-large-v3-turbo") */
  whisperModel: string;
  /** Model name for LLM cleanup (e.g. "gpt-4o-mini", "deepseek-chat") */
  llmModel: string;
  hotkey: string;
  /** Floating widget visual scale. 1 = 100%. */
  widgetScale: number;
  /** Keep dictation running while hiding the floating widget. */
  widgetVisible: boolean;
  /** Start with the settings window hidden, keeping tray and hotkeys active. */
  startMinimized: boolean;
  theme: ThemePreference;
  /** Transcription/recognition language (not the UI language). */
  language: string;
  /** UI/interface language. Undefined = auto-detect from OS on first run. */
  uiLanguage?: "ru" | "en";
  doubleTapTimeout: number;
  style: "classic" | "business" | "tech";
  /** User-defined prompt presets (built-in presets are merged in at runtime). */
  prompts: PromptPreset[];
  /** Id of the cleanup preset that drives transcription text style. */
  selectedCleanupPromptId: string;
  /** Id of the summary preset offered by default in the summary panel. */
  defaultSummaryPromptId: string;
  micId: string;
  /** Custom Whisper-compatible endpoint URL (leave empty for OpenAI) */
  whisperEndpoint: string;
  /** Custom LLM endpoint URL (leave empty for OpenAI) */
  llmEndpoint: string;
  /** When non-empty, llmEndpoint points at the BUNDLED local runtime serving this
   *  managed GGUF model id. Lets summary (re)start the sidecar before a request —
   *  the process dies on app restart while the endpoint stays persisted. Empty for
   *  a user's own local server (e.g. Ollama) or any non-local endpoint. */
  llmLocalModelId: string;
  /** If true, user provides their own API key. If false, uses subscription */
  useOwnKey: boolean;
  /** Device auth token for Talkis Cloud */
  deviceToken: string;
  /** Default file transcription mode: split uploaded files by speakers */
  fileSpeakerDiarization: boolean;
  /** Dictation translation mode controlled from the widget. */
  translation: TranslationSettings;
}

export interface WidgetPosition {
  x: number;
  y: number;
}

const HISTORY_MAX_VOICE_ENTRIES = 1000;
const HISTORY_MAX_FILE_ENTRIES = 200;
const HISTORY_MAX_CALL_ENTRIES = 200;
const HISTORY_MAX_LIVE_TRANSLATION_ENTRIES = 200;
const HISTORY_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const HISTORY_MAX_SUMMARIES_PER_ENTRY = 3;
export const HISTORY_MAX_VOICE_AUDIO_ENTRIES = 100;

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
  return: "Enter",
  enter: "Enter",
  space: "Space",
  spacebar: "Space",
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
const DEFAULT_MAC_HOTKEY = "Command+Shift+Space";
const DEFAULT_DESKTOP_HOTKEY = "Control+Alt+Space";
const DEFAULT_LANGUAGE = "ru";
const LEGACY_SELECTION_TRANSLATION_HOTKEYS = [
  "Command+Alt+Y",
  "Control+Command+T",
  "Alt+T",
  "Control+Alt+Y",
];
const SELECTION_ENABLE_MIGRATION_VERSION = 1;
const SELECTION_TARGET_MIGRATION_VERSION = 1;
const LEGACY_SELECTION_LOCAL_TRANSLATOR_PROVIDER = "trad";
const DEFAULT_SELECTION_LOCAL_TRANSLATOR_PROVIDER = "nllb-200";
const DEFAULT_MAC_SELECTION_TRANSLATION_HOTKEY = "Control+Shift+Y";
const DEFAULT_DESKTOP_SELECTION_TRANSLATION_HOTKEY = "Control+Shift+Y";
const RESERVED_MAC_SYSTEM_HOTKEYS = new Set(["Command+Z", "Shift+Command+Z"]);
const BUNDLED_LOCAL_LLM_PORTS = new Set([8011]);
const BUNDLED_LOCAL_LLM_MODEL_IDS = new Set([
  "qwen3-1.7b-instruct-q4",
  "qwen3-4b-instruct-q4",
  "qwen3-8b-instruct-q4",
  "granite-3.3-2b-instruct-q4",
  "smollm3-3b-q4",
  "phi-4-mini-instruct-q4",
  "gemma-3-4b-it-q4",
  "qwen2.5-3b-instruct-q4",
  "qwen2.5-7b-instruct-q4",
]);

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function getDefaultHotkey(): string {
  return isMacPlatform() ? DEFAULT_MAC_HOTKEY : DEFAULT_DESKTOP_HOTKEY;
}

export const DEFAULT_HOTKEY = getDefaultHotkey();

export function getDefaultSelectionTranslationHotkey(): string {
  return isMacPlatform()
    ? DEFAULT_MAC_SELECTION_TRANSLATION_HOTKEY
    : DEFAULT_DESKTOP_SELECTION_TRANSLATION_HOTKEY;
}

export const DEFAULT_SELECTION_TRANSLATION_HOTKEY =
  getDefaultSelectionTranslationHotkey();

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

function normalizedHotkeyFromParts(parts: string[]): string | null {
  const modifiers = MODIFIER_ORDER.filter((modifier) =>
    parts.includes(modifier),
  );
  const mainKey = parts.find((part) => !isModifier(part));
  return mainKey ? [...modifiers, mainKey].join("+") : null;
}

function isSingleLetterMainKey(mainKey: string | undefined): boolean {
  return /^[A-Z]$/.test(mainKey || "");
}

function isCommandShiftLetterHotkey(parts: string[]): boolean {
  const modifiers = parts.filter(isModifier);
  const mainKey = parts.find((part) => !isModifier(part));
  return (
    modifiers.includes("Command") &&
    modifiers.includes("Shift") &&
    isSingleLetterMainKey(mainKey)
  );
}

export function isReservedMacSystemHotkey(
  hotkey: string | null | undefined,
  macPlatform: boolean = isMacPlatform(),
): boolean {
  if (!hotkey || !macPlatform) return false;

  const parts = hotkey
    .split("+")
    .map((part) => normalizeHotkeyPart(part))
    .filter((part): part is string => part !== null);
  const normalized = normalizedHotkeyFromParts(parts);
  return normalized ? RESERVED_MAC_SYSTEM_HOTKEYS.has(normalized) : false;
}

export function isUnsafeMacGlobalHotkey(
  hotkey: string | null | undefined,
  macPlatform: boolean = isMacPlatform(),
): boolean {
  if (!hotkey || !macPlatform) return false;

  const parts = hotkey
    .split("+")
    .map((part) => normalizeHotkeyPart(part))
    .filter((part): part is string => part !== null);
  return (
    isReservedMacSystemHotkey(hotkey, macPlatform) ||
    isCommandShiftLetterHotkey(parts)
  );
}

export function validateHotkey(hotkey: string): {
  valid: boolean;
  error?: string;
} {
  const parts = hotkey.split("+").map((part) => normalizeHotkeyPart(part));
  if (parts.some((part) => part === null)) {
    return {
      valid: false,
      error:
        "Поддерживаются буквы, цифры, Space, Enter, стрелки, F1–F12 и стандартные модификаторы",
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
      error:
        "Добавьте основную клавишу: букву, цифру, Space, Enter, стрелку или F1–F12",
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

  const normalizedHotkey = normalizedHotkeyFromParts(normalizedParts);
  if (
    normalizedHotkey &&
    isMacPlatform() &&
    RESERVED_MAC_SYSTEM_HOTKEYS.has(normalizedHotkey)
  ) {
    return {
      valid: false,
      error:
        "Command + Z и Command + Shift + Z заняты системным Undo/Redo. Выберите другое сочетание.",
    };
  }

  if (isMacPlatform() && isCommandShiftLetterHotkey(normalizedParts)) {
    return {
      valid: false,
      error:
        "На macOS сочетания Command + Shift + буква пересекаются с системными командами в разных раскладках. Используйте Space, F-клавишу или Option вместо Shift.",
    };
  }

  if (
    isMacPlatform() &&
    modifiers.includes("Control") &&
    modifiers.includes("Alt")
  ) {
    return {
      valid: false,
      error:
        "На macOS сочетания Control + Option часто перехватываются VoiceOver. Выберите другое сочетание.",
    };
  }

  if (modifiers.length === 0) {
    return {
      valid: false,
      error: "Добавьте хотя бы один модификатор: Cmd, Ctrl, Alt или Shift",
    };
  }

  return { valid: true };
}

export function normalizeHotkey(hotkey: string): {
  valid: boolean;
  normalized?: string;
  error?: string;
} {
  const validation = validateHotkey(hotkey);
  if (!validation.valid) {
    return validation;
  }

  const parts = hotkey
    .split("+")
    .map((part) => normalizeHotkeyPart(part))
    .filter((part): part is string => part !== null);
  const modifiers = MODIFIER_ORDER.filter((modifier) =>
    parts.includes(modifier),
  );
  const mainKey = parts.find((part) => !isModifier(part));

  if (!mainKey) {
    return {
      valid: false,
      error:
        "Добавьте основную клавишу: букву, цифру, Space, Enter, стрелку или F1–F12",
    };
  }

  return {
    valid: true,
    normalized: [...modifiers, mainKey].join("+"),
  };
}

export const DEFAULT_CLEANUP_PROMPT_ID = "classic";
export const DEFAULT_SUMMARY_PROMPT_ID = "summary-short";

/**
 * Built-in prompt presets shipped with the app. Cleanup ids match the legacy
 * `style` values (classic/business/tech) so migration is a straight mapping.
 * These are merged with user presets at runtime and never written to storage.
 */
export const BUILTIN_PROMPTS: PromptPreset[] = [
  {
    id: "classic",
    name: "Классический",
    kind: "cleanup",
    builtin: true,
    temperature: 0,
    prompt:
      "Исправь ошибки и пунктуацию, убери словесный мусор. Сохрани текст максимально близким к оригиналу. Не добавляй новых фактов.",
  },
  {
    id: "business",
    name: "Деловой",
    kind: "cleanup",
    builtin: true,
    temperature: 0.1,
    prompt:
      "Сделай речь чище и формальнее, сгладь явные запинки. Подходит для писем, задач и рабочих переписок. Не добавляй новых фактов.",
  },
  {
    id: "tech",
    name: "Разработка",
    kind: "cleanup",
    builtin: true,
    temperature: 0.15,
    prompt:
      "Обрабатывай текст с упором на терминологию и код: команды, пути, API и фразы вроде «консоль лог» превращай в канонический код.",
  },
  {
    id: "summary-short",
    name: "Краткое саммари",
    kind: "summary",
    builtin: true,
    temperature: 0.3,
    prompt:
      "Сделай краткое саммари разговора на русском: несколько предложений о сути, без воды. Не выдумывай детали, которых нет в тексте.",
  },
  {
    id: "summary-bullets",
    name: "Саммари по пунктам",
    kind: "summary",
    builtin: true,
    temperature: 0.3,
    prompt:
      "Сделай саммари разговора на русском в виде маркированного списка: каждый пункт — отдельный ключевой момент, факт или вывод. Будь лаконичен и не выдумывай того, чего нет в тексте.",
  },
  {
    id: "summary-actions",
    name: "Задачи и решения",
    kind: "summary",
    builtin: true,
    temperature: 0.2,
    prompt:
      "Из разговора выдели на русском три раздела: 1) Принятые решения; 2) Задачи и поручения (кто, что, срок, если есть); 3) Открытые вопросы. Если раздел пустой, пропусти его.",
  },
];

const BUILTIN_PROMPT_ID_SET = new Set(
  BUILTIN_PROMPTS.map((preset) => preset.id),
);

export function isLocalSttEndpoint(endpoint?: string): boolean {
  return /127\.0\.0\.1|localhost/i.test(endpoint || "");
}

function normalizeLocalSttEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) return endpoint;

  try {
    const parsed = new URL(endpoint);
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      return endpoint;
    }

    if (parsed.port === "8001" || parsed.port === "8002") {
      parsed.port = "8000";
      return parsed.toString().replace(/\/$/, "");
    }
  } catch {
    return endpoint;
  }

  return endpoint;
}

function needsLocalSttSettingsMigration(saved: unknown): boolean {
  if (!saved || typeof saved !== "object") {
    return false;
  }

  const raw = saved as Record<string, unknown>;
  const endpoint =
    typeof raw.whisperEndpoint === "string" ? raw.whisperEndpoint : "";
  if (!isLocalSttEndpoint(endpoint)) {
    return false;
  }

  const normalizedEndpoint = normalizeLocalSttEndpoint(endpoint);
  return (
    raw.useOwnKey !== true ||
    raw.provider !== "custom" ||
    raw.whisperApiKey !== "" ||
    normalizedEndpoint !== endpoint
  );
}

export function needsHotkeySettingsMigration(
  saved: unknown,
  settings: Partial<AppSettings>,
): boolean {
  if (!saved || typeof saved !== "object") {
    return false;
  }

  const raw = saved as Record<string, unknown>;
  const currentVoiceHotkey =
    typeof settings.hotkey === "string"
      ? normalizeHotkey(settings.hotkey).normalized
      : undefined;
  if (typeof raw.hotkey === "string") {
    const savedVoiceHotkey = normalizeHotkey(raw.hotkey).normalized;
    if (!savedVoiceHotkey || savedVoiceHotkey !== currentVoiceHotkey) {
      return true;
    }
  }

  const rawTranslation =
    raw.translation && typeof raw.translation === "object"
      ? (raw.translation as Record<string, unknown>)
      : null;
  if (rawTranslation) {
    const selectionEnableMigrationVersion =
      typeof rawTranslation.selectionEnableMigrationVersion === "number"
        ? rawTranslation.selectionEnableMigrationVersion
        : 0;
    if (selectionEnableMigrationVersion < SELECTION_ENABLE_MIGRATION_VERSION) {
      return true;
    }
    const selectionTargetMigrationVersion =
      typeof rawTranslation.selectionTargetMigrationVersion === "number"
        ? rawTranslation.selectionTargetMigrationVersion
        : 0;
    if (selectionTargetMigrationVersion < SELECTION_TARGET_MIGRATION_VERSION) {
      return true;
    }
  }
  if (!rawTranslation || typeof rawTranslation.selectionHotkey !== "string") {
    return false;
  }

  const savedSelectionHotkey = normalizeHotkey(
    rawTranslation.selectionHotkey,
  ).normalized;
  const currentSelectionHotkey =
    typeof settings.translation?.selectionHotkey === "string"
      ? normalizeHotkey(settings.translation.selectionHotkey).normalized
      : undefined;

  return (
    !savedSelectionHotkey || savedSelectionHotkey !== currentSelectionHotkey
  );
}

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  apiAdapters: {},
  selectedApiAdapter: "openai",
  translationAdapters: {},
  selectedTranslationAdapter: "openai",
  localModels: {},
  localModelsDir: "",
  transcriptionStorageDir: "",
  saveRecordingAudio: false,
  realtimeTranscriptionEnabled: true,
  whisperApiKey: "",
  llmApiKey: "",
  provider: "openai",
  whisperModel: "whisper-1",
  llmModel: "gpt-4o-mini",
  hotkey: DEFAULT_HOTKEY,
  widgetScale: DEFAULT_WIDGET_SCALE,
  widgetVisible: true,
  startMinimized: false,
  theme: "system",
  language: DEFAULT_LANGUAGE,
  doubleTapTimeout: 400,
  style: "classic",
  prompts: [],
  selectedCleanupPromptId: DEFAULT_CLEANUP_PROMPT_ID,
  defaultSummaryPromptId: DEFAULT_SUMMARY_PROMPT_ID,
  micId: "",
  whisperEndpoint: "",
  llmEndpoint: "",
  llmLocalModelId: "",
  useOwnKey: true,
  deviceToken: "",
  fileSpeakerDiarization: false,
  translation: {
    widgetEnabled: false,
    active: false,
    targetLanguage: "en",
    selectionTargetLanguage:
      defaultSelectionTranslationTarget(DEFAULT_LANGUAGE),
    selectionTargetMigrationVersion: SELECTION_TARGET_MIGRATION_VERSION,
    selectionEnabled: true,
    selectionHotkey: DEFAULT_SELECTION_TRANSLATION_HOTKEY,
    selectionLocalTranslatorProvider: "",
    selectionEnableMigrationVersion: SELECTION_ENABLE_MIGRATION_VERSION,
    liveWidgetEnabled: false,
    liveMicrophoneEnabled: false,
    liveTargetLanguage: "en",
    liveVoiceEnabled: false,
    liveVoice: "marin",
    liveVoiceVolume: 0.8,
    liveVoiceSpeed: 1.05,
    liveMuteOriginalEnabled: true,
  },
};

function parseStyle(value: unknown): AppSettings["style"] | undefined {
  if (value === "classic" || value === "business" || value === "tech") {
    return value;
  }

  return undefined;
}

function parsePromptKind(value: unknown): PromptKind | undefined {
  return value === "cleanup" || value === "summary" ? value : undefined;
}

/**
 * Parse stored user prompt presets. Built-in ids are reserved and merged at
 * runtime, so any stored preset reusing a built-in id is dropped.
 */
function parsePrompts(value: unknown): PromptPreset[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const presets: PromptPreset[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const kind = parsePromptKind(raw.kind);
    const prompt = typeof raw.prompt === "string" ? raw.prompt : "";

    if (!id || !name || !kind || BUILTIN_PROMPT_ID_SET.has(id)) {
      continue;
    }

    presets.push({
      id,
      name,
      kind,
      prompt,
      builtin: false,
      temperature:
        typeof raw.temperature === "number" ? raw.temperature : undefined,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    });
  }

  return presets;
}

function parseTheme(value: unknown): ThemePreference | undefined {
  if (value === "black") {
    return "dark";
  }

  if (value === "system" || value === "light" || value === "dark") {
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

function isBundledLocalLlmEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(/:(\d{4,5})(?:\/|$)/);
  if (!match) return false;
  const port = Number(match[1]);
  return BUNDLED_LOCAL_LLM_PORTS.has(port) || (port >= 18200 && port <= 18249);
}

function parseBundledLocalLlmModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const modelId = value.trim();
  return BUNDLED_LOCAL_LLM_MODEL_IDS.has(modelId) ? modelId : undefined;
}

function defaultTranslationTarget(sourceLanguage: string | undefined): string {
  return sourceLanguage === "en" ? "ru" : "en";
}

function defaultSelectionTranslationTarget(
  sourceLanguage: string | undefined,
): string {
  return sourceLanguage && sourceLanguage !== "auto" ? sourceLanguage : "en";
}

function normalizeSelectionLocalTranslatorProvider(provider: unknown): string {
  if (typeof provider !== "string") {
    return "";
  }

  const normalized = provider.trim();
  return normalized === LEGACY_SELECTION_LOCAL_TRANSLATOR_PROVIDER
    ? DEFAULT_SELECTION_LOCAL_TRANSLATOR_PROVIDER
    : normalized;
}

function normalizeTranslationSettings(
  translation: TranslationSettings,
  sourceLanguage: string,
): TranslationSettings {
  const source = sourceLanguage || DEFAULT_SETTINGS.language;
  const fallbackTarget = defaultTranslationTarget(source);
  const fallbackSelectionTarget =
    defaultSelectionTranslationTarget(sourceLanguage);
  const normalizedTarget =
    translation.targetLanguage &&
    translation.targetLanguage !== "auto" &&
    (source === "auto" || translation.targetLanguage !== source)
      ? translation.targetLanguage
      : fallbackTarget;
  const normalizedSelectionTarget =
    translation.selectionTargetLanguage &&
    translation.selectionTargetLanguage !== "auto"
      ? translation.selectionTargetLanguage
      : fallbackSelectionTarget;
  const normalizedSelectionHotkey =
    typeof translation.selectionHotkey === "string"
      ? normalizeHotkey(translation.selectionHotkey).normalized
      : undefined;
  const isLegacySelectionHotkey = LEGACY_SELECTION_TRANSLATION_HOTKEYS.map(
    (hotkey) => normalizeHotkey(hotkey).normalized,
  ).includes(normalizedSelectionHotkey);
  const selectionHotkey = isLegacySelectionHotkey
    ? DEFAULT_SELECTION_TRANSLATION_HOTKEY
    : normalizedSelectionHotkey || DEFAULT_SELECTION_TRANSLATION_HOTKEY;

  return {
    widgetEnabled: translation.widgetEnabled,
    active: translation.active,
    targetLanguage: normalizedTarget,
    selectionTargetLanguage: normalizedSelectionTarget,
    selectionTargetMigrationVersion: SELECTION_TARGET_MIGRATION_VERSION,
    selectionEnabled: translation.selectionEnabled,
    selectionHotkey,
    selectionLocalTranslatorProvider: normalizeSelectionLocalTranslatorProvider(
      translation.selectionLocalTranslatorProvider,
    ),
    selectionEnableMigrationVersion: SELECTION_ENABLE_MIGRATION_VERSION,
    liveWidgetEnabled: translation.liveWidgetEnabled,
    liveMicrophoneEnabled: translation.liveMicrophoneEnabled,
    liveTargetLanguage:
      translation.liveTargetLanguage &&
      translation.liveTargetLanguage !== "auto"
        ? translation.liveTargetLanguage
        : fallbackTarget,
    liveVoiceEnabled: translation.liveVoiceEnabled,
    liveVoice: translation.liveVoice.trim() || "marin",
    liveVoiceVolume: Math.min(1, Math.max(0, translation.liveVoiceVolume)),
    liveVoiceSpeed: Math.min(1.5, Math.max(0.25, translation.liveVoiceSpeed)),
    liveMuteOriginalEnabled: translation.liveMuteOriginalEnabled,
  };
}

function nonConflictingSelectionHotkey(voiceHotkey?: string): string {
  const voice = voiceHotkey
    ? normalizeHotkey(voiceHotkey).normalized
    : undefined;
  const candidates = isMacPlatform()
    ? [DEFAULT_MAC_SELECTION_TRANSLATION_HOTKEY, "Control+Shift+U"]
    : [DEFAULT_DESKTOP_SELECTION_TRANSLATION_HOTKEY, "Control+Alt+T"];
  return (
    candidates
      .map((candidate) => normalizeHotkey(candidate).normalized || candidate)
      .find((candidate) => candidate !== voice) ||
    DEFAULT_SELECTION_TRANSLATION_HOTKEY
  );
}

function parseTranslationSettings(
  value: unknown,
  sourceLanguage: string | undefined,
): TranslationSettings | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const selectionEnableMigrationVersion =
    typeof raw.selectionEnableMigrationVersion === "number"
      ? raw.selectionEnableMigrationVersion
      : 0;
  const selectionTargetMigrationVersion =
    typeof raw.selectionTargetMigrationVersion === "number"
      ? raw.selectionTargetMigrationVersion
      : 0;
  const shouldAutoEnableSelection =
    selectionEnableMigrationVersion < SELECTION_ENABLE_MIGRATION_VERSION &&
    raw.selectionEnabled === false;
  const rawSelectionTargetLanguage =
    typeof raw.selectionTargetLanguage === "string" &&
    raw.selectionTargetLanguage.trim()
      ? raw.selectionTargetLanguage.trim()
      : defaultSelectionTranslationTarget(sourceLanguage);
  const fallbackSelectionTarget =
    defaultSelectionTranslationTarget(sourceLanguage);
  const shouldMigrateSelectionTarget =
    selectionTargetMigrationVersion < SELECTION_TARGET_MIGRATION_VERSION &&
    sourceLanguage &&
    sourceLanguage !== "auto" &&
    rawSelectionTargetLanguage === "en" &&
    rawSelectionTargetLanguage !== fallbackSelectionTarget;

  return normalizeTranslationSettings(
    {
      widgetEnabled:
        typeof raw.widgetEnabled === "boolean" ? raw.widgetEnabled : false,
      active: typeof raw.active === "boolean" ? raw.active : false,
      targetLanguage:
        typeof raw.targetLanguage === "string" && raw.targetLanguage.trim()
          ? raw.targetLanguage.trim()
          : defaultTranslationTarget(sourceLanguage),
      selectionTargetLanguage: shouldMigrateSelectionTarget
        ? fallbackSelectionTarget
        : rawSelectionTargetLanguage,
      selectionTargetMigrationVersion,
      selectionEnabled: shouldAutoEnableSelection
        ? true
        : typeof raw.selectionEnabled === "boolean"
          ? raw.selectionEnabled
          : DEFAULT_SETTINGS.translation.selectionEnabled,
      selectionHotkey:
        typeof raw.selectionHotkey === "string" && raw.selectionHotkey.trim()
          ? raw.selectionHotkey.trim()
          : DEFAULT_SELECTION_TRANSLATION_HOTKEY,
      selectionLocalTranslatorProvider:
        normalizeSelectionLocalTranslatorProvider(
          raw.selectionLocalTranslatorProvider,
        ),
      selectionEnableMigrationVersion,
      liveWidgetEnabled:
        typeof raw.liveWidgetEnabled === "boolean"
          ? raw.liveWidgetEnabled
          : DEFAULT_SETTINGS.translation.liveWidgetEnabled,
      liveMicrophoneEnabled:
        typeof raw.liveMicrophoneEnabled === "boolean"
          ? raw.liveMicrophoneEnabled
          : DEFAULT_SETTINGS.translation.liveMicrophoneEnabled,
      liveTargetLanguage:
        typeof raw.liveTargetLanguage === "string" &&
        raw.liveTargetLanguage.trim()
          ? raw.liveTargetLanguage.trim()
          : defaultTranslationTarget(sourceLanguage),
      liveVoiceEnabled:
        typeof raw.liveVoiceEnabled === "boolean"
          ? raw.liveVoiceEnabled
          : DEFAULT_SETTINGS.translation.liveVoiceEnabled,
      liveVoice:
        typeof raw.liveVoice === "string" && raw.liveVoice.trim()
          ? raw.liveVoice.trim()
          : DEFAULT_SETTINGS.translation.liveVoice,
      liveVoiceVolume:
        typeof raw.liveVoiceVolume === "number" &&
        Number.isFinite(raw.liveVoiceVolume)
          ? raw.liveVoiceVolume
          : DEFAULT_SETTINGS.translation.liveVoiceVolume,
      liveVoiceSpeed:
        typeof raw.liveVoiceSpeed === "number" &&
        Number.isFinite(raw.liveVoiceSpeed)
          ? raw.liveVoiceSpeed
          : DEFAULT_SETTINGS.translation.liveVoiceSpeed,
      liveMuteOriginalEnabled:
        typeof raw.liveMuteOriginalEnabled === "boolean"
          ? raw.liveMuteOriginalEnabled
          : DEFAULT_SETTINGS.translation.liveMuteOriginalEnabled,
    },
    sourceLanguage || DEFAULT_SETTINGS.language,
  );
}

export function normalizeSavedSettings(saved: unknown): Partial<AppSettings> {
  if (!saved || typeof saved !== "object") {
    return {};
  }

  const raw = saved as Record<string, unknown>;
  const rawApiAdapters =
    raw.apiAdapters && typeof raw.apiAdapters === "object"
      ? Object.entries(raw.apiAdapters as Record<string, unknown>).reduce<
          Record<string, ApiAdapterSettings>
        >((acc, [key, value]) => {
          if (!value || typeof value !== "object") return acc;

          const adapter = value as Record<string, unknown>;
          acc[key] = {
            apiKey: typeof adapter.apiKey === "string" ? adapter.apiKey : "",
            model: typeof adapter.model === "string" ? adapter.model : "",
            endpoint:
              typeof adapter.endpoint === "string"
                ? adapter.endpoint
                : undefined,
            connectionStatus:
              adapter.connectionStatus === "saved" ||
              adapter.connectionStatus === "verified"
                ? adapter.connectionStatus
                : undefined,
            lastConnectedAt:
              typeof adapter.lastConnectedAt === "string"
                ? adapter.lastConnectedAt
                : undefined,
            lastTestedApiKey:
              typeof adapter.lastTestedApiKey === "string"
                ? adapter.lastTestedApiKey
                : undefined,
            lastTestedModel:
              typeof adapter.lastTestedModel === "string"
                ? adapter.lastTestedModel
                : undefined,
            lastTestedEndpoint:
              typeof adapter.lastTestedEndpoint === "string"
                ? adapter.lastTestedEndpoint
                : undefined,
            streamingCapability:
              adapter.streamingCapability === "supported" ||
              adapter.streamingCapability === "unsupported"
                ? adapter.streamingCapability
                : undefined,
            streamingCapabilityFingerprint:
              typeof adapter.streamingCapabilityFingerprint === "string"
                ? adapter.streamingCapabilityFingerprint
                : undefined,
          };
          return acc;
        }, {})
      : undefined;
  const rawTranslationAdapters =
    raw.translationAdapters && typeof raw.translationAdapters === "object"
      ? Object.entries(
          raw.translationAdapters as Record<string, unknown>,
        ).reduce<Record<string, ApiAdapterSettings>>((acc, [key, value]) => {
          if (!value || typeof value !== "object") return acc;
          const adapter = value as Record<string, unknown>;
          acc[key] = {
            apiKey: typeof adapter.apiKey === "string" ? adapter.apiKey : "",
            model: typeof adapter.model === "string" ? adapter.model : "",
            endpoint:
              typeof adapter.endpoint === "string"
                ? adapter.endpoint
                : undefined,
            connectionStatus:
              adapter.connectionStatus === "saved" ||
              adapter.connectionStatus === "verified"
                ? adapter.connectionStatus
                : undefined,
            lastConnectedAt:
              typeof adapter.lastConnectedAt === "string"
                ? adapter.lastConnectedAt
                : undefined,
            lastTestedApiKey:
              typeof adapter.lastTestedApiKey === "string"
                ? adapter.lastTestedApiKey
                : undefined,
            lastTestedModel:
              typeof adapter.lastTestedModel === "string"
                ? adapter.lastTestedModel
                : undefined,
            lastTestedEndpoint:
              typeof adapter.lastTestedEndpoint === "string"
                ? adapter.lastTestedEndpoint
                : undefined,
            streamingCapability:
              adapter.streamingCapability === "supported" ||
              adapter.streamingCapability === "unsupported"
                ? adapter.streamingCapability
                : undefined,
            streamingCapabilityFingerprint:
              typeof adapter.streamingCapabilityFingerprint === "string"
                ? adapter.streamingCapabilityFingerprint
                : undefined,
          };
          return acc;
        }, {})
      : undefined;

  const rawLocalModels =
    raw.localModels && typeof raw.localModels === "object"
      ? Object.entries(raw.localModels as Record<string, unknown>).reduce<
          Record<string, LocalModelSettings>
        >((acc, [key, value]) => {
          if (!value || typeof value !== "object") return acc;

          const model = value as Record<string, unknown>;
          const status =
            model.status === "downloading" ||
            model.status === "downloaded" ||
            model.status === "error"
              ? model.status
              : "not_downloaded";
          acc[key] = {
            status,
            message:
              typeof model.message === "string" ? model.message : undefined,
            downloadedAt:
              typeof model.downloadedAt === "string"
                ? model.downloadedAt
                : undefined,
            lastCheckedAt:
              typeof model.lastCheckedAt === "string"
                ? model.lastCheckedAt
                : undefined,
          };
          return acc;
        }, {})
      : undefined;
  const legacyStreamingValues = rawLocalModels
    ? Object.values(raw.localModels as Record<string, unknown>)
        .map((value) =>
          value && typeof value === "object"
            ? (value as Record<string, unknown>).streamingEnabled
            : undefined,
        )
        .filter((value): value is boolean => typeof value === "boolean")
    : [];
  const legacyStreamingEnabled = legacyStreamingValues.includes(false)
    ? false
    : legacyStreamingValues.includes(true)
      ? true
      : undefined;
  const normalizedHotkey =
    typeof raw.hotkey === "string"
      ? normalizeHotkey(raw.hotkey).normalized
      : undefined;
  const hotkey =
    !isMacPlatform() && normalizedHotkey === DEFAULT_MAC_HOTKEY
      ? DEFAULT_DESKTOP_HOTKEY
      : normalizedHotkey;

  const normalized: Partial<AppSettings> = {
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    apiAdapters: rawApiAdapters,
    selectedApiAdapter:
      typeof raw.selectedApiAdapter === "string"
        ? raw.selectedApiAdapter
        : undefined,
    translationAdapters: rawTranslationAdapters,
    selectedTranslationAdapter:
      typeof raw.selectedTranslationAdapter === "string"
        ? raw.selectedTranslationAdapter
        : undefined,
    localModels: rawLocalModels,
    localModelsDir: "",
    transcriptionStorageDir: "",
    saveRecordingAudio:
      typeof raw.saveRecordingAudio === "boolean"
        ? raw.saveRecordingAudio
        : undefined,
    realtimeTranscriptionEnabled:
      typeof raw.realtimeTranscriptionEnabled === "boolean"
        ? raw.realtimeTranscriptionEnabled
        : legacyStreamingEnabled,
    whisperApiKey:
      typeof raw.whisperApiKey === "string" ? raw.whisperApiKey : undefined,
    llmApiKey: typeof raw.llmApiKey === "string" ? raw.llmApiKey : undefined,
    provider: parseProvider(raw.provider),
    whisperModel:
      raw.whisperModel === "whisper-large-v2"
        ? "whisper-large-v3-turbo"
        : typeof raw.whisperModel === "string"
          ? raw.whisperModel
          : undefined,
    llmModel: typeof raw.llmModel === "string" ? raw.llmModel : undefined,
    hotkey,
    widgetScale:
      raw.widgetScale === undefined
        ? undefined
        : normalizeWidgetScale(raw.widgetScale),
    widgetVisible:
      typeof raw.widgetVisible === "boolean" ? raw.widgetVisible : undefined,
    startMinimized:
      typeof raw.startMinimized === "boolean" ? raw.startMinimized : undefined,
    theme: parseTheme(raw.theme),
    language: typeof raw.language === "string" ? raw.language : undefined,
    uiLanguage:
      raw.uiLanguage === "en" || raw.uiLanguage === "ru"
        ? raw.uiLanguage
        : undefined,
    doubleTapTimeout:
      typeof raw.doubleTapTimeout === "number"
        ? raw.doubleTapTimeout
        : undefined,
    style: parseStyle(raw.style),
    prompts: parsePrompts(raw.prompts),
    selectedCleanupPromptId:
      typeof raw.selectedCleanupPromptId === "string" &&
      raw.selectedCleanupPromptId.trim()
        ? raw.selectedCleanupPromptId.trim()
        : // Migration: fall back to the legacy `style` value, whose ids match
          // the built-in cleanup presets one-to-one.
          parseStyle(raw.style),
    defaultSummaryPromptId:
      typeof raw.defaultSummaryPromptId === "string" &&
      raw.defaultSummaryPromptId.trim()
        ? raw.defaultSummaryPromptId.trim()
        : undefined,
    micId: typeof raw.micId === "string" ? raw.micId : undefined,
    whisperEndpoint:
      typeof raw.whisperEndpoint === "string" ? raw.whisperEndpoint : undefined,
    llmEndpoint:
      typeof raw.llmEndpoint === "string" ? raw.llmEndpoint : undefined,
    llmLocalModelId:
      typeof raw.llmLocalModelId === "string"
        ? raw.llmLocalModelId
        : isBundledLocalLlmEndpoint(raw.llmEndpoint)
          ? parseBundledLocalLlmModelId(raw.llmModel)
          : undefined,
    useOwnKey: typeof raw.useOwnKey === "boolean" ? raw.useOwnKey : undefined,
    deviceToken:
      typeof raw.deviceToken === "string" ? raw.deviceToken : undefined,
    fileSpeakerDiarization:
      typeof raw.fileSpeakerDiarization === "boolean"
        ? raw.fileSpeakerDiarization
        : undefined,
    translation: parseTranslationSettings(
      raw.translation,
      typeof raw.language === "string" ? raw.language : undefined,
    ),
  };

  const normalizedTranslationHotkey = normalizeHotkey(
    normalized.translation?.selectionHotkey || "",
  ).normalized;
  const normalizedVoiceHotkey = normalizeHotkey(
    normalized.hotkey || "",
  ).normalized;
  if (
    normalized.translation &&
    normalizedTranslationHotkey &&
    normalizedVoiceHotkey &&
    normalizedTranslationHotkey === normalizedVoiceHotkey
  ) {
    normalized.translation = {
      ...normalized.translation,
      selectionHotkey: nonConflictingSelectionHotkey(normalized.hotkey),
    };
  }

  if (isLocalSttEndpoint(normalized.whisperEndpoint)) {
    normalized.whisperEndpoint = normalizeLocalSttEndpoint(
      normalized.whisperEndpoint,
    );
    normalized.useOwnKey = true;
    normalized.provider = "custom";
    normalized.whisperApiKey = "";
  }

  return normalized;
}

let _store: Awaited<ReturnType<typeof load>> | null = null;
let _appDataLayoutMigration: Promise<void> | null = null;
const settingsSaveQueue = createSerialTaskQueue();

async function getStore() {
  if (!_store) {
    _store = await load("talkis.json");
  }
  return _store;
}

function readLegacyPath(
  saved: unknown,
  key: "localModelsDir" | "transcriptionStorageDir",
): string {
  if (!saved || typeof saved !== "object") {
    return "";
  }

  const value = (saved as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

async function migrateAppDataLayoutOnce(saved: unknown): Promise<void> {
  if (_appDataLayoutMigration) {
    return _appDataLayoutMigration;
  }

  _appDataLayoutMigration = (async () => {
    const store = await getStore();
    const legacyHistory = (await store.get<HistoryEntry[]>("history")) || [];
    await invoke("migrate_app_data_layout", {
      legacyLocalModelsDir: readLegacyPath(saved, "localModelsDir") || null,
      legacyTranscriptionStorageDir:
        readLegacyPath(saved, "transcriptionStorageDir") || null,
      legacyHistory,
    });
  })().catch((error) => {
    console.warn("Failed to migrate app data layout", error);
  });

  return _appDataLayoutMigration;
}

function getHistoryEntrySource(
  entry: HistoryEntry,
): NonNullable<HistoryEntry["source"]> {
  if (
    entry.source === "file" ||
    entry.source === "call" ||
    entry.source === "liveTranslation"
  ) {
    return entry.source;
  }

  return "voice";
}

function estimateJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function historyEntryText(
  entry: Pick<HistoryEntry, "cleaned" | "raw">,
): string {
  const cleaned = entry.cleaned ?? "";
  return cleaned.length > 0 ? cleaned : (entry.raw ?? "");
}

export function toHistoryListEntry(entry: HistoryEntry): HistoryListEntry {
  const text = historyEntryText(entry);

  return {
    id: entry.id,
    timestamp: entry.timestamp,
    duration: entry.duration,
    source: getHistoryEntrySource(entry),
    status: entry.status,
    errorMessage: entry.errorMessage,
    processingTime: entry.processingTime,
    fileName: entry.fileName,
    mode: entry.mode,
    textPreview:
      text.length > 250 ? `${text.slice(0, 250).trimEnd()}...` : text,
    textLength: text.length,
    hasAudio: Boolean(entry.audioPath || entry.audioBase64),
    hasCallTracks: Boolean(entry.callTracks?.length),
    hasFilePath: Boolean(entry.filePath),
    callCapturePhase: entry.callCapturePhase,
    summaryCount: Math.min(
      entry.summaries?.length ?? 0,
      HISTORY_MAX_SUMMARIES_PER_ENTRY,
    ),
  };
}

export function compactHistoryEntryForStorage(
  entry: HistoryEntry,
): HistoryEntry {
  const summaries = entry.summaries?.slice(0, HISTORY_MAX_SUMMARIES_PER_ENTRY);
  const raw = entry.raw ?? "";
  const cleaned = entry.cleaned ?? "";
  const shouldCompactRaw = raw === cleaned;
  const next: HistoryEntry = {
    ...entry,
    raw: shouldCompactRaw ? "" : raw,
  };

  if (summaries) {
    next.summaries = summaries;
  }

  return next;
}

export function normalizeHistoryEntryFromStorage(
  entry: HistoryEntry,
): HistoryEntry {
  if (!entry.raw && entry.cleaned) {
    return { ...entry, raw: entry.cleaned };
  }

  return entry;
}

function normalizeHistoryFromStorage(history: HistoryEntry[]): HistoryEntry[] {
  return history.map(normalizeHistoryEntryFromStorage);
}

function pruneHistory(history: HistoryEntry[]): HistoryEntry[] {
  // History is ordered newest first. Keep the newest entries per source and
  // trim from the bottom so old voice recordings cannot evict recent file
  // transcriptions, and large file transcripts cannot grow storage forever.
  //
  // Limits:
  // - voice: 1000 entries
  // - file: 200 entries
  // - call: 200 entries
  // - combined JSON payload: 50 MB
  const limitedByType: HistoryEntry[] = [];
  let voiceCount = 0;
  let fileCount = 0;
  let callCount = 0;
  let liveTranslationCount = 0;

  for (const entry of history) {
    const source = getHistoryEntrySource(entry);

    if (source === "file") {
      if (fileCount >= HISTORY_MAX_FILE_ENTRIES) {
        continue;
      }
      fileCount += 1;
    } else if (source === "call") {
      if (callCount >= HISTORY_MAX_CALL_ENTRIES) {
        continue;
      }
      callCount += 1;
    } else if (source === "liveTranslation") {
      if (liveTranslationCount >= HISTORY_MAX_LIVE_TRANSLATION_ENTRIES) {
        continue;
      }
      liveTranslationCount += 1;
    } else {
      if (voiceCount >= HISTORY_MAX_VOICE_ENTRIES) {
        continue;
      }
      voiceCount += 1;
    }

    limitedByType.push(entry);
  }

  while (
    limitedByType.length > 1 &&
    estimateJsonBytes(limitedByType) > HISTORY_MAX_TOTAL_BYTES
  ) {
    limitedByType.pop();
  }

  return limitedByType;
}

function isVoiceHistoryEntry(entry: HistoryEntry): boolean {
  return getHistoryEntrySource(entry) === "voice";
}

export function pruneHistoryAudioRetention(history: HistoryEntry[]): {
  history: HistoryEntry[];
  pathsToDelete: string[];
} {
  let voiceAudioCount = 0;
  const pathsToDelete: string[] = [];
  const updated = history.map((entry) => {
    const hasVoiceAudio =
      isVoiceHistoryEntry(entry) &&
      Boolean(entry.audioPath || entry.audioBase64);
    if (!hasVoiceAudio) {
      return entry;
    }

    voiceAudioCount += 1;
    if (voiceAudioCount <= HISTORY_MAX_VOICE_AUDIO_ENTRIES) {
      return entry;
    }

    if (entry.audioPath) {
      pathsToDelete.push(entry.audioPath);
    }
    return {
      ...entry,
      audioPath: undefined,
      audioBase64: undefined,
      audioMimeType: undefined,
      audioFileName: undefined,
    };
  });

  return { history: updated, pathsToDelete };
}

interface GetSettingsOptions {
  reload?: boolean;
}

export async function getSettings(
  options: GetSettingsOptions = {},
): Promise<AppSettings> {
  const store = await getStore();
  if (options.reload) {
    try {
      await store.reload();
    } catch (error) {
      console.warn(
        "Failed to reload settings store, using in-memory store",
        error,
      );
    }
  }
  const saved = await store.get<unknown>("settings");
  await migrateAppDataLayoutOnce(saved);
  const normalized = normalizeSavedSettings(saved);
  // Remove undefined keys so they don't overwrite defaults
  const defined = Object.fromEntries(
    Object.entries(normalized).filter(([, v]) => v !== undefined),
  );
  const result = { ...DEFAULT_SETTINGS, ...defined } as AppSettings;
  if (isLocalSttEndpoint(result.whisperEndpoint)) {
    result.whisperEndpoint =
      normalizeLocalSttEndpoint(result.whisperEndpoint) ||
      result.whisperEndpoint;
    result.useOwnKey = true;
    result.provider = "custom";
    result.whisperApiKey = "";
  }
  result.translation = normalizeTranslationSettings(
    result.translation,
    result.language,
  );
  if (
    needsLocalSttSettingsMigration(saved) ||
    needsHotkeySettingsMigration(saved, result) ||
    (saved &&
      typeof saved === "object" &&
      (saved as Record<string, unknown>).whisperModel === "whisper-large-v2") ||
    readLegacyPath(saved, "localModelsDir") ||
    readLegacyPath(saved, "transcriptionStorageDir")
  ) {
    try {
      await store.set("settings", result);
      await store.save();
    } catch (error) {
      console.warn("Failed to persist settings migration", error);
    }
  }
  return result;
}

export type AppSettingsPatch = Omit<Partial<AppSettings>, "translation"> & {
  translation?: Partial<TranslationSettings>;
};

export function mergeAppSettingsPatch(
  current: AppSettings,
  patch: AppSettingsPatch,
): AppSettings {
  return {
    ...current,
    ...patch,
    translation: patch.translation
      ? { ...current.translation, ...patch.translation }
      : current.translation,
  };
}

export function saveSettings(settings: AppSettingsPatch): Promise<void> {
  return settingsSaveQueue.enqueue(async () => {
    const store = await getStore();
    const current = await getSettings({ reload: true });
    const nextSettings = mergeAppSettingsPatch(current, settings);

    if (typeof settings.hotkey === "string") {
      const normalized = normalizeHotkey(settings.hotkey);
      if (!normalized.valid || !normalized.normalized) {
        throw new Error(normalized.error || "Неверный формат горячей клавиши");
      }

      nextSettings.hotkey = normalized.normalized;
    }

    if (settings.widgetScale !== undefined) {
      nextSettings.widgetScale = normalizeWidgetScale(settings.widgetScale);
    }

    nextSettings.translation = normalizeTranslationSettings(
      nextSettings.translation,
      nextSettings.language,
    );
    nextSettings.localModelsDir = "";
    nextSettings.transcriptionStorageDir = "";

    await store.set("settings", nextSettings);
    await store.save();

    if (settings.widgetVisible !== undefined) {
      try {
        await invoke("sync_widget_visibility");
      } catch (error) {
        // Keep the previous choice if the native window change cannot be applied.
        try {
          await store.set("settings", {
            ...nextSettings,
            widgetVisible: current.widgetVisible,
          });
          await store.save();
          await invoke("sync_widget_visibility");
        } catch (restoreError) {
          void logError(
            "WIDGET",
            `Failed to restore widget visibility after an apply error: ${String(restoreError)}`,
          );
        }

        throw error;
      }
    }
  });
}

export function makePromptId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `prompt-${crypto.randomUUID()}`;
  }

  return `prompt-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** Built-in presets merged with the user's stored presets. */
export function getAllPrompts(
  settings: Pick<AppSettings, "prompts">,
): PromptPreset[] {
  return [...BUILTIN_PROMPTS, ...settings.prompts];
}

export function listPromptsByKind(
  settings: Pick<AppSettings, "prompts">,
  kind: PromptKind,
): PromptPreset[] {
  return getAllPrompts(settings).filter((preset) => preset.kind === kind);
}

export function findPrompt(
  settings: Pick<AppSettings, "prompts">,
  id: string,
): PromptPreset | undefined {
  return getAllPrompts(settings).find((preset) => preset.id === id);
}

export function getSelectedCleanupPrompt(settings: AppSettings): PromptPreset {
  return (
    findPrompt(settings, settings.selectedCleanupPromptId) ??
    BUILTIN_PROMPTS.find((preset) => preset.id === DEFAULT_CLEANUP_PROMPT_ID)!
  );
}

export function getDefaultSummaryPrompt(settings: AppSettings): PromptPreset {
  return (
    findPrompt(settings, settings.defaultSummaryPromptId) ??
    BUILTIN_PROMPTS.find((preset) => preset.id === DEFAULT_SUMMARY_PROMPT_ID)!
  );
}

export interface PromptPresetInput {
  id?: string;
  name: string;
  kind: PromptKind;
  prompt: string;
  temperature?: number;
}

/** Create or update a user prompt preset. Built-in presets are immutable. */
export async function upsertPrompt(
  input: PromptPresetInput,
): Promise<PromptPreset> {
  const name = input.name.trim();
  const prompt = input.prompt.trim();

  if (!name) {
    throw new Error("Название промпта не может быть пустым");
  }
  if (!prompt) {
    throw new Error("Текст промпта не может быть пустым");
  }

  const id = input.id?.trim() || makePromptId();
  if (BUILTIN_PROMPT_ID_SET.has(id)) {
    throw new Error("Встроенный промпт нельзя изменить — создайте копию");
  }

  const now = new Date().toISOString();
  const current = await getSettings({ reload: true });
  const existing = current.prompts.find((preset) => preset.id === id);
  const saved: PromptPreset = {
    id,
    name,
    kind: input.kind,
    prompt,
    builtin: false,
    temperature: input.temperature,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const prompts = existing
    ? current.prompts.map((preset) => (preset.id === id ? saved : preset))
    : [...current.prompts, saved];

  await saveSettings({ prompts });
  return saved;
}

/** Delete a user prompt preset and reset references that pointed at it. */
export async function deletePrompt(id: string): Promise<void> {
  if (BUILTIN_PROMPT_ID_SET.has(id)) {
    throw new Error("Встроенный промпт нельзя удалить");
  }

  const current = await getSettings({ reload: true });
  const prompts = current.prompts.filter((preset) => preset.id !== id);
  if (prompts.length === current.prompts.length) {
    return;
  }

  const patch: Partial<AppSettings> = { prompts };
  if (current.selectedCleanupPromptId === id) {
    patch.selectedCleanupPromptId = DEFAULT_CLEANUP_PROMPT_ID;
  }
  if (current.defaultSummaryPromptId === id) {
    patch.defaultSummaryPromptId = DEFAULT_SUMMARY_PROMPT_ID;
  }

  await saveSettings(patch);
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const storageDir = await getHistoryStorageDir();
  const history = storageDir
    ? await readHistoryFromStorageDir(storageDir)
    : await readHistoryFromDefaultStorage();

  void logInfo(
    "HISTORY",
    `Loaded full history entries=${history.length} approxBytes=${estimateJsonBytes(history)}`,
  );
  return history;
}

export async function getHistoryIndex(): Promise<HistoryListEntry[]> {
  const storageDir = await getHistoryStorageDir();
  const index = await invoke<HistoryListEntry[]>("read_history_index_file", {
    storageDir,
  });

  void logInfo(
    "HISTORY",
    `Loaded history index entries=${index.length} approxBytes=${estimateJsonBytes(index)}`,
  );
  return index;
}

export async function getHistoryEntry(
  id: string,
): Promise<HistoryEntry | null> {
  const storageDir = await getHistoryStorageDir();
  const entry = await invoke<HistoryEntry | null>("read_history_entry_file", {
    storageDir,
    id,
  });

  return entry ? normalizeHistoryEntryFromStorage(entry) : null;
}

async function getHistoryForMutation(): Promise<HistoryEntry[]> {
  const storageDir = await getHistoryStorageDir();
  if (storageDir) {
    return readHistoryFromStorageDir(storageDir);
  }

  return readHistoryFromDefaultStorage();
}

export async function addHistoryEntry(entry: HistoryEntry): Promise<void> {
  const history = await getHistoryForMutation();
  await writeHistory([entry, ...history]);
  // Accumulate words statistics once per transcription; de-dupes by entry id
  // and never throws, so it cannot affect history persistence.
  await recordTranscriptionStats(entry);
}

export async function updateHistoryEntry(entry: HistoryEntry): Promise<void> {
  const history = await getHistoryForMutation();
  const previous = history.find((item) => item.id === entry.id);
  const updated = history.map((item) => (item.id === entry.id ? entry : item));
  await writeHistory(updated);
  if (previous) {
    const nextPaths = new Set(historyAudioPaths(entry));
    await deleteHistoryAudioFiles(
      historyAudioPaths(previous).filter((path) => !nextPaths.has(path)),
    );
  }
  // Counts a retried entry that only now succeeded; duplicates are ignored.
  await recordTranscriptionStats(entry);
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const history = await getHistoryForMutation();
  const removed = history.find((entry) => entry.id === id);
  await writeHistory(history.filter((e) => e.id !== id));
  await deleteHistoryAudioForEntry(removed);
}

/** Prepend a generated summary to a history entry and persist. Returns the updated entry. */
export async function addSummaryToEntry(
  entryId: string,
  summary: SummaryEntry,
): Promise<HistoryEntry | null> {
  const history = await getHistoryForMutation();
  let updatedEntry: HistoryEntry | null = null;
  const updated = history.map((item) => {
    if (item.id !== entryId) return item;
    updatedEntry = normalizeHistoryEntryFromStorage(
      compactHistoryEntryForStorage({
        ...item,
        summaries: [summary, ...(item.summaries ?? [])],
      }),
    );
    return updatedEntry;
  });
  if (updatedEntry) await writeHistory(updated);
  return updatedEntry;
}

/** Replace the text of one summary on an entry (used by inline edit). */
export async function updateSummaryInEntry(
  entryId: string,
  summaryId: string,
  text: string,
): Promise<HistoryEntry | null> {
  const history = await getHistoryForMutation();
  let updatedEntry: HistoryEntry | null = null;
  const updated = history.map((item) => {
    if (item.id !== entryId) return item;
    updatedEntry = normalizeHistoryEntryFromStorage(
      compactHistoryEntryForStorage({
        ...item,
        summaries: (item.summaries ?? []).map((s) =>
          s.id === summaryId ? { ...s, text } : s,
        ),
      }),
    );
    return updatedEntry;
  });
  if (updatedEntry) await writeHistory(updated);
  return updatedEntry;
}

/** Remove one summary from an entry and persist. */
export async function deleteSummaryFromEntry(
  entryId: string,
  summaryId: string,
): Promise<HistoryEntry | null> {
  const history = await getHistoryForMutation();
  let updatedEntry: HistoryEntry | null = null;
  const updated = history.map((item) => {
    if (item.id !== entryId) return item;
    updatedEntry = normalizeHistoryEntryFromStorage(
      compactHistoryEntryForStorage({
        ...item,
        summaries: (item.summaries ?? []).filter((s) => s.id !== summaryId),
      }),
    );
    return updatedEntry;
  });
  if (updatedEntry) await writeHistory(updated);
  return updatedEntry;
}

/**
 * Any entry still marked "processing" when the app starts is an orphan — its
 * in-flight job died with the previous process (crash, quit, freeze). Mark such
 * entries "interrupted" so the user can re-run them. Idempotent and safe to call
 * from multiple windows. Returns true when at least one entry was reconciled.
 */
export async function reconcileInterruptedProcessing(): Promise<boolean> {
  const history = await getHistoryForMutation();
  let changed = false;
  const reconciled = history.map((entry) => {
    if (entry.status !== "processing") {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      status: "interrupted" as const,
      errorMessage:
        entry.errorMessage ||
        "Обработка прервана: приложение было закрыто. Можно запустить повторно.",
    };
  });

  if (changed) {
    await writeHistory(reconciled);
  }

  return changed;
}

export async function clearHistory(): Promise<void> {
  const history = await getHistoryForMutation();
  await writeHistory([]);
  await deleteHistoryAudioFiles(history.flatMap(historyAudioPaths));
}

async function getHistoryStorageDir(): Promise<string> {
  return "";
}

async function readHistoryFromDefaultStorage(): Promise<HistoryEntry[]> {
  return readHistoryFromStorageDir("");
}

export async function writeHistoryToDefaultStorage(
  history: HistoryEntry[],
): Promise<void> {
  const { history: retained, pathsToDelete } = prepareHistoryForWrite(history);
  await invoke("write_history_file", {
    storageDir: "",
    history: retained,
  });
  await deleteHistoryAudioFiles(pathsToDelete);
}

async function readHistoryFromStorageDir(
  storageDir: string,
): Promise<HistoryEntry[]> {
  const history = await invoke<HistoryEntry[]>("read_history_file", {
    storageDir,
  });
  return normalizeHistoryFromStorage(history);
}

export async function writeHistoryToStorageDir(
  storageDir: string,
  history: HistoryEntry[],
): Promise<void> {
  const { history: retained, pathsToDelete } = prepareHistoryForWrite(history);
  await invoke("write_history_file", {
    storageDir,
    history: retained,
  });
  await deleteHistoryAudioFiles(pathsToDelete);
}

async function writeHistory(history: HistoryEntry[]): Promise<void> {
  const storageDir = await getHistoryStorageDir();
  if (storageDir) {
    await writeHistoryToStorageDir(storageDir, history);
    return;
  }

  await writeHistoryToDefaultStorage(history);
}

function prepareHistoryForWrite(history: HistoryEntry[]): {
  history: HistoryEntry[];
  pathsToDelete: string[];
} {
  const compacted = history.map(compactHistoryEntryForStorage);
  const pruned = pruneHistory(compacted);
  const retainedIds = new Set(pruned.map((entry) => entry.id));
  const droppedPaths = history
    .filter((entry) => !retainedIds.has(entry.id))
    .flatMap(historyAudioPaths);
  const retained = pruneHistoryAudioRetention(pruned);

  return {
    history: retained.history,
    pathsToDelete: [
      ...droppedPaths.filter((path): path is string => Boolean(path)),
      ...retained.pathsToDelete,
    ],
  };
}

export interface SavedHistoryAudio {
  path: string;
  mimeType: string;
  fileName: string;
}

export interface ReadHistoryAudio {
  audioBase64: string;
  mimeType: string;
}

export async function saveHistoryAudio({
  storageDir,
  entryId,
  audioBase64,
  mimeType,
}: {
  storageDir?: string;
  entryId: string;
  audioBase64: string;
  mimeType: string;
}): Promise<SavedHistoryAudio> {
  return invoke<SavedHistoryAudio>("save_history_audio", {
    storageDir: storageDir ?? (await getHistoryStorageDir()),
    entryId,
    audioBase64,
    mimeType,
  });
}

export async function readHistoryAudio(
  path: string,
): Promise<ReadHistoryAudio> {
  return invoke<ReadHistoryAudio>("read_history_audio", {
    storageDir: await getHistoryStorageDir(),
    path,
  });
}

export async function deleteHistoryAudio(path: string): Promise<void> {
  await invoke("delete_history_audio", {
    storageDir: await getHistoryStorageDir(),
    path,
  });
}

async function deleteHistoryAudioFiles(
  paths: Array<string | undefined>,
): Promise<void> {
  const uniquePaths = [
    ...new Set(paths.filter((path): path is string => Boolean(path))),
  ];

  await Promise.all(
    uniquePaths.map(async (path) => {
      try {
        await deleteHistoryAudio(path);
      } catch (error) {
        console.warn("Failed to delete history audio", path, error);
      }
    }),
  );
}

function historyAudioPaths(entry: HistoryEntry): string[] {
  const paths: string[] = [];

  if (isVoiceHistoryEntry(entry) && entry.audioPath) {
    paths.push(entry.audioPath);
  }

  if (
    (entry.source === "call" || entry.source === "liveTranslation") &&
    entry.callTracks?.length
  ) {
    for (const track of entry.callTracks) {
      if (track.path) {
        paths.push(track.path);
      }
    }
  }

  return paths;
}

async function deleteHistoryAudioForEntry(entry?: HistoryEntry): Promise<void> {
  if (!entry) {
    return;
  }

  await deleteHistoryAudioFiles(historyAudioPaths(entry));
}

const PERMISSIONS_PASSED_KEY = "permissions_passed";
const PERMISSIONS_VERSION_KEY = "permissions_version";
const CURRENT_PERMISSIONS_VERSION = 3;
const SYSTEM_AUDIO_PERMISSION_VERIFIED_V2_KEY =
  "system_audio_permission_verified_v2";
const WIDGET_POSITION_KEY = "widget_position";

export async function getPermissionsPassed(): Promise<boolean> {
  const store = await getStore();
  const passed = (await store.get<boolean>(PERMISSIONS_PASSED_KEY)) ?? false;
  const version = (await store.get<number>(PERMISSIONS_VERSION_KEY)) ?? 1;
  return passed && version >= CURRENT_PERMISSIONS_VERSION;
}

export async function setPermissionsPassed(value: boolean): Promise<void> {
  const store = await getStore();
  await store.set(PERMISSIONS_PASSED_KEY, value);
  await store.set(
    PERMISSIONS_VERSION_KEY,
    value ? CURRENT_PERMISSIONS_VERSION : 0,
  );
  await store.save();
}

export async function getSystemAudioPermissionVerifiedV2(): Promise<boolean> {
  const store = await getStore();
  return (
    (await store.get<boolean>(SYSTEM_AUDIO_PERMISSION_VERIFIED_V2_KEY)) ?? false
  );
}

export async function setSystemAudioPermissionVerifiedV2(
  value: boolean,
): Promise<void> {
  const store = await getStore();
  await store.set(SYSTEM_AUDIO_PERMISSION_VERIFIED_V2_KEY, value);
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

export async function saveWidgetPosition(
  position: WidgetPosition,
): Promise<void> {
  const store = await getStore();
  await store.set(WIDGET_POSITION_KEY, position);
  await store.save();
}
