import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { Check, ChevronDown, Search } from "lucide-react";

import { getSettings, saveSettings, AppSettings, DEFAULT_HOTKEY, formatHotkeyLabel } from "../../../lib/store";
import {
  HOTKEY_CAPTURE_STATE_EVENT,
  HOTKEY_CHANGE_REQUEST_EVENT,
  HOTKEY_REGISTRATION_RESULT_EVENT,
  HotkeyRegistrationResultPayload,
  NATIVE_HOTKEY_CAPTURE_EVENT,
  NativeHotkeyCapturePayload,
  SETTINGS_UPDATED_EVENT,
} from "../../../lib/hotkeyEvents";
import { logError, logInfo } from "../../../lib/logger";
import { LANGUAGES } from "../../../config/languages";

type HotkeyFeedbackTone = "idle" | "success" | "error";

export function SettingsTab() {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // Language picker state
  const [langSearch, setLangSearch] = useState("");
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);

  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [micOpen, setMicOpen] = useState(false);
  const [micStatus, setMicStatus] = useState<MicAvailabilityState>("empty");
  const [micMessage, setMicMessage] = useState("Проверяем доступные микрофоны...");
  const micRef = useRef<HTMLDivElement>(null);

  const settingsRef = useRef<AppSettings | null>(null);
  const hotkeyButtonRef = useRef<HTMLDivElement>(null);
  const pendingHotkeyRef = useRef<string | null>(null);
  const hotkeyFeedbackResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isHotkeyCaptureActive, setIsHotkeyCaptureActive] = useState(false);
  const [isHotkeySubmitting, setIsHotkeySubmitting] = useState(false);
  const [hotkeyDraft, setHotkeyDraft] = useState<string | null>(null);
  const [hotkeyFeedback, setHotkeyFeedback] = useState("Нажмите на поле и введите новую комбинацию. Esc отменяет ввод.");
  const [hotkeyFeedbackTone, setHotkeyFeedbackTone] = useState<HotkeyFeedbackTone>("idle");
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartLoaded, setAutostartLoaded] = useState(false);
  const [autostartPending, setAutostartPending] = useState(false);

  type MicAvailabilityState = "ready" | "missing-selected" | "permission-needed" | "empty";

  const clearHotkeyFeedbackResetTimer = () => {
    if (!hotkeyFeedbackResetTimerRef.current) {
      return;
    }

    clearTimeout(hotkeyFeedbackResetTimerRef.current);
    hotkeyFeedbackResetTimerRef.current = null;
  };

  useEffect(() => {
    getSettings().then(s => {
      setSettings(s);
      settingsRef.current = s;
    });
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadAutostartState = async (): Promise<void> => {
      try {
        const enabled = await isAutostartEnabled();
        if (!mounted) return;
        setAutostartEnabled(enabled);
        setAutostartLoaded(true);
      } catch (error) {
        if (!mounted) return;
        setAutostartLoaded(true);
        void logError("SETTINGS", `Failed to load autostart state: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    void loadAutostartState();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const unlistenHotkeyResult = listen<HotkeyRegistrationResultPayload>(
      HOTKEY_REGISTRATION_RESULT_EVENT,
      async ({ payload }) => {
        if (!pendingHotkeyRef.current || payload.requestedHotkey !== pendingHotkeyRef.current) {
          return;
        }

        pendingHotkeyRef.current = null;
        setIsHotkeySubmitting(false);
        setHotkeyDraft(null);

        if (!payload.success) {
          setHotkeyFeedbackTone("error");
          setHotkeyFeedback(payload.message || "Не удалось применить новую комбинацию.");
          return;
        }

        const latestSettings = await getSettings();
        settingsRef.current = latestSettings;
        setSettings(latestSettings);
        setHotkeyFeedbackTone("success");
        setHotkeyFeedback("Новая горячая клавиша сохранена и уже работает.");
        clearHotkeyFeedbackResetTimer();
        hotkeyFeedbackResetTimerRef.current = setTimeout(() => {
          setHotkeyFeedbackTone("idle");
          setHotkeyFeedback("Нажмите на поле, чтобы изменить комбинацию снова.");
          hotkeyFeedbackResetTimerRef.current = null;
        }, 2200);
      },
    );

    const unlistenNativeHotkeyCapture = listen<NativeHotkeyCapturePayload>(
      NATIVE_HOTKEY_CAPTURE_EVENT,
      async ({ payload }) => {
        if (payload.status === "listening") {
          setIsHotkeyCaptureActive(true);
          setIsHotkeySubmitting(false);
          setHotkeyDraft(null);
          setHotkeyFeedbackTone("idle");
          setHotkeyFeedback(payload.message || "Нажмите новую комбинацию.");
          return;
        }

        if (payload.status === "preview") {
          setHotkeyDraft(payload.hotkey || null);
          setHotkeyFeedbackTone("idle");
          setHotkeyFeedback(payload.message || "Отпустите комбинацию, чтобы применить.");
          return;
        }

        if (payload.status === "cancelled") {
          await invoke("stop_native_hotkey_capture").catch(() => null);
          await emit(HOTKEY_CAPTURE_STATE_EVENT, { active: false }).catch(() => null);
          setIsHotkeyCaptureActive(false);
          setHotkeyDraft(null);
          setHotkeyFeedbackTone("idle");
          setHotkeyFeedback(payload.message || "Ввод отменен.");
          return;
        }

        if (payload.status !== "completed") {
          return;
        }

        const candidate = payload.hotkey?.trim();
        await invoke("stop_native_hotkey_capture").catch(() => null);
        await emit(HOTKEY_CAPTURE_STATE_EVENT, { active: false }).catch(() => null);

        if (!candidate) {
          setIsHotkeyCaptureActive(false);
          setHotkeyDraft(null);
          setHotkeyFeedbackTone("error");
          setHotkeyFeedback("Не удалось распознать комбинацию.");
          return;
        }

        pendingHotkeyRef.current = candidate;
        setIsHotkeyCaptureActive(false);
        setIsHotkeySubmitting(true);
        setHotkeyDraft(candidate);
        setHotkeyFeedbackTone("idle");
        setHotkeyFeedback("Проверяем, свободна ли эта комбинация...");

        emit(HOTKEY_CHANGE_REQUEST_EVENT, { hotkey: candidate }).catch((error) => {
          pendingHotkeyRef.current = null;
          setIsHotkeySubmitting(false);
          setHotkeyDraft(null);
          setHotkeyFeedbackTone("error");
          setHotkeyFeedback("Не удалось отправить новую комбинацию на проверку.");
          void logError("SETTINGS", `Failed to emit hotkey change request: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
    );

    return () => {
      unlistenHotkeyResult.then((unlisten) => unlisten());
      unlistenNativeHotkeyCapture.then((unlisten) => unlisten());
      void emit(HOTKEY_CAPTURE_STATE_EVENT, { active: false }).catch(() => null);
      void invoke("stop_native_hotkey_capture").catch(() => null);
      clearHotkeyFeedbackResetTimer();
    };
  }, []);

  useEffect(() => {
    if (!settings) return;

    const fetchMics = async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
          void logInfo("SETTINGS", "Media devices API not available");
          setMicStatus("empty");
          setMicMessage("Список микрофонов недоступен в этой среде.");
          return;
        }

        let devices = await navigator.mediaDevices.enumerateDevices();
        let mics = devices.filter(d => d.kind === "audioinput");
        let needsPermission = false;

        if (mics.length === 0 || mics.some(m => !m.label || m.label === "")) {
          if (navigator.mediaDevices.getUserMedia) {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              await new Promise(r => setTimeout(r, 50));
              devices = await navigator.mediaDevices.enumerateDevices();
              mics = devices.filter(d => d.kind === "audioinput");
              stream.getTracks().forEach(t => t.stop());
            } catch (permitErr) {
              void logInfo("SETTINGS", `Microphone permission denied or no mic available: ${permitErr instanceof Error ? permitErr.message : String(permitErr)}`);
              needsPermission = true;
            }
          }
        }

        const uniqueMics: MediaDeviceInfo[] = [];
        const seenIds = new Set<string>();
        for (const m of mics) {
          if (m.deviceId && !seenIds.has(m.deviceId)) {
            uniqueMics.push(m);
            seenIds.add(m.deviceId);
          }
        }

        setMicrophones(uniqueMics);

        const selectedMic = settings.micId ? uniqueMics.find(m => m.deviceId === settings.micId) : null;
        if (settings.micId && !selectedMic) {
          setMicStatus("missing-selected");
          setMicMessage("Ранее выбранный микрофон недоступен. Во время записи будет использован системный по умолчанию.");
          return;
        }

        if (uniqueMics.length === 0) {
          if (needsPermission) {
            setMicStatus("permission-needed");
            setMicMessage("Список микрофонов появится после доступа к микрофону в macOS.");
            return;
          }

          setMicStatus("empty");
          setMicMessage("Не удалось найти доступные микрофоны. Подключите устройство или проверьте системные настройки.");
          return;
        }

        const activeLabel = selectedMic ? getMicrophoneLabel(selectedMic, uniqueMics.indexOf(selectedMic)) : "Системный микрофон по умолчанию";
        setMicStatus("ready");
        setMicMessage(selectedMic ? `Сейчас используется: ${activeLabel}` : `Сейчас используется: ${activeLabel}`);
      } catch (err) {
        void logError("SETTINGS", `Mic enumeration error: ${err instanceof Error ? err.message : String(err)}`);
        setMicStatus("empty");
        setMicMessage("Не удалось получить список микрофонов. Попробуйте открыть настройки ещё раз.");
      }
    };

    fetchMics();

    navigator.mediaDevices?.addEventListener?.("devicechange", fetchMics);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", fetchMics);
    };
  }, [settings?.micId]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
      if (micRef.current && !micRef.current.contains(e.target as Node)) setMicOpen(false);
      if (isHotkeyCaptureActive && hotkeyButtonRef.current && !hotkeyButtonRef.current.contains(e.target as Node)) {
        void stopHotkeyCapture("Ввод отменен. Текущая комбинация сохранена.");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isHotkeyCaptureActive]);

  const update = async (patch: Partial<AppSettings>): Promise<AppSettings | null> => {
    if (!settingsRef.current) return null;
    const s = { ...settingsRef.current, ...patch };
    settingsRef.current = s;
    setSettings(s);
    await saveSettings(s);
    emit(SETTINGS_UPDATED_EVENT).catch((e) => {
      void logError("SETTINGS", `Failed to emit settings update event: ${e instanceof Error ? e.message : String(e)}`);
    });
    return s;
  };

  const startHotkeyCapture = async (): Promise<void> => {
    if (isHotkeySubmitting || isHotkeyCaptureActive) {
      return;
    }

    clearHotkeyFeedbackResetTimer();
    pendingHotkeyRef.current = null;
    setIsHotkeyCaptureActive(true);
    setHotkeyDraft(null);
    setHotkeyFeedbackTone("idle");
    setHotkeyFeedback("Запускаем запись новой комбинации...");

    try {
      await emit(HOTKEY_CAPTURE_STATE_EVENT, { active: true });
      await invoke("start_native_hotkey_capture");
    } catch (error) {
      await emit(HOTKEY_CAPTURE_STATE_EVENT, { active: false }).catch(() => null);
      setIsHotkeyCaptureActive(false);
      setHotkeyDraft(null);
      setHotkeyFeedbackTone("error");
      setHotkeyFeedback("Не удалось запустить запись горячей клавиши.");
      void logError("SETTINGS", `Failed to start native hotkey capture: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const stopHotkeyCapture = async (message?: string): Promise<void> => {
    pendingHotkeyRef.current = null;
    setIsHotkeyCaptureActive(false);
    setHotkeyDraft(null);

    try {
      await invoke("stop_native_hotkey_capture");
    } catch (error) {
      void logError("SETTINGS", `Failed to stop native hotkey capture: ${error instanceof Error ? error.message : String(error)}`);
    }

    await emit(HOTKEY_CAPTURE_STATE_EVENT, { active: false }).catch(() => null);

    if (message) {
      setHotkeyFeedbackTone("idle");
      setHotkeyFeedback(message);
    }
  };

  const handleHotkeyCaptureSurfaceKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (isHotkeyCaptureActive || isHotkeySubmitting) {
      return;
    }

    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    void startHotkeyCapture();
  };

  const handleHotkeyCaptureSurfaceMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();

    if (isHotkeyCaptureActive || isHotkeySubmitting) {
      return;
    }

    void startHotkeyCapture();
  };

  const toggleAutostart = async (): Promise<void> => {
    if (autostartPending) {
      return;
    }

    const nextEnabled = !autostartEnabled;
    setAutostartPending(true);

    try {
      if (nextEnabled) {
        await enableAutostart();
      } else {
        await disableAutostart();
      }

      const confirmedEnabled = await isAutostartEnabled();
      setAutostartEnabled(confirmedEnabled);
      setAutostartLoaded(true);
      void logInfo("SETTINGS", `Autostart ${confirmedEnabled ? "enabled" : "disabled"}`);
    } catch (error) {
      void logError("SETTINGS", `Failed to update autostart: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAutostartPending(false);
    }
  };

  const getMicrophoneLabel = (mic: MediaDeviceInfo, index: number): string => {
    const label = mic.label?.trim();
    return label ? label : `Микрофон ${index + 1}`;
  };

  if (!settings) return null;

  const filteredLangs = LANGUAGES.filter(l =>
    l.name.toLowerCase().includes(langSearch.toLowerCase()) ||
    l.native.toLowerCase().includes(langSearch.toLowerCase()) ||
    l.code.toLowerCase().includes(langSearch.toLowerCase())
  );
  const currentLang = LANGUAGES.find(l => l.code === settings.language);
  const selectedMicrophone = microphones.find(m => m.deviceId === settings.micId) || null;
  const visibleMicrophoneLabel = selectedMicrophone
    ? getMicrophoneLabel(selectedMicrophone, microphones.indexOf(selectedMicrophone))
    : settings.micId
      ? "Системный микрофон по умолчанию"
      : "Системный микрофон по умолчанию";
  const hotkeyDisplayValue = hotkeyDraft
    ? formatHotkeyLabel(hotkeyDraft)
    : isHotkeyCaptureActive
      ? "Нажмите сочетание"
      : formatHotkeyLabel(settings.hotkey || DEFAULT_HOTKEY);
  const hotkeyFeedbackColor = hotkeyFeedbackTone === "error"
    ? "#b42318"
    : hotkeyFeedbackTone === "success"
      ? "#027a48"
      : "var(--text-mid)";
  const autostartDisabled = !autostartLoaded || autostartPending;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="card" style={{ display: "grid", gap: 10, zIndex: langOpen ? 20 : 1 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 280px", alignItems: "start", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-hi)", margin: 0 }}>Язык распознавания</div>
          </div>
        <div ref={langRef} style={{ position: "relative", width: "100%" }}>
          <button onClick={() => setLangOpen((o) => !o)} className="btn" style={{ width: "100%", justifyContent: "space-between", gap: 8, minHeight: 46 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {currentLang ? `${currentLang.native} (${currentLang.name})` : settings.language}
            </span>
            <ChevronDown size={13} strokeWidth={2} style={{ flexShrink: 0, transform: langOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
          </button>
          {langOpen && (
            <div style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: 320, maxHeight: 320, background: "rgba(255,255,255,0.98)", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 24, boxShadow: "var(--shadow-panel)", zIndex: 100, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ padding: 12, borderBottom: "1px solid rgba(0,0,0,0.06)", display: "flex", alignItems: "center", gap: 8 }}>
                <Search size={13} style={{ color: "var(--text-low)", flexShrink: 0 }} />
                <input autoFocus value={langSearch} onChange={(e) => setLangSearch(e.target.value)} placeholder="Поиск языка..." style={{ border: "none", outline: "none", background: "transparent", fontSize: 12, color: "var(--text-hi)", flex: 1 }} />
              </div>
              <div style={{ overflow: "auto", flex: 1 }}>
                {filteredLangs.length === 0 ? (
                  <div style={{ padding: "14px 16px", fontSize: 12, color: "var(--text-low)" }}>Не найдено</div>
                ) : filteredLangs.map((lang) => (
                  <button
                    key={lang.code}
                    onClick={() => { update({ language: lang.code }); setLangOpen(false); setLangSearch(""); }}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      border: "none",
                      cursor: "pointer",
                      padding: "10px 16px",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      background: settings.language === lang.code ? "rgba(0,0,0,0.04)" : "transparent",
                      color: settings.language === lang.code ? "var(--text-hi)" : "var(--text-mid)",
                      fontSize: 12,
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "rgba(0,0,0,0.03)"}
                    onMouseLeave={(e) => e.currentTarget.style.background = settings.language === lang.code ? "rgba(0,0,0,0.04)" : "transparent"}
                  >
                    <span style={{ minWidth: 28, fontSize: 10, color: "var(--text-low)", fontFamily: "monospace" }}>{lang.code}</span>
                    <span style={{ flex: 1 }}>{lang.native}</span>
                    <span style={{ fontSize: 10, color: "var(--text-low)" }}>{lang.name}</span>
                    {settings.language === lang.code && <Check size={12} strokeWidth={2.5} style={{ color: "var(--text-hi)", flexShrink: 0 }} />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        </div>
        <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>Язык, на котором вы говорите.</div>
      </div>

      <div className="card" style={{ display: "grid", gap: 10, zIndex: micOpen ? 20 : 1 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 280px", alignItems: "start", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-hi)", margin: 0 }}>Микрофон</div>
          </div>
        <div ref={micRef} style={{ position: "relative", width: "100%" }}>
          <button
            onClick={() => {
              if (microphones.length === 0 || micStatus === "permission-needed") return;
              setMicOpen((o) => !o);
            }}
            className="btn"
            style={{ width: "100%", justifyContent: "space-between", gap: 8, minHeight: 46, opacity: microphones.length === 0 || micStatus === "permission-needed" ? 0.7 : 1, cursor: microphones.length === 0 || micStatus === "permission-needed" ? "not-allowed" : "pointer" }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {microphones.length === 0 ? "Системный микрофон по умолчанию" : visibleMicrophoneLabel}
            </span>
            <ChevronDown size={13} strokeWidth={2} style={{ flexShrink: 0, transform: micOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
          </button>

          {micOpen && microphones.length > 0 && (
            <div style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: "100%", maxHeight: 240, background: "rgba(255,255,255,0.98)", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 24, boxShadow: "var(--shadow-panel)", zIndex: 100, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ overflow: "auto", flex: 1, padding: "6px 0" }}>
                <button
                  onClick={() => { void update({ micId: "" }); setMicOpen(false); }}
                  style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: settings.micId === "" ? "rgba(0,0,0,0.04)" : "transparent", color: settings.micId === "" ? "var(--text-hi)" : "var(--text-mid)", fontSize: 12, transition: "background 0.1s" }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "rgba(0,0,0,0.03)"}
                  onMouseLeave={(e) => e.currentTarget.style.background = settings.micId === "" ? "rgba(0,0,0,0.04)" : "transparent"}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Системный микрофон по умолчанию</span>
                  {settings.micId === "" && <Check size={12} strokeWidth={2.5} style={{ color: "var(--text-hi)", flexShrink: 0 }} />}
                </button>
                {microphones.map((m, i) => (
                  <button
                    key={m.deviceId}
                    onClick={() => { void update({ micId: m.deviceId }); setMicOpen(false); }}
                    style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", background: settings.micId === m.deviceId ? "rgba(0,0,0,0.04)" : "transparent", color: settings.micId === m.deviceId ? "var(--text-hi)" : "var(--text-mid)", fontSize: 12, transition: "background 0.1s" }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "rgba(0,0,0,0.03)"}
                    onMouseLeave={(e) => e.currentTarget.style.background = settings.micId === m.deviceId ? "rgba(0,0,0,0.04)" : "transparent"}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{getMicrophoneLabel(m, i)}</span>
                    {settings.micId === m.deviceId && <Check size={12} strokeWidth={2.5} style={{ color: "var(--text-hi)", flexShrink: 0 }} />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        </div>
        <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>Устройство для записи голоса.</div>
        <div style={{ fontSize: 13, color: "var(--text-low)", lineHeight: 1.6 }}>{micMessage}</div>
      </div>

      <div className="card" style={{ display: "grid", gap: 10, background: "rgba(255,255,255,0.82)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 280px", alignItems: "start", gap: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-hi)", margin: 0 }}>Горячая клавиша</div>
            <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.65, marginTop: 6 }}>
              Нажмите на поле справа и введите новую комбинацию. Если сочетание занято, оставим предыдущую клавишу.
            </div>
          </div>
          <div
            ref={hotkeyButtonRef}
            role="button"
            tabIndex={0}
            aria-disabled={isHotkeySubmitting}
            onMouseDown={handleHotkeyCaptureSurfaceMouseDown}
            onKeyDown={handleHotkeyCaptureSurfaceKeyDown}
            className="btn"
            style={{
              width: "100%",
              minHeight: 46,
              justifyContent: "space-between",
              gap: 8,
              border: isHotkeyCaptureActive ? "1px solid rgba(15,118,110,0.28)" : undefined,
              boxShadow: isHotkeyCaptureActive ? "0 0 0 4px rgba(15,118,110,0.08)" : undefined,
              opacity: isHotkeySubmitting ? 0.8 : 1,
              cursor: isHotkeySubmitting ? "wait" : "pointer",
            }}
          >
            <span style={{ color: "var(--text-hi)", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {hotkeyDisplayValue}
            </span>
            <span style={{ color: "var(--text-low)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", flexShrink: 0 }}>
              {isHotkeySubmitting ? "Проверка" : isHotkeyCaptureActive ? "Запись" : "Изменить"}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 13, color: hotkeyFeedbackColor, lineHeight: 1.6 }}>{hotkeyFeedback}</div>
          <div style={{ fontSize: 12, color: "var(--text-low)", whiteSpace: "nowrap" }}>
            Текущая: {formatHotkeyLabel(settings.hotkey || DEFAULT_HOTKEY)}
          </div>
        </div>
      </div>

      <div className="card" style={{ display: "grid", gap: 10, background: "rgba(255,255,255,0.82)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 280px", alignItems: "center", gap: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-hi)", margin: 0 }}>Автозапуск</div>
            <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.65, marginTop: 6 }}>
              Запускать Talkis автоматически при входе в систему.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autostartEnabled}
            aria-disabled={autostartDisabled}
            onClick={() => { void toggleAutostart(); }}
            className="btn"
            style={{
              width: "100%",
              minHeight: 46,
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) 42px",
              alignItems: "center",
              gap: 12,
              opacity: autostartDisabled ? 0.72 : 1,
              cursor: autostartDisabled ? "wait" : "pointer",
              transform: "none",
            }}
          >
            <span style={{ color: "var(--text-hi)", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 74 }}>
              {autostartEnabled ? "Включен" : "Выключен"}
            </span>
            <span
              aria-hidden="true"
              style={{
                width: 42,
                height: 24,
                borderRadius: 999,
                background: autostartEnabled ? "#111" : "rgba(0,0,0,0.12)",
                padding: 3,
                position: "relative",
                transition: "background 0.15s ease",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 3,
                  left: 3,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "#fff",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
                  transform: autostartEnabled ? "translateX(18px)" : "translateX(0)",
                  transition: "transform 0.18s ease",
                }}
              />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
