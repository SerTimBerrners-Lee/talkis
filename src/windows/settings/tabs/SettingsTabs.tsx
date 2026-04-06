import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

import { AppSettings, ApiProvider, getSettings, saveSettings } from "../../../lib/store";
import { Check, Briefcase, Code, MessageSquare, Crown, Zap, ChevronDown, FileText, LucideIcon } from "lucide-react";
import { CloudProfile, fetchCloudProfile, getAuthLoginUrl } from "../../../lib/cloudAuth";

import { TRANSCRIPTION_STYLE_OPTIONS } from "../../../lib/transcriptionPrompts";
import { SETTINGS_UPDATED_EVENT } from "../../../lib/hotkeyEvents";

const IS_DEV = import.meta.env.DEV;

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

export function SettingsTabs({ type }: SettingsTabsProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [promptPreview, setPromptPreview] = useState<PromptPreview | null>(null);
  const [promptPreviewError, setPromptPreviewError] = useState<string | null>(null);
  const [cloudProfile, setCloudProfile] = useState<CloudProfile | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [sttDropdownOpen, setSttDropdownOpen] = useState(false);
  const [llmDropdownOpen, setLlmDropdownOpen] = useState(false);
  const sttDropdownRef = useRef<HTMLDivElement>(null);
  const llmDropdownRef = useRef<HTMLDivElement>(null);

  // Close model dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sttDropdownRef.current && !sttDropdownRef.current.contains(e.target as Node)) setSttDropdownOpen(false);
      if (llmDropdownRef.current && !llmDropdownRef.current.contains(e.target as Node)) setLlmDropdownOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => { getSettings().then(setSettings); }, []);

  // Cloud profile — always fetch (regardless of tab) so hooks are stable
  useEffect(() => {
    fetchCloudProfile().then(setCloudProfile).catch(() => {});
  }, []);

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
    const s = { ...settings, ...patch };
    setSettings(s);
    saveSettings(s).then(() => {
      emit(SETTINGS_UPDATED_EVENT).catch(() => {});
    });
  };

  if (type === "model") {
    const hasActiveSubscription = cloudProfile?.subscription.active === true;
    const isCustom = settings.provider === "custom";

    const handleActivateSubscription = async () => {
      try {
        await openUrl(getAuthLoginUrl());
      } catch {
        // Error handled silently
      }
    };

    const handleProviderChange = (provider: ApiProvider) => {
      setTestStatus("idle");
      setTestMessage(null);
      if (provider === "openai") {
        update({
          provider: "openai",
          whisperEndpoint: "",
          llmEndpoint: "",
          whisperModel: "whisper-1",
          llmModel: "gpt-4o-mini",
        });
      } else {
        update({ provider: "custom" });
      }
    };

    const handleTestConnection = async () => {
      setTestStatus("testing");
      setTestMessage(null);
      try {
        const result = await invoke<{ success: boolean; message: string; latency_ms: number }>("test_api_connection", {
          req: {
            api_key: settings.apiKey,
            llm_endpoint: isCustom ? (settings.llmEndpoint || null) : null,
            llm_model: isCustom ? (settings.llmModel || null) : null,
          },
        });
        setTestStatus(result.success ? "success" : "error");
        setTestMessage(result.message);
      } catch (err) {
        setTestStatus("error");
        setTestMessage(err instanceof Error ? err.message : String(err));
      }
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
        ) : (
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
            <button onClick={handleActivateSubscription} style={{ width: "100%", padding: "12px", borderRadius: 10, background: "#fff", color: "#000", border: "none", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer", transition: "opacity 0.15s", fontFamily: "var(--font-main)" }}>
              Активировать
            </button>
          </div>
        )}

        {/* ── Separator ── */}
        {!hasActiveSubscription && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.08)" }} />
            <span className="label">или</span>
            <div style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.08)" }} />
          </div>
        )}

        {/* ── Provider toggle ── */}
        {!hasActiveSubscription && (
          <>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-hi)", marginBottom: 4 }}>Свой API ключ</div>
              <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6, marginBottom: 14 }}>
                Используйте OpenAI напрямую или подключите любой совместимый сервер.
              </div>

              {/* segmented control */}
              <div style={{ display: "flex", background: "rgba(0,0,0,0.05)", borderRadius: 10, padding: 3, gap: 2 }}>
                {(["openai", "custom"] as const).map((p) => {
                  const active = settings.useOwnKey && settings.provider === p;
                  return (
                    <button
                      key={p}
                      onClick={() => { update({ useOwnKey: true }); handleProviderChange(p); }}
                      style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", fontSize: 13, fontWeight: active ? 700 : 500, fontFamily: "var(--font-main)", background: active ? "#000" : "transparent", color: active ? "#fff" : "var(--text-mid)", cursor: "pointer", transition: "all 0.18s ease" }}
                    >
                      {p === "openai" ? "OpenAI ключ" : "Своя конфигурация"}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── API Key input (OpenAI mode: one key, Custom mode: LLM key) ── */}
            {settings.useOwnKey && (
              <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>
                  {isCustom ? "API ключ" : "OpenAI API ключ"}
                </div>
                <input
                  type="password"
                  value={settings.apiKey}
                  onChange={(e) => { update({ apiKey: e.target.value }); setTestStatus("idle"); setTestMessage(null); }}
                  className="input"
                  placeholder={keyPlaceholder}
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}
                />
                {!isCustom && (
                  <div style={{ fontSize: 12, color: "var(--text-low)", lineHeight: 1.6 }}>
                    Получить ключ на{" "}
                    <span style={{ color: "var(--text-hi)", fontWeight: 600 }}>platform.openai.com</span>
                  </div>
                )}
                {isCustom && (
                  <div style={{ fontSize: 12, color: "var(--text-low)", lineHeight: 1.6 }}>
                    Основной ключ — используется для всех запросов.
                  </div>
                )}
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
                              onClick={() => { update({ whisperModel: opt.value }); setSttDropdownOpen(false); }}
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
                          {settings.llmModel || "gpt-4o-mini"}
                        </span>
                        <ChevronDown size={13} strokeWidth={2} style={{ flexShrink: 0, transform: llmDropdownOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
                      </button>
                      {llmDropdownOpen && (
                        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, background: "rgba(255,255,255,0.98)", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 16, boxShadow: "var(--shadow-panel)", zIndex: 100, overflow: "hidden" }}>
                          {[
                            { value: "gpt-4o-mini", label: "gpt-4o-mini", desc: "Баланс цена/качество" },
                            { value: "gpt-4o", label: "gpt-4o", desc: "Лучшее качество" },
                            { value: "gpt-4.1-mini", label: "gpt-4.1-mini", desc: "Новая, быстрая" },
                            { value: "gpt-4.1-nano", label: "gpt-4.1-nano", desc: "Самая дешёвая" },
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
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>Транскрипция (STT)</div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div className="label">Endpoint</div>
                      <input type="text" value={settings.whisperEndpoint} onChange={(e) => update({ whisperEndpoint: e.target.value })} className="input" placeholder="https://api.openai.com" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div className="label">Модель</div>
                      <input type="text" value={settings.whisperModel} onChange={(e) => update({ whisperModel: e.target.value })} className="input" placeholder="whisper-1" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }} />
                    </div>
                  </div>
                </div>

                <div style={{ height: 1, background: "rgba(0,0,0,0.06)" }} />

                {/* ── LLM section ── */}
                {settings.style !== "none" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>Обработка текста (LLM)</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <div className="label">Endpoint</div>
                        <input type="text" value={settings.llmEndpoint} onChange={(e) => update({ llmEndpoint: e.target.value })} className="input" placeholder="https://api.openai.com" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }} />
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <div className="label">Модель</div>
                        <input type="text" value={settings.llmModel} onChange={(e) => update({ llmModel: e.target.value })} className="input" placeholder="gpt-4o-mini" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 11 }} />
                      </div>
                    </div>
                  </div>
                )}

                <div style={{ fontSize: 12, color: "var(--text-low)", lineHeight: 1.6 }}>
                  {settings.style === "none"
                    ? "LLM-обработка отключена. Текст вставляется сразу после транскрипции."
                    : "Оба endpoint'а должны быть совместимы с форматом OpenAI API. Пустое поле — OpenAI по умолчанию."
                  }
                </div>
              </div>
            )}

            {/* ── Test connection ── */}
            {settings.useOwnKey && settings.apiKey && (
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
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const STYLE_ICONS: Record<AppSettings["style"], LucideIcon> = {
    classic: MessageSquare,
    business: Briefcase,
    tech: Code,
    none: FileText,
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
