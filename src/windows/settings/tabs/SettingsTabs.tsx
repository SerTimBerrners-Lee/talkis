import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

import { AppSettings, getSettings, saveSettings } from "../../../lib/store";
import { Check, Briefcase, Code, MessageSquare, Key, Crown, LucideIcon } from "lucide-react";
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

    const handleActivateSubscription = async () => {
      try {
        await openUrl(getAuthLoginUrl());
      } catch {
        // Error handled silently
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

            <button
              onClick={handleActivateSubscription}
              style={{
                width: "100%",
                padding: "12px",
                borderRadius: 10,
                background: "#fff",
                color: "#000",
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

        {/* ── Own API key option ── */}
        {!hasActiveSubscription && (
          <>
            <OptionCard
              active={settings.useOwnKey}
              icon={<Key size={20} strokeWidth={settings.useOwnKey ? 2.4 : 1.8} />}
              title="Свои API ключи"
              description="Подключите свой OpenAI API ключ для распознавания и обработки текста."
              onClick={() => !settings.useOwnKey && update({ useOwnKey: true })}
            />

            {settings.useOwnKey && (
              <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-hi)" }}>OpenAI API ключ</div>
                </div>
                <div style={{ position: "relative" }}>
                  <input
                    type="password"
                    value={settings.apiKey}
                    onChange={(e) => update({ apiKey: e.target.value })}
                    className="input"
                    placeholder="sk-..."
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}
                  />
                </div>
                <div style={{ fontSize: 12, color: "var(--text-low)", lineHeight: 1.6 }}>
                  Ключ используется для Whisper (распознавание) и GPT-4o mini (обработка) и не отправляется на сервер Talkis.
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Footer hint ── */}
        <div className="card" style={{ padding: 18, background: "rgba(255,255,255,0.58)" }}>
          <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.65 }}>
            {hasActiveSubscription ? (
              <>Все запросы обрабатываются через серверы Talkis без ограничений.</>
            ) : settings.useOwnKey ? (
              <>
                Ключ можно получить на <span style={{ color: "var(--text-hi)", fontWeight: 600 }}>platform.openai.com</span> в разделе API Keys.
              </>
            ) : (
              <>Активируйте подписку или подключите свой OpenAI API-ключ для работы приложения.</>
            )}
          </div>
        </div>
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
