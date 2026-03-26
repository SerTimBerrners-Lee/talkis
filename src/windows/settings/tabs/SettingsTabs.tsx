import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

import { AppSettings, getSettings, saveSettings } from "../../../lib/store";
import { Check, Briefcase, Code, MessageSquare, Key, Crown, LucideIcon } from "lucide-react";

import { TRANSCRIPTION_STYLE_OPTIONS } from "../../../lib/transcriptionPrompts";

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

  useEffect(() => { getSettings().then(setSettings); }, []);

  useEffect(() => {
    if (!settings || type !== "style") return;

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
    saveSettings(s);
  };

  if (type === "model") {
    const hasKey = settings.apiKey.trim().length > 0;
    const isActive = hasKey;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, color: "var(--text-hi)" }}>
              {isActive ? "Подключено" : "Не подключено"}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
              {isActive ? "OpenAI API ключ уже сохранен." : "Подключение не настроено."}
            </div>
          </div>
          <div style={{ width: 12, height: 12, borderRadius: 999, background: isActive ? "#000" : "rgba(0,0,0,0.16)" }} />
        </div>

        <OptionCard
          disabled
          icon={<Crown size={20} strokeWidth={1.8} />}
          title="Подписка Talk Flow"
          description="Скоро. Сейчас приложение работает только с вашим OpenAI API-ключом."
          badge="Soon"
        />

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.08)" }} />
          <span className="label">или</span>
          <div style={{ flex: 1, height: 1, background: "rgba(0,0,0,0.08)" }} />
        </div>

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
              Ключ используется для Whisper (распознавание) и GPT-4o mini (обработка) и не отправляется на сервер Talk Flow.
            </div>
          </div>
        )}

        <div className="card" style={{ padding: 18, background: "rgba(255,255,255,0.58)" }}>
          <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.65 }}>
            {settings.useOwnKey ? (
              <>
                Ключ можно получить на <span style={{ color: "var(--text-hi)", fontWeight: 600 }}>platform.openai.com</span> в разделе API Keys.
              </>
            ) : (
              <>Подписка Talk Flow пока недоступна. Для работы приложения используйте свой OpenAI API-ключ.</>
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
    </div>
  );
}
