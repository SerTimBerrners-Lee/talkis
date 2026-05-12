import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Briefcase,
  Check,
  Cloud,
  Code,
  Crown,
  Download,
  Gauge,
  HardDrive,
  LogOut,
  LucideIcon,
  MessageSquare,
  Server,
  Target,
  Trash2,
  User,
  Zap,
} from "lucide-react";

import { AppSettings, getSettings, LocalModelSettings, saveSettings } from "../../../lib/store";
import { CloudProfile, fetchCloudProfile, getAuthLoginUrl, cloudLogout, handleAuthToken, generateExchangeCode, getAuthLoginUrlWithCode, pollForToken, getCachedCloudProfile, subscribeCloudProfile } from "../../../lib/cloudAuth";
import { logInfo } from "../../../lib/logger";

import { TRANSCRIPTION_STYLE_OPTIONS } from "../../../lib/transcriptionPrompts";
import { SETTINGS_UPDATED_EVENT } from "../../../lib/hotkeyEvents";
import assemblyAiAvatar from "../../../assets/adapters/assemblyai.png";
import cartesiaAvatar from "../../../assets/adapters/cartesia.png";
import deepgramAvatar from "../../../assets/adapters/deepgram.jpeg";
import elevenLabsAvatar from "../../../assets/adapters/elevenlabs.png";
import fireworksAvatar from "../../../assets/adapters/fireworks.png";
import groqAvatar from "../../../assets/adapters/groq.png";
import mistralAvatar from "../../../assets/adapters/mistral.png";
import nvidiaAvatar from "../../../assets/adapters/nvidia.webp";
import openAiAvatar from "../../../assets/adapters/openai.svg";
import qwenAvatar from "../../../assets/adapters/qwen.png";
import volcengineAvatar from "../../../assets/adapters/volcengine.webp";
import xAiAvatar from "../../../assets/adapters/xai.png";

const IS_DEV = import.meta.env.DEV;
type LocalRuntimeKind = "whisper" | "nvidia" | "qwen";
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
  whisper: "http://127.0.0.1:8000",
  nvidia: "http://127.0.0.1:8001",
  qwen: "http://127.0.0.1:8002",
};
const LOCAL_STT_PRESET_ENDPOINT = LOCAL_RUNTIME_ENDPOINTS.whisper;
const LOCAL_STT_PRESET_MODEL = "whisper-large-v3-turbo";
const LOCAL_STT_MODEL_DOWNLOAD_PROGRESS_EVENT = "local-stt-model-download-progress";

interface SettingsTabsProps { type: "model" | "style"; }

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

interface ApiAdapterOption {
  id: ApiAdapterId;
  name: string;
  description: string;
  recommendedModel: string;
  initials: string;
  accent: string;
  avatar?: string;
  testable: boolean;
}

const API_ADAPTERS: ApiAdapterOption[] = [
  {
    id: "openai",
    name: "OpenAI API",
    description: "Подключение через OpenAI API для распознавания речи.",
    recommendedModel: "gpt-4o-transcribe",
    initials: "AI",
    accent: "#0f172a",
    avatar: openAiAvatar,
    testable: true,
  },
  {
    id: "deepgram",
    name: "Deepgram API",
    description: "Адаптер для облачного распознавания речи через Deepgram.",
    recommendedModel: "nova-3",
    initials: "DG",
    accent: "#13ef93",
    avatar: deepgramAvatar,
    testable: false,
  },
  {
    id: "cartesia",
    name: "Cartesia API",
    description: "Адаптер под речевые модели Cartesia.",
    recommendedModel: "sonic",
    initials: "CA",
    accent: "#6d5dfc",
    avatar: cartesiaAvatar,
    testable: false,
  },
  {
    id: "mistral",
    name: "Mistral AI",
    description: "Адаптер под модели распознавания и обработки Mistral AI.",
    recommendedModel: "voxtral-mini-latest",
    initials: "MI",
    accent: "#ff7000",
    avatar: mistralAvatar,
    testable: false,
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs API",
    description: "Адаптер для speech-to-text сценариев через ElevenLabs.",
    recommendedModel: "scribe_v1",
    initials: "EL",
    accent: "#111827",
    avatar: elevenLabsAvatar,
    testable: false,
  },
  {
    id: "fireworks",
    name: "Fireworks AI API",
    description: "Адаптер под hosted speech-модели Fireworks AI.",
    recommendedModel: "whisper-v3",
    initials: "FW",
    accent: "#f97316",
    avatar: fireworksAvatar,
    testable: false,
  },
  {
    id: "groq",
    name: "Groq API",
    description: "Адаптер под быстрые hosted Whisper-модели Groq.",
    recommendedModel: "whisper-large-v3-turbo",
    initials: "GQ",
    accent: "#f55036",
    avatar: groqAvatar,
    testable: false,
  },
  {
    id: "assemblyai",
    name: "AssemblyAI",
    description: "Адаптер для распознавания речи через AssemblyAI.",
    recommendedModel: "universal",
    initials: "AA",
    accent: "#2563eb",
    avatar: assemblyAiAvatar,
    testable: false,
  },
  {
    id: "volcengine",
    name: "Volcengine API",
    description: "Адаптер под речевые сервисы Volcengine.",
    recommendedModel: "seed-asr",
    initials: "VE",
    accent: "#7c3aed",
    avatar: volcengineAvatar,
    testable: false,
  },
  {
    id: "xai",
    name: "xAI API",
    description: "Адаптер под API xAI для будущих voice/STT сценариев.",
    recommendedModel: "grok-voice",
    initials: "xAI",
    accent: "#000000",
    avatar: xAiAvatar,
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
  initials: string;
  accent: string;
  avatar?: string;
  recommended?: boolean;
  runtimeReady?: boolean;
  unavailableReason?: string;
  downloadBytes?: number;
}

const LOCAL_MODEL_OPTIONS: LocalModelOption[] = [
  {
    id: "parakeet-tdt-06b-v3",
    name: "NVIDIA Parakeet TDT 0.6B v3",
    description: "Быстрая локальная ASR-модель Parakeet через MLX runtime для Apple Silicon.",
    model: "mlx-community/parakeet-tdt-0.6b-v3",
    engineLabel: "Parakeet",
    runtime: "OpenAI-compatible / Parakeet MLX runtime",
    runtimeKind: "nvidia",
    size: "0.6B",
    speed: "быстро",
    accuracy: "высокая",
    initials: "P3",
    accent: "#76b900",
    avatar: nvidiaAvatar,
    recommended: true,
    runtimeReady: true,
    downloadBytes: 2_509_044_141,
  },
  {
    id: "parakeet-tdt-06b-v2",
    name: "NVIDIA Parakeet TDT 0.6B v2",
    description: "Стабильная английская Parakeet TDT-модель через MLX runtime для Apple Silicon.",
    model: "mlx-community/parakeet-tdt-0.6b-v2",
    engineLabel: "Parakeet",
    runtime: "OpenAI-compatible / Parakeet MLX runtime",
    runtimeKind: "nvidia",
    size: "0.6B",
    speed: "быстро",
    accuracy: "высокая",
    initials: "P2",
    accent: "#5f9f00",
    avatar: nvidiaAvatar,
    runtimeReady: true,
    downloadBytes: 2_470_305_134,
  },
  {
    id: "qwen3-asr-06b",
    name: "Qwen3-ASR 0.6B",
    description: "Компактная ASR-модель Qwen для локального распознавания через совместимый runtime.",
    model: "Qwen/Qwen3-ASR-0.6B",
    engineLabel: "Qwen",
    runtime: "OpenAI-compatible / Qwen runtime",
    runtimeKind: "qwen",
    size: "0.6B",
    speed: "средне",
    accuracy: "высокая",
    initials: "Q3",
    accent: "#2563eb",
    avatar: qwenAvatar,
    runtimeReady: true,
    downloadBytes: 1_880_619_678,
  },
  {
    id: "whisper-large-v3-turbo-quantized",
    name: "Whisper Large V3 Turbo Quantized",
    description: "Более легкий вариант Turbo для локальной работы с меньшим расходом памяти.",
    model: "whisper-large-v3-turbo",
    engineLabel: "Whisper",
    runtime: "OpenAI-compatible / MLX runtime",
    runtimeKind: "whisper",
    size: "4-bit",
    speed: "быстро",
    accuracy: "высокая",
    initials: "WQ",
    accent: "#111827",
    runtimeReady: false,
  },
  {
    id: "whisper-small",
    name: "Whisper Small",
    description: "Баланс скорости и качества для слабых машин и быстрых коротких диктовок.",
    model: "whisper-small",
    engineLabel: "Whisper",
    runtime: "Talkis Local / whisper.cpp",
    runtimeKind: "whisper",
    size: "small",
    speed: "быстро",
    accuracy: "средняя",
    initials: "WS",
    accent: "#334155",
    runtimeReady: true,
    downloadBytes: 487_601_967,
  },
  {
    id: "whisper-large-v3-turbo",
    name: "Whisper Large V3 Turbo",
    description: "Рекомендуемый Whisper-вариант: быстрый, качественный и хорошо подходит для диктовки.",
    model: "whisper-large-v3-turbo",
    engineLabel: "Whisper",
    runtime: "Talkis Local / whisper.cpp",
    runtimeKind: "whisper",
    size: "large",
    speed: "быстро",
    accuracy: "высокая",
    initials: "WT",
    accent: "#0f172a",
    recommended: true,
    runtimeReady: true,
    downloadBytes: 1_624_555_275,
  },
  {
    id: "whisper-large-v3",
    name: "Whisper Large V3",
    description: "Максимальное качество Whisper, но выше требования к памяти и времени обработки.",
    model: "whisper-large-v3",
    engineLabel: "Whisper",
    runtime: "Talkis Local / whisper.cpp",
    runtimeKind: "whisper",
    size: "large",
    speed: "средне",
    accuracy: "максимальная",
    initials: "W3",
    accent: "#1e293b",
    runtimeReady: true,
    downloadBytes: 3_095_033_483,
  },
  {
    id: "whisper-large-v2",
    name: "Whisper Large V2",
    description: "Предыдущая large-версия Whisper для совместимости с существующими локальными установками.",
    model: "whisper-large-v2",
    engineLabel: "Whisper",
    runtime: "Talkis Local / whisper.cpp",
    runtimeKind: "whisper",
    size: "large",
    speed: "средне",
    accuracy: "высокая",
    initials: "W2",
    accent: "#475569",
    runtimeReady: true,
    downloadBytes: 3_094_623_691,
  },
  {
    id: "whisper-medium",
    name: "Whisper Medium",
    description: "Промежуточный вариант между Small и Large: заметно качественнее Small, но тяжелее.",
    model: "whisper-medium",
    engineLabel: "Whisper",
    runtime: "Talkis Local / whisper.cpp",
    runtimeKind: "whisper",
    size: "medium",
    speed: "средне",
    accuracy: "высокая",
    initials: "WM",
    accent: "#475569",
    runtimeReady: true,
    downloadBytes: 1_533_763_059,
  },
  {
    id: "whisper-base",
    name: "Whisper Base",
    description: "Быстрая и легкая модель для простых сценариев и слабых машин.",
    model: "whisper-base",
    engineLabel: "Whisper",
    runtime: "Talkis Local / whisper.cpp",
    runtimeKind: "whisper",
    size: "base",
    speed: "очень быстро",
    accuracy: "базовая",
    initials: "WB",
    accent: "#64748b",
    runtimeReady: true,
    downloadBytes: 147_951_465,
  },
  {
    id: "whisper-tiny",
    name: "Whisper Tiny",
    description: "Минимальный размер и максимальная скорость, качество ниже остальных Whisper-моделей.",
    model: "whisper-tiny",
    engineLabel: "Whisper",
    runtime: "Talkis Local / whisper.cpp",
    runtimeKind: "whisper",
    size: "tiny",
    speed: "очень быстро",
    accuracy: "низкая+",
    initials: "WT",
    accent: "#94a3b8",
    runtimeReady: true,
    downloadBytes: 77_691_713,
  },
];

interface OptionCardProps {
  active?: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  badge?: string;
  onClick?: () => void;
  disabled?: boolean;
}

function OptionCard({ active = false, icon, title, description, badge, onClick, disabled = false }: OptionCardProps) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        position: "relative",
        padding: 18,
        borderRadius: 10,
        background: active ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.72)",
        border: `1px solid ${active ? "rgba(0,0,0,0.16)" : "rgba(0,0,0,0.08)"}`,
        color: "var(--text-hi)",
        cursor: disabled ? "not-allowed" : onClick ? "pointer" : "default",
        transition: "transform 0.16s ease, border-color 0.16s ease, background 0.16s ease",
        opacity: disabled ? 0.72 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled && onClick && !active) e.currentTarget.style.transform = "translateY(-1px)";
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
            background: active ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.05)",
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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
            <div style={{ fontSize: 15, fontWeight: active ? 700 : 600, color: "var(--text-hi)" }}>{title}</div>
            {badge && <div className="label" style={{ color: "var(--text-low)" }}>{badge}</div>}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.65, color: "var(--text-mid)" }}>{description}</div>
        </div>
      </div>

      {active && (
        <div style={{ position: "absolute", top: 16, right: 16, color: "var(--text-hi)" }}>
          <Check size={18} strokeWidth={2.6} />
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
  return (
    <div className="card" style={{ padding: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px" }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "rgba(0,0,0,0.05)",
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
              style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }}
            />
          ) : (
            <User size={16} strokeWidth={1.5} color="var(--text-low)" />
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
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
              fontSize: 11,
              color: "var(--text-low)",
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
            padding: 6,
            borderRadius: 6,
            color: "var(--text-low)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "color 0.15s, background 0.15s",
          }}
          title="Выйти"
        >
          <LogOut size={14} strokeWidth={1.8} />
        </button>
      </div>

      <button
        onClick={onActivate}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          width: "calc(100% - 16px)",
          margin: "8px 8px 0",
          padding: "10px",
          borderRadius: 8,
          background: "#000",
          color: "#fff",
          border: "none",
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          lineHeight: 1,
          whiteSpace: "nowrap",
          cursor: "pointer",
          transition: "opacity 0.15s",
          fontFamily: "var(--font)",
        }}
      >
        <Crown size={13} strokeWidth={2} color="#fff" />
        <span style={{ display: "flex", alignItems: "center", lineHeight: 1, whiteSpace: "nowrap" }}>Перейти на PRO</span>
      </button>
    </div>
  );
}

function SubscriptionGuestCard({ onActivate }: { onActivate: () => void }) {
  return (
    <div style={{ padding: "22px 20px", borderRadius: 14, background: "#000", color: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <Crown size={16} strokeWidth={2.2} />
        <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: "-0.02em" }}>Подписка Talkis</span>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 14px", fontSize: 12, lineHeight: 2, opacity: 0.85 }}>
        <li>• Безлимитное использование без ограничений</li>
        <li>• Без VPN и Прокси</li>
        <li>• Синхронизация со всеми устройствами</li>
      </ul>
      <button onClick={onActivate} style={{ width: "100%", padding: "12px", borderRadius: 10, background: "#fff", color: "#000", border: "none", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer", transition: "opacity 0.15s", fontFamily: "var(--font-main)" }}>
        Перейти на PRO
      </button>
    </div>
  );
}

function extractTokenFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("token") || null;
  } catch {
    return null;
  }
}

export function SettingsTabs({ type }: SettingsTabsProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [promptPreview, setPromptPreview] = useState<PromptPreview | null>(null);
  const [promptPreviewError, setPromptPreviewError] = useState<string | null>(null);
  const [cloudProfile, setCloudProfile] = useState<CloudProfile | null | undefined>(() => getCachedCloudProfile());
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [waitingForAuth, setWaitingForAuth] = useState(false);
  const [waitingForSubscriptionRefresh, setWaitingForSubscriptionRefresh] = useState(false);
  const [expandedApiAdapter, setExpandedApiAdapter] = useState<ApiAdapterId | null>(null);
  const [expandedLocalModel, setExpandedLocalModel] = useState<string | null>(null);
  const [pendingDeleteModel, setPendingDeleteModel] = useState<LocalModelOption | null>(null);
  const [localInstalledModels, setLocalInstalledModels] = useState<string[]>([]);
  const [apiAdapterTestStates, setApiAdapterTestStates] = useState<Partial<Record<ApiAdapterId, { status: AdapterTestStatus; message: string }>>>({});
  const [localModelActionStates, setLocalModelActionStates] = useState<Partial<Record<string, LocalModelActionState>>>({});
  const authPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const exchangeCodeRef = useRef<string | null>(null);
  const settingsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const syncSettings = useCallback(async () => {
    const nextSettings = await getSettings({ reload: true });
    setSettings(nextSettings);
    return nextSettings;
  }, []);

  const loadCloudProfile = useCallback(async () => {
    const profile = await fetchCloudProfile({ force: true });
    return profile;
  }, []);

  const applyCloudToken = useCallback(async (token: string) => {
    await handleAuthToken(token);
    await syncSettings();
    const profile = await loadCloudProfile();
    setWaitingForAuth(false);
    exchangeCodeRef.current = null;
    setWaitingForSubscriptionRefresh(!profile?.subscription.active);
    return profile;
  }, [loadCloudProfile, syncSettings]);

  const refreshLocalInstalledModels = useCallback(async () => {
    if (!settings || type !== "model" || !settings.useOwnKey || settings.provider !== "custom") {
      return;
    }

    try {
      const result = await invoke<{ success: boolean; models: string[]; message: string }>("list_stt_models", {
        req: {
          api_key: settings.apiKey || "",
          whisper_api_key: settings.whisperApiKey || null,
          whisper_endpoint: settings.whisperEndpoint || LOCAL_STT_PRESET_ENDPOINT,
          local_models_dir: settings.localModelsDir || null,
        },
      });

      const installedModels = result.models || [];
      setLocalInstalledModels(installedModels);

      const installedModelSet = new Set(installedModels);
      const installedLocalOptions = LOCAL_MODEL_OPTIONS.filter((model) => installedModelSet.has(model.model));
      if (installedLocalOptions.length > 0) {
        const now = new Date().toISOString();
        const nextLocalModels = { ...(settings.localModels || {}) };
        let changed = false;

        for (const model of installedLocalOptions) {
          const current = nextLocalModels[model.id] || { status: "not_downloaded" as const };
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
      }
    } catch (err) {
      setLocalInstalledModels([]);
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

  useEffect(() => {
    void syncSettings().catch(() => {});
  }, [syncSettings]);

  // Cloud profile — always fetch (regardless of tab) so hooks are stable
  useEffect(() => {
    if (getCachedCloudProfile() === undefined) {
      loadCloudProfile().catch(() => {});
    }
  }, [loadCloudProfile]);

  useEffect(() => {
    return subscribeCloudProfile((nextProfile) => {
      setCloudProfile(nextProfile);
    });
  }, []);

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
      if (!code) return;

      const token = await pollForToken(code);
      if (!token || exchangeCodeRef.current !== code) return;

      logInfo("SETTINGS", "Auth polling returned device token");
      await applyCloudToken(token);
    }, 3000);

    const timeout = setTimeout(() => {
      setWaitingForAuth(false);
      exchangeCodeRef.current = null;
    }, 120_000);

    return () => {
      if (authPollingRef.current) {
        clearInterval(authPollingRef.current);
        authPollingRef.current = null;
      }
      clearTimeout(timeout);
    };
  }, [applyCloudToken, waitingForAuth]);

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
        setPromptPreviewError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [settings?.language, settings?.style, type]);

  useEffect(() => {
    void refreshLocalInstalledModels();
  }, [refreshLocalInstalledModels]);

  useEffect(() => {
    const unlistenPromise = listen<LocalModelDownloadProgressEvent>(LOCAL_STT_MODEL_DOWNLOAD_PROGRESS_EVENT, (event) => {
      const modelOptions = LOCAL_MODEL_OPTIONS.filter((model) => model.model === event.payload.model);
      if (modelOptions.length === 0) return;

      const progress = typeof event.payload.percent === "number"
        ? Math.max(0, Math.min(100, event.payload.percent))
        : undefined;
      const message = event.payload.message || (progress !== undefined
        ? `Скачиваем модель: ${progress}%`
        : "Скачиваем модель.");

      setLocalModelActionStates((prev) => {
        const modelOption = modelOptions.find((model) => prev[model.id]?.status === "installing")
          || modelOptions.find((model) => model.runtimeReady === true)
          || modelOptions[0];

        return {
          ...prev,
          [modelOption.id]: {
            ...(prev[modelOption.id] || { status: "installing", message }),
            status: event.payload.status === "downloaded" ? "success" : "installing",
            message: event.payload.status === "downloaded" ? (event.payload.message || "Модель скачана.") : message,
            progress: event.payload.status === "downloaded" ? 100 : progress,
            downloadedBytes: event.payload.downloaded_bytes,
            totalBytes: event.payload.total_bytes ?? undefined,
          },
        };
      });
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  if (!settings) return null;

  const update = (patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...(prev ?? settings), ...patch };
      settingsSaveQueueRef.current = settingsSaveQueueRef.current
        .catch(() => {})
        .then(() => saveSettings(next))
        .then(() => {
          emit(SETTINGS_UPDATED_EVENT).catch(() => {});
        });
      return next;
    });
  };

  if (type === "model") {
    const isAuthenticated = cloudProfile !== null && cloudProfile !== undefined;
    const hasActiveSubscription = cloudProfile?.subscription.active === true;
    const isCloudMode = !settings.useOwnKey;
    const isCustom = settings.provider === "custom";
    const desktopPlatform = detectDesktopPlatform();
    const activeModelMode: "cloud" | "api" | "local" = isCloudMode ? "cloud" : isCustom ? "local" : "api";
    const isApiMode = activeModelMode === "api";
    const isLocalMode = activeModelMode === "local";
    const localSttTargetModel = (settings.whisperModel || LOCAL_STT_PRESET_MODEL).trim() || LOCAL_STT_PRESET_MODEL;
    const localInstalledModelSet = new Set(localInstalledModels);
    const localModelsDir = (settings.localModelsDir || "").trim();
    const apiKeyValue = (settings.apiKey || "").trim();
    const apiModelValue = (settings.whisperModel || "").trim();
    const isApiTestDisabled = testStatus === "testing" || !apiKeyValue || !apiModelValue;
    const modeOptions: Array<{
      id: "cloud" | "api" | "local";
      label: string;
      Icon: LucideIcon;
    }> = [
      {
        id: "cloud",
        label: "Облако",
        Icon: Cloud,
      },
      {
        id: "api",
        label: "API",
        Icon: Code,
      },
      {
        id: "local",
        label: "Локально",
        Icon: Server,
      },
    ];

    const resetTestState = () => {
      setTestStatus("idle");
      setTestMessage(null);
    };

    const resetInstallState = () => {
      setLocalModelActionStates({});
    };

    const getRuntimeKindFromEndpoint = (endpoint: string): LocalModelOption["runtimeKind"] | null => {
      try {
        const parsed = new URL(endpoint);
        const port = Number(parsed.port);
        if ((parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") || !Number.isFinite(port)) {
          return null;
        }

        if (port === 8000 || (port >= 18000 && port <= 18049)) return "whisper";
        if (port === 8001 || (port >= 18050 && port <= 18099)) return "nvidia";
        if (port === 8002 || (port >= 18100 && port <= 18149)) return "qwen";
      } catch {
        return null;
      }

      return null;
    };

    const getLocalModelEndpoint = (model: LocalModelOption) => {
      const currentEndpoint = settings.whisperEndpoint.trim();
      if (currentEndpoint && getRuntimeKindFromEndpoint(currentEndpoint) === model.runtimeKind) {
        return currentEndpoint;
      }

      return LOCAL_RUNTIME_ENDPOINTS[model.runtimeKind];
    };

    const getPreferredLocalModel = (): LocalModelOption => {
      const currentModel = (settings.whisperModel || "").trim();
      const isDownloaded = (model: LocalModelOption) =>
        localInstalledModelSet.has(model.model) || settings.localModels?.[model.id]?.status === "downloaded";

      const currentLocalModel = LOCAL_MODEL_OPTIONS.find(
        (model) => model.runtimeReady === true && model.model === currentModel && isDownloaded(model),
      );
      if (currentLocalModel) {
        return currentLocalModel;
      }

      return (
        LOCAL_MODEL_OPTIONS.find((model) => model.runtimeReady === true && isDownloaded(model)) ||
        LOCAL_MODEL_OPTIONS.find((model) => model.model === LOCAL_STT_PRESET_MODEL) ||
        LOCAL_MODEL_OPTIONS.find((model) => model.runtimeReady === true) ||
        LOCAL_MODEL_OPTIONS[0]
      );
    };

    const getApiAdapterValues = (adapter: ApiAdapterOption) => {
      if (adapter.id === "openai") {
        return {
          apiKey: settings.apiKey || "",
          model: settings.whisperModel || "",
        };
      }

      const savedAdapter = settings.apiAdapters?.[adapter.id];
      return {
        apiKey: savedAdapter?.apiKey || "",
        model: savedAdapter?.model || adapter.recommendedModel,
      };
    };

    const getPersistedAdapterStatus = (adapter: ApiAdapterOption, apiKey: string, model: string) => {
      const savedAdapter = settings.apiAdapters?.[adapter.id];
      const normalizedApiKey = apiKey.trim();
      const normalizedModel = model.trim();

      if (!savedAdapter?.connectionStatus || !normalizedApiKey || !normalizedModel) {
        return null;
      }

      if (
        savedAdapter.lastTestedApiKey !== normalizedApiKey ||
        savedAdapter.lastTestedModel !== normalizedModel
      ) {
        return null;
      }

      return savedAdapter.connectionStatus;
    };

    const updateApiAdapterValues = (adapter: ApiAdapterOption, patch: Partial<{ apiKey: string; model: string }>) => {
      if (adapter.id === "openai") {
        update({
          ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}),
          ...(patch.model !== undefined ? { whisperModel: patch.model } : {}),
        });
        resetTestState();
        return;
      }

      const currentValues = getApiAdapterValues(adapter);
      update({
        apiAdapters: {
          ...(settings.apiAdapters || {}),
          [adapter.id]: {
            ...currentValues,
            ...patch,
          },
        },
      });
      setApiAdapterTestStates((prev) => ({
        ...prev,
        [adapter.id]: { status: "idle", message: "" },
      }));
    };

    const getAdapterStatus = (adapter: ApiAdapterOption, apiKey: string, model: string) => {
      const persistedStatus = getPersistedAdapterStatus(adapter, apiKey, model);

      if (adapter.id === "openai") {
        const hasCredentials = Boolean(apiKey.trim()) && Boolean(model.trim());
        const effectiveStatus = testStatus === "idle" && persistedStatus === "verified"
          ? "success"
          : testStatus as AdapterTestStatus;
        const label = !apiKey.trim()
          ? "Нужен API-ключ"
          : effectiveStatus === "success"
            ? "Подключен"
            : effectiveStatus === "error"
              ? "Ошибка"
              : effectiveStatus === "testing"
                ? "Проверяем"
                : "Готов к проверке";
        const connectionLabel = !hasCredentials
          ? "API-ключ не указан"
          : effectiveStatus === "success"
            ? "Соединение работает"
            : effectiveStatus === "error"
              ? "Ошибка соединения"
              : effectiveStatus === "testing"
                ? "Проверяем соединение..."
                : "Соединение не проверено";
        const color = effectiveStatus === "success"
          ? "#16a34a"
          : effectiveStatus === "error"
            ? "#dc2626"
            : "var(--text-low)";

        return {
          label,
          message: testMessage || (persistedStatus === "verified" ? "Соединение проверено и сохранено." : null),
          status: effectiveStatus,
          color,
          connectionLabel,
        };
      }

      const adapterState = apiAdapterTestStates[adapter.id];
      const hasCredentials = Boolean(apiKey.trim()) && Boolean(model.trim());
      const effectiveStatus: AdapterTestStatus = adapterState?.status === "error"
        ? "error"
        : persistedStatus
          ? "success"
          : adapterState?.status || "idle";
      const label = effectiveStatus === "success"
        ? "Сохранен"
        : !apiKey.trim()
          ? "Нужен API-ключ"
          : !model.trim()
            ? "Нужна модель"
            : "Готов к подключению";

      return {
        label,
        message: adapterState?.message || (persistedStatus ? `${adapter.name}: ключ и модель сохранены.` : null),
        status: effectiveStatus,
        color: effectiveStatus === "success" ? "#16a34a" : effectiveStatus === "error" ? "#dc2626" : hasCredentials ? "var(--text-hi)" : "var(--text-low)",
        connectionLabel: effectiveStatus === "success" ? "Ключ и модель сохранены" : hasCredentials ? "Готов к сохранению" : "Заполните ключ и модель",
      };
    };

    const handleApiAdapterTest = async (adapter: ApiAdapterOption) => {
      if (adapter.id === "openai") {
        await handleTestConnection();
        return;
      }

      const values = getApiAdapterValues(adapter);
      if (!values.apiKey.trim() || !values.model.trim()) {
        setApiAdapterTestStates((prev) => ({
          ...prev,
          [adapter.id]: { status: "error", message: "Укажите API-ключ и название модели перед проверкой." },
        }));
        return;
      }

      setApiAdapterTestStates((prev) => ({
        ...prev,
        [adapter.id]: {
          status: "success",
          message: `${adapter.name}: ключ и модель сохранены. Реальная проверка соединения будет доступна после подключения backend-адаптера.`,
        },
      }));
      update({
        apiAdapters: {
          ...(settings.apiAdapters || {}),
          [adapter.id]: {
            apiKey: values.apiKey,
            model: values.model,
            connectionStatus: "saved",
            lastConnectedAt: new Date().toISOString(),
            lastTestedApiKey: values.apiKey.trim(),
            lastTestedModel: values.model.trim(),
          },
        },
      });
    };

    const handleActivateSubscription = async () => {
      try {
        if (isAuthenticated) {
          setWaitingForSubscriptionRefresh(true);
          await openUrl(getAuthLoginUrl().replace("/auth/login?device=true", "/dashboard"));
          return;
        }

        const code = generateExchangeCode();
        exchangeCodeRef.current = code;
        setWaitingForAuth(true);
        await openUrl(getAuthLoginUrlWithCode(code));
      } catch {
        // Error handled silently
      }
    };

    const handleCloudLogout = async () => {
      if (authPollingRef.current) {
        clearInterval(authPollingRef.current);
        authPollingRef.current = null;
      }
      exchangeCodeRef.current = null;
      setWaitingForAuth(false);
      setWaitingForSubscriptionRefresh(false);
      await cloudLogout();
      setCloudProfile(null);
      await syncSettings();
    };

    const handleModeChange = (mode: typeof modeOptions[number]["id"]) => {
      if (mode === activeModelMode) {
        return;
      }

      resetTestState();
      resetInstallState();

      if (mode === "cloud") {
        update({ useOwnKey: false });
        return;
      }

      const localModel = getPreferredLocalModel();
      update({
        useOwnKey: true,
        ...(mode === "api"
          ? {
              provider: "openai" as const,
              whisperEndpoint: "",
              llmApiKey: "",
              llmEndpoint: "",
              whisperModel: "whisper-1",
              llmModel: "none",
            }
          : {
              provider: "custom" as const,
              whisperApiKey: "",
              whisperEndpoint: getLocalModelEndpoint(localModel),
              whisperModel: localModel.model,
              llmApiKey: "",
              llmEndpoint: "",
              llmModel: "none",
            }),
      });
    };

    const handleTestConnection = async () => {
      setTestStatus("testing");
      setTestMessage(null);

      const testStt = isCustom || settings.provider === "openai";
      const testLlm = false;

      try {
        if (!testStt && !testLlm) {
          setTestStatus("error");
          setTestMessage("Сначала укажите endpoint или API-ключ для проверки соединения.");
          return;
        }

        const result = await invoke<{ success: boolean; message: string; latency_ms: number }>("test_api_connection", {
          req: {
            api_key: settings.apiKey || "",
            whisper_api_key: isCustom ? (settings.whisperApiKey || null) : null,
            whisper_endpoint: isCustom ? (settings.whisperEndpoint || null) : null,
            local_models_dir: isCustom ? (localModelsDir || null) : null,
            whisper_model: isCustom ? (settings.whisperModel || null) : (settings.whisperModel || "whisper-1"),
            llm_api_key: null,
            llm_endpoint: null,
            llm_model: "none",
            test_stt: testStt,
            test_llm: testLlm,
          },
        });
        setTestStatus(result.success ? "success" : "error");
        setTestMessage(result.message);
        if (result.success && !isCustom) {
          const normalizedApiKey = (settings.apiKey || "").trim();
          const normalizedModel = (settings.whisperModel || "whisper-1").trim();

          update({
            apiAdapters: {
              ...(settings.apiAdapters || {}),
              openai: {
                apiKey: settings.apiKey || "",
                model: settings.whisperModel || "whisper-1",
                connectionStatus: "verified",
                lastConnectedAt: new Date().toISOString(),
                lastTestedApiKey: normalizedApiKey,
                lastTestedModel: normalizedModel,
              },
            },
          });
        }
      } catch (err) {
        setTestStatus("error");
        setTestMessage(err instanceof Error ? err.message : String(err));
      }
    };

    const updateLocalModelCache = (modelId: string, patch: Partial<LocalModelSettings>) => {
      const current = settings.localModels?.[modelId] || { status: "not_downloaded" as const };
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

    const getLocalModelStatus = (model: LocalModelOption) => {
      const actionState = localModelActionStates[model.id];
      const cachedState = settings.localModels?.[model.id];
      const isPlatformSupported = model.runtimeKind === "whisper" || desktopPlatform === "macos";
      const isRuntimeReady = model.runtimeReady === true && isPlatformSupported;
      const isInstalled = isRuntimeReady && (localInstalledModelSet.has(model.model) || cachedState?.status === "downloaded");
      const isSelected = localSttTargetModel === model.model && isInstalled;

      if (!isRuntimeReady) {
        const runtimeName = model.runtimeKind === "nvidia" ? "NVIDIA" : model.runtimeKind === "qwen" ? "Qwen" : "MLX";
        const isRuntimeSlotReady = model.runtimeKind === "qwen" || model.runtimeKind === "nvidia";
        return {
          label: isRuntimeSlotReady ? "Модель не подключена" : "Движок не подключен",
          connectionLabel: isRuntimeSlotReady
            ? `${runtimeName} runtime работает, но эта модель ещё не включена.`
            : `${runtimeName} runtime-слот подготовлен, но движок еще не встроен в сборку.`,
          status: "unsupported" as const,
          color: "var(--text-low)",
          message: !isPlatformSupported
            ? "Эта локальная модель пока доступна только на macOS. Для Windows и Linux оставлен Whisper runtime."
            : model.unavailableReason || `${runtimeName} sidecar запускается отдельно от Whisper, но скачивание и распознавание для этой линейки будут включены после подключения локального engine.`,
          isInstalled: false,
          isSelected: false,
        };
      }

      if (actionState?.status === "deleting") {
        return {
          label: "Удаляется",
          connectionLabel: "",
          status: "deleting" as const,
          color: "var(--text-hi)",
          message: actionState.message || cachedState?.message || null,
          isInstalled,
          isSelected,
        };
      }

      if (!isInstalled && (actionState?.status === "installing" || cachedState?.status === "downloading")) {
        return {
          label: "Скачивается",
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
          label: "Выбрана",
          connectionLabel: "",
          status: "selected" as const,
          color: "#16a34a",
          message: actionState?.message || cachedState?.message || null,
          isInstalled,
          isSelected,
        };
      }

      if (isInstalled) {
        return {
          label: "Готова",
          connectionLabel: "",
          status: "installed" as const,
          color: "#16a34a",
          message: actionState?.message || cachedState?.message || null,
          isInstalled,
          isSelected,
        };
      }

      if (actionState?.status === "error" || cachedState?.status === "error") {
        return {
          label: "Ошибка",
          connectionLabel: "Не удалось подготовить модель",
          status: "error" as const,
          color: "#dc2626",
          message: actionState?.message || cachedState?.message || null,
          isInstalled,
          isSelected,
        };
      }

      return {
        label: "Не скачана",
        connectionLabel: "",
        status: "idle" as const,
        color: "var(--text-low)",
        message: actionState?.message || cachedState?.message || null,
        isInstalled,
        isSelected,
      };
    };

    const getLocalModelLevel = (kind: "speed" | "accuracy", value: string) => {
      if (kind === "speed") {
        if (value === "очень быстро") return 5;
        if (value === "быстро") return 4;
        if (value === "средне") return 3;
        return 2;
      }

      if (value === "максимальная") return 5;
      if (value === "высокая") return 4;
      if (value === "средняя+" || value === "средняя") return 3;
      if (value === "служебная") return 2;
      return 1;
    };

    const formatLocalDownloadBytes = (bytes?: number, options: { showZero?: boolean } = {}) => {
      if (!bytes || bytes <= 0) return options.showZero ? "0 Б" : "";
      const mb = bytes / (1024 * 1024);
      if (mb >= 1024) {
        const gb = mb / 1024;
        return `${gb.toFixed(gb >= 10 ? 0 : 1).replace(".", ",")} ГБ`;
      }

      return `${mb.toFixed(mb >= 10 ? 0 : 1).replace(".", ",")} МБ`;
    };

    const getLocalModelStorageLabel = (model: LocalModelOption) => {
      return formatLocalDownloadBytes(model.downloadBytes) || (model.runtimeReady ? "Неизвестно" : "Не подключено");
    };

    const renderDotRating = (level: number) => (
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {Array.from({ length: 5 }).map((_, index) => (
          <span
            key={index}
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: index < level ? "#000" : "rgba(0,0,0,0.18)",
              display: "block",
            }}
          />
        ))}
      </div>
    );

    const renderLocalModelStats = (model: LocalModelOption) => {
      const stats: { key: string; title: string; label: string; Icon: LucideIcon; level: number }[] = [
        { key: "speed", title: `Скорость: ${model.speed}`, label: "Скорость", Icon: Gauge, level: getLocalModelLevel("speed", model.speed) },
        { key: "accuracy", title: `Точность: ${model.accuracy}`, label: "Точность", Icon: Target, level: getLocalModelLevel("accuracy", model.accuracy) },
      ];
      const storageLabel = getLocalModelStorageLabel(model);

      return (
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 9, flexWrap: "wrap" }}>
          <div
            title={`Размер загрузки: ${storageLabel}`}
            aria-label={`Размер загрузки: ${storageLabel}`}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <HardDrive size={14} strokeWidth={1.9} color="#000" />
            <span style={{ fontSize: 12, fontWeight: 650, color: "var(--text-hi)", lineHeight: 1 }}>
              {storageLabel}
            </span>
          </div>

          {stats.map(({ key, title, label, Icon, level }) => (
            <div
              key={key}
              title={title}
              aria-label={title}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <Icon size={14} strokeWidth={1.9} color="#000" />
              <span style={{ fontSize: 12, fontWeight: 650, color: "var(--text-hi)", lineHeight: 1 }}>
                {label}
              </span>
              {renderDotRating(level)}
            </div>
          ))}
        </div>
      );
    };

    const handleSelectLocalModel = (model: LocalModelOption, endpointOverride?: string) => {
      update({
        useOwnKey: true,
        provider: "custom",
        whisperApiKey: "",
        whisperEndpoint: endpointOverride || getLocalModelEndpoint(model),
        whisperModel: model.model,
        llmApiKey: "",
        llmEndpoint: "",
        llmModel: "none",
      });
      resetTestState();
      resetInstallState();

      if (localInstalledModelSet.has(model.model)) {
        updateLocalModelCache(model.id, {
          status: "downloaded",
          downloadedAt: settings.localModels?.[model.id]?.downloadedAt || new Date().toISOString(),
          lastCheckedAt: new Date().toISOString(),
          message: undefined,
        });
      }
    };

    const handleInstallLocalSttModel = async (model: LocalModelOption) => {
      setLocalModelActionStates((prev) => ({
        ...prev,
        [model.id]: { status: "installing", message: "Готовим локальный STT runtime.", progress: 0 },
      }));
      updateLocalModelCache(model.id, {
        status: "downloading",
        message: "Готовим локальный STT runtime.",
      });

      try {
        const result = await invoke<{ success: boolean; message: string; whisper_endpoint?: string | null }>("install_stt_model", {
          req: {
            api_key: settings.apiKey || "",
            whisper_api_key: settings.whisperApiKey || null,
            whisper_endpoint: getLocalModelEndpoint(model),
            local_models_dir: localModelsDir || null,
            whisper_model: model.model,
          },
        });

        setLocalModelActionStates((prev) => ({
          ...prev,
          [model.id]: { status: result.success ? "success" : "error", message: result.success ? "" : result.message },
        }));
        updateLocalModelCache(model.id, {
          status: result.success ? "downloaded" : "error",
          message: result.success ? undefined : result.message,
          downloadedAt: result.success ? new Date().toISOString() : undefined,
          lastCheckedAt: new Date().toISOString(),
        });

        if (result.success) {
          handleSelectLocalModel(model, result.whisper_endpoint || undefined);
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

    const handleDeleteLocalSttModel = async (model: LocalModelOption) => {
      setPendingDeleteModel(null);
      setLocalModelActionStates((prev) => ({
        ...prev,
        [model.id]: { status: "deleting", message: "Удаляем локальный файл модели." },
      }));

      try {
        const result = await invoke<{ success: boolean; message: string }>("delete_stt_model", {
          req: {
            api_key: settings.apiKey || "",
            whisper_api_key: settings.whisperApiKey || null,
            whisper_endpoint: getLocalModelEndpoint(model),
            local_models_dir: localModelsDir || null,
            whisper_model: model.model,
          },
        });

        setLocalModelActionStates((prev) => ({
          ...prev,
          [model.id]: { status: result.success ? "success" : "error", message: result.success ? "" : result.message },
        }));
        updateLocalModelCache(model.id, {
          status: result.success ? "not_downloaded" : "error",
          message: result.success ? undefined : result.message,
          downloadedAt: undefined,
          lastCheckedAt: new Date().toISOString(),
        });

        if (result.success) {
          setLocalInstalledModels((prev) => prev.filter((id) => id !== model.model));
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

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

        {/* ── Subscription banner OR active status ── */}
        {hasActiveSubscription ? (
          <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 42, height: 42, borderRadius: 999, background: "#000", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Crown size={20} strokeWidth={2.2} color="#fff" />
              </div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-hi)" }}>Подписка активна</div>
                <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
                  {`Безлимитный доступ до ${cloudProfile?.subscription.expiresAt ? new Date(cloudProfile.subscription.expiresAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "—"}`}
                </div>
              </div>
            </div>
            <div style={{ width: 10, height: 10, borderRadius: 999, background: "#000", flexShrink: 0 }} />
          </div>
        ) : isAuthenticated ? (
          <CloudSubscriptionAccountCard
            profile={cloudProfile}
            onActivate={handleActivateSubscription}
            onLogout={() => {
              void handleCloudLogout();
            }}
          />
        ) : (
          <SubscriptionGuestCard onActivate={handleActivateSubscription} />
        )}

        {/* ── Separator ── */}
        {!hasActiveSubscription && !isCloudMode && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.08)" }} />
            <span className="label">или</span>
            <div style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.08)" }} />
          </div>
        )}

        <>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-hi)", marginBottom: 4 }}>
              Режим распознавания
            </div>
            <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6, marginBottom: 14 }}>
              Вы можете в любой момент переключаться между облаком, своим API-ключом и локальной моделью.
            </div>

            <div style={{ display: "flex", background: "rgba(0,0,0,0.05)", borderRadius: 10, padding: 3, gap: 2 }}>
              {modeOptions.map(({ id, label, Icon }) => {
                const active = activeModelMode === id;

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
                      background: active ? "#000" : "transparent",
                      color: active ? "#fff" : "var(--text-mid)",
                      cursor: "pointer",
                      transition: "all 0.18s ease",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 7,
                    }}
                  >
                    <Icon size={15} strokeWidth={active ? 2.2 : 1.7} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {hasActiveSubscription && !settings.useOwnKey && (
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>Облако</div>
              <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
                Запросы на распознавание и обработку текста идут через облако Talkis. Все данные шифруются при передаче, а аудио и текст не сохраняются на сервере после обработки.
              </div>
            </div>
          )}

          {isCloudMode && !hasActiveSubscription && (
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>Облако</div>
              <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
                Для облачного режима нужна авторизация и активная подписка. После входа плашка и статус подписки обновятся автоматически.
              </div>
            </div>
          )}

          {isApiMode && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)", marginBottom: 4 }}>
                  Доступные API-адаптеры
                </div>
                <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
                  Выберите адаптер, раскройте его и укажите ключ вместе с названием модели распознавания.
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {API_ADAPTERS.map((adapter) => {
                  const isExpanded = expandedApiAdapter === adapter.id;
                  const adapterValues = getApiAdapterValues(adapter);
                  const adapterStatus = getAdapterStatus(adapter, adapterValues.apiKey, adapterValues.model);
                  const isAdapterConnected = adapterStatus.status === "success";
                  const isAdapterTestDisabled = adapter.id === "openai"
                    ? isApiTestDisabled
                    : !adapterValues.apiKey.trim() || !adapterValues.model.trim();

                  return (
                    <div key={adapter.id} className="card" style={{ padding: 0, overflow: "hidden", background: "rgba(255,255,255,0.72)" }}>
                      <button
                        type="button"
                        onClick={() => setExpandedApiAdapter(isExpanded ? null : adapter.id)}
                        style={{
                          width: "100%",
                          border: "none",
                          background: "transparent",
                          padding: "12px 14px",
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          cursor: "pointer",
                          textAlign: "left",
                          fontFamily: "var(--font-main)",
                        }}
                      >
                        <div style={{ width: 36, height: 36, borderRadius: 999, background: "rgba(0,0,0,0.04)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
                          {adapter.avatar ? (
                            <img
                              src={adapter.avatar}
                              alt=""
                              aria-hidden="true"
                              style={{ width: "100%", height: "100%", display: "block", objectFit: "cover" }}
                            />
                          ) : (
                            <span style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: adapter.accent, color: "#fff", fontSize: adapter.initials.length > 2 ? 10 : 12, fontWeight: 800 }}>
                              {adapter.initials}
                            </span>
                          )}
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 3 }}>
                            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>{adapter.name}</div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: adapterStatus.color, padding: "5px 9px", borderRadius: 999, background: "rgba(0,0,0,0.04)", whiteSpace: "nowrap" }}>
                              {adapterStatus.label}
                            </div>
                          </div>
                          <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-mid)" }}>
                            {adapter.description} Рекомендуемая модель: {adapter.recommendedModel}.
                          </div>
                        </div>
                      </button>

                      {isExpanded && (
                        <div style={{ borderTop: "1px solid rgba(0,0,0,0.07)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div className="label" style={{ width: 76, flexShrink: 0 }}>API-ключ</div>
                            <input
                              type="password"
                              value={adapterValues.apiKey}
                              onChange={(e) => updateApiAdapterValues(adapter, { apiKey: e.target.value })}
                              className="input"
                              placeholder="API key"
                              style={{ flex: 1, minWidth: 0, height: 36, padding: "8px 10px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}
                            />
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div className="label" style={{ width: 76, flexShrink: 0 }}>Модель</div>
                            <input
                              type="text"
                              value={adapterValues.model}
                              onChange={(e) => updateApiAdapterValues(adapter, { model: e.target.value })}
                              className="input"
                              placeholder={adapter.recommendedModel}
                              style={{ flex: 1, minWidth: 0, height: 36, padding: "8px 10px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}
                            />
                            <div style={{ fontSize: 11, color: "var(--text-low)", whiteSpace: "nowrap", flexShrink: 0 }}>Рекомендуем: {adapter.recommendedModel}</div>
                          </div>

                          {adapterStatus.message && (
                            <div style={{
                              fontSize: 12,
                              lineHeight: 1.6,
                              padding: "8px 10px",
                              borderRadius: 8,
                              background: adapterStatus.status === "success" ? "rgba(22,163,74,0.06)" : adapterStatus.status === "error" ? "rgba(220,38,38,0.06)" : "rgba(0,0,0,0.04)",
                              color: adapterStatus.status === "success" ? "#16a34a" : adapterStatus.status === "error" ? "#dc2626" : "var(--text-mid)",
                              border: `1px solid ${adapterStatus.status === "success" ? "rgba(22,163,74,0.15)" : adapterStatus.status === "error" ? "rgba(220,38,38,0.15)" : "rgba(0,0,0,0.07)"}`,
                            }}>
                              {adapterStatus.message}
                            </div>
                          )}

                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, color: adapterStatus.color, fontSize: 12, fontWeight: 600 }}>
                              {adapterStatus.status === "success" && <Check size={15} strokeWidth={2.5} />}
                              {adapterStatus.connectionLabel}
                            </div>
                            {isAdapterConnected ? (
                              <div style={{
                                padding: "9px 12px",
                                borderRadius: 10,
                                border: "1px solid rgba(22,163,74,0.16)",
                                background: "rgba(22,163,74,0.06)",
                                color: "#16a34a",
                                fontSize: 12,
                                fontWeight: 700,
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                              }}>
                                <Check size={14} strokeWidth={2.5} />
                                Подключено
                              </div>
                            ) : (
                              <button
                                onClick={() => void handleApiAdapterTest(adapter)}
                                disabled={isAdapterTestDisabled}
                                style={{
                                  padding: "9px 12px",
                                  borderRadius: 10,
                                  border: "1px solid rgba(0,0,0,0.12)",
                                  background: isAdapterTestDisabled ? "rgba(0,0,0,0.04)" : "#000",
                                  color: isAdapterTestDisabled ? "var(--text-mid)" : "#fff",
                                  fontSize: 12,
                                  fontWeight: 700,
                                  fontFamily: "var(--font-main)",
                                  cursor: adapterStatus.status === "testing" ? "wait" : isAdapterTestDisabled ? "not-allowed" : "pointer",
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                }}
                              >
                                {adapterStatus.status === "testing" ? (
                                  <>
                                    <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid rgba(255,255,255,0.35)", borderTopColor: "#fff", borderRadius: 999, animation: "spin 0.8s linear infinite" }} />
                                    Проверяем...
                                  </>
                                ) : (
                                  <>
                                    <Zap size={14} strokeWidth={2.2} />
                                    {adapter.testable ? "Тестировать и сохранить" : "Сохранить"}
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

          {isLocalMode && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)", marginBottom: 4 }}>
                  Локальные модели
                </div>
                <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
                  Выберите модель, скачайте ее через локальный STT runtime и используйте без облака.
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {LOCAL_MODEL_OPTIONS.map((model) => {
                  const isExpanded = expandedLocalModel === model.id;
                  const modelStatus = getLocalModelStatus(model);
                  const modelActionState = localModelActionStates[model.id];
                  const isRuntimeReady = getLocalModelStatus(model).status !== "unsupported" && model.runtimeReady === true;
                  const isDownloaded = modelStatus.isInstalled;
                  const isModelBusy = modelStatus.status === "installing" || modelStatus.status === "deleting";
                  const isInstallDisabled = isModelBusy || !isRuntimeReady;
                  const canSelect = isRuntimeReady && modelStatus.isInstalled;
                  const downloadProgress = modelStatus.status === "installing" ? modelActionState?.progress : undefined;
                  const downloadedLabel = formatLocalDownloadBytes(modelActionState?.downloadedBytes, { showZero: Boolean(modelActionState?.totalBytes) });
                  const totalLabel = formatLocalDownloadBytes(modelActionState?.totalBytes);

                  return (
                    <div key={model.id} className="card" style={{ padding: 0, overflow: "hidden", background: "rgba(255,255,255,0.72)" }}>
                      <button
                        type="button"
                        onClick={() => setExpandedLocalModel(isExpanded ? null : model.id)}
                        style={{
                          width: "100%",
                          border: "none",
                          background: "transparent",
                          padding: "12px 14px",
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          cursor: "pointer",
                          textAlign: "left",
                          fontFamily: "var(--font-main)",
                        }}
                      >
                        <div style={{ width: 36, height: 36, borderRadius: 999, background: (model.avatar || model.engineLabel === "Whisper") ? "rgba(0,0,0,0.04)" : model.accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "#fff", fontSize: 11, fontWeight: 800, overflow: "hidden" }}>
                          {model.avatar || model.engineLabel === "Whisper" ? (
                            <img
                              src={model.avatar || openAiAvatar}
                              alt=""
                              aria-hidden="true"
                              style={{ width: "100%", height: "100%", display: "block", objectFit: "cover" }}
                            />
                          ) : (
                            model.initials
                          )}
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 3 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{model.name}</div>
                              {model.recommended && (
                                <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text-hi)", padding: "3px 7px", borderRadius: 999, background: "rgba(0,0,0,0.06)", flexShrink: 0 }}>
                                  Рекомендуем
                                </div>
                              )}
                            </div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: modelStatus.color, padding: "5px 9px", borderRadius: 999, background: "rgba(0,0,0,0.04)", whiteSpace: "nowrap" }}>
                              {modelStatus.label}
                            </div>
                          </div>
                          <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text-mid)" }}>
                            {model.description} Runtime: {model.runtime}.
                          </div>
                          {renderLocalModelStats(model)}
                        </div>
                      </button>

                      {isExpanded && (
                        <div style={{ borderTop: "1px solid rgba(0,0,0,0.07)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                          {modelStatus.message && modelStatus.status !== "installing" && modelStatus.status !== "installed" && modelStatus.status !== "selected" && (
                            <div style={{
                              fontSize: 12,
                              lineHeight: 1.6,
                              padding: "8px 10px",
                              borderRadius: 8,
                              background: modelStatus.status === "error" ? "rgba(220,38,38,0.06)" : "rgba(0,0,0,0.04)",
                              color: modelStatus.status === "error" ? "#dc2626" : "var(--text-mid)",
                              border: `1px solid ${modelStatus.status === "error" ? "rgba(220,38,38,0.15)" : "rgba(0,0,0,0.07)"}`,
                            }}>
                              {modelStatus.message}
                            </div>
                          )}

                          {modelStatus.status === "installing" && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 12, color: "var(--text-mid)", fontWeight: 650 }}>
                                <span>{modelActionState?.message || "Загрузка модели"}</span>
                                <span style={{ color: "var(--text-hi)" }}>
                                  {downloadProgress !== undefined ? `${downloadProgress}%` : downloadedLabel || "Подготовка"}
                                </span>
                              </div>
                              <div style={{ width: "100%", height: 8, borderRadius: 999, background: "rgba(0,0,0,0.10)", overflow: "hidden" }}>
                                <div
                                  style={{
                                    width: `${downloadProgress ?? 2}%`,
                                    minWidth: downloadProgress === undefined ? 18 : 0,
                                    height: "100%",
                                    borderRadius: 999,
                                    background: "#000",
                                    transition: "width 0.2s ease",
                                  }}
                                />
                              </div>
                              {(downloadedLabel || totalLabel) && (
                                <div style={{ fontSize: 11, color: "var(--text-low)", lineHeight: 1.4 }}>
                                  {downloadedLabel}{totalLabel ? ` из ${totalLabel}` : ""}
                                </div>
                              )}
                            </div>
                          )}

                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                            {modelStatus.connectionLabel && (
                              <div style={{ display: "flex", alignItems: "center", gap: 8, color: modelStatus.color, fontSize: 12, fontWeight: 600 }}>
                                {(modelStatus.status === "installed" || modelStatus.status === "selected") && <Check size={15} strokeWidth={2.5} />}
                                {modelStatus.connectionLabel}
                              </div>
                            )}

                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
                              {canSelect && !modelStatus.isSelected && (
                                <button
                                  onClick={() => handleSelectLocalModel(model)}
                                  style={{
                                    padding: "9px 12px",
                                    borderRadius: 10,
                                    border: "1px solid rgba(0,0,0,0.12)",
                                    background: "rgba(0,0,0,0.02)",
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
                                  <Check size={14} strokeWidth={2.5} />
                                  Выбрать
                                </button>
                              )}

                              {!isModelBusy && (
                                <button
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
                                    border: "1px solid rgba(0,0,0,0.12)",
                                    background: isInstallDisabled ? "rgba(0,0,0,0.04)" : isDownloaded ? "rgba(0,0,0,0.02)" : "#000",
                                    color: isInstallDisabled ? "var(--text-mid)" : isDownloaded ? "var(--text-hi)" : "#fff",
                                    fontSize: 12,
                                    fontWeight: 700,
                                    fontFamily: "var(--font-main)",
                                    cursor: isInstallDisabled ? "not-allowed" : "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                  }}
                                >
                                  {isDownloaded ? (
                                    <>
                                      <Trash2 size={14} strokeWidth={2.2} />
                                      Удалить
                                    </>
                                  ) : (
                                    <>
                                      <Download size={14} strokeWidth={2.2} />
                                      {isRuntimeReady ? "Скачать" : "Недоступно"}
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
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
                    background: "rgba(0,0,0,0.22)",
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
                      boxShadow: "0 18px 50px rgba(0,0,0,0.18)",
                    }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div id="delete-local-model-title" style={{ fontSize: 17, fontWeight: 750, color: "var(--text-hi)", marginBottom: 8 }}>
                      Вы действительно хотите удалить?
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text-mid)", marginBottom: 16 }}>
                      {pendingDeleteModel.name} будет удалена с диска. При необходимости модель можно скачать заново.
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteModel(null)}
                        style={{
                          padding: "10px 14px",
                          borderRadius: 10,
                          border: "1px solid rgba(0,0,0,0.12)",
                          background: "rgba(0,0,0,0.02)",
                          color: "var(--text-hi)",
                          fontSize: 12,
                          fontWeight: 700,
                          fontFamily: "var(--font-main)",
                          cursor: "pointer",
                        }}
                      >
                        Отмена
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteLocalSttModel(pendingDeleteModel)}
                        style={{
                          padding: "10px 14px",
                          borderRadius: 10,
                          border: "1px solid rgba(0,0,0,0.12)",
                          background: "#000",
                          color: "#fff",
                          fontSize: 12,
                          fontWeight: 700,
                          fontFamily: "var(--font-main)",
                          cursor: "pointer",
                        }}
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                </div>
              )}
              </div>
            )}
        </>
      </div>
    );
  }

  const STYLE_ICONS: Record<AppSettings["style"], LucideIcon> = {
    classic: MessageSquare,
    business: Briefcase,
    tech: Code,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "grid", gap: 4 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-hi)" }}>Стиль обработки текста</div>
        <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>Выберите режим обработки.</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {TRANSCRIPTION_STYLE_OPTIONS.map((st) => {
          const isActive = settings.style === st.id;
          const Icon = STYLE_ICONS[st.id];

          return (
            <OptionCard
              key={st.id}
              active={isActive}
              icon={<Icon size={20} strokeWidth={isActive ? 2.4 : 1.8} />}
              title={st.title}
              description={st.description}
              onClick={() => update({ style: st.id as AppSettings["style"] })}
            />
          );
        })}
      </div>

      {IS_DEV && (
        <details className="card" style={{ background: "rgba(255,255,255,0.68)" }}>
          <summary style={{ cursor: "pointer", listStyle: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)", marginBottom: 4 }}>Prompt Preview</div>
              <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
                Итоговый prompt для текущего языка и стиля обработки.
              </div>
            </div>
            {promptPreview && <div className="label">v{promptPreview.version}</div>}
          </summary>

          <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
            {promptPreviewError ? (
              <div style={{ fontSize: 12, color: "#b42318", lineHeight: 1.6 }}>
                Не удалось собрать preview prompt: {promptPreviewError}
              </div>
            ) : promptPreview ? (
              <>
                <div style={{ display: "grid", gap: 4 }}>
                  <div className="label">Профиль</div>
                  <div style={{ fontSize: 12, color: "var(--text-hi)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                    {promptPreview.profileKey}
                  </div>
                </div>

                <div style={{ display: "grid", gap: 6 }}>
                  <div className="label">Слои</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {promptPreview.layers.map((layer) => (
                      <span
                        key={layer}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 999,
                          background: "rgba(0,0,0,0.05)",
                          fontSize: 11,
                          color: "var(--text-mid)",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        }}
                      >
                        {layer}
                      </span>
                    ))}
                  </div>
                </div>

                <div style={{ display: "grid", gap: 6 }}>
                  <div className="label">Текст prompt</div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 14,
                      borderRadius: 12,
                      background: "rgba(0,0,0,0.04)",
                      color: "var(--text-mid)",
                      fontSize: 11,
                      lineHeight: 1.65,
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
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
              <div style={{ fontSize: 12, color: "var(--text-mid)" }}>Собираем preview...</div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
