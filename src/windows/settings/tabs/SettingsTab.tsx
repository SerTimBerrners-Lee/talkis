import { useState, useEffect, useRef, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  IconCheck,
  IconChevronDown,
  IconMail,
  IconDeviceDesktop,
  IconMoon,
  IconSearch,
  IconSun,
  type Icon,
} from "../../../lib/icons";

import {
  getSettings,
  mergeAppSettingsPatch,
  saveSettings,
  AppSettings,
  AppSettingsPatch,
} from "../../../lib/store";
import { DictationHotkeyControl } from "../../../components/DictationHotkeyControl";
import { SettingsToggleControl } from "../../../components/SettingsToggleControl";
import { applyThemePreference } from "../../../lib/theme";
import {
  formatWidgetScalePercent,
  normalizeWidgetScale,
  WIDGET_SCALE_MAX,
  WIDGET_SCALE_MIN,
  WIDGET_SCALE_STEP,
} from "../../../lib/widgetScale";
import { SETTINGS_UPDATED_EVENT } from "../../../lib/hotkeyEvents";
import { getLogPath, logError, logInfo } from "../../../lib/logger";
import { LANGUAGES } from "../../../config/languages";
import { useI18n } from "../../../lib/i18n";

const SETTING_ROW_COLUMNS = "minmax(0, 1fr) 280px";
const SETTING_ROW_GAP = 16;
const CONTROL_HEIGHT = 38;
const CONTROL_RADIUS = 8;
const CONTROL_FONT_SIZE = 12;
const SUPPORT_EMAIL = "david.perov60@gmail.com";
const SETTINGS_CARD_STYLE = {
  display: "grid",
  gap: 10,
  background: "transparent",
  backdropFilter: "none",
  WebkitBackdropFilter: "none",
} as const;
const GROUPED_SETTINGS_CARD_STYLE = {
  ...SETTINGS_CARD_STYLE,
  gap: 0,
  overflow: "visible",
  isolation: "isolate",
} as const;
const GROUPED_SETTINGS_SECTION_STYLE = {
  display: "grid",
  gap: 10,
  padding: "12px 0",
  borderTop: "1px solid var(--border-subtle)",
} as const;
const GROUPED_SETTINGS_FIRST_SECTION_STYLE = {
  ...GROUPED_SETTINGS_SECTION_STYLE,
  paddingTop: 0,
  borderTop: "none",
} as const;
const GROUPED_SETTINGS_LAST_SECTION_STYLE = {
  ...GROUPED_SETTINGS_SECTION_STYLE,
  paddingBottom: 0,
} as const;
const THEME_OPTIONS: Array<{ id: AppSettings["theme"]; Icon: Icon }> = [
  { id: "system", Icon: IconDeviceDesktop },
  { id: "light", Icon: IconSun },
  { id: "dark", Icon: IconMoon },
];
export function SettingsTab(): ReactElement | null {
  const { lang, t } = useI18n();
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // Language picker state
  const [langSearch, setLangSearch] = useState("");
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);

  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [micOpen, setMicOpen] = useState(false);
  const [micStatus, setMicStatus] = useState<MicAvailabilityState>("empty");
  const [, setMicMessage] = useState(t("settingsGeneralExtra.mic.checking"));
  const micRef = useRef<HTMLDivElement>(null);

  const settingsRef = useRef<AppSettings | null>(null);
  const widgetScaleSaveRequestRef = useRef(0);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartLoaded, setAutostartLoaded] = useState(false);
  const [autostartPending, setAutostartPending] = useState(false);
  const widgetVisibilityPendingRef = useRef(false);
  const [widgetVisibilityPending, setWidgetVisibilityPending] = useState(false);
  const [widgetVisibilityError, setWidgetVisibilityError] = useState("");
  const startMinimizedPendingRef = useRef(false);
  const [startMinimizedPending, setStartMinimizedPending] = useState(false);
  const [startMinimizedError, setStartMinimizedError] = useState("");
  const [appDataDir, setAppDataDir] = useState("");
  const [logPath, setLogPath] = useState("");
  const [logFolderPending, setLogFolderPending] = useState(false);
  const [logFolderError, setLogFolderError] = useState("");
  const [supportFeedback, setSupportFeedback] = useState("");

  type MicAvailabilityState =
    "ready" | "missing-selected" | "permission-needed" | "empty";

  useEffect(() => {
    getSettings({ reload: true }).then((s) => {
      setSettings(s);
      settingsRef.current = s;
    });
  }, []);

  useEffect(() => {
    invoke<string>("get_default_transcription_storage_dir")
      .then(setAppDataDir)
      .catch((error) => {
        void logError(
          "SETTINGS",
          `Failed to load app data directory: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    void getLogPath().then(setLogPath);
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
        void logError(
          "SETTINGS",
          `Failed to load autostart state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    void loadAutostartState();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!settings) return;

    const fetchMics = async () => {
      try {
        if (
          !navigator.mediaDevices ||
          !navigator.mediaDevices.enumerateDevices
        ) {
          void logInfo("SETTINGS", "Media devices API not available");
          setMicStatus("empty");
          setMicMessage(t("settingsGeneralExtra.mic.unavailableEnv"));
          return;
        }

        let devices = await navigator.mediaDevices.enumerateDevices();
        let mics = devices.filter((d) => d.kind === "audioinput");
        let needsPermission = false;

        if (mics.length === 0 || mics.some((m) => !m.label || m.label === "")) {
          if (navigator.mediaDevices.getUserMedia) {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
              });
              await new Promise((r) => setTimeout(r, 50));
              devices = await navigator.mediaDevices.enumerateDevices();
              mics = devices.filter((d) => d.kind === "audioinput");
              stream.getTracks().forEach((t) => t.stop());
            } catch (permitErr) {
              void logInfo(
                "SETTINGS",
                `Microphone permission denied or no mic available: ${permitErr instanceof Error ? permitErr.message : String(permitErr)}`,
              );
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

        const selectedMic = settings.micId
          ? uniqueMics.find((m) => m.deviceId === settings.micId)
          : null;
        if (settings.micId && !selectedMic) {
          setMicStatus("missing-selected");
          setMicMessage(t("settingsGeneralExtra.mic.missingSelected"));
          return;
        }

        if (uniqueMics.length === 0) {
          if (needsPermission) {
            setMicStatus("permission-needed");
            setMicMessage(t("settingsGeneralExtra.mic.permissionNeeded"));
            return;
          }

          setMicStatus("empty");
          setMicMessage(t("settingsGeneralExtra.mic.noneFound"));
          return;
        }

        const activeLabel = selectedMic
          ? getMicrophoneLabel(selectedMic, uniqueMics.indexOf(selectedMic))
          : t("settings.mic.systemDefault");
        setMicStatus("ready");
        setMicMessage(
          t("settingsGeneralExtra.mic.inUse", { label: activeLabel }),
        );
      } catch (err) {
        void logError(
          "SETTINGS",
          `IconMicrophone enumeration error: ${err instanceof Error ? err.message : String(err)}`,
        );
        setMicStatus("empty");
        setMicMessage(t("settingsGeneralExtra.mic.enumFailed"));
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
      if (langRef.current && !langRef.current.contains(e.target as Node))
        setLangOpen(false);
      if (micRef.current && !micRef.current.contains(e.target as Node))
        setMicOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const update = async (
    patch: AppSettingsPatch,
  ): Promise<AppSettings | null> => {
    if (!settingsRef.current) return null;
    const s = mergeAppSettingsPatch(settingsRef.current, patch);
    settingsRef.current = s;
    setSettings(s);
    const scaleRequestId =
      patch.widgetScale === undefined
        ? null
        : ++widgetScaleSaveRequestRef.current;
    if (scaleRequestId !== null) {
      void logInfo(
        "WIDGET_SCALE",
        `requestId=${scaleRequestId} stage=queued scale=${normalizeWidgetScale(patch.widgetScale)}`,
      );
    }
    await saveSettings(patch);
    if (scaleRequestId !== null) {
      void logInfo(
        "WIDGET_SCALE",
        `requestId=${scaleRequestId} stage=saved scale=${normalizeWidgetScale(patch.widgetScale)}`,
      );
    }
    emit(SETTINGS_UPDATED_EVENT).catch((e) => {
      void logError(
        "SETTINGS",
        `Failed to emit settings update event: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    return s;
  };

  const toggleWidgetVisibility = async (): Promise<void> => {
    if (!settingsRef.current || widgetVisibilityPendingRef.current) {
      return;
    }

    const visible = !settingsRef.current.widgetVisible;
    widgetVisibilityPendingRef.current = true;
    setWidgetVisibilityPending(true);
    setWidgetVisibilityError("");

    try {
      await saveSettings({ widgetVisible: visible });
      const latest = mergeAppSettingsPatch(settingsRef.current, {
        widgetVisible: visible,
      });
      settingsRef.current = latest;
      setSettings(latest);
      void emit(SETTINGS_UPDATED_EVENT).catch((error) => {
        void logError(
          "SETTINGS",
          `Failed to emit widget visibility update: ${String(error)}`,
        );
      });
    } catch (error) {
      setWidgetVisibilityError(t("settings.widgetVisibility.error"));
      void logError(
        "SETTINGS",
        `Failed to update widget visibility: ${String(error)}`,
      );

      // A save may succeed even if applying the native window change fails.
      try {
        const latest = await getSettings({ reload: true });
        settingsRef.current = latest;
        setSettings(latest);
      } catch (reloadError) {
        void logError(
          "SETTINGS",
          `Failed to reload widget visibility: ${String(reloadError)}`,
        );
      }
    } finally {
      widgetVisibilityPendingRef.current = false;
      setWidgetVisibilityPending(false);
    }
  };

  const toggleStartMinimized = async (): Promise<void> => {
    if (!settingsRef.current || startMinimizedPendingRef.current) {
      return;
    }

    const enabled = !settingsRef.current.startMinimized;
    startMinimizedPendingRef.current = true;
    setStartMinimizedPending(true);
    setStartMinimizedError("");

    try {
      await saveSettings({ startMinimized: enabled });
      const latest = mergeAppSettingsPatch(settingsRef.current, {
        startMinimized: enabled,
      });
      settingsRef.current = latest;
      setSettings(latest);
      void emit(SETTINGS_UPDATED_EVENT).catch((error) => {
        void logError(
          "SETTINGS",
          `Failed to emit startup setting update: ${String(error)}`,
        );
      });
    } catch (error) {
      setStartMinimizedError(t("settings.startMinimized.error"));
      void logError(
        "SETTINGS",
        `Failed to save startup setting: ${String(error)}`,
      );

      try {
        const latest = await getSettings({ reload: true });
        settingsRef.current = latest;
        setSettings(latest);
      } catch (reloadError) {
        void logError(
          "SETTINGS",
          `Failed to reload startup setting: ${String(reloadError)}`,
        );
      }
    } finally {
      startMinimizedPendingRef.current = false;
      setStartMinimizedPending(false);
    }
  };

  const contactSupport = async (): Promise<void> => {
    const subject = encodeURIComponent(
      t("settingsGeneralExtra.support.mailSubject"),
    );
    const body = encodeURIComponent(t("settingsGeneralExtra.support.mailBody"));
    const mailto = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;

    try {
      await openUrl(mailto);
      setSupportFeedback("");
    } catch (error) {
      void logError(
        "SETTINGS",
        `Failed to open support mail: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Fallback: put the address on the clipboard so support is still reachable.
      try {
        await navigator.clipboard.writeText(SUPPORT_EMAIL);
        setSupportFeedback(
          t("settingsGeneralExtra.support.mailCopied", {
            email: SUPPORT_EMAIL,
          }),
        );
      } catch {
        setSupportFeedback(
          t("settingsGeneralExtra.support.writeUs", { email: SUPPORT_EMAIL }),
        );
      }
    }
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
      void logInfo(
        "SETTINGS",
        `Autostart ${confirmedEnabled ? "enabled" : "disabled"}`,
      );
    } catch (error) {
      void logError(
        "SETTINGS",
        `Failed to update autostart: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setAutostartPending(false);
    }
  };

  const openAppDataDir = async (): Promise<void> => {
    try {
      const dir =
        appDataDir ||
        (await invoke<string>("get_default_transcription_storage_dir"));
      setAppDataDir(dir);
      await openPath(dir);
      void logInfo("SETTINGS", `Opened app data directory: ${dir}`);
    } catch (error) {
      void logError(
        "SETTINGS",
        `Failed to open app data directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const openLogFolder = async (): Promise<void> => {
    if (logFolderPending) return;

    setLogFolderPending(true);
    setLogFolderError("");

    try {
      await invoke("open_log_folder");
      void logInfo("SETTINGS", "Opened diagnostic log folder");
    } catch (error) {
      setLogFolderError(t("settings.diagnostics.openFailed"));
      void logError(
        "SETTINGS",
        `Failed to open log folder: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setLogFolderPending(false);
    }
  };

  const getMicrophoneLabel = (mic: MediaDeviceInfo, index: number): string => {
    const label = mic.label?.trim();
    return label
      ? label
      : t("settingsGeneralExtra.mic.fallbackName", { index: index + 1 });
  };

  if (!settings) return null;

  const filteredLangs = LANGUAGES.filter(
    (l) =>
      l.name.toLowerCase().includes(langSearch.toLowerCase()) ||
      l.native.toLowerCase().includes(langSearch.toLowerCase()) ||
      l.code.toLowerCase().includes(langSearch.toLowerCase()),
  );
  const currentLang = LANGUAGES.find((l) => l.code === settings.language);
  const selectedMicrophone =
    microphones.find((m) => m.deviceId === settings.micId) || null;
  const visibleMicrophoneLabel = selectedMicrophone
    ? getMicrophoneLabel(
        selectedMicrophone,
        microphones.indexOf(selectedMicrophone),
      )
    : settings.micId
      ? t("settings.mic.systemDefault")
      : t("settings.mic.systemDefault");
  const autostartDisabled = !autostartLoaded || autostartPending;
  const widgetScale = normalizeWidgetScale(settings.widgetScale);
  const isCloudMode = !settings.useOwnKey;
  const realtimeTranscriptionActive =
    !isCloudMode && settings.realtimeTranscriptionEnabled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        className="card"
        style={{
          ...GROUPED_SETTINGS_CARD_STYLE,
          position: "relative",
          zIndex: langOpen || micOpen ? 20 : 1,
        }}
      >
        <div style={GROUPED_SETTINGS_FIRST_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.uiLanguage.title")}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                background: "var(--control-track)",
                borderRadius: 10,
                padding: 3,
                gap: 2,
                width: "100%",
                justifySelf: "end",
              }}
            >
              {(["ru", "en"] as const).map((code) => {
                const active = lang === code;

                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => {
                      void update({ uiLanguage: code });
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: CONTROL_HEIGHT - 6,
                      padding: "0 4px",
                      borderRadius: CONTROL_RADIUS,
                      border: "none",
                      fontSize: CONTROL_FONT_SIZE,
                      fontWeight: active ? 700 : 500,
                      background: active
                        ? "var(--dropdown-active)"
                        : "transparent",
                      color: active ? "var(--text-hi)" : "var(--text-mid)",
                      cursor: "pointer",
                      transition: "background 0.15s ease, color 0.15s ease",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                    }}
                  >
                    <span
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t(
                        code === "ru"
                          ? "settings.uiLanguage.ru"
                          : "settings.uiLanguage.en",
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div style={GROUPED_SETTINGS_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.theme.title")}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                background: "var(--control-track)",
                borderRadius: 10,
                padding: 3,
                gap: 2,
                width: "100%",
                justifySelf: "end",
              }}
            >
              {THEME_OPTIONS.map(({ id, Icon }) => {
                const active = settings.theme === id;

                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      applyThemePreference(id);
                      void update({ theme: id });
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      minHeight: CONTROL_HEIGHT - 6,
                      padding: "0 4px",
                      borderRadius: CONTROL_RADIUS,
                      border: "none",
                      fontSize: CONTROL_FONT_SIZE,
                      fontWeight: active ? 700 : 500,
                      background: active
                        ? "var(--dropdown-active)"
                        : "transparent",
                      color: active ? "var(--text-hi)" : "var(--text-mid)",
                      cursor: "pointer",
                      transition: "background 0.15s ease, color 0.15s ease",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                    }}
                  >
                    <Icon
                      size={13}
                      stroke={active ? 2.2 : 1.7}
                      style={{ flexShrink: 0 }}
                    />
                    <span
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t(`settings.theme.${id}`)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div
          style={{
            ...GROUPED_SETTINGS_SECTION_STYLE,
            position: "relative",
            zIndex: langOpen ? 20 : 1,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.recognitionLang.title")}
              </div>
            </div>
            <div
              ref={langRef}
              style={{
                position: "relative",
                width: "100%",
                justifySelf: "end",
              }}
            >
              <button
                onClick={() => setLangOpen((o) => !o)}
                className="btn"
                style={{
                  width: "100%",
                  justifyContent: "space-between",
                  gap: 8,
                  minHeight: CONTROL_HEIGHT,
                  padding: "0 10px",
                  borderRadius: CONTROL_RADIUS,
                  fontSize: CONTROL_FONT_SIZE,
                }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {currentLang
                    ? `${currentLang.native} (${currentLang.name})`
                    : settings.language}
                </span>
                <IconChevronDown
                  size={13}
                  stroke={2}
                  style={{
                    flexShrink: 0,
                    transform: langOpen ? "rotate(180deg)" : "none",
                    transition: "transform 0.15s",
                  }}
                />
              </button>
              {langOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    right: 0,
                    width: 320,
                    maxHeight: 320,
                    background: "var(--dropdown-bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 24,
                    boxShadow: "var(--shadow-panel)",
                    zIndex: 100,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: 12,
                      borderBottom: "1px solid var(--border-subtle)",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <IconSearch
                      size={13}
                      style={{ color: "var(--text-low)", flexShrink: 0 }}
                    />
                    <input
                      autoFocus
                      value={langSearch}
                      onChange={(e) => setLangSearch(e.target.value)}
                      placeholder={t(
                        "settings.recognitionLang.searchPlaceholder",
                      )}
                      style={{
                        border: "none",
                        outline: "none",
                        background: "transparent",
                        fontSize: 12,
                        color: "var(--text-hi)",
                        flex: 1,
                      }}
                    />
                  </div>
                  <div style={{ overflow: "auto", flex: 1 }}>
                    {filteredLangs.length === 0 ? (
                      <div
                        style={{
                          padding: "14px 16px",
                          fontSize: 12,
                          color: "var(--text-low)",
                        }}
                      >
                        {t("common.notFound")}
                      </div>
                    ) : (
                      filteredLangs.map((lang) => (
                        <button
                          key={lang.code}
                          onClick={() => {
                            update({ language: lang.code });
                            setLangOpen(false);
                            setLangSearch("");
                          }}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            border: "none",
                            cursor: "pointer",
                            padding: "10px 16px",
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            background:
                              settings.language === lang.code
                                ? "var(--dropdown-active)"
                                : "transparent",
                            color:
                              settings.language === lang.code
                                ? "var(--text-hi)"
                                : "var(--text-mid)",
                            fontSize: 12,
                            transition: "background 0.1s",
                          }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.background =
                              "var(--dropdown-hover)")
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.background =
                              settings.language === lang.code
                                ? "var(--dropdown-active)"
                                : "transparent")
                          }
                        >
                          <span
                            style={{
                              minWidth: 28,
                              fontSize: 10,
                              color: "var(--text-low)",
                              fontFamily: "monospace",
                            }}
                          >
                            {lang.code}
                          </span>
                          <span style={{ flex: 1 }}>{lang.native}</span>
                          <span
                            style={{ fontSize: 10, color: "var(--text-low)" }}
                          >
                            {lang.name}
                          </span>
                          {settings.language === lang.code && (
                            <IconCheck
                              size={12}
                              stroke={2.5}
                              style={{
                                color: "var(--text-hi)",
                                flexShrink: 0,
                              }}
                            />
                          )}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div
          style={{
            ...GROUPED_SETTINGS_SECTION_STYLE,
            position: "relative",
            zIndex: micOpen ? 20 : 1,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.mic.title")}
              </div>
            </div>
            <div
              ref={micRef}
              style={{
                position: "relative",
                width: "100%",
                justifySelf: "end",
              }}
            >
              <button
                onClick={() => {
                  if (
                    microphones.length === 0 ||
                    micStatus === "permission-needed"
                  )
                    return;
                  setMicOpen((o) => !o);
                }}
                className="btn"
                style={{
                  width: "100%",
                  justifyContent: "space-between",
                  gap: 8,
                  minHeight: CONTROL_HEIGHT,
                  padding: "0 10px",
                  borderRadius: CONTROL_RADIUS,
                  fontSize: CONTROL_FONT_SIZE,
                  opacity:
                    microphones.length === 0 ||
                    micStatus === "permission-needed"
                      ? 0.7
                      : 1,
                  cursor:
                    microphones.length === 0 ||
                    micStatus === "permission-needed"
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {microphones.length === 0
                    ? t("settings.mic.systemDefault")
                    : visibleMicrophoneLabel}
                </span>
                <IconChevronDown
                  size={13}
                  stroke={2}
                  style={{
                    flexShrink: 0,
                    transform: micOpen ? "rotate(180deg)" : "none",
                    transition: "transform 0.15s",
                  }}
                />
              </button>

              {micOpen && microphones.length > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    right: 0,
                    width: "100%",
                    maxHeight: 240,
                    background: "var(--dropdown-bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 24,
                    boxShadow: "var(--shadow-panel)",
                    zIndex: 100,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ overflow: "auto", flex: 1, padding: "6px 0" }}>
                    <button
                      onClick={() => {
                        void update({ micId: "" });
                        setMicOpen(false);
                      }}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        border: "none",
                        cursor: "pointer",
                        padding: "10px 16px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        background:
                          settings.micId === ""
                            ? "var(--dropdown-active)"
                            : "transparent",
                        color:
                          settings.micId === ""
                            ? "var(--text-hi)"
                            : "var(--text-mid)",
                        fontSize: 12,
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background =
                          "var(--dropdown-hover)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background =
                          settings.micId === ""
                            ? "var(--dropdown-active)"
                            : "transparent")
                      }
                    >
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {t("settings.mic.systemDefault")}
                      </span>
                      {settings.micId === "" && (
                        <IconCheck
                          size={12}
                          stroke={2.5}
                          style={{ color: "var(--text-hi)", flexShrink: 0 }}
                        />
                      )}
                    </button>
                    {microphones.map((m, i) => (
                      <button
                        key={m.deviceId}
                        onClick={() => {
                          void update({ micId: m.deviceId });
                          setMicOpen(false);
                        }}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          border: "none",
                          cursor: "pointer",
                          padding: "10px 16px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          background:
                            settings.micId === m.deviceId
                              ? "var(--dropdown-active)"
                              : "transparent",
                          color:
                            settings.micId === m.deviceId
                              ? "var(--text-hi)"
                              : "var(--text-mid)",
                          fontSize: 12,
                          transition: "background 0.1s",
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.background =
                            "var(--dropdown-hover)")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.background =
                            settings.micId === m.deviceId
                              ? "var(--dropdown-active)"
                              : "transparent")
                        }
                      >
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {getMicrophoneLabel(m, i)}
                        </span>
                        {settings.micId === m.deviceId && (
                          <IconCheck
                            size={12}
                            stroke={2.5}
                            style={{ color: "var(--text-hi)", flexShrink: 0 }}
                          />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={GROUPED_SETTINGS_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.hotkey.title")}
              </div>
            </div>
            <DictationHotkeyControl
              settings={settings}
              onSettingsChange={(latestSettings) => {
                settingsRef.current = latestSettings;
                setSettings(latestSettings);
              }}
            />
          </div>
        </div>

        <div style={GROUPED_SETTINGS_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.widgetVisibility.title")}
              </div>
            </div>
            <SettingsToggleControl
              enabled={settings.widgetVisible}
              disabled={widgetVisibilityPending}
              label={t(
                settings.widgetVisible
                  ? "settings.widgetVisibility.on"
                  : "settings.widgetVisibility.off",
              )}
              ariaLabel={t("settings.widgetVisibility.title")}
              onToggle={() => {
                void toggleWidgetVisibility();
              }}
            />
          </div>
          {widgetVisibilityError && (
            <div role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>
              {widgetVisibilityError}
            </div>
          )}
        </div>

        <div style={GROUPED_SETTINGS_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.widgetSize.title")}
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) 56px",
                alignItems: "center",
                gap: 12,
                justifySelf: "end",
                width: "100%",
              }}
            >
              <input
                type="range"
                min={WIDGET_SCALE_MIN}
                max={WIDGET_SCALE_MAX}
                step={WIDGET_SCALE_STEP}
                value={widgetScale}
                onChange={(event) => {
                  void update({
                    widgetScale: normalizeWidgetScale(
                      Number(event.currentTarget.value),
                    ),
                  });
                }}
                aria-label={t("settings.widgetSize.aria")}
                style={{
                  width: "100%",
                  accentColor: "var(--accent)",
                  cursor: "pointer",
                }}
              />
              <div
                style={{
                  height: CONTROL_HEIGHT,
                  borderRadius: CONTROL_RADIUS,
                  background: "var(--control-muted)",
                  color: "var(--text-hi)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: CONTROL_FONT_SIZE,
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {formatWidgetScalePercent(widgetScale)}
              </div>
            </div>
          </div>
        </div>

        <div style={GROUPED_SETTINGS_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.autostart.title")}
              </div>
            </div>
            <SettingsToggleControl
              enabled={autostartEnabled}
              disabled={autostartDisabled}
              label={t(
                autostartEnabled ? "settings.autostart.on" : "settings.autostart.off",
              )}
              ariaLabel={t("settings.autostart.title")}
              onToggle={() => {
                void toggleAutostart();
              }}
            />
          </div>
        </div>

        <div style={GROUPED_SETTINGS_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.startMinimized.title")}
              </div>
            </div>
            <SettingsToggleControl
              enabled={settings.startMinimized}
              disabled={startMinimizedPending}
              label={t(
                settings.startMinimized
                  ? "settings.startMinimized.on"
                  : "settings.startMinimized.off",
              )}
              ariaLabel={t("settings.startMinimized.title")}
              onToggle={() => {
                void toggleStartMinimized();
              }}
            />
          </div>
          {startMinimizedError && (
            <div role="alert" style={{ color: "var(--danger)", fontSize: 11 }}>
              {startMinimizedError}
            </div>
          )}
        </div>

        <div style={GROUPED_SETTINGS_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.realtimeTranscription.title")}
              </div>
              <div
                id="realtime-transcription-description"
                style={{
                  marginTop: 4,
                  color: "var(--text-low)",
                  fontSize: 11,
                  lineHeight: 1.35,
                }}
              >
                {t(
                  isCloudMode
                    ? "settings.realtimeTranscription.cloudDesc"
                    : "settings.realtimeTranscription.desc",
                )}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={realtimeTranscriptionActive}
              aria-disabled={isCloudMode}
              aria-describedby="realtime-transcription-description"
              onClick={() => {
                if (isCloudMode) return;
                void update({
                  realtimeTranscriptionEnabled:
                    !settings.realtimeTranscriptionEnabled,
                });
              }}
              className="btn"
              style={{
                width: "100%",
                minHeight: CONTROL_HEIGHT,
                padding: "0 10px",
                borderRadius: CONTROL_RADIUS,
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) 34px",
                alignItems: "center",
                gap: 10,
                opacity: isCloudMode ? 0.64 : 1,
                cursor: isCloudMode ? "not-allowed" : "pointer",
                transform: "none",
                justifySelf: "end",
              }}
            >
              <span
                style={{
                  color: "var(--text-hi)",
                  fontSize: CONTROL_FONT_SIZE,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0,
                }}
              >
                {isCloudMode
                  ? t("settings.realtimeTranscription.unavailable")
                  : settings.realtimeTranscriptionEnabled
                    ? t("settings.realtimeTranscription.on")
                    : t("settings.realtimeTranscription.off")}
              </span>
              <span
                aria-hidden="true"
                style={{
                  width: 34,
                  height: 20,
                  borderRadius: 999,
                  background: realtimeTranscriptionActive
                    ? "var(--accent)"
                    : "var(--switch-track)",
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
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    background: "var(--accent-contrast)",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
                    transform: realtimeTranscriptionActive
                      ? "translateX(14px)"
                      : "translateX(0)",
                    transition: "transform 0.18s ease",
                  }}
                />
              </span>
            </button>
          </div>
        </div>

        <div style={GROUPED_SETTINGS_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.appDataDir.title")}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                void openAppDataDir();
              }}
              className="btn"
              style={{
                minHeight: CONTROL_HEIGHT,
                width: "100%",
                justifyContent: "center",
                padding: "0 10px",
                borderRadius: CONTROL_RADIUS,
                fontSize: CONTROL_FONT_SIZE,
              }}
            >
              {t("common.open")}
            </button>
          </div>
          <input
            type="text"
            value={appDataDir}
            readOnly
            className="input"
            placeholder={t("settings.modelsDir.placeholder")}
            style={{
              height: 40,
              padding: "8px 10px",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 11,
            }}
          />
        </div>

        <div style={GROUPED_SETTINGS_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.diagnostics.title")}
              </div>
            </div>
            <button
              type="button"
              disabled={logFolderPending}
              onClick={() => {
                void openLogFolder();
              }}
              className="btn"
              style={{
                minHeight: CONTROL_HEIGHT,
                width: "100%",
                justifyContent: "center",
                padding: "0 10px",
                borderRadius: CONTROL_RADIUS,
                fontSize: CONTROL_FONT_SIZE,
              }}
            >
              {t("common.open")}
            </button>
          </div>
          <input
            type="text"
            value={logPath}
            readOnly
            aria-label={t("settings.diagnostics.title")}
            className="input"
            style={{
              height: 40,
              padding: "8px 10px",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 11,
            }}
          />
          {logFolderError && (
            <div role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>
              {logFolderError}
            </div>
          )}
        </div>

        <div style={GROUPED_SETTINGS_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.recordingAudio.title")}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.saveRecordingAudio}
              onClick={() => {
                void update({
                  saveRecordingAudio: !settings.saveRecordingAudio,
                });
              }}
              className="btn"
              style={{
                width: "100%",
                minHeight: CONTROL_HEIGHT,
                padding: "0 10px",
                borderRadius: CONTROL_RADIUS,
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) 34px",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                transform: "none",
                justifySelf: "end",
              }}
            >
              <span
                style={{
                  color: "var(--text-hi)",
                  fontSize: CONTROL_FONT_SIZE,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0,
                }}
              >
                {settings.saveRecordingAudio
                  ? t("settings.recordingAudio.on")
                  : t("settings.recordingAudio.off")}
              </span>
              <span
                aria-hidden="true"
                style={{
                  width: 34,
                  height: 20,
                  borderRadius: 999,
                  background: settings.saveRecordingAudio
                    ? "var(--accent)"
                    : "var(--switch-track)",
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
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    background: "var(--accent-contrast)",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
                    transform: settings.saveRecordingAudio
                      ? "translateX(14px)"
                      : "translateX(0)",
                    transition: "transform 0.18s ease",
                  }}
                />
              </span>
            </button>
          </div>
        </div>

        <div style={GROUPED_SETTINGS_LAST_SECTION_STYLE}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: SETTING_ROW_COLUMNS,
              alignItems: "center",
              gap: SETTING_ROW_GAP,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-hi)",
                  margin: 0,
                }}
              >
                {t("settings.support.title")}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                void contactSupport();
              }}
              className="btn"
              style={{
                minHeight: CONTROL_HEIGHT,
                width: "100%",
                justifySelf: "end",
                justifyContent: "center",
                gap: 8,
                padding: "0 10px",
                borderRadius: CONTROL_RADIUS,
                fontSize: CONTROL_FONT_SIZE,
              }}
            >
              <IconMail size={14} stroke={2} />
              {t("settings.support.button")}
            </button>
          </div>
          {supportFeedback && (
            <div
              style={{
                fontSize: 13,
                color: "var(--text-mid)",
                lineHeight: 1.6,
              }}
            >
              {supportFeedback}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
