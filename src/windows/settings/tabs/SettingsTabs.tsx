import {
  lazy,
  Suspense,
  useState,
  useEffect,
  useRef,
  useCallback,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  IconBriefcase,
  IconBroadcast,
  IconCheck,
  IconCloud,
  IconCode,
  IconCrown,
  IconDownload,
  IconGauge,
  IconGlobe,
  IconLogout,
  Icon,
  IconLanguage,
  IconMessage,
  IconMicrophone,
  IconPencil,
  IconPlus,
  IconServer,
  IconTargetArrow,
  IconTrash,
  IconTypography,
  IconUser,
  IconX,
  IconBolt,
} from "../../../lib/icons";

import {
  AppSettings,
  getSettings,
  LocalModelSettings,
  saveSettings,
  listPromptsByKind,
  upsertPrompt,
  deletePrompt,
} from "../../../lib/store";
import {
  calculateCloudBalanceProgress,
  formatCloudMilliTokens,
} from "../../../lib/cloudTokenFormat";
import {
  apiModelModeSettingsPatch,
  DEFAULT_LOCAL_STT_ENDPOINT,
  DEFAULT_LOCAL_STT_MODEL,
  localModelModeSettingsPatch,
  talkisCloudModeSettingsPatch,
} from "../../../lib/modelMode";
import {
  beginCloudAuthFlow,
  cancelCloudAuthFlow,
  CloudProfile,
  fetchCloudProfile,
  getCloudTopUpUrl,
  cloudLogout,
  handleAuthToken,
  generateExchangeCode,
  getAuthLoginUrlWithCode,
  isCloudAuthFlowActive,
  pollForToken,
  getCachedCloudProfile,
  subscribeCloudProfile,
  type CloudAuthFlowId,
} from "../../../lib/cloudAuth";
import { logInfo } from "../../../lib/logger";

import { TRANSCRIPTION_STYLE_OPTIONS } from "../../../lib/transcriptionPrompts";
import { isSummaryAvailable, generatePromptText } from "../../../lib/summarize";
import { SETTINGS_UPDATED_EVENT } from "../../../lib/hotkeyEvents";
import { useI18n, type MsgKey } from "../../../lib/i18n";
import { Dropdown } from "../../../components/Dropdown";
import { LocalSttModelCard } from "../../../components/LocalSttModelCard";
import { ModelCardDisclosureButton } from "../../../components/ModelCardDisclosureButton";
import { RealtimeTranslationModels } from "./RealtimeTranslationModels";
import {
  hasVerifiedRealtimeCapability,
  realtimeConfigurationFingerprint,
  STREAMING_STT_ADAPTERS,
} from "../../../lib/realtimeModels";

const LocalLlmModels = lazy(() =>
  import("../../../components/LocalLlmModels").then((module) => ({
    default: module.LocalLlmModels,
  })),
);

const IS_DEV = import.meta.env.DEV;
type LocalRuntimeKind = "whisper" | "diarization";
type LocalModelKind = "transcription" | "text" | "other";
type DesktopPlatform = "macos" | "windows" | "linux" | "unknown";

function detectDesktopPlatform(): DesktopPlatform {
  if (typeof navigator === "undefined") {
    return "unknown";
  }

  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();

  if (value.includes("mac")) return "macos";
  if (value.includes("win")) return "windows";
  if (value.includes("linux") || value.includes("x11")) return "linux";

  return "unknown";
}

const LOCAL_RUNTIME_ENDPOINTS: Record<LocalRuntimeKind, string> = {
  whisper: DEFAULT_LOCAL_STT_ENDPOINT,
  diarization: "http://127.0.0.1:8003",
};
const LOCAL_STT_PRESET_ENDPOINT = LOCAL_RUNTIME_ENDPOINTS.whisper;
const LOCAL_STT_PRESET_MODEL = DEFAULT_LOCAL_STT_MODEL;
const LOCAL_STT_MODEL_DOWNLOAD_PROGRESS_EVENT =
  "local-stt-model-download-progress";

function isLocalSttEndpoint(endpoint?: string | null): boolean {
  return /127\.0\.0\.1|localhost/i.test(endpoint || "");
}

interface SettingsTabsProps {
  type: "model" | "style";
}

interface PromptPreview {
  prompt: string;
  layers: string[];
  profileKey: string;
  version: number;
}

interface LocalModelActionState {
  status: "idle" | "installing" | "deleting" | "success" | "error";
  message: string;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

interface LocalModelDownloadProgressEvent {
  model: string;
  status: "starting" | "preparing" | "downloading" | "downloaded";
  downloaded_bytes: number;
  total_bytes?: number | null;
  percent?: number | null;
  message?: string | null;
}

interface LocalTranslatorInfo {
  provider: string;
  name: string;
  status: "not_installed" | "downloading" | "ready" | "error";
  managed: boolean;
  message?: string | null;
}

type ApiAdapterId =
  | "openai"
  | "deepgram"
  | "cartesia"
  | "mistral"
  | "elevenlabs"
  | "fireworks"
  | "groq"
  | "assemblyai"
  | "volcengine"
  | "xai";

type AdapterTestStatus = "idle" | "testing" | "success" | "error" | "info";
type ModelMode = "cloud" | "api" | "local";

interface ApiAdapterOption {
  id: ApiAdapterId;
  name: string;
  description: string;
  recommendedModel: string;
  models: ApiAdapterModelOption[];
  defaultEndpoint: string;
  initials: string;
  accent: string;
  testable: boolean;
}

interface ApiAdapterModelOption {
  id: string;
  supportsStreaming?: boolean;
}

const CUSTOM_API_MODEL_VALUE = "__custom_model__";
const TEXT_MODEL_OPTIONS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1"];

const API_ADAPTERS: ApiAdapterOption[] = [
  {
    id: "openai",
    name: "OpenAI API",
    description: "Подключение через OpenAI API для распознавания речи.",
    recommendedModel: "gpt-4o-transcribe",
    models: [
      { id: "gpt-4o-transcribe", supportsStreaming: true },
      { id: "gpt-4o-mini-transcribe", supportsStreaming: true },
      { id: "gpt-realtime-whisper", supportsStreaming: true },
      { id: "whisper-1" },
    ],
    defaultEndpoint: "https://api.openai.com",
    initials: "AI",
    accent: "#0f172a",
    testable: true,
  },
  {
    id: "deepgram",
    name: "Deepgram API",
    description: "Адаптер для облачного распознавания речи через Deepgram.",
    recommendedModel: "nova-3",
    models: [
      { id: "nova-3", supportsStreaming: true },
      { id: "nova-2", supportsStreaming: true },
    ],
    defaultEndpoint: "https://api.deepgram.com",
    initials: "DG",
    accent: "#13ef93",
    testable: false,
  },
  {
    id: "cartesia",
    name: "Cartesia API",
    description: "Адаптер под речевые модели Cartesia.",
    recommendedModel: "sonic",
    models: [{ id: "sonic" }],
    defaultEndpoint: "",
    initials: "CA",
    accent: "#6d5dfc",
    testable: false,
  },
  {
    id: "mistral",
    name: "Mistral AI",
    description: "Адаптер под модели распознавания и обработки Mistral AI.",
    recommendedModel: "voxtral-mini-latest",
    models: [
      { id: "voxtral-mini-latest" },
      { id: "voxtral-mini-transcribe-realtime-2602", supportsStreaming: true },
    ],
    defaultEndpoint: "https://api.mistral.ai",
    initials: "MI",
    accent: "#ff7000",
    testable: false,
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs API",
    description: "Адаптер для speech-to-text сценариев через ElevenLabs.",
    recommendedModel: "scribe_v2",
    models: [
      { id: "scribe_v2" },
      { id: "scribe_v1" },
      { id: "scribe_v2_realtime", supportsStreaming: true },
    ],
    defaultEndpoint: "https://api.elevenlabs.io",
    initials: "EL",
    accent: "#111827",
    testable: false,
  },
  {
    id: "fireworks",
    name: "Fireworks AI API",
    description: "Адаптер под hosted speech-модели Fireworks AI.",
    recommendedModel: "whisper-v3",
    models: [{ id: "whisper-v3" }, { id: "whisper-v3-turbo" }],
    defaultEndpoint: "",
    initials: "FW",
    accent: "#f97316",
    testable: false,
  },
  {
    id: "groq",
    name: "Groq API",
    description: "Адаптер под быстрые hosted Whisper-модели Groq.",
    recommendedModel: "whisper-large-v3-turbo",
    models: [{ id: "whisper-large-v3-turbo" }, { id: "whisper-large-v3" }],
    defaultEndpoint: "",
    initials: "GQ",
    accent: "#f55036",
    testable: false,
  },
  {
    id: "assemblyai",
    name: "AssemblyAI",
    description: "Адаптер для распознавания речи через AssemblyAI.",
    recommendedModel: "universal",
    models: [
      { id: "universal" },
      { id: "u3-rt-pro", supportsStreaming: true },
      { id: "whisper-rt", supportsStreaming: true },
    ],
    defaultEndpoint: "https://streaming.assemblyai.com",
    initials: "AA",
    accent: "#2563eb",
    testable: false,
  },
  {
    id: "volcengine",
    name: "Volcengine API",
    description: "Адаптер под речевые сервисы Volcengine.",
    recommendedModel: "seed-asr",
    models: [{ id: "seed-asr" }],
    defaultEndpoint: "",
    initials: "VE",
    accent: "#7c3aed",
    testable: false,
  },
  {
    id: "xai",
    name: "xAI API",
    description: "Адаптер под API xAI для будущих voice/STT сценариев.",
    recommendedModel: "grok-transcribe",
    models: [{ id: "grok-transcribe", supportsStreaming: true }],
    defaultEndpoint: "https://api.x.ai",
    initials: "xAI",
    accent: "#000000",
    testable: false,
  },
];

interface LocalModelOption {
  id: string;
  name: string;
  description: string;
  model: string;
  engineLabel: string;
  runtime: string;
  runtimeKind: LocalRuntimeKind;
  size: string;
  speed: string;
  accuracy: string;
  languageLabel: string;
  initials: string;
  accent: string;
  recommended?: boolean;
  runtimeReady?: boolean;
  unavailableReason?: string;
  downloadBytes?: number;
  purpose?: "stt" | "diarization";
  supportsStreaming?: boolean;
}

interface LocalOtherComponent {
  id: string;
  name: string;
  descriptionKey: MsgKey;
  model: string;
  engineLabel: string;
  runtime: string;
  size: string;
  speed: string;
  accuracy: string;
  languageLabel: string;
  initials: string;
  accent: string;
  runtimeReady: boolean;
  downloadBytes?: number;
}

const LOCAL_MODEL_OPTIONS: LocalModelOption[] = [
  {
    id: "nemotron-35-asr-streaming-06b",
    name: "NVIDIA Nemotron 3.5 ASR Streaming 0.6B",
    description:
      "Мультиязычная streaming ASR-модель Nemotron для очень быстрой локальной диктовки.",
    model: "nvidia/nemotron-3.5-asr-streaming-0.6b",
    engineLabel: "Nemotron",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "0.6B",
    speed: "очень быстро",
    accuracy: "высокая",
    languageLabel: "40",
    initials: "N3",
    accent: "#76b900",
    recommended: true,
    runtimeReady: true,
    downloadBytes: 716_000_000,
    supportsStreaming: true,
  },
  {
    id: "gigaam-v3-e2e-rnnt",
    name: "GigaAM v3 E2E RNNT",
    description:
      "Русская ASR-модель с пунктуацией и нормализацией текста для качественной локальной диктовки.",
    model: "ai-sage/GigaAM-v3",
    engineLabel: "GigaAM",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "0.2B",
    speed: "очень быстро",
    accuracy: "высокая",
    languageLabel: "1",
    initials: "GA",
    accent: "#111827",
    runtimeReady: true,
    downloadBytes: 183_948_704,
  },
  {
    id: "whisper-large-v3-turbo",
    name: "Whisper Large V3 Turbo",
    description:
      "Рекомендуемый Whisper-вариант: быстрый, качественный и хорошо подходит для диктовки.",
    model: "whisper-large-v3-turbo",
    engineLabel: "Whisper",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "large",
    speed: "быстро",
    accuracy: "высокая",
    languageLabel: "99+",
    initials: "WT",
    accent: "#0f172a",
    runtimeReady: true,
    downloadBytes: 473_992_235,
  },
  {
    id: "whisper-small",
    name: "Whisper Small",
    description:
      "Баланс скорости и качества для слабых машин и быстрых коротких диктовок.",
    model: "whisper-small",
    engineLabel: "Whisper",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "small",
    speed: "быстро",
    accuracy: "средняя",
    languageLabel: "99+",
    initials: "WS",
    accent: "#334155",
    runtimeReady: true,
    downloadBytes: 145_458_032,
  },
  {
    id: "whisper-large-v3",
    name: "Whisper Large V3",
    description:
      "Максимальное качество Whisper, но выше требования к памяти и времени обработки.",
    model: "whisper-large-v3",
    engineLabel: "Whisper",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "large",
    speed: "средне",
    accuracy: "максимальная",
    languageLabel: "99+",
    initials: "W3",
    accent: "#1e293b",
    runtimeReady: true,
    downloadBytes: 889_340_843,
  },
  {
    id: "whisper-medium",
    name: "Whisper Medium",
    description:
      "Промежуточный вариант между Small и Large: заметно качественнее Small, но тяжелее.",
    model: "whisper-medium",
    engineLabel: "Whisper",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "medium",
    speed: "средне",
    accuracy: "высокая",
    languageLabel: "99+",
    initials: "WM",
    accent: "#475569",
    runtimeReady: true,
    downloadBytes: 444_493_380,
  },
  {
    id: "whisper-base",
    name: "Whisper Base",
    description:
      "Быстрая и легкая модель для простых сценариев и слабых машин.",
    model: "whisper-base",
    engineLabel: "Whisper",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "base",
    speed: "очень быстро",
    accuracy: "базовая",
    languageLabel: "99+",
    initials: "WB",
    accent: "#64748b",
    runtimeReady: true,
    downloadBytes: 46_471_066,
  },
  {
    id: "whisper-tiny",
    name: "Whisper Tiny",
    description:
      "Минимальный размер и максимальная скорость, качество ниже остальных Whisper-моделей.",
    model: "whisper-tiny",
    engineLabel: "Whisper",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "tiny",
    speed: "очень быстро",
    accuracy: "низкая+",
    languageLabel: "99+",
    initials: "WT",
    accent: "#94a3b8",
    runtimeReady: true,
    downloadBytes: 25_321_834,
  },
  {
    id: "parakeet-tdt-06b-v3",
    name: "NVIDIA Parakeet TDT 0.6B v3",
    description:
      "Быстрая локальная ASR-модель Parakeet через transcribe.cpp GGUF runtime.",
    model: "nvidia/parakeet-tdt-0.6b-v3",
    engineLabel: "Parakeet",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "0.6B",
    speed: "быстро",
    accuracy: "высокая",
    languageLabel: "25",
    initials: "P3",
    accent: "#76b900",
    runtimeReady: true,
    downloadBytes: 740_000_000,
  },
  {
    id: "parakeet-tdt-06b-v2",
    name: "NVIDIA Parakeet TDT 0.6B v2",
    description:
      "Стабильная английская Parakeet TDT-модель через transcribe.cpp GGUF runtime.",
    model: "nvidia/parakeet-tdt-0.6b-v2",
    engineLabel: "Parakeet",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "0.6B",
    speed: "быстро",
    accuracy: "высокая",
    languageLabel: "English",
    initials: "P2",
    accent: "#5f9f00",
    runtimeReady: true,
    downloadBytes: 730_000_000,
  },
  {
    id: "nemotron-speech-streaming-en-06b",
    name: "NVIDIA Nemotron Speech Streaming EN 0.6B",
    description:
      "Английская streaming ASR-модель Nemotron с минимальной задержкой для live-диктовки.",
    model: "nvidia/nemotron-speech-streaming-en-0.6b",
    engineLabel: "Nemotron",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "0.6B",
    speed: "очень быстро",
    accuracy: "высокая",
    languageLabel: "English",
    initials: "NS",
    accent: "#5f9f00",
    runtimeReady: true,
    downloadBytes: 696_000_000,
    supportsStreaming: true,
  },
  {
    id: "moonshine-streaming-tiny",
    name: "Moonshine Streaming Tiny",
    description:
      "Очень лёгкая английская streaming-модель для мгновенного локального распознавания.",
    model: "moonshine-streaming-tiny",
    engineLabel: "Moonshine",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "tiny",
    speed: "очень быстро",
    accuracy: "базовая",
    languageLabel: "English",
    initials: "MT",
    accent: "#8b5cf6",
    runtimeReady: true,
    downloadBytes: 48_000_000,
    supportsStreaming: true,
  },
  {
    id: "moonshine-streaming-small",
    name: "Moonshine Streaming Small",
    description:
      "Лёгкая английская streaming-модель: быстрее Whisper Small и подходит для live-ввода.",
    model: "moonshine-streaming-small",
    engineLabel: "Moonshine",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "small",
    speed: "очень быстро",
    accuracy: "средняя+",
    languageLabel: "English",
    initials: "MS",
    accent: "#7c3aed",
    runtimeReady: true,
    downloadBytes: 189_000_000,
    supportsStreaming: true,
  },
  {
    id: "qwen3-asr-06b",
    name: "Qwen3-ASR 0.6B",
    description:
      "Компактная ASR-модель Qwen для локального распознавания через transcribe.cpp GGUF runtime.",
    model: "Qwen/Qwen3-ASR-0.6B",
    engineLabel: "Qwen",
    runtime: "Talkis Local / transcribe.cpp",
    runtimeKind: "whisper",
    size: "0.6B",
    speed: "средне",
    accuracy: "высокая",
    languageLabel: "52",
    initials: "Q3",
    accent: "#2563eb",
    runtimeReady: true,
    downloadBytes: 811_000_000,
  },
];

const LOCAL_OTHER_COMPONENTS: LocalOtherComponent[] = [
  {
    id: "nllb-200",
    name: "NLLB-200 Distilled",
    descriptionKey: "models.localOther.nllb-200.description",
    model: "JustFrederik/nllb-200-distilled-600M-ct2-int8",
    engineLabel: "CTranslate2",
    runtime: "Talkis Local / CTranslate2",
    size: "600M INT8",
    speed: "средне",
    accuracy: "средняя+",
    languageLabel: "200+",
    initials: "N2",
    accent: "#2563eb",
    runtimeReady: true,
    downloadBytes: 645_000_000,
  },
  {
    id: "opus-mt-ru-en",
    name: "OPUS-MT RU -> EN",
    descriptionKey: "models.localOther.opus-mt-ru-en.description",
    model: "gaudi/opus-mt-ru-en-ctranslate2",
    engineLabel: "CTranslate2",
    runtime: "Talkis Local / CTranslate2",
    size: "Marian CT2",
    speed: "быстро",
    accuracy: "средняя",
    languageLabel: "RU -> EN",
    initials: "RE",
    accent: "#16a34a",
    runtimeReady: true,
    downloadBytes: 308_000_000,
  },
  {
    id: "opus-mt-en-ru",
    name: "OPUS-MT EN -> RU",
    descriptionKey: "models.localOther.opus-mt-en-ru.description",
    model: "manancode/opus-mt-en-ru-ctranslate2-android",
    engineLabel: "CTranslate2",
    runtime: "Talkis Local / CTranslate2",
    size: "Marian CT2 INT8",
    speed: "быстро",
    accuracy: "средняя",
    languageLabel: "EN -> RU",
    initials: "ER",
    accent: "#0f766e",
    runtimeReady: true,
    downloadBytes: 83_000_000,
  },
];

// Translation keys for the per-adapter / per-model descriptions. The original
// Russian text lives in the i18n dictionary fragment (settingsModels); these maps
// keep the keys statically typed so they satisfy the MsgKey union.
const API_ADAPTER_DESCRIPTION_KEYS: Record<ApiAdapterId, MsgKey> = {
  openai: "models.adapter.openai.description",
  deepgram: "models.adapter.deepgram.description",
  cartesia: "models.adapter.cartesia.description",
  mistral: "models.adapter.mistral.description",
  elevenlabs: "models.adapter.elevenlabs.description",
  fireworks: "models.adapter.fireworks.description",
  groq: "models.adapter.groq.description",
  assemblyai: "models.adapter.assemblyai.description",
  volcengine: "models.adapter.volcengine.description",
  xai: "models.adapter.xai.description",
};

const LOCAL_MODEL_DESCRIPTION_KEYS: Record<string, MsgKey> = {
  "whisper-large-v3-turbo": "models.local.whisper-large-v3-turbo.description",
  "whisper-small": "models.local.whisper-small.description",
  "whisper-large-v3": "models.local.whisper-large-v3.description",
  "whisper-medium": "models.local.whisper-medium.description",
  "whisper-base": "models.local.whisper-base.description",
  "whisper-tiny": "models.local.whisper-tiny.description",
  "parakeet-tdt-06b-v3": "models.local.parakeet-tdt-06b-v3.description",
  "parakeet-tdt-06b-v2": "models.local.parakeet-tdt-06b-v2.description",
  "nemotron-35-asr-streaming-06b":
    "models.local.nemotron-35-asr-streaming-06b.description",
  "nemotron-speech-streaming-en-06b":
    "models.local.nemotron-speech-streaming-en-06b.description",
  "moonshine-streaming-tiny":
    "models.local.moonshine-streaming-tiny.description",
  "moonshine-streaming-small":
    "models.local.moonshine-streaming-small.description",
  "qwen3-asr-06b": "models.local.qwen3-asr-06b.description",
  "gigaam-v3-e2e-rnnt": "models.local.gigaam-v3-e2e-rnnt.description",
};

interface OptionCardProps {
  active?: boolean;
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  badge?: string;
  onClick?: () => void;
  disabled?: boolean;
}

const CARD_TEXT_PREVIEW_LIMIT = 250;

/**
 * Long card text (e.g. a prompt body) shown truncated with a Раскрыть/Скрыть
 * toggle — the same pattern as the history table. The toggle stops propagation so
 * it doesn't also trigger the card's own onClick (which selects the prompt).
 */
function CollapsibleCardText({ text }: { text: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const tooLong = text.length > CARD_TEXT_PREVIEW_LIMIT;
  const visible =
    tooLong && !expanded
      ? `${text.slice(0, CARD_TEXT_PREVIEW_LIMIT).trimEnd()}...`
      : text;
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {visible}
      </span>
      {tooLong && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          style={{
            justifySelf: "start",
            padding: 0,
            border: "none",
            background: "transparent",
            color: "var(--text-hi)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "var(--font-main)",
          }}
        >
          {expanded ? t("mainTab.collapse") : t("mainTab.expand")}
        </button>
      )}
    </div>
  );
}

function OptionCard({
  active = false,
  icon,
  title,
  description,
  badge,
  onClick,
  disabled = false,
}: OptionCardProps) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        position: "relative",
        padding: 18,
        borderRadius: 10,
        background: active ? "var(--dropdown-active)" : "var(--surface)",
        border: `1px solid ${active ? "var(--border-strong)" : "var(--border)"}`,
        color: "var(--text-hi)",
        cursor: disabled ? "not-allowed" : onClick ? "pointer" : "default",
        transition:
          "transform 0.16s ease, border-color 0.16s ease, background 0.16s ease",
        opacity: disabled ? 0.72 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled && onClick && !active)
          e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      <div style={{ display: "flex", gap: 16 }}>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 999,
            background: active
              ? "var(--control-muted-strong)"
              : "var(--avatar-bg)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: active ? "var(--text-hi)" : "var(--text-mid)",
            flexShrink: 0,
          }}
        >
          {icon}
        </div>

        <div style={{ flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 6,
            }}
          >
            <div
              style={{
                fontSize: 15,
                fontWeight: active ? 700 : 600,
                color: "var(--text-hi)",
              }}
            >
              {title}
            </div>
            {badge && (
              <div className="label" style={{ color: "var(--text-low)" }}>
                {badge}
              </div>
            )}
          </div>
          <div
            style={{ fontSize: 13, lineHeight: 1.65, color: "var(--text-mid)" }}
          >
            {description}
          </div>
        </div>
      </div>

      {active && (
        <div
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            color: "var(--text-hi)",
          }}
        >
          <IconCheck size={18} stroke={2.6} />
        </div>
      )}
    </div>
  );
}

function CloudSubscriptionAccountCard({
  profile,
  onActivate,
  onLogout,
}: {
  profile: CloudProfile;
  onActivate: () => void;
  onLogout: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="card"
      style={{
        padding: "22px 20px",
        borderRadius: 10,
        background: "var(--control-muted)",
        color: "var(--text-hi)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          paddingBottom: 16,
          marginBottom: 16,
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: "50%",
            background: "var(--avatar-bg)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            overflow: "hidden",
          }}
        >
          {profile.user.avatarUrl ? (
            <img
              src={profile.user.avatarUrl}
              alt=""
              style={{
                width: "100%",
                height: "100%",
                borderRadius: "50%",
                objectFit: "cover",
              }}
            />
          ) : (
            <IconUser size={22} stroke={1.5} color="var(--text-low)" />
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 17,
              fontWeight: 700,
              color: "var(--text-hi)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {profile.user.login || profile.user.email.split("@")[0]}
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-mid)",
              lineHeight: 1.6,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {profile.user.email}
          </div>
        </div>

        <button
          onClick={onLogout}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 8,
            borderRadius: 8,
            color: "var(--text-low)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "color 0.15s, background 0.15s",
          }}
          title={t("models.account.logout")}
        >
          <IconLogout size={16} stroke={1.8} />
        </button>
      </div>

      <SubscriptionPromoContent onActivate={onActivate} />
    </div>
  );
}

function SubscriptionPromoContent({ onActivate }: { onActivate: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <IconCrown size={16} stroke={2.2} />
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            minWidth: 0,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontWeight: 700,
              fontSize: 14,
              letterSpacing: "-0.02em",
              lineHeight: 1.2,
            }}
          >
            {t("models.guest.title")}
          </span>
        </div>
      </div>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: "0 0 14px",
          fontSize: 12,
          lineHeight: 2,
          opacity: 0.85,
        }}
      >
        <li>{t("models.guest.benefit1")}</li>
        <li>{t("models.guest.benefit2")}</li>
        <li>{t("models.guest.benefit3")}</li>
      </ul>
      <button
        onClick={onActivate}
        style={{
          width: "100%",
          padding: "12px",
          borderRadius: 10,
          background: "var(--accent)",
          color: "var(--accent-contrast)",
          border: "none",
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          cursor: "pointer",
          transition: "opacity 0.15s",
          fontFamily: "var(--font-main)",
        }}
      >
        {t("models.cta.upgradePro")}
      </button>
    </>
  );
}

function SubscriptionGuestCard({ onActivate }: { onActivate: () => void }) {
  return (
    <div
      className="card"
      style={{
        padding: "22px 20px",
        borderRadius: 10,
        background: "var(--control-muted)",
        color: "var(--text-hi)",
      }}
    >
      <SubscriptionPromoContent onActivate={onActivate} />
    </div>
  );
}

const DEFAULT_CLOUD_PROGRESS_TARGET = 3_900_000n;
const DEFAULT_CLOUD_LOW_THRESHOLD = 780_000n;

function cloudMilliTokens(value: string | undefined, fallback = 0n): bigint {
  if (!value) return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

/**
 * Three-state cloud block shared by the recognition mode surfaces: available
 * wallet, signed-in empty wallet, or guest sign-in card.
 */
function SubscriptionCards({
  profile,
  onActivate,
  onTopUp,
  onLogout,
}: {
  profile: CloudProfile | null | undefined;
  onActivate: () => void;
  onTopUp: () => void;
  onLogout: () => void;
}) {
  const { t, lang } = useI18n();

  if (profile?.subscription.active === true) {
    const locale = lang === "ru" ? "ru-RU" : "en-US";
    const wallet = profile.wallet;
    const balance = cloudMilliTokens(wallet?.balanceMilliTokens);
    const reserved = cloudMilliTokens(wallet?.reservedMilliTokens);
    const target = cloudMilliTokens(
      profile.thresholds?.progressTargetMilliTokens,
      DEFAULT_CLOUD_PROGRESS_TARGET,
    );
    const lowThreshold = cloudMilliTokens(
      profile.thresholds?.lowBalanceMilliTokens,
      DEFAULT_CLOUD_LOW_THRESHOLD,
    );
    const progress = calculateCloudBalanceProgress(balance, reserved, target);
    const low = wallet?.low ?? balance < lowThreshold;

    return (
      <div
        className="card"
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              minWidth: 0,
            }}
          >
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: 999,
                background: "var(--accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <IconCrown
                size={20}
                stroke={2.2}
                color="var(--accent-contrast)"
              />
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                }}
              >
                {t("models.subscription.active")}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--text-mid)",
                  lineHeight: 1.6,
                }}
              >
                {wallet
                  ? t("models.subscription.balance", {
                      tokens: formatCloudMilliTokens(balance, locale),
                    })
                  : t("models.cloud.proReady")}
              </div>
            </div>
          </div>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: low ? "var(--text-low)" : "var(--accent)",
              flexShrink: 0,
            }}
          />
        </div>

        {wallet && (
          <>
            <div
              role="progressbar"
              aria-label={t("models.subscription.balance", {
                tokens: formatCloudMilliTokens(balance, locale),
              })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.wholePercentage}
              style={{
                height: 8,
                borderRadius: 999,
                overflow: "hidden",
                background: "var(--control-track)",
              }}
            >
              <div
                style={{
                  width: `${progress.percentage}%`,
                  height: "100%",
                  borderRadius: 999,
                  background: "var(--accent)",
                  transition: "width 0.2s ease",
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: low ? "var(--text-hi)" : "var(--text-low)",
                  lineHeight: 1.5,
                }}
              >
                {low
                  ? t("models.subscription.low")
                  : reserved > 0n
                    ? t("models.subscription.reserved", {
                        tokens: formatCloudMilliTokens(reserved, locale),
                      })
                    : `${progress.wholePercentage}%`}
              </div>
              {low && (
                <button
                  type="button"
                  onClick={onTopUp}
                  style={{
                    padding: "9px 14px",
                    borderRadius: 10,
                    border: "none",
                    background: "var(--accent)",
                    color: "var(--accent-contrast)",
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: "var(--font-main)",
                    cursor: "pointer",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  {t("models.subscription.topUp")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  if (profile) {
    return (
      <CloudSubscriptionAccountCard
        profile={profile}
        onActivate={onActivate}
        onLogout={onLogout}
      />
    );
  }

  return <SubscriptionGuestCard onActivate={onActivate} />;
}

function extractTokenFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("token") || null;
  } catch {
    return null;
  }
}

interface PromptEditorState {
  id?: string;
  name: string;
  prompt: string;
  temperature?: number;
}

const PROMPT_FIELD_STYLE: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--control-bg)",
  color: "var(--text-hi)",
  fontSize: 13,
  fontFamily: "var(--font-main)",
  lineHeight: 1.6,
  boxSizing: "border-box",
};

/**
 * Constructor for the summary prompt library: list built-in + user presets,
 * create / edit / duplicate / delete user prompts, and pick the default one.
 */
function PromptLibrary({
  settings,
  onReload,
  update,
}: {
  settings: AppSettings;
  onReload: () => Promise<unknown>;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const { t } = useI18n();
  const [editor, setEditor] = useState<PromptEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const promptFieldRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the prompt textarea to fit its content up to a cap, then scroll.
  const autoSizePromptField = (el: HTMLTextAreaElement | null): void => {
    if (!el) return;
    const MAX_HEIGHT = 440;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  };
  useEffect(() => {
    autoSizePromptField(promptFieldRef.current);
  }, [editor?.id, editor?.prompt]);

  const canGenerate = isSummaryAvailable(settings);
  const handleGenerate = async (): Promise<void> => {
    if (!editor || generating || (!editor.prompt.trim() && !editor.name.trim()))
      return;
    setGenerating(true);
    setError(null);
    try {
      // The title participates in forming the prompt (it states the goal).
      const generated = await generatePromptText(settings, {
        title: editor.name,
        draft: editor.prompt,
      });
      setEditor((cur) => (cur ? { ...cur, prompt: generated } : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const summaryPrompts = listPromptsByKind(settings, "summary");
  const defaultId = settings.defaultSummaryPromptId;
  const selectedPreset = summaryPrompts.find(
    (preset) => preset.id === defaultId,
  );
  const selectedIsCustom = selectedPreset ? !selectedPreset.builtin : false;

  const startNew = () => {
    setError(null);
    setEditor({ name: "", prompt: "" });
  };
  const startEditSelected = () => {
    if (!selectedPreset) return;
    setError(null);
    setEditor({
      id: selectedPreset.id,
      name: selectedPreset.name,
      prompt: selectedPreset.prompt,
      temperature: selectedPreset.temperature,
    });
  };

  const handleSave = async () => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await upsertPrompt({
        id: editor.id,
        name: editor.name,
        kind: "summary",
        prompt: editor.prompt,
        temperature: editor.temperature,
      });
      await onReload();
      update({ defaultSummaryPromptId: saved.id });
      setEditor(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (!selectedPreset || selectedPreset.builtin) return;
    setBusyId(selectedPreset.id);
    setError(null);
    try {
      await deletePrompt(selectedPreset.id);
      await onReload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (editor) {
    return (
      <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <div className="label">{t("models.prompt.nameLabel")}</div>
          <input
            value={editor.name}
            onChange={(e) => setEditor({ ...editor, name: e.target.value })}
            placeholder={t("models.prompt.namePlaceholder")}
            maxLength={80}
            style={PROMPT_FIELD_STYLE}
          />
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          <div className="label">{t("models.prompt.promptLabel")}</div>
          <textarea
            ref={promptFieldRef}
            value={editor.prompt}
            onChange={(e) => {
              setEditor({ ...editor, prompt: e.target.value });
              autoSizePromptField(e.target);
            }}
            placeholder={t("models.prompt.promptPlaceholder")}
            style={{
              ...PROMPT_FIELD_STYLE,
              resize: "none",
              minHeight: 120,
              overflowY: "hidden",
            }}
          />
        </div>
        {error && (
          <div
            style={{ fontSize: 12, color: "var(--danger)", lineHeight: 1.5 }}
          >
            {error}
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {canGenerate ? (
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={
                generating || (!editor.prompt.trim() && !editor.name.trim())
              }
              style={{
                padding: "9px 16px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-hi)",
                fontSize: 13,
                fontWeight: 600,
                cursor:
                  generating || (!editor.prompt.trim() && !editor.name.trim())
                    ? "default"
                    : "pointer",
                opacity:
                  generating || (!editor.prompt.trim() && !editor.name.trim())
                    ? 0.6
                    : 1,
                fontFamily: "var(--font-main)",
              }}
            >
              {generating
                ? t("models.prompt.improving")
                : t("models.prompt.improve")}
            </button>
          ) : (
            <div
              style={{
                fontSize: 12,
                color: "var(--text-mid)",
                lineHeight: 1.45,
                maxWidth: 360,
              }}
            >
              {t("models.prompt.noModelHint")}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                setEditor(null);
                setError(null);
              }}
              disabled={saving}
              style={{
                padding: "9px 16px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-mid)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "var(--font-main)",
              }}
            >
              {t("models.common.cancel")}
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                padding: "9px 18px",
                borderRadius: 10,
                border: "none",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                fontSize: 13,
                fontWeight: 700,
                cursor: saving ? "default" : "pointer",
                opacity: saving ? 0.6 : 1,
                fontFamily: "var(--font-main)",
              }}
            >
              {saving ? t("models.prompt.saving") : t("models.prompt.save")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
        {t("models.prompt.libraryHint")}
      </div>

      {summaryPrompts.map((preset) => {
        const active = preset.id === defaultId;

        return (
          <OptionCard
            key={preset.id}
            active={active}
            icon={<IconMessage size={20} stroke={active ? 2.4 : 1.8} />}
            title={preset.name}
            description={<CollapsibleCardText text={preset.prompt} />}
            onClick={() => update({ defaultSummaryPromptId: preset.id })}
          />
        );
      })}

      {error && (
        <div style={{ fontSize: 12, color: "var(--danger)", lineHeight: 1.5 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={startNew}
          style={{
            flex: 1,
            minWidth: 160,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            padding: "11px 0",
            borderRadius: 10,
            border: "1px dashed var(--border-strong)",
            background: "transparent",
            color: "var(--text-hi)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "var(--font-main)",
          }}
        >
          <IconPlus size={16} stroke={2} />
          {t("models.prompt.create")}
        </button>

        {selectedIsCustom && (
          <>
            <button
              onClick={startEditSelected}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "11px 16px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--control-bg)",
                color: "var(--text-hi)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "var(--font-main)",
              }}
            >
              <IconPencil size={15} stroke={2} />
              {t("models.common.edit")}
            </button>
            <button
              onClick={() => void handleDeleteSelected()}
              disabled={busyId === selectedPreset?.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "11px 16px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--control-bg)",
                color: "var(--danger)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "var(--font-main)",
              }}
            >
              <IconTrash size={15} stroke={2} />
              {t("models.common.delete")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TextModelCard({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [testState, setTestState] = useState<{
    status: AdapterTestStatus;
    message: string;
  }>({ status: "idle", message: "" });
  const endpoint = (settings.llmEndpoint || "").trim();
  const model = (settings.llmModel || "").trim();
  const apiKey = (settings.llmApiKey || settings.apiKey || "").trim();
  const isLocalEndpoint = /127\.0\.0\.1|localhost/i.test(endpoint);
  const hasSelectedModel = Boolean(model) && model.toLowerCase() !== "none";
  const configured = hasSelectedModel && (isLocalEndpoint || Boolean(apiKey));
  const isKnownModel = TEXT_MODEL_OPTIONS.includes(settings.llmModel);
  const modelSelectValue = isKnownModel
    ? settings.llmModel
    : CUSTOM_API_MODEL_VALUE;
  const statusLabel =
    testState.status === "testing"
      ? t("models.textModel.statusTesting")
      : testState.status === "error"
        ? t("models.textModel.statusError")
        : configured
          ? t("models.textModel.statusSet")
          : t("models.textModel.statusUnset");
  const statusColor =
    testState.status === "error"
      ? "var(--error-bright)"
      : configured || testState.status === "success"
        ? "var(--success-bright)"
        : "var(--text-low)";
  const FIELD_STYLE: CSSProperties = {
    flex: 1,
    minWidth: 0,
    height: 36,
    padding: "8px 10px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 12,
  };
  // Editing a custom text model means it's no longer the bundled local runtime, so
  // drop the marker that tells summary to auto-start the sidecar.
  const editField = (patch: Partial<AppSettings>) => {
    setTestState({ status: "idle", message: "" });
    update({ ...patch, llmLocalModelId: "" });
  };
  const testTextModel = async (): Promise<void> => {
    if (!hasSelectedModel) {
      setTestState({
        status: "error",
        message: t("models.textModel.needModel"),
      });
      return;
    }
    if (!isLocalEndpoint && !apiKey) {
      setTestState({
        status: "error",
        message: t("models.textModel.needApiKey"),
      });
      return;
    }

    setTestState({
      status: "testing",
      message: t("models.connection.testing"),
    });
    try {
      await invoke<{ result: string }>("process_text", {
        req: {
          text: "Connection test",
          prompt: "Reply only with OK.",
          temperature: 0,
          max_tokens: 8,
          endpoint: endpoint || null,
          model,
          api_key: apiKey || null,
        },
      });
      setTestState({
        status: "success",
        message: t("models.textModel.testSuccess"),
      });
    } catch (error) {
      setTestState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <div
      className="card"
      style={{
        padding: 0,
        overflow: expanded ? "visible" : "hidden",
        position: "relative",
        zIndex: expanded ? 10 : 0,
        background: "var(--surface)",
      }}
    >
      <div
        style={{
          position: "relative",
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          textAlign: "left",
          fontFamily: "var(--font-main)",
        }}
      >
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 3,
            }}
          >
            <div
              style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}
            >
              {t("models.textModel.title")}
            </div>
            <div
              title={testState.message || undefined}
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: statusColor,
                padding: "5px 9px",
                borderRadius: 999,
                background: "var(--control-muted)",
                whiteSpace: "nowrap",
              }}
            >
              {statusLabel}
            </div>
          </div>
          <div
            style={{
              paddingRight: 34,
              fontSize: 12,
              lineHeight: 1.45,
              color: "var(--text-mid)",
            }}
          >
            {t("models.textModel.desc")}
          </div>
          <ModelCardDisclosureButton
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
            label={t(expanded ? "mainTab.collapse" : "mainTab.expand")}
          />
        </div>
      </div>

      {expanded && (
        <div
          style={{
            borderTop: "1px solid var(--border-subtle)",
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="label" style={{ width: 76, flexShrink: 0 }}>
              {t("models.field.apiKey")}
            </div>
            <input
              type="password"
              value={settings.llmApiKey}
              onChange={(e) => editField({ llmApiKey: e.target.value })}
              className="input"
              placeholder={t("models.textModel.apiKeyPlaceholder")}
              spellCheck={false}
              style={FIELD_STYLE}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="label" style={{ width: 76, flexShrink: 0 }}>
              {t("models.field.model")}
            </div>
            <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 6 }}>
              <Dropdown
                value={modelSelectValue}
                options={[
                  ...TEXT_MODEL_OPTIONS.map((modelOption) => ({
                    value: modelOption,
                    label: modelOption,
                  })),
                  {
                    value: CUSTOM_API_MODEL_VALUE,
                    label: t("models.field.customModel"),
                  },
                ]}
                onChange={(value) =>
                  editField({
                    llmModel: value === CUSTOM_API_MODEL_VALUE ? "" : value,
                  })
                }
              />
              {modelSelectValue === CUSTOM_API_MODEL_VALUE && (
                <input
                  type="text"
                  value={settings.llmModel}
                  onChange={(event) =>
                    editField({ llmModel: event.currentTarget.value })
                  }
                  className="input"
                  placeholder={t("models.field.customModelPlaceholder")}
                  aria-label={t("models.field.customModelPlaceholder")}
                  spellCheck={false}
                  style={{ ...FIELD_STYLE, width: "100%" }}
                />
              )}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-low)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {t("models.field.recommended", { model: "gpt-4o-mini" })}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="label" style={{ width: 76, flexShrink: 0 }}>
              {t("models.field.host")}
            </div>
            <input
              type="url"
              value={settings.llmEndpoint}
              onChange={(e) => editField({ llmEndpoint: e.target.value })}
              className="input"
              placeholder="https://api.openai.com/v1 · http://127.0.0.1:2455/v1"
              spellCheck={false}
              style={FIELD_STYLE}
            />
            {settings.llmEndpoint.trim() ? (
              <button
                type="button"
                onClick={() => editField({ llmEndpoint: "" })}
                style={{
                  border: "1px solid var(--border-dashed)",
                  background: "var(--control-muted)",
                  color: "var(--text-hi)",
                  borderRadius: 8,
                  padding: "7px 9px",
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: "var(--font-main)",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  cursor: "pointer",
                }}
              >
                {t("models.common.reset")}
              </button>
            ) : (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-low)",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {t("models.common.optional")}
              </div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => void testTextModel()}
              disabled={testState.status === "testing"}
              style={{
                padding: "9px 12px",
                borderRadius: 10,
                border: "1px solid var(--border-dashed)",
                background:
                  testState.status === "testing"
                    ? "var(--control-muted)"
                    : "var(--accent)",
                color:
                  testState.status === "testing"
                    ? "var(--text-mid)"
                    : "var(--accent-contrast)",
                fontSize: 12,
                fontWeight: 700,
                fontFamily: "var(--font-main)",
                cursor: testState.status === "testing" ? "wait" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {testState.status === "testing" ? (
                <>
                  <span className="loading-soft-ring" />
                  {t("models.test.checking")}
                </>
              ) : (
                <>
                  <IconBolt size={14} stroke={2.2} />
                  {t("models.textModel.testButton")}
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsTabs({ type }: SettingsTabsProps) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [promptPreview, setPromptPreview] = useState<PromptPreview | null>(
    null,
  );
  const [promptPreviewError, setPromptPreviewError] = useState<string | null>(
    null,
  );
  const [cloudProfile, setCloudProfile] = useState<
    CloudProfile | null | undefined
  >(() => getCachedCloudProfile());
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [waitingForAuth, setWaitingForAuth] = useState(false);
  const [waitingForSubscriptionRefresh, setWaitingForSubscriptionRefresh] =
    useState(false);
  const [modelModeView, setModelModeView] = useState<ModelMode | null>(null);
  const [styleTabView, setStyleTabView] = useState<"style" | "prompts">(
    "style",
  );
  const [localModelKind, setLocalModelKind] =
    useState<LocalModelKind>("transcription");
  const [apiModelKind, setApiModelKind] = useState<
    "transcription" | "text" | "translation"
  >("transcription");
  const [expandedApiAdapter, setExpandedApiAdapter] =
    useState<ApiAdapterId | null>(null);
  const [expandedLocalModel, setExpandedLocalModel] = useState<string | null>(
    null,
  );
  const [expandedLocalOtherComponent, setExpandedLocalOtherComponent] =
    useState<string | null>(null);
  const [pendingDeleteModel, setPendingDeleteModel] =
    useState<LocalModelOption | null>(null);
  const [localInstalledModels, setLocalInstalledModels] = useState<string[]>(
    [],
  );
  const [localTranslators, setLocalTranslators] = useState<
    Record<string, LocalTranslatorInfo>
  >({});
  const [apiAdapterTestStates, setApiAdapterTestStates] = useState<
    Partial<
      Record<ApiAdapterId, { status: AdapterTestStatus; message: string }>
    >
  >({});
  const [dirtyApiAdapters, setDirtyApiAdapters] = useState<
    Partial<Record<ApiAdapterId, boolean>>
  >({});
  const apiAdapterEditRevisionsRef = useRef<
    Partial<Record<ApiAdapterId, number>>
  >({});
  const [localModelActionStates, setLocalModelActionStates] = useState<
    Partial<Record<string, LocalModelActionState>>
  >({});
  const authPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const exchangeCodeRef = useRef<string | null>(null);
  const authFlowRef = useRef<CloudAuthFlowId | null>(null);
  const settingsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const optimisticLocalInstalledModelsRef = useRef<Set<string>>(new Set());

  const clearLocalAuthPolling = useCallback(() => {
    if (authPollingRef.current) {
      clearInterval(authPollingRef.current);
      authPollingRef.current = null;
    }
    exchangeCodeRef.current = null;
    authFlowRef.current = null;
    setWaitingForAuth(false);
  }, []);

  const cancelLocalAuthPolling = useCallback(() => {
    cancelCloudAuthFlow();
    clearLocalAuthPolling();
  }, [clearLocalAuthPolling]);

  const syncSettings = useCallback(async () => {
    const nextSettings = await getSettings({ reload: true });
    setSettings(nextSettings);
    return nextSettings;
  }, []);

  const loadCloudProfile = useCallback(async () => {
    const profile = await fetchCloudProfile({ force: true });
    return profile;
  }, []);

  const applyCloudToken = useCallback(
    async (token: string) => {
      const flowId = authFlowRef.current;
      if (!isCloudAuthFlowActive(flowId)) {
        logInfo(
          "SETTINGS",
          "Ignoring auth token without an active local auth flow",
        );
        return null;
      }

      await handleAuthToken(token, { authFlowId: flowId });
      clearLocalAuthPolling();
      await syncSettings();
      const profile = await loadCloudProfile();
      setWaitingForSubscriptionRefresh(!profile?.subscription.active);
      return profile;
    },
    [clearLocalAuthPolling, loadCloudProfile, syncSettings],
  );

  const refreshLocalInstalledModels = useCallback(async () => {
    if (
      !settings ||
      type !== "model" ||
      !settings.useOwnKey ||
      !isLocalSttEndpoint(settings.whisperEndpoint)
    ) {
      return;
    }

    try {
      const result = await invoke<{
        success: boolean;
        models: string[];
        message: string;
      }>("list_stt_models", {
        req: {
          api_key: settings.apiKey || "",
          whisper_api_key: settings.whisperApiKey || null,
          whisper_endpoint:
            settings.whisperEndpoint || LOCAL_STT_PRESET_ENDPOINT,
          local_models_dir: settings.localModelsDir || null,
        },
      });

      const confirmedInstalledModels = result.models || [];
      for (const modelId of confirmedInstalledModels) {
        optimisticLocalInstalledModelsRef.current.delete(modelId);
      }
      const installedModels = Array.from(
        new Set([
          ...confirmedInstalledModels,
          ...optimisticLocalInstalledModelsRef.current,
        ]),
      );
      setLocalInstalledModels(installedModels);

      const installedModelSet = new Set(installedModels);
      const installedLocalOptions = LOCAL_MODEL_OPTIONS.filter((model) =>
        installedModelSet.has(model.model),
      );
      const now = new Date().toISOString();
      const nextLocalModels = { ...(settings.localModels || {}) };
      let changed = false;

      for (const model of LOCAL_MODEL_OPTIONS) {
        const current = nextLocalModels[model.id];
        if (
          current?.status === "downloaded" &&
          !installedModelSet.has(model.model)
        ) {
          delete nextLocalModels[model.id];
          changed = true;
        }
      }

      for (const model of installedLocalOptions) {
        const current = nextLocalModels[model.id] || {
          status: "not_downloaded" as const,
        };
        if (current.status !== "downloaded" || current.message) {
          nextLocalModels[model.id] = {
            ...current,
            status: "downloaded",
            message: undefined,
            downloadedAt: current.downloadedAt || now,
            lastCheckedAt: now,
          };
          changed = true;
        }
      }

      if (changed) {
        update({ localModels: nextLocalModels });
        setLocalModelActionStates((prev) => {
          const next = { ...prev };
          for (const model of installedLocalOptions) {
            delete next[model.id];
          }
          return next;
        });
      }
    } catch (err) {
      setLocalInstalledModels((prev) =>
        Array.from(
          new Set([...prev, ...optimisticLocalInstalledModelsRef.current]),
        ),
      );
    }
  }, [
    settings?.apiKey,
    settings?.provider,
    settings?.useOwnKey,
    settings?.whisperApiKey,
    settings?.whisperEndpoint,
    settings?.localModelsDir,
    settings?.localModels,
    type,
  ]);

  const refreshLocalTranslators = useCallback(async () => {
    if (type !== "model") {
      return;
    }

    try {
      const translators = await invoke<LocalTranslatorInfo[]>(
        "list_local_translators",
      );
      setLocalTranslators(
        Object.fromEntries(
          translators.map((translator) => [translator.provider, translator]),
        ),
      );
    } catch (err) {
      logInfo(
        "SETTINGS",
        `Failed to refresh local translators: ${err instanceof Error ? err.message : String(err)}`,
      );
      setLocalTranslators({});
    }
  }, [type]);

  useEffect(() => {
    void syncSettings().catch(() => {});
  }, [syncSettings]);

  useEffect(() => {
    void refreshLocalTranslators();
  }, [refreshLocalTranslators]);

  // IconCloud profile — always fetch (regardless of tab) so hooks are stable
  useEffect(() => {
    if (getCachedCloudProfile() === undefined) {
      loadCloudProfile().catch(() => {});
    }
  }, [loadCloudProfile]);

  useEffect(() => {
    return subscribeCloudProfile((nextProfile) => {
      setCloudProfile(nextProfile);
      if (nextProfile) {
        clearLocalAuthPolling();
      }
    });
  }, [clearLocalAuthPolling]);

  useEffect(() => {
    const refreshCloudProfile = () => {
      void loadCloudProfile();
      void syncSettings();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshCloudProfile();
      }
    };

    window.addEventListener("focus", refreshCloudProfile);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", refreshCloudProfile);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadCloudProfile]);

  useEffect(() => {
    const unlistenPromise = listen<string>("deep-link-auth", async (event) => {
      logInfo("SETTINGS", "Received auth token via Tauri event");
      await applyCloudToken(event.payload);
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [applyCloudToken]);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        await onOpenUrl(async (urls) => {
          if (cancelled) return;

          for (const url of urls) {
            const token = extractTokenFromUrl(url);
            if (!token) continue;

            logInfo("SETTINGS", `Deep link auth URL received: ${url}`);
            await applyCloudToken(token);
          }
        });
      } catch (error) {
        logInfo("SETTINGS", `Deep link JS API unavailable: ${error}`);
      }
    };

    void setup();

    return () => {
      cancelled = true;
    };
  }, [applyCloudToken]);

  useEffect(() => {
    if (!waitingForAuth) {
      if (authPollingRef.current) {
        clearInterval(authPollingRef.current);
        authPollingRef.current = null;
      }
      return;
    }

    authPollingRef.current = setInterval(async () => {
      const code = exchangeCodeRef.current;
      const flowId = authFlowRef.current;
      if (!code || !isCloudAuthFlowActive(flowId)) return;

      const token = await pollForToken(code);
      if (
        !token ||
        exchangeCodeRef.current !== code ||
        authFlowRef.current !== flowId ||
        !isCloudAuthFlowActive(flowId)
      )
        return;

      logInfo("SETTINGS", "Auth polling returned device token");
      await applyCloudToken(token);
    }, 3000);

    const timeout = setTimeout(() => {
      cancelLocalAuthPolling();
    }, 120_000);

    return () => {
      if (authPollingRef.current) {
        clearInterval(authPollingRef.current);
        authPollingRef.current = null;
      }
      clearTimeout(timeout);
    };
  }, [applyCloudToken, cancelLocalAuthPolling, waitingForAuth]);

  useEffect(() => {
    if (!waitingForSubscriptionRefresh) {
      return;
    }

    const interval = setInterval(async () => {
      const profile = await loadCloudProfile();
      if (profile?.subscription.active) {
        setWaitingForSubscriptionRefresh(false);
      }
    }, 3000);

    const timeout = setTimeout(() => {
      setWaitingForSubscriptionRefresh(false);
    }, 120_000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [loadCloudProfile, waitingForSubscriptionRefresh]);

  useEffect(() => {
    if (!settings || type !== "style" || !IS_DEV) return;

    let cancelled = false;

    invoke<PromptPreview>("get_cleanup_prompt_preview", {
      language: settings.language,
      style: settings.style,
    })
      .then((preview) => {
        if (cancelled) return;
        setPromptPreview(preview);
        setPromptPreviewError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setPromptPreview(null);
        setPromptPreviewError(
          error instanceof Error ? error.message : String(error),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [settings?.language, settings?.style, type]);

  useEffect(() => {
    void refreshLocalInstalledModels();
  }, [refreshLocalInstalledModels]);

  useEffect(() => {
    if (!settings) return;

    if (type !== "model") {
      setModelModeView(null);
      return;
    }

    const currentMode: ModelMode = !settings.useOwnKey
      ? "cloud"
      : isLocalSttEndpoint(settings.whisperEndpoint)
        ? "local"
        : "api";

    setModelModeView((current) => current ?? currentMode);
  }, [settings?.useOwnKey, settings?.whisperEndpoint, type]);

  useEffect(() => {
    const unlistenPromise = listen<LocalModelDownloadProgressEvent>(
      LOCAL_STT_MODEL_DOWNLOAD_PROGRESS_EVENT,
      (event) => {
        const modelOptions = LOCAL_MODEL_OPTIONS.filter(
          (model) => model.model === event.payload.model,
        );
        if (modelOptions.length === 0) return;

        const progress =
          typeof event.payload.percent === "number"
            ? Math.max(0, Math.min(100, event.payload.percent))
            : undefined;
        const message =
          event.payload.message ||
          (progress !== undefined
            ? t("models.download.progress", { percent: progress })
            : t("models.download.inProgress"));

        setLocalModelActionStates((prev) => {
          const modelOption =
            modelOptions.find(
              (model) => prev[model.id]?.status === "installing",
            ) ||
            modelOptions.find((model) => model.runtimeReady === true) ||
            modelOptions[0];

          return {
            ...prev,
            [modelOption.id]: {
              ...(prev[modelOption.id] || { status: "installing", message }),
              status:
                event.payload.status === "downloaded"
                  ? "success"
                  : "installing",
              message:
                event.payload.status === "downloaded"
                  ? event.payload.message || t("models.download.done")
                  : message,
              progress: event.payload.status === "downloaded" ? 100 : progress,
              downloadedBytes: event.payload.downloaded_bytes,
              totalBytes: event.payload.total_bytes ?? undefined,
            },
          };
        });
      },
    );

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  if (!settings) return null;

  const update = (patch: Partial<AppSettings>): void => {
    setSettings((prev) => {
      const next = { ...(prev ?? settings), ...patch };
      settingsSaveQueueRef.current = settingsSaveQueueRef.current
        .catch(() => {})
        .then(() => saveSettings(patch))
        .then(() => {
          emit(SETTINGS_UPDATED_EVENT).catch(() => {});
        });
      return next;
    });
  };

  // Subscription activation / logout — shared by the Models → IconCloud section and
  // the dedicated "Подписка Talkis" tab so both surfaces drive the same flow.
  const handleActivateSubscription = async () => {
    try {
      const authed = cloudProfile !== null && cloudProfile !== undefined;
      if (authed) {
        setWaitingForSubscriptionRefresh(true);
        await openUrl(cloudProfile.topUpUrl || getCloudTopUpUrl());
        return;
      }

      const code = generateExchangeCode();
      const flowId = beginCloudAuthFlow();
      exchangeCodeRef.current = code;
      authFlowRef.current = flowId;
      setWaitingForAuth(true);
      await openUrl(getAuthLoginUrlWithCode(code));
    } catch {
      cancelLocalAuthPolling();
    }
  };

  const handleCloudLogout = async () => {
    cancelLocalAuthPolling();
    setWaitingForSubscriptionRefresh(false);
    await cloudLogout();
    setCloudProfile(null);
    await syncSettings();
  };

  if (type === "model") {
    const hasActiveSubscription = cloudProfile?.subscription.active === true;
    const isCloudMode = !settings.useOwnKey;
    const isLocalSttMode =
      settings.useOwnKey && isLocalSttEndpoint(settings.whisperEndpoint);
    const isCloudSelected = isCloudMode && hasActiveSubscription;
    const desktopPlatform = detectDesktopPlatform();
    const activeModelMode: ModelMode = isCloudSelected
      ? "cloud"
      : isLocalSttMode
        ? "local"
        : "api";
    const visibleModelMode = modelModeView ?? activeModelMode;
    const isApiMode = visibleModelMode === "api";
    const isLocalMode = visibleModelMode === "local";
    const isCloudView = visibleModelMode === "cloud";
    const selectedApiAdapterId = (settings.selectedApiAdapter ||
      "openai") as ApiAdapterId;
    // In Local mode a local text (LLM) model is "selected" once llmEndpoint points
    // at a local runtime. Without it, transcription works but summarization can't.
    const localTextModelSelected = /127\.0\.0\.1|localhost/i.test(
      settings.llmEndpoint || "",
    );
    // In API mode the text model is "set up" once its own endpoint or API key is
    // filled. The model name has a built-in default ("gpt-4o-mini"), so it can't
    // signal configuration on its own.
    const apiTextModelConfigured =
      Boolean((settings.llmEndpoint || "").trim()) ||
      Boolean((settings.llmApiKey || "").trim());
    const localSttTargetModel =
      (settings.whisperModel || LOCAL_STT_PRESET_MODEL).trim() ||
      LOCAL_STT_PRESET_MODEL;
    const localInstalledModelSet = new Set(localInstalledModels);
    const localModelsDir = (settings.localModelsDir || "").trim();
    const modeOptions: Array<{
      id: ModelMode;
      label: string;
      Icon: Icon;
    }> = [
      {
        id: "cloud",
        label: t("models.mode.cloud"),
        Icon: IconCloud,
      },
      {
        id: "api",
        label: "API",
        Icon: IconCode,
      },
      {
        id: "local",
        label: t("models.mode.local"),
        Icon: IconServer,
      },
    ];

    const resetTestState = () => {
      setTestStatus("idle");
      setTestMessage(null);
      setApiAdapterTestStates({});
    };

    const resetInstallState = () => {
      setLocalModelActionStates({});
    };

    const getRuntimeKindFromEndpoint = (
      endpoint: string,
    ): LocalModelOption["runtimeKind"] | null => {
      try {
        const parsed = new URL(endpoint);
        const port = Number(parsed.port);
        if (
          (parsed.hostname !== "127.0.0.1" &&
            parsed.hostname !== "localhost") ||
          !Number.isFinite(port)
        ) {
          return null;
        }

        if (
          port === 8000 ||
          port === 8001 ||
          port === 8002 ||
          (port >= 18000 && port <= 18149)
        )
          return "whisper";
        if (port === 8003 || (port >= 18150 && port <= 18199))
          return "diarization";
      } catch {
        return null;
      }

      return null;
    };

    const getLocalModelEndpoint = (model: LocalModelOption) => {
      const currentEndpoint = settings.whisperEndpoint.trim();
      if (
        currentEndpoint &&
        getRuntimeKindFromEndpoint(currentEndpoint) === model.runtimeKind
      ) {
        return currentEndpoint;
      }

      return LOCAL_RUNTIME_ENDPOINTS[model.runtimeKind];
    };

    const isApiAdapterSelected = (adapter: ApiAdapterOption) =>
      activeModelMode === "api" && selectedApiAdapterId === adapter.id;

    const getApiAdapterValues = (adapter: ApiAdapterOption) => {
      if (isApiAdapterSelected(adapter)) {
        return {
          apiKey: settings.apiKey || "",
          model: settings.whisperModel || "",
          endpoint: settings.whisperEndpoint || "",
        };
      }

      const savedAdapter = settings.apiAdapters?.[adapter.id];
      return {
        apiKey:
          savedAdapter?.apiKey ||
          (adapter.id === "openai" ? settings.apiKey || "" : ""),
        model: savedAdapter?.model || adapter.recommendedModel,
        endpoint: savedAdapter?.endpoint || "",
      };
    };

    const getApiAdapterModelOption = (
      adapter: ApiAdapterOption,
      model: string,
    ) => adapter.models.find((option) => option.id === model.trim());

    const getPersistedAdapterStatus = (
      adapter: ApiAdapterOption,
      apiKey: string,
      model: string,
      endpoint: string,
    ) => {
      const savedAdapter = settings.apiAdapters?.[adapter.id];
      const normalizedApiKey = apiKey.trim();
      const normalizedModel = model.trim();
      const normalizedEndpoint = endpoint.trim();

      if (
        !savedAdapter?.connectionStatus ||
        !normalizedApiKey ||
        !normalizedModel
      ) {
        return null;
      }

      if (
        savedAdapter.lastTestedApiKey !== normalizedApiKey ||
        savedAdapter.lastTestedModel !== normalizedModel ||
        (savedAdapter.lastTestedEndpoint || "") !== normalizedEndpoint
      ) {
        return null;
      }

      return savedAdapter.connectionStatus;
    };

    const updateApiAdapterValues = (
      adapter: ApiAdapterOption,
      patch: Partial<{ apiKey: string; model: string; endpoint: string }>,
    ) => {
      apiAdapterEditRevisionsRef.current[adapter.id] =
        (apiAdapterEditRevisionsRef.current[adapter.id] || 0) + 1;
      const currentValues = getApiAdapterValues(adapter);
      const nextValues = {
        ...currentValues,
        ...patch,
      };

      update({
        ...(isApiAdapterSelected(adapter)
          ? {
              apiKey: nextValues.apiKey,
              whisperModel: nextValues.model,
              whisperEndpoint: nextValues.endpoint,
            }
          : {}),
        apiAdapters: {
          ...(settings.apiAdapters || {}),
          [adapter.id]: {
            ...nextValues,
          },
        },
      });
      setApiAdapterTestStates((prev) => ({
        ...prev,
        [adapter.id]: { status: "idle", message: "" },
      }));
      setDirtyApiAdapters((prev) => ({ ...prev, [adapter.id]: true }));
      if (adapter.id === "openai") {
        setTestStatus("idle");
        setTestMessage(null);
      }
    };

    const getAdapterStatus = (
      adapter: ApiAdapterOption,
      apiKey: string,
      model: string,
      endpoint: string,
    ) => {
      const persistedStatus = getPersistedAdapterStatus(
        adapter,
        apiKey,
        model,
        endpoint,
      );
      const isSelected =
        isApiAdapterSelected(adapter) &&
        Boolean(persistedStatus) &&
        !dirtyApiAdapters[adapter.id];

      if (adapter.id === "openai") {
        const adapterState = apiAdapterTestStates[adapter.id];
        const effectiveStatus =
          adapterState?.status === "testing" ||
          adapterState?.status === "error" ||
          adapterState?.status === "success"
            ? adapterState.status
            : testStatus === "idle" && persistedStatus
              ? "success"
              : (testStatus as AdapterTestStatus);
        const label = isSelected
          ? t("models.adapterStatus.selected")
          : !apiKey.trim()
            ? t("models.adapterStatus.needApiKey")
            : effectiveStatus === "success"
              ? t("models.adapterStatus.ready")
              : effectiveStatus === "error"
                ? t("models.adapterStatus.error")
                : effectiveStatus === "testing"
                  ? t("models.adapterStatus.testing")
                  : t("models.adapterStatus.readyToTest");
        const color =
          isSelected || effectiveStatus === "success"
            ? "var(--success-bright)"
            : effectiveStatus === "error"
              ? "var(--error-bright)"
              : "var(--text-low)";

        return {
          label,
          message:
            effectiveStatus === "error"
              ? adapterState?.message || testMessage
              : null,
          status: isSelected
            ? ("success" as AdapterTestStatus)
            : effectiveStatus,
          color,
          isSelected,
        };
      }

      const adapterState = apiAdapterTestStates[adapter.id];
      const hasCredentials = Boolean(apiKey.trim()) && Boolean(model.trim());
      const effectiveStatus: AdapterTestStatus =
        adapterState?.status === "error"
          ? "error"
          : persistedStatus
            ? "success"
            : adapterState?.status || "idle";
      const label = isSelected
        ? t("models.adapterStatus.selected")
        : effectiveStatus === "success"
          ? t("models.adapterStatus.ready")
          : !apiKey.trim()
            ? t("models.adapterStatus.needApiKey")
            : !model.trim()
              ? t("models.adapterStatus.needModel")
              : t("models.adapterStatus.readyToSelect");

      return {
        label,
        message: effectiveStatus === "error" ? adapterState?.message : null,
        status: effectiveStatus,
        color:
          isSelected || effectiveStatus === "success"
            ? "var(--success-bright)"
            : effectiveStatus === "error"
              ? "var(--error-bright)"
              : hasCredentials
                ? "var(--text-hi)"
                : "var(--text-low)",
        isSelected,
      };
    };

    const handleApiAdapterTest = async (adapter: ApiAdapterOption) => {
      const values = getApiAdapterValues(adapter);
      if (!values.apiKey.trim() || !values.model.trim()) {
        setApiAdapterTestStates((prev) => ({
          ...prev,
          [adapter.id]: {
            status: "error",
            message: t("models.test.needKeyAndModel"),
          },
        }));
        return;
      }
      const testedRevision =
        apiAdapterEditRevisionsRef.current[adapter.id] || 0;
      const configurationChanged = () =>
        (apiAdapterEditRevisionsRef.current[adapter.id] || 0) !==
        testedRevision;

      const modelOption = getApiAdapterModelOption(adapter, values.model);
      const realtimeCatalogAdapter = STREAMING_STT_ADAPTERS.find(
        (candidate) => candidate.id === adapter.id,
      );
      const shouldTestRealtime = Boolean(
        realtimeCatalogAdapter &&
        (modelOption?.supportsStreaming || !modelOption),
      );
      let streamingCapability: "supported" | "unsupported" | undefined;
      let streamingCapabilityFingerprint: string | undefined;

      if (shouldTestRealtime && realtimeCatalogAdapter) {
        setApiAdapterTestStates((prev) => ({
          ...prev,
          [adapter.id]: {
            status: "testing",
            message: t("models.connection.testing"),
          },
        }));

        try {
          const result = await invoke<{ success: boolean; message: string }>(
            "test_realtime_connection",
            {
              req: {
                provider: adapter.id,
                apiKey: values.apiKey,
                model: values.model,
                endpoint:
                  values.endpoint || realtimeCatalogAdapter.defaultEndpoint,
                purpose: "stt",
              },
            },
          );
          if (configurationChanged()) {
            setApiAdapterTestStates((prev) => ({
              ...prev,
              [adapter.id]: { status: "idle", message: "" },
            }));
            return;
          }
          setApiAdapterTestStates((prev) => ({
            ...prev,
            [adapter.id]: {
              status: result.success ? "success" : "error",
              message: result.success ? "" : result.message,
            },
          }));
          if (!result.success) return;
          streamingCapability = "supported";
          streamingCapabilityFingerprint = realtimeConfigurationFingerprint({
            provider: adapter.id,
            apiKey: values.apiKey,
            model: values.model,
            endpoint: values.endpoint,
            defaultEndpoint: realtimeCatalogAdapter.defaultEndpoint,
          });
        } catch (err) {
          if (configurationChanged()) {
            setApiAdapterTestStates((prev) => ({
              ...prev,
              [adapter.id]: { status: "idle", message: "" },
            }));
            return;
          }
          setApiAdapterTestStates((prev) => ({
            ...prev,
            [adapter.id]: {
              status: "error",
              message: err instanceof Error ? err.message : String(err),
            },
          }));
          return;
        }
      } else if (adapter.testable) {
        setApiAdapterTestStates((prev) => ({
          ...prev,
          [adapter.id]: { status: "testing", message: "" },
        }));
        try {
          const result = await invoke<{ success: boolean; message: string }>(
            "test_api_connection",
            {
              req: {
                api_key: values.apiKey,
                whisper_api_key: null,
                whisper_endpoint: values.endpoint || null,
                local_models_dir: null,
                whisper_model: values.model,
                llm_api_key: null,
                llm_endpoint: null,
                llm_model: "none",
                test_stt: true,
                test_llm: false,
              },
            },
          );
          if (configurationChanged()) {
            setApiAdapterTestStates((prev) => ({
              ...prev,
              [adapter.id]: { status: "idle", message: "" },
            }));
            return;
          }
          if (!result.success) throw new Error(result.message);
        } catch (err) {
          if (configurationChanged()) {
            setApiAdapterTestStates((prev) => ({
              ...prev,
              [adapter.id]: { status: "idle", message: "" },
            }));
            return;
          }
          setApiAdapterTestStates((prev) => ({
            ...prev,
            [adapter.id]: {
              status: "error",
              message: err instanceof Error ? err.message : String(err),
            },
          }));
          return;
        }
      } else {
        setApiAdapterTestStates((prev) => ({
          ...prev,
          [adapter.id]: {
            status: "success",
            message: "",
          },
        }));
      }

      if (configurationChanged()) {
        return;
      }
      setApiAdapterTestStates((prev) => ({
        ...prev,
        [adapter.id]: {
          status: "success",
          message: "",
        },
      }));
      setDirtyApiAdapters((prev) => ({ ...prev, [adapter.id]: false }));
      update({
        apiAdapters: {
          ...(settings.apiAdapters || {}),
          [adapter.id]: {
            apiKey: values.apiKey,
            model: values.model,
            endpoint: values.endpoint,
            connectionStatus:
              shouldTestRealtime || adapter.testable ? "verified" : "saved",
            lastConnectedAt: new Date().toISOString(),
            lastTestedApiKey: values.apiKey.trim(),
            lastTestedModel: values.model.trim(),
            lastTestedEndpoint: values.endpoint.trim(),
            streamingCapability,
            streamingCapabilityFingerprint,
          },
        },
      });
    };

    const buildActiveApiAdapterSnapshot = (): Partial<AppSettings> => {
      if (activeModelMode !== "api") {
        return {};
      }

      const adapterId = selectedApiAdapterId || "openai";
      const currentAdapter = settings.apiAdapters?.[adapterId] || {
        apiKey: settings.apiKey || "",
        model: settings.whisperModel || "whisper-1",
      };

      return {
        apiAdapters: {
          ...(settings.apiAdapters || {}),
          [adapterId]: {
            ...currentAdapter,
            apiKey: settings.apiKey || "",
            model: settings.whisperModel || "whisper-1",
            endpoint: settings.whisperEndpoint || "",
          },
        },
      };
    };

    const handleSelectApiAdapter = (adapter: ApiAdapterOption) => {
      const values = getApiAdapterValues(adapter);
      const apiKey = values.apiKey.trim();
      const model = values.model.trim();
      const endpoint = values.endpoint.trim();

      if (!apiKey || !model) {
        setApiAdapterTestStates((prev) => ({
          ...prev,
          [adapter.id]: {
            status: "error",
            message: t("models.test.needKeyAndModelBeforeSelect"),
          },
        }));
        return;
      }

      update({
        useOwnKey: true,
        provider: "openai",
        selectedApiAdapter: adapter.id,
        apiKey,
        whisperApiKey: "",
        whisperEndpoint: endpoint,
        whisperModel: model,
        llmApiKey: "",
        llmEndpoint: "",
        llmModel: "none",
        apiAdapters: {
          ...(settings.apiAdapters || {}),
          [adapter.id]: {
            ...(settings.apiAdapters?.[adapter.id] || {}),
            apiKey,
            model,
            endpoint,
            connectionStatus:
              settings.apiAdapters?.[adapter.id]?.connectionStatus || "saved",
            lastConnectedAt:
              settings.apiAdapters?.[adapter.id]?.lastConnectedAt ||
              new Date().toISOString(),
            lastTestedApiKey:
              settings.apiAdapters?.[adapter.id]?.lastTestedApiKey,
            lastTestedModel:
              settings.apiAdapters?.[adapter.id]?.lastTestedModel,
            lastTestedEndpoint:
              settings.apiAdapters?.[adapter.id]?.lastTestedEndpoint,
          },
        },
      });
      setModelModeView("api");
      resetInstallState();
    };

    const handleModeChange = (mode: (typeof modeOptions)[number]["id"]) => {
      if (mode === visibleModelMode) {
        return;
      }

      setModelModeView(mode);
      resetTestState();
      resetInstallState();
    };

    const handleSelectCloudMode = () => {
      if (!hasActiveSubscription) {
        return;
      }

      update(talkisCloudModeSettingsPatch(buildActiveApiAdapterSnapshot()));
      setModelModeView("cloud");
      resetTestState();
      resetInstallState();
    };

    // Explicit "use this mode" commit for the API / Local segments. The recognition
    // and text model share the same backend flag, so committing the mode here is the
    // single source of truth; the specific adapter / model is still picked below.
    const handleSelectApiMode = () => {
      const adapter =
        API_ADAPTERS.find((candidate) => candidate.id === selectedApiAdapterId) ||
        API_ADAPTERS[0];
      const values = getApiAdapterValues(adapter);
      update(
        apiModelModeSettingsPatch({
          adapterId: adapter.id,
          apiKey: values.apiKey,
          endpoint: values.endpoint,
          model: values.model,
        }),
      );
      setModelModeView("api");
      resetTestState();
      resetInstallState();
    };

    const handleSelectLocalMode = () => {
      const preferredModel =
        LOCAL_MODEL_OPTIONS.find(
          (model) =>
            model.purpose !== "diarization" &&
            localInstalledModelSet.has(model.model),
        ) ||
        LOCAL_MODEL_OPTIONS.find(
          (model) =>
            model.purpose !== "diarization" &&
            settings.localModels?.[model.id]?.status === "downloaded",
        ) ||
        LOCAL_MODEL_OPTIONS.find(
          (model) => model.model === LOCAL_STT_PRESET_MODEL,
        ) ||
        LOCAL_MODEL_OPTIONS[0];

      update(
        localModelModeSettingsPatch(
          {
            endpoint: getLocalModelEndpoint(preferredModel),
            model: preferredModel.model,
          },
          buildActiveApiAdapterSnapshot(),
        ),
      );
      setModelModeView("local");
      resetTestState();
      resetInstallState();
    };

    const renderModeCommitRow = (mode: "api" | "local") => {
      const isActive = activeModelMode === mode;
      const modeLabel = mode === "api" ? "API" : t("models.mode.local");
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 10,
            background: "var(--control-muted)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12.5,
              fontWeight: 650,
              color: isActive ? "var(--success-bright)" : "var(--text-mid)",
            }}
          >
            {isActive && <IconCheck size={15} stroke={2.5} />}
            <span>
              {isActive
                ? t("models.modeCommit.active")
                : t("models.modeCommit.label", { mode: modeLabel })}
            </span>
          </div>
          {!isActive && (
            <button
              type="button"
              onClick={
                mode === "api" ? handleSelectApiMode : handleSelectLocalMode
              }
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "none",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                fontSize: 12,
                fontWeight: 700,
                fontFamily: "var(--font-main)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              {t("models.modeCommit.select")}
            </button>
          )}
        </div>
      );
    };

    const updateLocalModelCache = (
      modelId: string,
      patch: Partial<LocalModelSettings>,
    ) => {
      const current = settings.localModels?.[modelId] || {
        status: "not_downloaded" as const,
      };
      update({
        localModels: {
          ...(settings.localModels || {}),
          [modelId]: {
            ...current,
            ...patch,
          },
        },
      });
    };

    const handleSelectLocalTranslator = (
      component: LocalOtherComponent,
      selected: boolean,
    ) => {
      update({
        translation: {
          ...settings.translation,
          selectionLocalTranslatorProvider: selected ? component.id : "",
        },
      });
    };

    const getLocalModelStatus = (model: LocalModelOption) => {
      const actionState = localModelActionStates[model.id];
      const cachedState = settings.localModels?.[model.id];
      const isPlatformSupported =
        model.runtimeKind === "whisper" ||
        model.runtimeKind === "diarization" ||
        desktopPlatform === "macos";
      const isRuntimeReady = model.runtimeReady === true && isPlatformSupported;
      const isInstalled =
        isRuntimeReady && localInstalledModelSet.has(model.model);
      const isSelected =
        activeModelMode === "local" &&
        localSttTargetModel === model.model &&
        isInstalled;

      if (!isRuntimeReady) {
        const runtimeName =
          model.runtimeKind === "diarization"
            ? "Diarization"
            : "transcribe.cpp";
        const isRuntimeSlotReady = model.runtimeKind === "diarization";
        return {
          label: isRuntimeSlotReady
            ? t("models.local.modelNotConnected")
            : t("models.local.engineNotConnected"),
          connectionLabel: isRuntimeSlotReady
            ? t("models.local.runtimeReadyModelOff", { runtime: runtimeName })
            : t("models.local.runtimeSlotPrepared", { runtime: runtimeName }),
          status: "unsupported" as const,
          color: "var(--text-low)",
          message: !isPlatformSupported
            ? t("models.local.macOnly")
            : model.unavailableReason ||
              t("models.local.sidecarPending", { runtime: runtimeName }),
          isInstalled: false,
          isSelected: false,
        };
      }

      if (actionState?.status === "deleting") {
        return {
          label: t("models.local.deleting"),
          connectionLabel: "",
          status: "deleting" as const,
          color: "var(--text-hi)",
          message: actionState.message || cachedState?.message || null,
          isInstalled,
          isSelected,
        };
      }

      if (
        !isInstalled &&
        (actionState?.status === "installing" ||
          cachedState?.status === "downloading")
      ) {
        return {
          label: t("models.local.downloading"),
          connectionLabel: "",
          status: "installing" as const,
          color: "var(--text-hi)",
          message: actionState?.message || cachedState?.message || null,
          isInstalled,
          isSelected,
        };
      }

      if (isSelected) {
        return {
          label: t("models.local.selected"),
          connectionLabel: "",
          status: "selected" as const,
          color: "var(--success-bright)",
          message: actionState?.message || cachedState?.message || null,
          isInstalled,
          isSelected,
        };
      }

      if (isInstalled) {
        return {
          label: t("models.local.ready"),
          connectionLabel: "",
          status: "installed" as const,
          color: "var(--success-bright)",
          message: actionState?.message || cachedState?.message || null,
          isInstalled,
          isSelected,
        };
      }

      if (actionState?.status === "error" || cachedState?.status === "error") {
        return {
          label: t("models.adapterStatus.error"),
          connectionLabel: t("models.local.prepareFailed"),
          status: "error" as const,
          color: "var(--error-bright)",
          message: actionState?.message || cachedState?.message || null,
          isInstalled,
          isSelected,
        };
      }

      return {
        label: t("models.local.notDownloaded"),
        connectionLabel: "",
        status: "idle" as const,
        color: "var(--text-low)",
        message: actionState?.message || cachedState?.message || null,
        isInstalled,
        isSelected,
      };
    };

    const getLocalOtherStatus = (component: LocalOtherComponent) => {
      const actionState = localModelActionStates[component.id];
      const cachedState = settings.localModels?.[component.id];
      const backendState =
        localTranslators[component.id] ||
        (component.id === "nllb-200" ? localTranslators.trad : undefined);
      const isSelected =
        settings.translation.selectionLocalTranslatorProvider ===
          component.id ||
        (component.id === "nllb-200" &&
          settings.translation.selectionLocalTranslatorProvider === "trad");

      if (actionState?.status === "deleting") {
        return {
          label: t("models.local.deleting"),
          status: "deleting" as const,
          color: "var(--text-hi)",
          message:
            actionState.message ||
            cachedState?.message ||
            backendState?.message ||
            null,
          isInstalled: backendState?.status === "ready",
          isSelected,
          canDelete: backendState?.managed === true,
        };
      }

      if (
        actionState?.status === "installing" ||
        backendState?.status === "downloading"
      ) {
        return {
          label: t("models.localOther.status.downloading"),
          status: "installing" as const,
          color: "var(--text-hi)",
          message:
            actionState?.message ||
            cachedState?.message ||
            backendState?.message ||
            null,
          isInstalled: false,
          isSelected: false,
          canDelete: false,
        };
      }

      if (backendState?.status === "ready") {
        return {
          label: t("models.localOther.status.ready"),
          status: "installed" as const,
          color: "var(--success-bright)",
          message: backendState.message || cachedState?.message || null,
          isInstalled: true,
          isSelected,
          canDelete: backendState.managed === true,
        };
      }

      if (actionState?.status === "error" || backendState?.status === "error") {
        return {
          label: t("models.localOther.status.error"),
          status: "error" as const,
          color: "var(--error-bright)",
          message:
            actionState?.message ||
            cachedState?.message ||
            backendState?.message ||
            null,
          isInstalled: false,
          isSelected: false,
          canDelete: false,
        };
      }

      return {
        label: t("models.localOther.status.notInstalled"),
        status: "idle" as const,
        color: "var(--text-low)",
        message: backendState?.message || null,
        isInstalled: false,
        isSelected: false,
        canDelete: false,
      };
    };

    const formatLocalDownloadBytes = (
      bytes?: number,
      options: { showZero?: boolean } = {},
    ) => {
      if (!bytes || bytes <= 0)
        return options.showZero ? t("models.size.zero") : "";
      const mb = bytes / (1024 * 1024);
      if (mb >= 1024) {
        const gb = mb / 1024;
        return t("models.size.gb", {
          value: gb.toFixed(gb >= 10 ? 0 : 1).replace(".", ","),
        });
      }

      return t("models.size.mb", {
        value: mb.toFixed(mb >= 10 ? 0 : 1).replace(".", ","),
      });
    };

    const getLocalModelStorageLabel = (
      model: Pick<LocalModelOption, "downloadBytes" | "runtimeReady">,
    ) => {
      return (
        formatLocalDownloadBytes(model.downloadBytes) ||
        (model.runtimeReady
          ? t("models.size.unknown")
          : t("models.size.notConnected"))
      );
    };

    const translateSpeedValue = (value: string) => {
      switch (value) {
        case "очень быстро":
          return t("models.speedValue.veryFast");
        case "быстро":
          return t("models.speedValue.fast");
        case "средне":
          return t("models.speedValue.medium");
        default:
          return value;
      }
    };

    const translateAccuracyValue = (value: string) => {
      switch (value) {
        case "максимальная":
          return t("models.accuracyValue.maximum");
        case "высокая":
          return t("models.accuracyValue.high");
        case "средняя":
          return t("models.accuracyValue.medium");
        case "средняя+":
          return t("models.accuracyValue.mediumPlus");
        case "базовая":
          return t("models.accuracyValue.basic");
        case "низкая+":
          return t("models.accuracyValue.lowPlus");
        case "служебная":
          return t("models.accuracyValue.utility");
        default:
          return value;
      }
    };

    const translateLanguageValue = (value: string) => {
      if (value === "English") return t("models.languageValue.english");
      if (value.includes("->") || value.includes("→")) return value;
      return t("models.languageValue.count", { value });
    };

    const renderLocalModelStats = (
      model: Pick<
        LocalModelOption,
        | "downloadBytes"
        | "runtimeReady"
        | "speed"
        | "accuracy"
        | "languageLabel"
        | "supportsStreaming"
      >,
    ) => {
      const speedValueLabel = translateSpeedValue(model.speed);
      const accuracyValueLabel = translateAccuracyValue(model.accuracy);
      const languageValueLabel = translateLanguageValue(model.languageLabel);
      const stats: { key: string; title: string; Icon: Icon; value: string }[] =
        [
          {
            key: "speed",
            title: t("models.stat.speedTitle", { value: speedValueLabel }),
            Icon: IconGauge,
            value: speedValueLabel,
          },
          {
            key: "accuracy",
            title: t("models.stat.accuracyTitle", {
              value: accuracyValueLabel,
            }),
            Icon: IconTargetArrow,
            value: accuracyValueLabel,
          },
        ];
      const storageLabel = getLocalModelStorageLabel(model);

      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 9,
            flexWrap: "nowrap",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <div
            title={t("models.stat.downloadSizeTitle", { value: storageLabel })}
            aria-label={t("models.stat.downloadSizeTitle", {
              value: storageLabel,
            })}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              flexShrink: 0,
            }}
          >
            <IconDownload size={14} stroke={1.9} color="var(--text-hi)" />
            <span
              style={{
                fontSize: 12,
                fontWeight: 650,
                color: "var(--text-hi)",
                lineHeight: 1,
                whiteSpace: "nowrap",
              }}
            >
              {storageLabel}
            </span>
          </div>

          <div
            title={t("models.stat.languagesTitle", {
              value: languageValueLabel,
            })}
            aria-label={t("models.stat.languagesTitle", {
              value: languageValueLabel,
            })}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              flexShrink: 0,
            }}
          >
            <IconGlobe size={14} stroke={1.9} color="var(--text-hi)" />
            <span
              style={{
                fontSize: 12,
                fontWeight: 650,
                color: "var(--text-hi)",
                lineHeight: 1,
                whiteSpace: "nowrap",
              }}
            >
              {languageValueLabel}
            </span>
          </div>

          {stats.map(({ key, title, Icon, value }) => (
            <div
              key={key}
              title={title}
              aria-label={title}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                flexShrink: 0,
              }}
            >
              <Icon size={14} stroke={1.9} color="var(--text-hi)" />
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 650,
                  color: "var(--text-hi)",
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                }}
              >
                {value}
              </span>
            </div>
          ))}

          {model.supportsStreaming && (
            <div
              title={t("models.stat.streaming")}
              aria-label={t("models.stat.streaming")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                flexShrink: 0,
              }}
            >
              <IconBroadcast size={14} stroke={1.9} color="var(--text-hi)" />
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 650,
                  color: "var(--text-hi)",
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                }}
              >
                {t("models.stat.streaming")}
              </span>
            </div>
          )}
        </div>
      );
    };

    const handleSelectLocalModel = (
      model: LocalModelOption,
      endpointOverride?: string,
    ) => {
      update({
        ...buildActiveApiAdapterSnapshot(),
        useOwnKey: true,
        provider: "custom",
        whisperApiKey: "",
        whisperEndpoint: endpointOverride || getLocalModelEndpoint(model),
        whisperModel: model.model,
      });
      setModelModeView("local");
      resetTestState();
      resetInstallState();

      if (localInstalledModelSet.has(model.model)) {
        updateLocalModelCache(model.id, {
          status: "downloaded",
          downloadedAt:
            settings.localModels?.[model.id]?.downloadedAt ||
            new Date().toISOString(),
          lastCheckedAt: new Date().toISOString(),
          message: undefined,
        });
      }
    };

    const handleInstallLocalSttModel = async (model: LocalModelOption) => {
      optimisticLocalInstalledModelsRef.current.delete(model.model);
      setLocalModelActionStates((prev) => ({
        ...prev,
        [model.id]: {
          status: "installing",
          message: t("models.install.preparingRuntime"),
          progress: 0,
        },
      }));
      updateLocalModelCache(model.id, {
        status: "downloading",
        message: t("models.install.preparingRuntime"),
      });

      try {
        const result = await invoke<{
          success: boolean;
          message: string;
          whisper_endpoint?: string | null;
        }>("install_stt_model", {
          req: {
            api_key: settings.apiKey || "",
            whisper_api_key: settings.whisperApiKey || null,
            whisper_endpoint: getLocalModelEndpoint(model),
            local_models_dir: localModelsDir || null,
            whisper_model: model.model,
          },
        });

        if (result.success) {
          optimisticLocalInstalledModelsRef.current.add(model.model);
          setLocalInstalledModels((prev) =>
            prev.includes(model.model) ? prev : [...prev, model.model],
          );
        } else {
          optimisticLocalInstalledModelsRef.current.delete(model.model);
        }
        setLocalModelActionStates((prev) => ({
          ...prev,
          [model.id]: {
            status: result.success ? "success" : "error",
            message: result.success ? "" : result.message,
          },
        }));
        updateLocalModelCache(model.id, {
          status: result.success ? "downloaded" : "error",
          message: result.success ? undefined : result.message,
          downloadedAt: result.success ? new Date().toISOString() : undefined,
          lastCheckedAt: new Date().toISOString(),
        });

        if (result.success && model.purpose !== "diarization") {
          handleSelectLocalModel(model, result.whisper_endpoint || undefined);
          await refreshLocalInstalledModels();
        } else if (result.success) {
          await refreshLocalInstalledModels();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("отменена")) {
          // IconUser cancelled — reset to the not-downloaded state silently.
          optimisticLocalInstalledModelsRef.current.delete(model.model);
          setLocalModelActionStates((prev) => {
            const next = { ...prev };
            delete next[model.id];
            return next;
          });
          updateLocalModelCache(model.id, {
            status: "not_downloaded",
            message: undefined,
            lastCheckedAt: new Date().toISOString(),
          });
          return;
        }
        optimisticLocalInstalledModelsRef.current.delete(model.model);
        setLocalModelActionStates((prev) => ({
          ...prev,
          [model.id]: { status: "error", message },
        }));
        updateLocalModelCache(model.id, {
          status: "error",
          message,
          lastCheckedAt: new Date().toISOString(),
        });
      }
    };

    const handleCancelLocalSttDownload = async (model: LocalModelOption) => {
      try {
        await invoke("cancel_local_model_download", { modelId: model.model });
      } catch {
        /* best-effort */
      }
    };

    const handleDeleteLocalSttModel = async (model: LocalModelOption) => {
      setPendingDeleteModel(null);
      optimisticLocalInstalledModelsRef.current.delete(model.model);
      setLocalModelActionStates((prev) => ({
        ...prev,
        [model.id]: {
          status: "deleting",
          message: t("models.delete.removingFile"),
        },
      }));

      try {
        const result = await invoke<{ success: boolean; message: string }>(
          "delete_stt_model",
          {
            req: {
              api_key: settings.apiKey || "",
              whisper_api_key: settings.whisperApiKey || null,
              whisper_endpoint: getLocalModelEndpoint(model),
              local_models_dir: localModelsDir || null,
              whisper_model: model.model,
            },
          },
        );

        setLocalModelActionStates((prev) => ({
          ...prev,
          [model.id]: {
            status: result.success ? "success" : "error",
            message: result.success ? "" : result.message,
          },
        }));
        updateLocalModelCache(model.id, {
          status: result.success ? "not_downloaded" : "error",
          message: result.success ? undefined : result.message,
          downloadedAt: undefined,
          lastCheckedAt: new Date().toISOString(),
        });

        if (result.success) {
          setLocalInstalledModels((prev) =>
            prev.filter((id) => id !== model.model),
          );
          await refreshLocalInstalledModels();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLocalModelActionStates((prev) => ({
          ...prev,
          [model.id]: { status: "error", message },
        }));
        updateLocalModelCache(model.id, {
          status: "error",
          message,
          lastCheckedAt: new Date().toISOString(),
        });
      }
    };

    const handleInstallLocalTranslator = async (
      component: LocalOtherComponent,
    ) => {
      setLocalModelActionStates((prev) => ({
        ...prev,
        [component.id]: {
          status: "installing",
          message: t("models.install.preparingRuntime"),
          progress: 0,
        },
      }));
      updateLocalModelCache(component.id, {
        status: "downloading",
        message: t("models.install.preparingRuntime"),
      });

      try {
        const result = await invoke<{ success: boolean; message: string }>(
          "download_local_translator",
          {
            req: { provider: component.id },
          },
        );
        setLocalModelActionStates((prev) => ({
          ...prev,
          [component.id]: {
            status: result.success ? "success" : "error",
            message: result.success ? "" : result.message,
          },
        }));
        updateLocalModelCache(component.id, {
          status: result.success ? "downloaded" : "error",
          message: result.success ? undefined : result.message,
          downloadedAt: result.success ? new Date().toISOString() : undefined,
          lastCheckedAt: new Date().toISOString(),
        });
        await refreshLocalTranslators();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLocalModelActionStates((prev) => ({
          ...prev,
          [component.id]: { status: "error", message },
        }));
        updateLocalModelCache(component.id, {
          status: "error",
          message,
          lastCheckedAt: new Date().toISOString(),
        });
        await refreshLocalTranslators();
      }
    };

    const handleDeleteLocalTranslator = async (
      component: LocalOtherComponent,
    ) => {
      setLocalModelActionStates((prev) => ({
        ...prev,
        [component.id]: {
          status: "deleting",
          message: t("models.delete.removingFile"),
        },
      }));

      try {
        const result = await invoke<{ success: boolean; message: string }>(
          "delete_local_translator",
          {
            req: { provider: component.id },
          },
        );
        setLocalModelActionStates((prev) => ({
          ...prev,
          [component.id]: {
            status: result.success ? "success" : "error",
            message: result.success ? "" : result.message,
          },
        }));
        updateLocalModelCache(component.id, {
          status: result.success ? "not_downloaded" : "error",
          message: result.success ? undefined : result.message,
          downloadedAt: undefined,
          lastCheckedAt: new Date().toISOString(),
        });
        if (
          result.success &&
          (settings.translation.selectionLocalTranslatorProvider ===
            component.id ||
            (component.id === "nllb-200" &&
              settings.translation.selectionLocalTranslatorProvider === "trad"))
        ) {
          handleSelectLocalTranslator(component, false);
        }
        await refreshLocalTranslators();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLocalModelActionStates((prev) => ({
          ...prev,
          [component.id]: { status: "error", message },
        }));
        updateLocalModelCache(component.id, {
          status: "error",
          message,
          lastCheckedAt: new Date().toISOString(),
        });
        await refreshLocalTranslators();
      }
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <>
          <div>
            <div
              style={{
                fontSize: 17,
                fontWeight: 700,
                color: "var(--text-hi)",
                marginBottom: 4,
              }}
            >
              {t("models.modeSection.title")}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--text-mid)",
                lineHeight: 1.6,
                marginBottom: 14,
              }}
            >
              {t("models.modeSection.desc")}
            </div>

            <div
              style={{
                display: "flex",
                background: "var(--control-track)",
                borderRadius: 10,
                padding: 3,
                gap: 2,
              }}
            >
              {modeOptions.map(({ id, label, Icon }) => {
                const active = visibleModelMode === id;

                return (
                  <button
                    key={id}
                    onClick={() => handleModeChange(id)}
                    style={{
                      flex: 1,
                      padding: "10px 0",
                      borderRadius: 8,
                      border: "none",
                      fontSize: 13,
                      fontWeight: active ? 700 : 500,
                      fontFamily: "var(--font-main)",
                      background: active
                        ? "var(--dropdown-active)"
                        : "transparent",
                      color: active ? "var(--text-hi)" : "var(--text-mid)",
                      cursor: "pointer",
                      transition: "all 0.18s ease",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 7,
                    }}
                  >
                    <Icon size={15} stroke={active ? 2.2 : 1.7} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {isCloudView && (
            <>
              <SubscriptionCards
                profile={cloudProfile}
                onActivate={handleActivateSubscription}
                onTopUp={handleActivateSubscription}
                onLogout={() => {
                  void handleCloudLogout();
                }}
              />

              {hasActiveSubscription && (
                <div
                  className="card"
                  style={{ display: "flex", flexDirection: "column", gap: 12 }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: "var(--text-hi)",
                        marginBottom: 4,
                      }}
                    >
                      {t("models.mode.cloud")}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--text-mid)",
                        lineHeight: 1.6,
                      }}
                    >
                      {t("models.cloud.descActive")}
                    </div>
                  </div>

                  {(isCloudSelected || hasActiveSubscription) && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          color: isCloudSelected
                            ? "var(--success-bright)"
                            : "var(--text-hi)",
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        <IconCheck size={15} stroke={2.5} />
                        {isCloudSelected
                          ? t("models.connection.usedForRecognition")
                          : t("models.cloud.proReady")}
                      </div>

                      {isCloudSelected ? (
                        <div
                          style={{
                            padding: "9px 12px",
                            borderRadius: 10,
                            border: "1px solid var(--success-border)",
                            background: "var(--success-soft)",
                            color: "var(--success-bright)",
                            fontSize: 12,
                            fontWeight: 700,
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <IconCheck size={14} stroke={2.5} />
                          {t("models.common.selected")}
                        </div>
                      ) : hasActiveSubscription ? (
                        <button
                          type="button"
                          onClick={handleSelectCloudMode}
                          style={{
                            padding: "9px 12px",
                            borderRadius: 10,
                            border: "1px solid var(--border-dashed)",
                            background: "var(--control-muted)",
                            color: "var(--text-hi)",
                            fontSize: 12,
                            fontWeight: 700,
                            fontFamily: "var(--font-main)",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <IconCheck size={14} stroke={2.5} />
                          {t("models.common.select")}
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {isApiMode && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                style={{
                  display: "flex",
                  background: "var(--control-track)",
                  borderRadius: 10,
                  padding: 3,
                  gap: 2,
                }}
              >
                {(
                  [
                    {
                      id: "transcription",
                      label: t("models.local.tabTranscription"),
                      Icon: IconMicrophone,
                    },
                    {
                      id: "text",
                      label: t("models.local.tabText"),
                      Icon: IconMessage,
                    },
                    {
                      id: "translation",
                      label: t("models.local.tabTranslation"),
                      Icon: IconLanguage,
                    },
                  ] as const
                ).map(({ id, label, Icon }) => {
                  const active = apiModelKind === id;

                  return (
                    <button
                      key={id}
                      onClick={() => setApiModelKind(id)}
                      style={{
                        flex: 1,
                        padding: "10px 0",
                        borderRadius: 8,
                        border: "none",
                        fontSize: 13,
                        fontWeight: active ? 700 : 500,
                        fontFamily: "var(--font-main)",
                        background: active
                          ? "var(--dropdown-active)"
                          : "transparent",
                        color: active ? "var(--text-hi)" : "var(--text-mid)",
                        cursor: "pointer",
                        transition: "all 0.18s ease",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 7,
                      }}
                    >
                      <Icon size={15} stroke={active ? 2.2 : 1.7} />
                      <span>{label}</span>
                      {id === "text" && !apiTextModelConfigured && (
                        <span
                          title={t("summary.unavailable.tooltip")}
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: 999,
                            background: "var(--accent)",
                            flexShrink: 0,
                          }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              {renderModeCommitRow("api")}

              {apiModelKind === "transcription" && (
                <>
                  <div>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: "var(--text-hi)",
                        marginBottom: 4,
                      }}
                    >
                      {t("models.apiSection.title")}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--text-mid)",
                        lineHeight: 1.6,
                      }}
                    >
                      {t("models.apiSection.desc")}
                    </div>
                  </div>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    {API_ADAPTERS.map((adapter) => {
                      const isExpanded = expandedApiAdapter === adapter.id;
                      const adapterValues = getApiAdapterValues(adapter);
                      const adapterStatus = getAdapterStatus(
                        adapter,
                        adapterValues.apiKey,
                        adapterValues.model,
                        adapterValues.endpoint,
                      );
                      const selectedModelOption = getApiAdapterModelOption(
                        adapter,
                        adapterValues.model,
                      );
                      const realtimeCatalogAdapter =
                        STREAMING_STT_ADAPTERS.find(
                          (candidate) => candidate.id === adapter.id,
                        );
                      const streamingVerified = Boolean(
                        !dirtyApiAdapters[adapter.id] &&
                        realtimeCatalogAdapter &&
                        hasVerifiedRealtimeCapability(
                          realtimeCatalogAdapter,
                          settings.apiAdapters?.[adapter.id],
                        ),
                      );
                      const modelSelectValue =
                        selectedModelOption?.id || CUSTOM_API_MODEL_VALUE;
                      const isAdapterSelected = adapterStatus.isSelected;
                      const isAdapterReady = adapterStatus.status === "success";
                      const canSelectApiAdapter =
                        Boolean(adapterValues.apiKey.trim()) &&
                        Boolean(adapterValues.model.trim());
                      const isAdapterTestDisabled =
                        adapterStatus.status === "testing" ||
                        !canSelectApiAdapter;

                      return (
                        <div
                          key={adapter.id}
                          className="card"
                          style={{
                            padding: 0,
                            overflow: isExpanded ? "visible" : "hidden",
                            position: "relative",
                            zIndex: isExpanded ? 10 : 0,
                            background: "var(--surface)",
                          }}
                        >
                          <div
                            style={{
                              position: "relative",
                              padding: "12px 14px",
                              display: "flex",
                              alignItems: "center",
                              gap: 12,
                              textAlign: "left",
                              fontFamily: "var(--font-main)",
                            }}
                          >
                            <div
                              style={{
                                position: "relative",
                                flex: 1,
                                minWidth: 0,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: 10,
                                  marginBottom: 3,
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: 15,
                                    fontWeight: 700,
                                    color: "var(--text-hi)",
                                  }}
                                >
                                  {adapter.name}
                                </div>
                                <div
                                  title={adapterStatus.message || undefined}
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: adapterStatus.color,
                                    padding: "5px 9px",
                                    borderRadius: 999,
                                    background: "var(--control-muted)",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {adapterStatus.label}
                                </div>
                              </div>
                              <div style={{ paddingRight: 34 }}>
                                <div
                                  style={{
                                    fontSize: 12,
                                    lineHeight: 1.45,
                                    color: "var(--text-mid)",
                                  }}
                                >
                                  {t(API_ADAPTER_DESCRIPTION_KEYS[adapter.id])}{" "}
                                  {t("models.adapter.recommendedModel", {
                                    model: adapter.recommendedModel,
                                  })}
                                </div>
                                {streamingVerified &&
                                  (selectedModelOption?.supportsStreaming ||
                                    !selectedModelOption) && (
                                    <div
                                      title={t("models.stat.streaming")}
                                      aria-label={t("models.stat.streaming")}
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 5,
                                        marginTop: 9,
                                      }}
                                    >
                                      <IconBroadcast
                                        size={14}
                                        stroke={1.9}
                                        color="var(--text-hi)"
                                      />
                                      <span
                                        style={{
                                          fontSize: 12,
                                          fontWeight: 650,
                                          color: "var(--text-hi)",
                                          lineHeight: 1,
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {t("models.stat.streaming")}
                                      </span>
                                    </div>
                                  )}
                              </div>
                              <ModelCardDisclosureButton
                                expanded={isExpanded}
                                onToggle={() =>
                                  setExpandedApiAdapter(
                                    isExpanded ? null : adapter.id,
                                  )
                                }
                                label={t(
                                  isExpanded
                                    ? "mainTab.collapse"
                                    : "mainTab.expand",
                                )}
                              />
                            </div>
                          </div>

                          {isExpanded && (
                            <div
                              style={{
                                borderTop: "1px solid var(--border-subtle)",
                                padding: "12px 14px",
                                display: "flex",
                                flexDirection: "column",
                                gap: 10,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                }}
                              >
                                <div
                                  className="label"
                                  style={{ width: 76, flexShrink: 0 }}
                                >
                                  {t("models.field.apiKey")}
                                </div>
                                <input
                                  type="password"
                                  value={adapterValues.apiKey}
                                  onChange={(e) =>
                                    updateApiAdapterValues(adapter, {
                                      apiKey: e.target.value,
                                    })
                                  }
                                  className="input"
                                  placeholder="API key"
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    height: 36,
                                    padding: "8px 10px",
                                    fontFamily:
                                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                    fontSize: 12,
                                  }}
                                />
                              </div>

                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                }}
                              >
                                <div
                                  className="label"
                                  style={{ width: 76, flexShrink: 0 }}
                                >
                                  {t("models.field.model")}
                                </div>
                                <div
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    display: "grid",
                                    gap: 6,
                                  }}
                                >
                                  <Dropdown
                                    value={modelSelectValue}
                                    options={[
                                      ...adapter.models.map((modelOption) => ({
                                        value: modelOption.id,
                                        label: `${modelOption.id}${modelOption.supportsStreaming ? ` · ${t("models.stat.streaming")}` : ""}`,
                                      })),
                                      {
                                        value: CUSTOM_API_MODEL_VALUE,
                                        label: t("models.field.customModel"),
                                      },
                                    ]}
                                    onChange={(value) => {
                                      updateApiAdapterValues(adapter, {
                                        model:
                                          value === CUSTOM_API_MODEL_VALUE
                                            ? ""
                                            : value,
                                      });
                                    }}
                                  />
                                  {modelSelectValue ===
                                    CUSTOM_API_MODEL_VALUE && (
                                    <input
                                      type="text"
                                      value={adapterValues.model}
                                      onChange={(event) =>
                                        updateApiAdapterValues(adapter, {
                                          model: event.currentTarget.value,
                                        })
                                      }
                                      className="input"
                                      placeholder={t(
                                        "models.field.customModelPlaceholder",
                                      )}
                                      aria-label={t(
                                        "models.field.customModelPlaceholder",
                                      )}
                                      style={{
                                        width: "100%",
                                        height: 36,
                                        padding: "8px 10px",
                                        fontFamily:
                                          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                        fontSize: 12,
                                      }}
                                    />
                                  )}
                                </div>
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: "var(--text-low)",
                                    whiteSpace: "nowrap",
                                    flexShrink: 0,
                                  }}
                                >
                                  {t("models.field.recommended", {
                                    model: adapter.recommendedModel,
                                  })}
                                </div>
                              </div>

                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                }}
                              >
                                <div
                                  className="label"
                                  style={{ width: 76, flexShrink: 0 }}
                                >
                                  {t("models.field.host")}
                                </div>
                                <input
                                  type="url"
                                  value={adapterValues.endpoint}
                                  onChange={(e) =>
                                    updateApiAdapterValues(adapter, {
                                      endpoint: e.target.value,
                                    })
                                  }
                                  className="input"
                                  placeholder={
                                    adapter.defaultEndpoint
                                      ? t(
                                          "models.field.hostDefaultPlaceholder",
                                          { endpoint: adapter.defaultEndpoint },
                                        )
                                      : t("models.field.hostPlaceholder")
                                  }
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    height: 36,
                                    padding: "8px 10px",
                                    fontFamily:
                                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                    fontSize: 12,
                                  }}
                                />
                                {adapterValues.endpoint.trim() ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateApiAdapterValues(adapter, {
                                        endpoint: "",
                                      })
                                    }
                                    style={{
                                      border: "1px solid var(--border-dashed)",
                                      background: "var(--control-muted)",
                                      color: "var(--text-hi)",
                                      borderRadius: 8,
                                      padding: "7px 9px",
                                      fontSize: 11,
                                      fontWeight: 700,
                                      fontFamily: "var(--font-main)",
                                      whiteSpace: "nowrap",
                                      flexShrink: 0,
                                      cursor: "pointer",
                                    }}
                                  >
                                    {t("models.common.reset")}
                                  </button>
                                ) : (
                                  <div
                                    style={{
                                      fontSize: 11,
                                      color: "var(--text-low)",
                                      whiteSpace: "nowrap",
                                      flexShrink: 0,
                                    }}
                                  >
                                    {t("models.common.optional")}
                                  </div>
                                )}
                              </div>

                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "flex-end",
                                  gap: 10,
                                  flexWrap: "wrap",
                                }}
                              >
                                {isAdapterSelected ? (
                                  <div
                                    style={{
                                      padding: "9px 12px",
                                      borderRadius: 10,
                                      border: "1px solid var(--success-border)",
                                      background: "var(--success-soft)",
                                      color: "var(--success-bright)",
                                      fontSize: 12,
                                      fontWeight: 700,
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 8,
                                    }}
                                  >
                                    <IconCheck size={14} stroke={2.5} />
                                    {t("models.common.selected")}
                                  </div>
                                ) : (
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 8,
                                      flexWrap: "wrap",
                                    }}
                                  >
                                    {isAdapterReady && (
                                      <button
                                        onClick={() =>
                                          handleSelectApiAdapter(adapter)
                                        }
                                        disabled={!canSelectApiAdapter}
                                        style={{
                                          padding: "9px 12px",
                                          borderRadius: 10,
                                          border:
                                            "1px solid var(--border-dashed)",
                                          background: canSelectApiAdapter
                                            ? "var(--control-muted)"
                                            : "var(--control-muted)",
                                          color: canSelectApiAdapter
                                            ? "var(--text-hi)"
                                            : "var(--text-mid)",
                                          fontSize: 12,
                                          fontWeight: 700,
                                          fontFamily: "var(--font-main)",
                                          cursor: canSelectApiAdapter
                                            ? "pointer"
                                            : "not-allowed",
                                          display: "flex",
                                          alignItems: "center",
                                          gap: 8,
                                        }}
                                      >
                                        <IconCheck size={14} stroke={2.5} />
                                        {t("models.common.select")}
                                      </button>
                                    )}

                                    <button
                                      onClick={() =>
                                        void handleApiAdapterTest(adapter)
                                      }
                                      disabled={isAdapterTestDisabled}
                                      style={{
                                        padding: "9px 12px",
                                        borderRadius: 10,
                                        border:
                                          "1px solid var(--border-dashed)",
                                        background: isAdapterTestDisabled
                                          ? "var(--control-muted)"
                                          : "var(--accent)",
                                        color: isAdapterTestDisabled
                                          ? "var(--text-mid)"
                                          : "var(--accent-contrast)",
                                        fontSize: 12,
                                        fontWeight: 700,
                                        fontFamily: "var(--font-main)",
                                        cursor:
                                          adapterStatus.status === "testing"
                                            ? "wait"
                                            : isAdapterTestDisabled
                                              ? "not-allowed"
                                              : "pointer",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 8,
                                      }}
                                    >
                                      {adapterStatus.status === "testing" ? (
                                        <>
                                          <span className="loading-soft-ring" />
                                          {t("models.test.checking")}
                                        </>
                                      ) : (
                                        <>
                                          <IconBolt size={14} stroke={2.2} />
                                          {adapter.testable
                                            ? t("models.test.testAndSave")
                                            : t("models.test.saveButton")}
                                        </>
                                      )}
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {apiModelKind === "text" && (
                <TextModelCard settings={settings} update={update} />
              )}
              {apiModelKind === "translation" && (
                <RealtimeTranslationModels
                  settings={settings}
                  update={update}
                />
              )}
            </div>
          )}

          {isLocalMode && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                style={{
                  display: "flex",
                  background: "var(--control-track)",
                  borderRadius: 10,
                  padding: 3,
                  gap: 2,
                }}
              >
                {(
                  [
                    {
                      id: "transcription",
                      label: t("models.local.tabTranscription"),
                      Icon: IconMicrophone,
                    },
                    {
                      id: "text",
                      label: t("models.local.tabText"),
                      Icon: IconMessage,
                    },
                    {
                      id: "other",
                      label: t("models.local.tabOther"),
                      Icon: IconLanguage,
                    },
                  ] as const
                ).map(({ id, label, Icon }) => {
                  const active = localModelKind === id;

                  return (
                    <button
                      key={id}
                      onClick={() => setLocalModelKind(id)}
                      style={{
                        flex: 1,
                        padding: "10px 0",
                        borderRadius: 8,
                        border: "none",
                        fontSize: 13,
                        fontWeight: active ? 700 : 500,
                        fontFamily: "var(--font-main)",
                        background: active
                          ? "var(--dropdown-active)"
                          : "transparent",
                        color: active ? "var(--text-hi)" : "var(--text-mid)",
                        cursor: "pointer",
                        transition: "all 0.18s ease",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 7,
                      }}
                    >
                      <Icon size={15} stroke={active ? 2.2 : 1.7} />
                      <span>{label}</span>
                      {id === "text" && !localTextModelSelected && (
                        <span
                          title={t("localLlm.required")}
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: 999,
                            background: "var(--accent)",
                            flexShrink: 0,
                          }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              {renderModeCommitRow("local")}

              {localModelKind === "transcription" && (
                <>
                  <div>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: "var(--text-hi)",
                        marginBottom: 4,
                      }}
                    >
                      {t("models.local.sectionTitle")}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--text-mid)",
                        lineHeight: 1.6,
                      }}
                    >
                      {t("models.local.sectionDesc")}
                    </div>
                  </div>

                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    {LOCAL_MODEL_OPTIONS.map((model) => {
                      const isExpanded = expandedLocalModel === model.id;
                      const modelStatus = getLocalModelStatus(model);
                      const modelActionState = localModelActionStates[model.id];
                      const isRuntimeReady =
                        modelStatus.status !== "unsupported" &&
                        model.runtimeReady === true;
                      const isDownloaded = modelStatus.isInstalled;
                      const isModelBusy =
                        modelStatus.status === "installing" ||
                        modelStatus.status === "deleting";
                      const isInstallDisabled = isModelBusy || !isRuntimeReady;
                      const canSelect =
                        isRuntimeReady &&
                        modelStatus.isInstalled &&
                        model.purpose !== "diarization";
                      const downloadProgress =
                        modelStatus.status === "installing"
                          ? modelActionState?.progress
                          : undefined;
                      const downloadedLabel = formatLocalDownloadBytes(
                        modelActionState?.downloadedBytes,
                        { showZero: Boolean(modelActionState?.totalBytes) },
                      );
                      const totalLabel = formatLocalDownloadBytes(
                        modelActionState?.totalBytes,
                      );

                      return (
                        <LocalSttModelCard
                          key={model.id}
                          name={model.name}
                          description={t(
                            LOCAL_MODEL_DESCRIPTION_KEYS[model.id],
                          )}
                          recommendedLabel={
                            model.recommended
                              ? t("models.local.recommendedBadge")
                              : undefined
                          }
                          statusLabel={modelStatus.label}
                          statusColor={modelStatus.color}
                          expanded={isExpanded}
                          onToggle={() =>
                            setExpandedLocalModel(isExpanded ? null : model.id)
                          }
                          disclosureLabel={t(
                            isExpanded ? "mainTab.collapse" : "mainTab.expand",
                          )}
                          stats={{
                            storageLabel: getLocalModelStorageLabel(model),
                            storageTitle: t("models.stat.downloadSizeTitle", {
                              value: getLocalModelStorageLabel(model),
                            }),
                            languageLabel: translateLanguageValue(
                              model.languageLabel,
                            ),
                            languageTitle: t("models.stat.languagesTitle", {
                              value: translateLanguageValue(
                                model.languageLabel,
                              ),
                            }),
                            speedLabel: translateSpeedValue(model.speed),
                            speedTitle: t("models.stat.speedTitle", {
                              value: translateSpeedValue(model.speed),
                            }),
                            accuracyLabel: translateAccuracyValue(
                              model.accuracy,
                            ),
                            accuracyTitle: t("models.stat.accuracyTitle", {
                              value: translateAccuracyValue(model.accuracy),
                            }),
                            streamingLabel: model.supportsStreaming
                              ? t("models.stat.streaming")
                              : undefined,
                          }}
                          notice={
                            modelStatus.message &&
                            modelStatus.status !== "installing" &&
                            modelStatus.status !== "installed" &&
                            modelStatus.status !== "selected"
                              ? {
                                  message: modelStatus.message,
                                  tone:
                                    modelStatus.status === "error"
                                      ? "error"
                                      : "neutral",
                                }
                              : undefined
                          }
                          progress={
                            modelStatus.status === "installing"
                              ? {
                                  message:
                                    modelActionState?.message ||
                                    t("models.download.loading"),
                                  percent: downloadProgress,
                                  valueLabel:
                                    downloadedLabel ||
                                    t("models.download.preparing"),
                                  downloadedLabel,
                                  totalLabel,
                                  totalTemplate: totalLabel
                                    ? t("models.download.of", {
                                        total: totalLabel,
                                      })
                                    : undefined,
                                }
                              : undefined
                          }
                          connectionLabel={
                            modelStatus.connectionLabel || undefined
                          }
                          connectionColor={modelStatus.color}
                          showConnectionCheck={
                            modelStatus.status === "installed" ||
                            modelStatus.status === "selected"
                          }
                          actions={
                            <>
                              {canSelect && !modelStatus.isSelected && (
                                <button
                                  type="button"
                                  onClick={() => handleSelectLocalModel(model)}
                                  style={{
                                    padding: "9px 12px",
                                    borderRadius: 10,
                                    border: "1px solid var(--border-dashed)",
                                    background: "var(--control-muted)",
                                    color: "var(--text-hi)",
                                    fontSize: 12,
                                    fontWeight: 700,
                                    fontFamily: "var(--font-main)",
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                  }}
                                >
                                  <IconCheck size={14} stroke={2.5} />
                                  {t("models.common.select")}
                                </button>
                              )}

                              {!isModelBusy && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (isDownloaded) {
                                      setPendingDeleteModel(model);
                                      return;
                                    }

                                    void handleInstallLocalSttModel(model);
                                  }}
                                  disabled={isInstallDisabled}
                                  style={{
                                    padding: "9px 12px",
                                    borderRadius: 10,
                                    border: "1px solid var(--border-dashed)",
                                    background: isInstallDisabled
                                      ? "var(--control-muted)"
                                      : isDownloaded
                                        ? "var(--control-muted)"
                                        : "var(--accent)",
                                    color: isInstallDisabled
                                      ? "var(--text-mid)"
                                      : isDownloaded
                                        ? "var(--text-hi)"
                                        : "var(--accent-contrast)",
                                    fontSize: 12,
                                    fontWeight: 700,
                                    fontFamily: "var(--font-main)",
                                    cursor: isInstallDisabled
                                      ? "not-allowed"
                                      : "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                  }}
                                >
                                  {isDownloaded ? (
                                    <>
                                      <IconTrash size={14} stroke={2.2} />
                                      {t("models.common.delete")}
                                    </>
                                  ) : (
                                    <>
                                      <IconDownload size={14} stroke={2.2} />
                                      {isRuntimeReady
                                        ? t("models.common.download")
                                        : t("models.common.unavailable")}
                                    </>
                                  )}
                                </button>
                              )}

                              {modelStatus.status === "installing" && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleCancelLocalSttDownload(model)
                                  }
                                  style={{
                                    padding: "9px 12px",
                                    borderRadius: 10,
                                    border: "1px solid var(--border-dashed)",
                                    background: "var(--control-muted)",
                                    color: "var(--text-hi)",
                                    fontSize: 12,
                                    fontWeight: 700,
                                    fontFamily: "var(--font-main)",
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                  }}
                                >
                                  <IconX size={14} stroke={2.2} />
                                  {t("models.common.cancel")}
                                </button>
                              )}
                            </>
                          }
                        />
                      );
                    })}
                  </div>
                  {pendingDeleteModel && (
                    <div
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="delete-local-model-title"
                      style={{
                        position: "fixed",
                        inset: 0,
                        zIndex: 1000,
                        background: "var(--modal-scrim)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 20,
                      }}
                      onClick={() => setPendingDeleteModel(null)}
                    >
                      <div
                        className="card"
                        style={{
                          width: "min(420px, 100%)",
                          background: "var(--bg)",
                          padding: 18,
                          boxShadow: "var(--shadow-modal)",
                        }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div
                          id="delete-local-model-title"
                          style={{
                            fontSize: 17,
                            fontWeight: 750,
                            color: "var(--text-hi)",
                            marginBottom: 8,
                          }}
                        >
                          {t("models.deleteDialog.title")}
                        </div>
                        <div
                          style={{
                            fontSize: 13,
                            lineHeight: 1.6,
                            color: "var(--text-mid)",
                            marginBottom: 16,
                          }}
                        >
                          {t("models.deleteDialog.body", {
                            name: pendingDeleteModel.name,
                          })}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "flex-end",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => setPendingDeleteModel(null)}
                            style={{
                              padding: "10px 14px",
                              borderRadius: 10,
                              border: "1px solid var(--border-dashed)",
                              background: "var(--control-muted)",
                              color: "var(--text-hi)",
                              fontSize: 12,
                              fontWeight: 700,
                              fontFamily: "var(--font-main)",
                              cursor: "pointer",
                            }}
                          >
                            {t("models.common.cancel")}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void handleDeleteLocalSttModel(pendingDeleteModel)
                            }
                            style={{
                              padding: "10px 14px",
                              borderRadius: 10,
                              border: "1px solid var(--border-dashed)",
                              background: "var(--accent)",
                              color: "var(--accent-contrast)",
                              fontSize: 12,
                              fontWeight: 700,
                              fontFamily: "var(--font-main)",
                              cursor: "pointer",
                            }}
                          >
                            {t("models.common.delete")}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {localModelKind === "text" && (
                <Suspense
                  fallback={
                    <div
                      className="card"
                      style={{
                        padding: 14,
                        fontSize: 13,
                        color: "var(--text-mid)",
                      }}
                    >
                      {t("models.download.loading")}
                    </div>
                  }
                >
                  <LocalLlmModels settings={settings} update={update} />
                </Suspense>
              )}

              {localModelKind === "other" && (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 12 }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: "var(--text-hi)",
                        marginBottom: 4,
                      }}
                    >
                      {t("models.localOther.sectionTitle")}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--text-mid)",
                        lineHeight: 1.6,
                      }}
                    >
                      {t("models.localOther.sectionDesc")}
                    </div>
                  </div>

                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    {LOCAL_OTHER_COMPONENTS.map((component) => {
                      const componentStatus = getLocalOtherStatus(component);
                      const isBusy =
                        componentStatus.status === "installing" ||
                        componentStatus.status === "deleting";
                      const isExpanded =
                        expandedLocalOtherComponent === component.id || isBusy;

                      return (
                        <div
                          key={component.id}
                          className="card"
                          style={{
                            padding: 0,
                            overflow: "hidden",
                            background: "var(--surface)",
                          }}
                        >
                          <div
                            style={{
                              position: "relative",
                              padding: "12px 14px",
                              display: "flex",
                              alignItems: "center",
                              gap: 12,
                              textAlign: "left",
                              fontFamily: "var(--font-main)",
                            }}
                          >
                            <div
                              style={{
                                position: "relative",
                                flex: 1,
                                minWidth: 0,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: 10,
                                  marginBottom: 3,
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: 15,
                                    fontWeight: 700,
                                    color: "var(--text-hi)",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                >
                                  {component.name}
                                </div>
                                <div
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: componentStatus.color,
                                    padding: "5px 9px",
                                    borderRadius: 999,
                                    background: "var(--control-muted)",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {componentStatus.label}
                                </div>
                              </div>
                              <div style={{ paddingRight: 34 }}>
                                <div
                                  style={{
                                    fontSize: 12,
                                    lineHeight: 1.45,
                                    color: "var(--text-mid)",
                                  }}
                                >
                                  {t(component.descriptionKey)}
                                </div>
                                {renderLocalModelStats(component)}
                              </div>
                              <ModelCardDisclosureButton
                                expanded={isExpanded}
                                onToggle={() =>
                                  setExpandedLocalOtherComponent(
                                    isExpanded ? null : component.id,
                                  )
                                }
                                label={t(
                                  isExpanded
                                    ? "mainTab.collapse"
                                    : "mainTab.expand",
                                )}
                              />
                            </div>
                          </div>

                          {isExpanded && (
                            <div
                              style={{
                                borderTop: "1px solid var(--border-subtle)",
                                padding: "12px 14px",
                                display: "flex",
                                flexDirection: "column",
                                gap: 10,
                              }}
                            >
                              {componentStatus.message &&
                                componentStatus.status !== "installed" && (
                                  <div
                                    style={{
                                      fontSize: 12,
                                      lineHeight: 1.6,
                                      padding: "8px 10px",
                                      borderRadius: 8,
                                      background:
                                        componentStatus.status === "error"
                                          ? "var(--danger-soft)"
                                          : "var(--control-muted)",
                                      color:
                                        componentStatus.status === "error"
                                          ? "var(--error-bright)"
                                          : "var(--text-mid)",
                                      border: `1px solid ${componentStatus.status === "error" ? "var(--danger-border)" : "var(--border-subtle)"}`,
                                    }}
                                  >
                                    {componentStatus.message}
                                  </div>
                                )}

                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "flex-end",
                                  gap: 8,
                                  flexWrap: "wrap",
                                }}
                              >
                                {componentStatus.status === "installed" && (
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 8,
                                      color: componentStatus.color,
                                      fontSize: 12,
                                      fontWeight: 600,
                                      marginRight: "auto",
                                    }}
                                  >
                                    <IconCheck size={15} stroke={2.5} />
                                    {componentStatus.isSelected
                                      ? t("models.localOther.selected")
                                      : t(
                                          "models.localOther.installedNotSelected",
                                        )}
                                  </div>
                                )}

                                {!isBusy && componentStatus.isInstalled && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleSelectLocalTranslator(
                                        component,
                                        !componentStatus.isSelected,
                                      )
                                    }
                                    style={{
                                      padding: "9px 12px",
                                      borderRadius: 10,
                                      border: "1px solid var(--border-dashed)",
                                      background: "var(--control-muted)",
                                      color: "var(--text-hi)",
                                      fontSize: 12,
                                      fontWeight: 700,
                                      fontFamily: "var(--font-main)",
                                      cursor: "pointer",
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 8,
                                    }}
                                  >
                                    {componentStatus.isSelected ? (
                                      <>
                                        <IconX size={14} stroke={2.2} />
                                        {t("models.localOther.cancelSelection")}
                                      </>
                                    ) : (
                                      <>
                                        <IconCheck size={14} stroke={2.5} />
                                        {t("models.localOther.select")}
                                      </>
                                    )}
                                  </button>
                                )}

                                {!isBusy &&
                                  (!componentStatus.isInstalled ||
                                    componentStatus.canDelete) && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (componentStatus.isInstalled) {
                                          void handleDeleteLocalTranslator(
                                            component,
                                          );
                                          return;
                                        }

                                        void handleInstallLocalTranslator(
                                          component,
                                        );
                                      }}
                                      style={{
                                        padding: "9px 12px",
                                        borderRadius: 10,
                                        border:
                                          "1px solid var(--border-dashed)",
                                        background: componentStatus.isInstalled
                                          ? "var(--control-muted)"
                                          : "var(--accent)",
                                        color: componentStatus.isInstalled
                                          ? "var(--text-hi)"
                                          : "var(--accent-contrast)",
                                        fontSize: 12,
                                        fontWeight: 700,
                                        fontFamily: "var(--font-main)",
                                        cursor: "pointer",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 8,
                                      }}
                                    >
                                      {componentStatus.isInstalled ? (
                                        <>
                                          <IconTrash size={14} stroke={2.2} />
                                          {t("models.common.delete")}
                                        </>
                                      ) : (
                                        <>
                                          <IconDownload
                                            size={14}
                                            stroke={2.2}
                                          />
                                          {t("models.common.download")}
                                        </>
                                      )}
                                    </button>
                                  )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      </div>
    );
  }

  const STYLE_ICONS: Record<AppSettings["style"], Icon> = {
    classic: IconMessage,
    business: IconBriefcase,
    tech: IconCode,
  };

  const styleTabOptions: Array<{
    id: "style" | "prompts";
    label: string;
    Icon: Icon;
  }> = [
    { id: "style", label: t("models.styleTab.style"), Icon: IconTypography },
    { id: "prompts", label: t("models.styleTab.prompts"), Icon: IconMessage },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "grid", gap: 4 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-hi)" }}>
          {t("models.textProcessing.title")}
        </div>
        <div
          style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}
        >
          {t("models.textProcessing.desc")}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          background: "var(--control-track)",
          borderRadius: 10,
          padding: 3,
          gap: 2,
        }}
      >
        {styleTabOptions.map(({ id, label, Icon }) => {
          const active = styleTabView === id;

          return (
            <button
              key={id}
              onClick={() => setStyleTabView(id)}
              style={{
                flex: 1,
                padding: "10px 0",
                borderRadius: 8,
                border: "none",
                fontSize: 13,
                fontWeight: active ? 700 : 500,
                fontFamily: "var(--font-main)",
                background: active ? "var(--dropdown-active)" : "transparent",
                color: active ? "var(--text-hi)" : "var(--text-mid)",
                cursor: "pointer",
                transition: "all 0.18s ease",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
              }}
            >
              <Icon size={15} stroke={active ? 2.2 : 1.7} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {styleTabView === "style" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {TRANSCRIPTION_STYLE_OPTIONS.map((st) => {
            const isActive = settings.style === st.id;
            const Icon = STYLE_ICONS[st.id];

            return (
              <OptionCard
                key={st.id}
                active={isActive}
                icon={<Icon size={20} stroke={isActive ? 2.4 : 1.8} />}
                title={st.title}
                description={st.description}
                onClick={() =>
                  update({
                    style: st.id as AppSettings["style"],
                    selectedCleanupPromptId: st.id,
                  })
                }
              />
            );
          })}
        </div>
      )}

      {styleTabView === "prompts" && (
        <PromptLibrary
          settings={settings}
          onReload={syncSettings}
          update={update}
        />
      )}

      {IS_DEV && styleTabView === "style" && (
        <details className="card" style={{ background: "var(--surface)" }}>
          <summary
            style={{
              cursor: "pointer",
              listStyle: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  marginBottom: 4,
                }}
              >
                {t("models.preview.title")}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--text-mid)",
                  lineHeight: 1.6,
                }}
              >
                {t("models.preview.desc")}
              </div>
            </div>
            {promptPreview && (
              <div className="label">v{promptPreview.version}</div>
            )}
          </summary>

          <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
            {promptPreviewError ? (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--danger)",
                  lineHeight: 1.6,
                }}
              >
                {t("models.preview.buildError", { error: promptPreviewError })}
              </div>
            ) : promptPreview ? (
              <>
                <div style={{ display: "grid", gap: 4 }}>
                  <div className="label">{t("models.preview.profile")}</div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-hi)",
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    }}
                  >
                    {promptPreview.profileKey}
                  </div>
                </div>

                <div style={{ display: "grid", gap: 6 }}>
                  <div className="label">{t("models.preview.layers")}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {promptPreview.layers.map((layer) => (
                      <span
                        key={layer}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 999,
                          background: "var(--control-track)",
                          fontSize: 11,
                          color: "var(--text-mid)",
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        }}
                      >
                        {layer}
                      </span>
                    ))}
                  </div>
                </div>

                <div style={{ display: "grid", gap: 6 }}>
                  <div className="label">{t("models.preview.promptText")}</div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 14,
                      borderRadius: 12,
                      background: "var(--control-muted)",
                      color: "var(--text-mid)",
                      fontSize: 11,
                      lineHeight: 1.65,
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      whiteSpace: "pre-wrap",
                      maxHeight: 300,
                      overflow: "auto",
                    }}
                  >
                    {promptPreview.prompt}
                  </pre>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-mid)" }}>
                {t("models.preview.building")}
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
