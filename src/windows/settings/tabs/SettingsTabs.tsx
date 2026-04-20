import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";

import { AppSettings, ApiProvider, getSettings, saveSettings } from "../../../lib/store";
import { Check, Briefcase, Code, MessageSquare, Crown, Zap, ChevronDown, LucideIcon, LogOut, User } from "lucide-react";
import { CloudProfile, fetchCloudProfile, getAuthLoginUrl, cloudLogout, handleAuthToken, generateExchangeCode, getAuthLoginUrlWithCode, pollForToken, getCachedCloudProfile, subscribeCloudProfile } from "../../../lib/cloudAuth";
import { logInfo } from "../../../lib/logger";

import { TRANSCRIPTION_STYLE_OPTIONS } from "../../../lib/transcriptionPrompts";
import { SETTINGS_UPDATED_EVENT } from "../../../lib/hotkeyEvents";

const IS_DEV = import.meta.env.DEV;
const LOCAL_STT_PRESET_ENDPOINT = "http://127.0.0.1:8000";
const LOCAL_STT_PRESET_MODEL = "whisper-1";
const LOCAL_STT_HELP_URL = "https://speaches.ai/installation/";

function isLikelyLocalEndpoint(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("http://127.0.0.1") ||
    normalized.startsWith("http://localhost") ||
    normalized.startsWith("https://127.0.0.1") ||
    normalized.startsWith("https://localhost")
  );
}

function inferSttAccessMode(settings: AppSettings | null | undefined): "api" | "local" {
  if (!settings) {
    return "api";
  }

  if (isLikelyLocalEndpoint(settings.whisperEndpoint || "")) {
    return "local";
  }

  return "api";
}

interface SettingsTabsProps { type: "model" | "style"; }

interface PromptPreview {
  prompt: string;
  layers: string[];
  profileKey: string;
  version: number;
}

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
        borderRadius: 12,
        background: active ? "#000" : "rgba(255,255,255,0.72)",
        border: `1px solid ${active ? "#000" : "rgba(0,0,0,0.08)"}`,
        color: active ? "#fff" : "var(--text-hi)",
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
            background: active ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.05)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: active ? "#fff" : "var(--text-mid)",
            flexShrink: 0,
          }}
        >
          {icon}
        </div>

        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: active ? "#fff" : "var(--text-hi)" }}>{title}</div>
            {badge && <div className="label" style={{ color: active ? "rgba(255,255,255,0.6)" : "var(--text-low)" }}>{badge}</div>}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.65, color: active ? "rgba(255,255,255,0.8)" : "var(--text-mid)" }}>{description}</div>
        </div>
      </div>

      {active && (
        <div style={{ position: "absolute", top: 16, right: 16, color: "#fff" }}>
          <Check size={18} strokeWidth={3} />
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
  const [sttAccessMode, setSttAccessMode] = useState<"api" | "local">("api");
  const [waitingForAuth, setWaitingForAuth] = useState(false);
  const [waitingForSubscriptionRefresh, setWaitingForSubscriptionRefresh] = useState(false);
  const [sttDropdownOpen, setSttDropdownOpen] = useState(false);
  const [llmDropdownOpen, setLlmDropdownOpen] = useState(false);
  const sttDropdownRef = useRef<HTMLDivElement>(null);
  const llmDropdownRef = useRef<HTMLDivElement>(null);
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

  // Close model dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sttDropdownRef.current && !sttDropdownRef.current.contains(e.target as Node)) setSttDropdownOpen(false);
      if (llmDropdownRef.current && !llmDropdownRef.current.contains(e.target as Node)) setLlmDropdownOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => { void syncSettings(); }, [syncSettings]);

  useEffect(() => {
    if (!settings) {
      return;
    }

    if (settings.provider !== "custom") {
      setSttAccessMode("api");
      return;
    }

    setSttAccessMode((current) => {
      if (current === "local" && isLikelyLocalEndpoint(settings.whisperEndpoint || "")) {
        return current;
      }

      return inferSttAccessMode(settings);
    });
  }, [settings]);

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
    const isLocalSttMode = isCustom && sttAccessMode === "local";
    const localSttTargetModel = (settings.whisperModel || LOCAL_STT_PRESET_MODEL).trim() || LOCAL_STT_PRESET_MODEL;
    const modeOptions = ["cloud", "openai", "custom"] as const;

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

    const getProviderPatch = (provider: ApiProvider): Partial<AppSettings> => {
      if (provider === "openai") {
        return {
          provider: "openai",
          whisperEndpoint: "",
          llmEndpoint: "",
          whisperModel: "whisper-1",
          llmModel: "gpt-4o-mini",
        };
      }

      return { provider: "custom" };
    };

    const handleModeChange = (mode: typeof modeOptions[number]) => {
      setTestStatus("idle");
      setTestMessage(null);

      if (mode === "cloud") {
        update({ useOwnKey: false });
        return;
      }

      update({
        useOwnKey: true,
        ...getProviderPatch(mode),
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
            whisper_model: isCustom ? (settings.whisperModel || null) : "whisper-1",
            llm_api_key: isCustom ? (settings.llmApiKey || null) : null,
            llm_endpoint: isCustom ? (settings.llmEndpoint || null) : null,
            llm_model: isCustom ? (settings.llmModel || null) : "gpt-4o-mini",
            test_stt: testStt,
            test_llm: testLlm,
          },
        });
        setTestStatus(result.success ? "success" : "error");
        setTestMessage(result.message);
      } catch (err) {
        setTestStatus("error");
        setTestMessage(err instanceof Error ? err.message : String(err));
      }
    };

    const handleSttAccessModeChange = (mode: "api" | "local") => {
      setTestStatus("idle");
      setTestMessage(null);
      setSttAccessMode(mode);

      if (mode === "local") {
        update({
          whisperApiKey: "",
          whisperEndpoint: isLikelyLocalEndpoint(settings.whisperEndpoint || "")
            ? settings.whisperEndpoint
            : LOCAL_STT_PRESET_ENDPOINT,
          whisperModel: settings.whisperModel || LOCAL_STT_PRESET_MODEL,
        });
        return;
      }

      update({
        whisperEndpoint: isLikelyLocalEndpoint(settings.whisperEndpoint || "")
          ? ""
          : settings.whisperEndpoint,
        whisperModel: settings.whisperModel || "whisper-1",
      });
    };

    const handleOpenLocalSttDocs = async () => {
      await openUrl(LOCAL_STT_HELP_URL);
    };

    const keyPlaceholder = isCustom ? "API ключ или токен..." : "sk-...";

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

        {/* ── Provider toggle ── */}
        <>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-hi)", marginBottom: 4 }}>
              Режим распознавания
            </div>
            <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6, marginBottom: 14 }}>
              Вы можете в любой момент переключаться между Talkis Cloud, OpenAI и своей конфигурацией.
            </div>

            {/* segmented control */}
            <div style={{ display: "flex", background: "rgba(0,0,0,0.05)", borderRadius: 10, padding: 3, gap: 2 }}>
              {modeOptions.map((mode) => {
                const active = mode === "cloud"
                  ? isCloudMode
                  : settings.useOwnKey && settings.provider === mode;
                const label = mode === "cloud"
                  ? "Talkis Cloud"
                  : mode === "openai"
                    ? "OpenAI ключ"
                    : "Своя конфигурация";

                return (
                  <button
                    key={mode}
                    onClick={() => handleModeChange(mode)}
                    style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", fontSize: 13, fontWeight: active ? 700 : 500, fontFamily: "var(--font-main)", background: active ? "#000" : "transparent", color: active ? "#fff" : "var(--text-mid)", cursor: "pointer", transition: "all 0.18s ease" }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {hasActiveSubscription && !settings.useOwnKey && (
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>Talkis Cloud</div>
              <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
                Запросы на распознавание и обработку текста идут через облако Talkis. Все данные шифруются при передаче, а аудио и текст не сохраняются на сервере после обработки.
              </div>
            </div>
          )}

          {isCloudMode && !hasActiveSubscription && (
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>Talkis Cloud</div>
              <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
                Для облачного режима нужна авторизация и активная подписка. После входа плашка и статус подписки обновятся автоматически.
              </div>
            </div>
          )}

            {/* ── API Key input (OpenAI mode only) ── */}
          {settings.useOwnKey && !isCustom && (
              <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>OpenAI API ключ</div>
                <input
                  type="password"
                  value={settings.apiKey}
                  onChange={(e) => { update({ apiKey: e.target.value }); setTestStatus("idle"); setTestMessage(null); }}
                  className="input"
                  placeholder={keyPlaceholder}
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}
                />
                <div style={{ fontSize: 12, color: "var(--text-low)", lineHeight: 1.6 }}>
                  Получить ключ на{" "}
                  <span style={{ color: "var(--text-hi)", fontWeight: 600 }}>platform.openai.com</span>
                </div>
              </div>
            )}

            {/* ── OpenAI mode: model selectors ── */}
          {settings.useOwnKey && !isCustom && (
              <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14, position: "relative", zIndex: (sttDropdownOpen || llmDropdownOpen) ? 20 : 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>Модели</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {/* STT model dropdown */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div className="label">Транскрипция</div>
                    <div ref={sttDropdownRef} style={{ position: "relative" }}>
                      <button
                        onClick={() => { setSttDropdownOpen(o => !o); setLlmDropdownOpen(false); }}
                        className="btn"
                        style={{ width: "100%", justifyContent: "space-between", gap: 8, minHeight: 40 }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                          {settings.whisperModel || "whisper-1"}
                        </span>
                        <ChevronDown size={13} strokeWidth={2} style={{ flexShrink: 0, transform: sttDropdownOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
                      </button>
                      {sttDropdownOpen && (
                        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, background: "rgba(255,255,255,0.98)", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 16, boxShadow: "var(--shadow-panel)", zIndex: 100, overflow: "hidden" }}>
                          {[
                            { value: "whisper-1", label: "whisper-1", desc: "Классическая" },
                            { value: "gpt-4o-mini-transcribe", label: "gpt-4o-mini-transcribe", desc: "Быстрая, дешевле" },
                            { value: "gpt-4o-transcribe", label: "gpt-4o-transcribe", desc: "Лучшее качество" },
                          ].map(opt => (
                            <button
                              key={opt.value}
                              onClick={() => {
                                const patch: Partial<AppSettings> = { whisperModel: opt.value };
                                // Auto-set LLM to the same transcribe model for style processing
                                if (opt.value.includes("transcribe")) {
                                  patch.llmModel = opt.value;
                                }
                                update(patch);
                                setSttDropdownOpen(false);
                              }}
                              style={{
                                width: "100%", textAlign: "left", border: "none", cursor: "pointer",
                                padding: "10px 14px", display: "flex", alignItems: "center", gap: 8,
                                background: (settings.whisperModel || "whisper-1") === opt.value ? "rgba(0,0,0,0.04)" : "transparent",
                                color: (settings.whisperModel || "whisper-1") === opt.value ? "var(--text-hi)" : "var(--text-mid)",
                                fontSize: 12, transition: "background 0.1s",
                              }}
                              onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.03)"}
                              onMouseLeave={e => e.currentTarget.style.background = (settings.whisperModel || "whisper-1") === opt.value ? "rgba(0,0,0,0.04)" : "transparent"}
                            >
                              <span style={{ flex: 1, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{opt.label}</span>
                              <span style={{ fontSize: 10, color: "var(--text-low)" }}>{opt.desc}</span>
                              {(settings.whisperModel || "whisper-1") === opt.value && <Check size={12} strokeWidth={2.5} style={{ color: "var(--text-hi)", flexShrink: 0 }} />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* LLM model dropdown */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div className="label">Обработка текста</div>
                    <div ref={llmDropdownRef} style={{ position: "relative" }}>
                      <button
                        onClick={() => { setLlmDropdownOpen(o => !o); setSttDropdownOpen(false); }}
                        className="btn"
                        style={{ width: "100%", justifyContent: "space-between", gap: 8, minHeight: 40 }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                          {(settings.llmModel || "gpt-4o-mini") === "none" ? "Без обработки" : (settings.llmModel || "gpt-4o-mini")}
                        </span>
                        <ChevronDown size={13} strokeWidth={2} style={{ flexShrink: 0, transform: llmDropdownOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
                      </button>
                      {llmDropdownOpen && (
                        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, background: "rgba(255,255,255,0.98)", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 16, boxShadow: "var(--shadow-panel)", zIndex: 100, overflow: "hidden" }}>
                          {[
                            ...((settings.whisperModel || "").includes("transcribe") ? [
                              { value: settings.whisperModel!, label: settings.whisperModel!, desc: "Та же модель" },
                            ] : []),
                            { value: "gpt-4o-mini", label: "gpt-4o-mini", desc: "Баланс цена/качество" },
                            { value: "gpt-4o", label: "gpt-4o", desc: "Лучшее качество" },
                            { value: "gpt-4.1-mini", label: "gpt-4.1-mini", desc: "Новая, быстрая" },
                            { value: "gpt-4.1-nano", label: "gpt-4.1-nano", desc: "Самая дешёвая" },
                            { value: "none", label: "Без обработки", desc: "Сырой текст" },
                          ].map(opt => (
                            <button
                              key={opt.value}
                              onClick={() => { update({ llmModel: opt.value }); setLlmDropdownOpen(false); }}
                              style={{
                                width: "100%", textAlign: "left", border: "none", cursor: "pointer",
                                padding: "10px 14px", display: "flex", alignItems: "center", gap: 8,
                                background: (settings.llmModel || "gpt-4o-mini") === opt.value ? "rgba(0,0,0,0.04)" : "transparent",
                                color: (settings.llmModel || "gpt-4o-mini") === opt.value ? "var(--text-hi)" : "var(--text-mid)",
                                fontSize: 12, transition: "background 0.1s",
                              }}
                              onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.03)"}
                              onMouseLeave={e => e.currentTarget.style.background = (settings.llmModel || "gpt-4o-mini") === opt.value ? "rgba(0,0,0,0.04)" : "transparent"}
                            >
                              <span style={{ flex: 1, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{opt.label}</span>
                              <span style={{ fontSize: 10, color: "var(--text-low)" }}>{opt.desc}</span>
                              {(settings.llmModel || "gpt-4o-mini") === opt.value && <Check size={12} strokeWidth={2.5} style={{ color: "var(--text-hi)", flexShrink: 0 }} />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-low)", lineHeight: 1.6 }}>
                  Транскрипция — преобразование голоса в текст. Обработка — очистка и форматирование по стилю.
                </div>
              </div>
            )}

            {/* ── Custom provider: STT + LLM configuration ── */}
          {settings.useOwnKey && isCustom && (
              <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>Настройка провайдера</div>

                {/* ── STT section ── */}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>Транскрипция (STT)</div>
                  <div style={{ display: "flex", background: "rgba(0,0,0,0.05)", borderRadius: 10, padding: 3, gap: 2 }}>
                    {([
                      { id: "api", label: "Через API-ключ" },
                       { id: "local", label: "Через локальную модель" },
                    ] as const).map((option) => {
                      const active = sttAccessMode === option.id;
                      return (
                        <button
                          key={option.id}
                          onClick={() => handleSttAccessModeChange(option.id)}
                          style={{
                            flex: 1,
                            padding: "10px 0",
                            borderRadius: 8,
                            border: "none",
                            fontSize: 12,
                            fontWeight: active ? 700 : 500,
                            fontFamily: "var(--font-main)",
                            background: active ? "#000" : "transparent",
                            color: active ? "#fff" : "var(--text-mid)",
                            cursor: "pointer",
                            transition: "all 0.18s ease",
                          }}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>

                  {sttAccessMode === "api" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div className="label">API ключ</div>
                        <input
                          type="password"
                          value={settings.whisperApiKey}
                          onChange={(e) => { update({ whisperApiKey: e.target.value }); setTestStatus("idle"); setTestMessage(null); }}
                          className="input"
                          placeholder="sk-..."
                          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }}
                      />
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.6 }}>
                      Для локального сервера API-ключ не нужен. Укажите endpoint и модель ниже, затем запустите распознавание через ваш `localhost`.
                    </div>
                  )}

                  {sttAccessMode === "local" && (
                    <details style={{ borderRadius: 12, background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.06)", overflow: "hidden" }}>
                      <summary style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "12px 14px", cursor: "pointer", listStyle: "none",
                        fontSize: 13, fontWeight: 700, color: "var(--text-hi)",
                        userSelect: "none",
                      }}>
                        <span>Как запустить локальную модель</span>
                        <ChevronDown size={14} strokeWidth={2.2} style={{ flexShrink: 0, transition: "transform 0.2s" }} />
                      </summary>
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "0 14px 14px" }}>
                        <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.65 }}>1. Установите Docker Desktop.</div>
                        <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.65 }}>2. Скачайте конфигурацию Speaches:</div>
                        <div style={{ fontSize: 11, color: "var(--text-hi)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", lineHeight: 1.7, padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.72)", border: "1px solid rgba(0,0,0,0.06)" }}>
                          curl -O https://raw.githubusercontent.com/speaches-ai/speaches/master/compose.yaml<br />
                          curl -O https://raw.githubusercontent.com/speaches-ai/speaches/master/compose.cpu.yaml
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.65 }}>3. Запустите локальный сервер:</div>
                        <div style={{ fontSize: 11, color: "var(--text-hi)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", lineHeight: 1.7, padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.72)", border: "1px solid rgba(0,0,0,0.06)" }}>
                          docker compose -f compose.cpu.yaml up -d
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.65 }}>4. Установите модель:</div>
                        <div style={{ fontSize: 11, color: "var(--text-hi)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", lineHeight: 1.7, padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.72)", border: "1px solid rgba(0,0,0,0.06)" }}>
                          curl {LOCAL_STT_PRESET_ENDPOINT}/v1/models/{localSttTargetModel} -X POST
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.65 }}>5. Вернитесь сюда и нажмите «Тестировать соединение».</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
                          <button
                            onClick={() => { void handleOpenLocalSttDocs(); }}
                            style={{
                              border: "none", background: "transparent",
                              color: "var(--text-hi)", padding: 0, cursor: "pointer",
                              fontSize: 12, fontWeight: 600,
                              textDecoration: "underline", textUnderlineOffset: 3,
                            }}
                          >
                            Документация Speaches
                          </button>
                          <span style={{ color: "var(--text-low)", fontSize: 11 }}>·</span>
                          <button
                            onClick={() => { void openUrl("https://github.com/SerTimBerrners-Lee/talkis"); }}
                            style={{
                              border: "none", background: "transparent",
                              color: "var(--text-hi)", padding: 0, cursor: "pointer",
                              fontSize: 12, fontWeight: 600,
                              textDecoration: "underline", textUnderlineOffset: 3,
                            }}
                          >
                            README на GitHub
                          </button>
                        </div>
                      </div>
                    </details>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div className="label">Endpoint</div>
                      <input type="text" value={settings.whisperEndpoint} onChange={(e) => { update({ whisperEndpoint: e.target.value }); setTestStatus("idle"); setTestMessage(null); }} className="input" placeholder={sttAccessMode === "local" ? LOCAL_STT_PRESET_ENDPOINT : "https://api.openai.com"} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div className="label">Модель</div>
                      <input type="text" value={settings.whisperModel} onChange={(e) => { update({ whisperModel: e.target.value }); setTestStatus("idle"); setTestMessage(null); }} className="input" placeholder={sttAccessMode === "local" ? LOCAL_STT_PRESET_MODEL : "whisper-1"} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }} />
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-low)", lineHeight: 1.6 }}>
                    {sttAccessMode === "local"
                      ? "Используйте этот режим, если вы подняли локальный сервер распознавания речи и хотите работать через него без облака и без внешнего API-ключа."
                      : "Используйте этот режим, если ваш сервер транскрибации требует авторизацию через API-ключ или токен."}
                  </div>
                </div>

                <div style={{ height: 1, background: "rgba(0,0,0,0.06)" }} />

                {/* ── LLM section ── */}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>Обработка текста (LLM)</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <div className="label">API ключ</div>
                    <input
                      type="password"
                      value={settings.llmApiKey || ""}
                      onChange={(e) => { update({ llmApiKey: e.target.value }); setTestStatus("idle"); setTestMessage(null); }}
                      className="input"
                      placeholder="Оставьте пустым, чтобы отключить обработку"
                      style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }}
                    />
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.6 }}>
                    Обработку текста вы подключаете сами: например, Ollama, LM Studio или любой OpenAI-совместимый сервер на `localhost`.
                  </div>
                  {(settings.llmApiKey || "").trim() && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <div className="label">Endpoint</div>
                        <input type="text" value={settings.llmEndpoint} onChange={(e) => { update({ llmEndpoint: e.target.value }); setTestStatus("idle"); setTestMessage(null); }} className="input" placeholder="https://api.openai.com" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }} />
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <div className="label">Модель</div>
                        <input type="text" value={settings.llmModel} onChange={(e) => { update({ llmModel: e.target.value }); setTestStatus("idle"); setTestMessage(null); }} className="input" placeholder="gpt-4o-mini" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }} />
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
              </div>
            )}

            {/* ── Test connection ── */}
          {settings.useOwnKey && (
              <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button
                    onClick={handleTestConnection}
                    disabled={testStatus === "testing"}
                    style={{ padding: "10px 20px", borderRadius: 10, border: "1px solid rgba(0,0,0,0.12)", background: testStatus === "testing" ? "rgba(0,0,0,0.04)" : "rgba(0,0,0,0.02)", color: "var(--text-hi)", fontSize: 13, fontWeight: 600, fontFamily: "var(--font-main)", cursor: testStatus === "testing" ? "wait" : "pointer", transition: "all 0.15s ease", display: "flex", alignItems: "center", gap: 8 }}
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
                    fontSize: 12, lineHeight: 1.6, padding: "10px 14px", borderRadius: 8,
                    background: testStatus === "success" ? "rgba(22,163,74,0.06)" : "rgba(220,38,38,0.06)",
                    color: testStatus === "success" ? "#16a34a" : "#dc2626",
                    border: `1px solid ${testStatus === "success" ? "rgba(22,163,74,0.15)" : "rgba(220,38,38,0.15)"}`,
                  }}>
                    {testMessage}
                  </div>
                )}
                <div style={{ fontSize: 12, color: "var(--text-low)", lineHeight: 1.6 }}>
                  {isLocalSttMode
                    ? "Проверяем локальный STT endpoint и, если включена обработка текста, отдельно LLM endpoint."
                    : isCustom
                      ? "Проверяем текущую кастомную конфигурацию STT и LLM по указанным endpoint'ам."
                      : "Проверяем доступ к OpenAI по вашему API-ключу."}
                </div>
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
