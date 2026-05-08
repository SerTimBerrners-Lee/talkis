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
  LogOut,
  LucideIcon,
  MessageSquare,
  Server,
  User,
  Zap,
} from "lucide-react";

import { AppSettings, getSettings, saveSettings } from "../../../lib/store";
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
import openAiAvatar from "../../../assets/adapters/openai.svg";
import volcengineAvatar from "../../../assets/adapters/volcengine.webp";
import xAiAvatar from "../../../assets/adapters/xai.png";

const IS_DEV = import.meta.env.DEV;
const LOCAL_STT_PRESET_ENDPOINT = "http://127.0.0.1:8000";
const LOCAL_STT_PRESET_MODEL = "whisper-1";
const LOCAL_STT_HELP_URL = "https://speaches.ai/installation/";

interface SettingsTabsProps { type: "model" | "style"; }

interface PromptPreview {
  prompt: string;
  layers: string[];
  profileKey: string;
  version: number;
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
        <span style={{ display: "flex", alignItems: "center", lineHeight: 1, whiteSpace: "nowrap" }}>Активировать подписку</span>
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
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 16 }}>
        <span style={{ textDecoration: "line-through", opacity: 0.45, fontSize: 12 }}>1 500 ₽</span>
        <span style={{ fontWeight: 800, fontSize: 22 }}>390 ₽</span>
        <span style={{ opacity: 0.5, fontSize: 11 }}>/ мес</span>
      </div>
      <button onClick={onActivate} style={{ width: "100%", padding: "12px", borderRadius: 10, background: "#fff", color: "#000", border: "none", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer", transition: "opacity 0.15s", fontFamily: "var(--font-main)" }}>
        Активировать
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
  const [installStatus, setInstallStatus] = useState<"idle" | "installing" | "success" | "error">("idle");
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [waitingForAuth, setWaitingForAuth] = useState(false);
  const [waitingForSubscriptionRefresh, setWaitingForSubscriptionRefresh] = useState(false);
  const [expandedApiAdapter, setExpandedApiAdapter] = useState<ApiAdapterId | null>(null);
  const [apiAdapterTestStates, setApiAdapterTestStates] = useState<Partial<Record<ApiAdapterId, { status: AdapterTestStatus; message: string }>>>({});
  const authPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const exchangeCodeRef = useRef<string | null>(null);

  const syncSettings = useCallback(async () => {
    const nextSettings = await getSettings();
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

  useEffect(() => { void syncSettings(); }, [syncSettings]);

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
      if (!token) return;

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

  if (!settings) return null;

  const update = (patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...(prev ?? settings), ...patch };
      void saveSettings(next).then(() => {
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
    const activeModelMode: "cloud" | "api" | "local" = isCloudMode ? "cloud" : isCustom ? "local" : "api";
    const isApiMode = activeModelMode === "api";
    const isLocalMode = activeModelMode === "local";
    const localSttEndpoint = (settings.whisperEndpoint || "").trim();
    const isInstallLocalModelDisabled = installStatus === "installing" || !localSttEndpoint;
    const localSttTargetModel = (settings.whisperModel || LOCAL_STT_PRESET_MODEL).trim() || LOCAL_STT_PRESET_MODEL;
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
      setInstallStatus("idle");
      setInstallMessage(null);
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
      await cloudLogout();
      setCloudProfile(null);
      await syncSettings();
      setWaitingForAuth(false);
      setWaitingForSubscriptionRefresh(false);
      exchangeCodeRef.current = null;
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

      update({
        useOwnKey: true,
        ...(mode === "api"
          ? {
              provider: "openai" as const,
              whisperEndpoint: "",
              llmEndpoint: "",
              whisperModel: "whisper-1",
              llmModel: "gpt-4o-mini",
            }
          : {
              provider: "custom" as const,
              whisperApiKey: "",
              whisperEndpoint: LOCAL_STT_PRESET_ENDPOINT,
              whisperModel: LOCAL_STT_PRESET_MODEL,
              llmModel: settings.llmModel || "gpt-4o-mini",
            }),
      });
    };

    const handleTestConnection = async () => {
      setTestStatus("testing");
      setTestMessage(null);

      const testStt = isCustom || settings.provider === "openai";
      const testLlm = isCustom
        ? Boolean((settings.llmApiKey || "").trim()) && (settings.llmModel || "gpt-4o-mini") !== "none"
        : Boolean((settings.apiKey || "").trim());

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
            whisper_model: isCustom ? (settings.whisperModel || null) : (settings.whisperModel || "whisper-1"),
            llm_api_key: isCustom ? (settings.llmApiKey || null) : null,
            llm_endpoint: isCustom ? (settings.llmEndpoint || null) : null,
            llm_model: isCustom ? (settings.llmModel || null) : (settings.llmModel || "gpt-4o-mini"),
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

    const handleOpenLocalSttDocs = async () => {
      await openUrl(LOCAL_STT_HELP_URL);
    };

    const handleInstallLocalSttModel = async () => {
      setInstallStatus("installing");
      setInstallMessage(null);

      try {
        const result = await invoke<{ success: boolean; message: string }>("install_stt_model", {
          req: {
            api_key: settings.apiKey || "",
            whisper_api_key: settings.whisperApiKey || null,
            whisper_endpoint: localSttEndpoint || LOCAL_STT_PRESET_ENDPOINT,
            whisper_model: localSttTargetModel,
          },
        });

        setInstallStatus(result.success ? "success" : "error");
        setInstallMessage(result.message);
      } catch (err) {
        setInstallStatus("error");
        setInstallMessage(err instanceof Error ? err.message : String(err));
      }
    };

    const renderTestConnectionBlock = (description: string) => (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button
            onClick={handleTestConnection}
            disabled={testStatus === "testing"}
            style={{
              padding: "10px 20px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.12)",
              background: testStatus === "testing" ? "rgba(0,0,0,0.04)" : "rgba(0,0,0,0.02)",
              color: "var(--text-hi)",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "var(--font-main)",
              cursor: testStatus === "testing" ? "wait" : "pointer",
              transition: "all 0.15s ease",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {testStatus === "testing" ? (
              <>
                <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid rgba(0,0,0,0.15)", borderTopColor: "var(--text-hi)", borderRadius: 999, animation: "spin 0.8s linear infinite" }} />
                Проверяем...
              </>
            ) : (
              <>
                <Zap size={14} strokeWidth={2.2} />
                Тестировать соединение
              </>
            )}
          </button>
          {testStatus === "success" && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#16a34a", fontSize: 13, fontWeight: 600 }}>
              <Check size={16} strokeWidth={2.5} />
              Работает
            </div>
          )}
        </div>
        {testMessage && (
          <div style={{
            fontSize: 12,
            lineHeight: 1.6,
            padding: "10px 14px",
            borderRadius: 8,
            background: testStatus === "success" ? "rgba(22,163,74,0.06)" : "rgba(220,38,38,0.06)",
            color: testStatus === "success" ? "#16a34a" : "#dc2626",
            border: `1px solid ${testStatus === "success" ? "rgba(22,163,74,0.15)" : "rgba(220,38,38,0.15)"}`,
          }}>
            {testMessage}
          </div>
        )}
        <div style={{ fontSize: 12, color: "var(--text-low)", lineHeight: 1.6 }}>{description}</div>
      </div>
    );

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
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)", marginBottom: 4 }}>Локально</div>
                <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
                  Режим для локального OpenAI-compatible STT сервера. По умолчанию используется Speaches на localhost.
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <div className="label">Endpoint локального сервера</div>
                  <input
                    type="text"
                    value={settings.whisperEndpoint}
                    onChange={(e) => { update({ whisperEndpoint: e.target.value }); resetTestState(); resetInstallState(); }}
                    className="input"
                    placeholder={LOCAL_STT_PRESET_ENDPOINT}
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }}
                  />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <div className="label">Локальная модель</div>
                  <input
                    type="text"
                    value={settings.whisperModel}
                    onChange={(e) => { update({ whisperModel: e.target.value }); resetTestState(); resetInstallState(); }}
                    className="input"
                    placeholder={LOCAL_STT_PRESET_MODEL}
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }}
                  />
                </div>
              </div>

                <div style={{ borderRadius: 10, background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.06)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-hi)" }}>Подготовка</div>
                  <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.65 }}>1. Установите Docker Desktop и запустите Speaches.</div>
                  <div style={{ fontSize: 11, color: "var(--text-hi)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", lineHeight: 1.7, padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.72)", border: "1px solid rgba(0,0,0,0.06)", overflowX: "auto" }}>
                    docker compose -f compose.cpu.yaml up -d
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.65 }}>
                    2. Установите модель через Talkis или вручную:{" "}
                    <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", color: "var(--text-hi)" }}>
                      curl {(localSttEndpoint || LOCAL_STT_PRESET_ENDPOINT).replace(/\/$/, "")}/v1/models/{localSttTargetModel} -X POST
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <button
                      onClick={() => { void handleInstallLocalSttModel(); }}
                      disabled={isInstallLocalModelDisabled}
                      style={{
                        padding: "10px 14px",
                        borderRadius: 10,
                        border: "1px solid rgba(0,0,0,0.12)",
                        background: isInstallLocalModelDisabled ? "rgba(0,0,0,0.04)" : "#000",
                        color: isInstallLocalModelDisabled ? "var(--text-mid)" : "#fff",
                        fontSize: 12,
                        fontWeight: 700,
                        fontFamily: "var(--font-main)",
                        cursor: installStatus === "installing" ? "wait" : isInstallLocalModelDisabled ? "not-allowed" : "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      {installStatus === "installing" ? (
                        <>
                          <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid rgba(0,0,0,0.15)", borderTopColor: "var(--text-hi)", borderRadius: 999, animation: "spin 0.8s linear infinite" }} />
                          Устанавливаем...
                        </>
                      ) : (
                        <>
                          <Download size={14} strokeWidth={2.2} />
                          Установить модель
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => { void handleOpenLocalSttDocs(); }}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "var(--text-hi)",
                        padding: 0,
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: 600,
                        textDecoration: "underline",
                        textUnderlineOffset: 3,
                      }}
                    >
                      Документация Speaches
                    </button>
                  </div>
                  {installMessage && (
                    <div style={{
                      fontSize: 12,
                      lineHeight: 1.6,
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: installStatus === "success" ? "rgba(22,163,74,0.06)" : "rgba(220,38,38,0.06)",
                      color: installStatus === "success" ? "#16a34a" : "#dc2626",
                      border: `1px solid ${installStatus === "success" ? "rgba(22,163,74,0.15)" : "rgba(220,38,38,0.15)"}`,
                    }}>
                      {installMessage}
                    </div>
                  )}
                </div>

                <div style={{ height: 1, background: "rgba(0,0,0,0.06)" }} />

                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>Обработка текста (LLM)</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <div className="label">API-ключ LLM</div>
                    <input
                      type="password"
                      value={settings.llmApiKey || ""}
                      onChange={(e) => { update({ llmApiKey: e.target.value }); resetTestState(); }}
                      className="input"
                      placeholder="Оставьте пустым, чтобы отключить обработку"
                      style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }}
                    />
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.6 }}>
                    Обработку текста вы подключаете сами: например, Ollama, LM Studio или любой OpenAI-совместимый сервер на `localhost`.
                  </div>
                  {(settings.llmApiKey || "").trim() && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <div className="label">Endpoint LLM</div>
                        <input type="text" value={settings.llmEndpoint} onChange={(e) => { update({ llmEndpoint: e.target.value }); resetTestState(); }} className="input" placeholder="https://api.openai.com" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }} />
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <div className="label">LLM модель</div>
                        <input type="text" value={settings.llmModel} onChange={(e) => { update({ llmModel: e.target.value }); resetTestState(); }} className="input" placeholder="gpt-4o-mini" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }} />
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ fontSize: 12, color: "var(--text-low)", lineHeight: 1.6 }}>
                  {(settings.llmApiKey || "").trim()
                    ? "Endpoint'ы должны быть совместимы с форматом OpenAI API. Пустое поле — OpenAI по умолчанию."
                    : "Обработка текста отключена. Текст вставляется сразу после транскрипции."
                  }
                </div>
                <div style={{ height: 1, background: "rgba(0,0,0,0.06)" }} />
                {renderTestConnectionBlock("Проверяем локальный STT endpoint и, если включена обработка текста, отдельно LLM endpoint.")}
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
