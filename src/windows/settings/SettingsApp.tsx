import { useState, useEffect } from "react";
import type { CSSProperties, ReactElement } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  IconDownload,
  IconExternalLink,
  IconFileMusic,
  IconHome,
  IconCpu,
  IconLoader2,
  IconMessage,
  IconLanguage,
  IconSparkles,
  IconAdjustmentsHorizontal,
  Icon,
} from "../../lib/icons";
import { TitleBar } from "../../components/TitleBar";
import { MainTab } from "./tabs/MainTab";
import { FileTranscriptionTab } from "./tabs/FileTranscriptionTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { SettingsTabs } from "./tabs/SettingsTabs";
import { DevChatTab } from "./tabs/DevChatTab";
import { TranslationTab } from "./tabs/TranslationTab";
import { OnboardingFlow } from "../../components/onboarding/OnboardingFlow";
import {
  APP_UPDATE_CHECK_REQUEST_EVENT,
  DEV_ONBOARDING_REQUEST_EVENT,
  SETTINGS_NAVIGATE_EVENT,
  SETTINGS_UPDATED_EVENT,
  SELECTION_TEXT_REQUEST_EVENT,
  SELECTION_TEXT_RESPONSE_EVENT,
  SettingsNavigatePayload,
  type SelectionTextRequestPayload,
} from "../../lib/hotkeyEvents";
import {
  getPermissionsPassed,
  setPermissionsPassed,
  getHistoryIndex,
  getSettings,
  isMacPlatform,
  type ThemePreference,
} from "../../lib/store";
import { checkAllPermissions } from "../../lib/permissions";
import { logError, logInfo } from "../../lib/logger";
import { UserPanel } from "../../components/UserPanel";
import { watchThemePreference } from "../../lib/theme";
import { syncWindowsTitlebarTheme } from "../../lib/windowsTitlebar";
import {
  isSettingsTab,
  resolveInitialSettingsTab,
  type SettingsTab as Tab,
} from "./settingsNavigation";
import {
  checkForAppUpdateNow,
  installAvailableAppUpdate,
  subscribeToAppUpdateState,
  type AppUpdateState,
} from "../../lib/updater";
import { useI18n, type MsgKey } from "../../lib/i18n";

function resolveInitialTab(): Tab {
  return resolveInitialSettingsTab(window.location.search);
}

const TABS: { id: Tab; labelKey: MsgKey; icon: Icon; note: string }[] = [
  {
    id: "main",
    labelKey: "settingsApp.tab.main",
    icon: IconHome,
    note: "История записей",
  },
  {
    id: "file",
    labelKey: "settingsApp.tab.file",
    icon: IconFileMusic,
    note: "Транскрибация",
  },
  {
    id: "chat",
    labelKey: "settingsApp.tab.chat",
    icon: IconMessage,
    note: "Чат с записями и текстом",
  },
  {
    id: "model",
    labelKey: "settingsApp.tab.model",
    icon: IconCpu,
    note: "Ключи и подключение модели",
  },
  {
    id: "interpreter",
    labelKey: "settingsApp.tab.interpreter",
    icon: IconLanguage,
    note: "Перевод диктовки, выделения и живой речи",
  },
  {
    id: "style",
    labelKey: "settingsApp.tab.style",
    icon: IconSparkles,
    note: "Стиль обработки и Промпты для саммари",
  },
  {
    id: "settings",
    labelKey: "settingsApp.tab.settings",
    icon: IconAdjustmentsHorizontal,
    note: "Язык, микрофон и горячая клавиша",
  },
];

function TabButton({
  tab,
  isActive,
  onClick,
}: {
  tab: (typeof TABS)[0];
  isActive: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const Icon = tab.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`nav-item ${isActive ? "active" : ""}`}
      aria-current={isActive ? "page" : undefined}
      style={{ width: "100%", textAlign: "left", font: "inherit" }}
    >
      <Icon size={18} stroke={isActive ? 2.2 : 1.6} />
      <span>{t(tab.labelKey)}</span>
    </button>
  );
}

function SidebarLogo() {
  return (
    <div style={{ padding: "4px 8px 12px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 6,
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 3, height: 22 }}
        >
          {[8, 16, 11, 19, 10].map((height, index) => (
            <span
              key={index}
              style={{
                display: "block",
                width: 3,
                height,
                borderRadius: 999,
                background: "var(--accent)",
                animation: `voice-logo-pulse 1.15s ease-in-out ${index * 0.1}s infinite`,
              }}
            />
          ))}
        </div>
        <div
          style={{
            fontSize: 30,
            lineHeight: 0.95,
            fontWeight: 800,
            letterSpacing: "-0.06em",
            fontFamily: "var(--font-brand)",
            color: "var(--text-hi)",
          }}
        >
          Talkis
        </div>
      </div>
    </div>
  );
}

const GITHUB_REPO_URL = "https://github.com/SerTimBerrners-Lee/talkis";

function formatUpdateVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function AppUpdateFooter(): ReactElement | null {
  const { t } = useI18n();
  const [version, setVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<AppUpdateState>({
    status: "idle",
  });

  useEffect(() => {
    let mounted = true;

    getVersion()
      .then((appVersion) => {
        if (mounted) {
          setVersion(appVersion);
        }
      })
      .catch((error) => {
        void logError(
          "SETTINGS_APP",
          `Failed to load app version: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) {
      return;
    }

    const unsubscribe = subscribeToAppUpdateState(setUpdateState);
    void checkForAppUpdateNow();

    return unsubscribe;
  }, []);

  if (!version) {
    return null;
  }

  const showUpdateButton =
    !import.meta.env.DEV &&
    Boolean(updateState.version) &&
    (updateState.status === "available" ||
      updateState.status === "installing" ||
      updateState.status === "error");
  const updateVersion = updateState.version
    ? formatUpdateVersion(updateState.version)
    : "";
  const installing = updateState.status === "installing";

  return (
    <div
      style={{
        display: "grid",
        gap: 4,
        padding: "0 8px",
      }}
    >
      {showUpdateButton && (
        <div style={{ display: "grid", gap: 5 }}>
          <button
            type="button"
            className="btn"
            disabled={installing}
            onClick={() => {
              void installAvailableAppUpdate().catch((error) => {
                void logError(
                  "SETTINGS_APP",
                  `Failed to install app update: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
            }}
            style={{
              width: "100%",
              minHeight: 32,
              height: "auto",
              padding: "7px 9px",
              justifyContent: "center",
              borderRadius: 10,
              fontSize: 11,
              fontWeight: 700,
              lineHeight: 1.25,
              whiteSpace: "normal",
              textAlign: "center",
            }}
          >
            {installing ? (
              <IconLoader2
                className="loading-soft-icon"
                size={13}
                stroke={2}
                style={{
                  flexShrink: 0,
                }}
              />
            ) : (
              <IconDownload size={13} stroke={2} style={{ flexShrink: 0 }} />
            )}
            <span>
              {installing
                ? t("settingsApp.installing")
                : t("settingsApp.installUpdate", { version: updateVersion })}
            </span>
          </button>

          {updateState.status === "error" && (
            <div
              style={{
                fontSize: 10,
                lineHeight: 1.35,
                color: "var(--danger)",
                textAlign: "center",
              }}
            >
              {t("settingsApp.updateFailed")}
            </div>
          )}
        </div>
      )}

      <div
        role="link"
        tabIndex={0}
        onClick={() => {
          void openUrl(GITHUB_REPO_URL);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void openUrl(GITHUB_REPO_URL);
          }
        }}
        aria-label={t("settingsApp.versionAria", { version })}
        title={t("settingsApp.githubTitle")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          fontSize: 11,
          lineHeight: 1,
          color: "var(--text-low)",
          userSelect: "none",
          cursor: "pointer",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center" }}>
          v{version}
        </span>
        <IconExternalLink
          size={10}
          stroke={2}
          style={{ display: "block", marginTop: -1 }}
        />
      </div>
    </div>
  );
}

function getTextControlSelection(element: Element | null): string {
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement
  ) {
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    if (end > start) {
      return element.value.slice(start, end);
    }
  }

  return "";
}

function getCurrentDomSelectionText(): string {
  if (!document.hasFocus()) {
    return "";
  }

  const activeElementSelection = getTextControlSelection(
    document.activeElement,
  );
  if (activeElementSelection.trim()) {
    return activeElementSelection;
  }

  return window.getSelection()?.toString() ?? "";
}

export function SettingsApp(): ReactElement {
  const { t } = useI18n();
  const initialQuery = new URLSearchParams(window.location.search);
  const checkUpdateAtStartup = initialQuery.get("checkUpdate") === "1";
  const isStartupWindow = initialQuery.get("startup") === "1";
  const [devOnboardingRequestId, setDevOnboardingRequestId] = useState(
    import.meta.env.DEV && initialQuery.get("onboarding") === "1" ? 1 : 0,
  );
  const [activeTab, setActiveTab] = useState<Tab>(resolveInitialTab);
  const [focusedFileResultId, setFocusedFileResultId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("resultId"),
  );
  const [focusedHistoryEntryId, setFocusedHistoryEntryId] = useState<
    string | null
  >(null);
  const [focusedHistoryEntryNonce, setFocusedHistoryEntryNonce] = useState(0);
  const [themePreference, setThemePreference] =
    useState<ThemePreference>("system");
  const [navigationNonce, setNavigationNonce] = useState(0);
  const [showPermissions, setShowPermissions] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const syncTheme = async (reload = false): Promise<void> => {
      const settings = await getSettings({ reload });
      setThemePreference(settings.theme);
    };

    void syncTheme(true);

    const unlistenPromise = listen(SETTINGS_UPDATED_EVENT, () => {
      void syncTheme(true);
    });

    return () => {
      unlistenPromise.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    return watchThemePreference(themePreference, (theme) => {
      void syncWindowsTitlebarTheme(theme).catch((error) => {
        void logError(
          "WINDOW_TITLEBAR",
          `Failed to sync Windows title bar theme: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }, [themePreference]);

  useEffect(() => {
    let mounted = true;

    const revealStartupWindow = async (): Promise<void> => {
      if (isStartupWindow && mounted) {
        await invoke("reveal_startup_settings");
      }
    };

    const startupSettings = getSettings().then(async (settings) => {
      if (!settings.startMinimized) {
        await revealStartupWindow();
      }

      return settings;
    });

    Promise.all([getPermissionsPassed(), checkAllPermissions(), startupSettings])
      .then(async ([passed, permissions, settings]) => {
        const hasRequiredStartupPermissions =
          permissions.microphone !== "denied" &&
          (!isMacPlatform() || permissions.accessibility === "granted");
        const shouldRecoverExistingInstall =
          !passed &&
          hasRequiredStartupPermissions &&
          (await getHistoryIndex()
            .then((history) => history.length > 0)
            .catch(() => false));

        if (shouldRecoverExistingInstall) {
          await setPermissionsPassed(true);
        }

        if (!mounted) return;

        const needsOnboarding = !(
          (passed || shouldRecoverExistingInstall) &&
          hasRequiredStartupPermissions
        );
        setShowPermissions(needsOnboarding);
        setLoadError(null);

        if (needsOnboarding) {
          await revealStartupWindow();
        }

        if (isStartupWindow) {
          void logInfo(
            "SETTINGS_APP",
            `Startup presentation: startMinimized=${settings.startMinimized}, needsOnboarding=${needsOnboarding}`,
          );
        }
      })
      .catch((error) => {
        if (!mounted) return;

        void logError(
          "SETTINGS_APP",
          `Failed to load initial state: ${error instanceof Error ? error.message : String(error)}`,
        );
        setShowPermissions(false);
        setLoadError(t("settingsApp.loadError"));
        void revealStartupWindow().catch((revealError) => {
          void logError(
            "SETTINGS_APP",
            `Failed to reveal startup error: ${String(revealError)}`,
          );
        });
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (checkUpdateAtStartup) {
      void checkForAppUpdateNow();
    }

    const unlistenPromise = listen(APP_UPDATE_CHECK_REQUEST_EVENT, () => {
      void checkForAppUpdateNow();
    });

    return () => {
      unlistenPromise.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const unlistenPromise = listen(DEV_ONBOARDING_REQUEST_EVENT, () => {
      setDevOnboardingRequestId((current) => current + 1);
    });

    return () => {
      unlistenPromise.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<SettingsNavigatePayload>(
      SETTINGS_NAVIGATE_EVENT,
      ({ payload }) => {
        const nextTab = isSettingsTab(payload.tab) ? payload.tab : "main";
        setActiveTab(nextTab);
        setFocusedFileResultId(
          nextTab === "file" ? payload.resultId || null : null,
        );
        setNavigationNonce((current) => current + 1);

        requestAnimationFrame(() => {
          document
            .querySelector("main")
            ?.scrollTo({ top: 0, left: 0, behavior: "auto" });
        });
      },
    );

    return () => {
      unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<SelectionTextRequestPayload>(
      SELECTION_TEXT_REQUEST_EVENT,
      ({ payload }) => {
        void emit(SELECTION_TEXT_RESPONSE_EVENT, {
          requestId: payload.requestId,
          text: getCurrentDomSelectionText(),
          sourceWindow: "settings",
        });
      },
    );

    return () => {
      unlisten.then((dispose) => dispose());
    };
  }, []);

  const handlePermissionsComplete = async () => {
    await setPermissionsPassed(true);
    setShowPermissions(false);
    setDevOnboardingRequestId(0);
    await emit(SETTINGS_UPDATED_EVENT);
  };

  const openHistoryEntryFromChat = (entryId: string): void => {
    setFocusedHistoryEntryId(entryId);
    setFocusedHistoryEntryNonce((current) => current + 1);
    setActiveTab("main");
  };

  if (showPermissions === null) {
    return (
      <div
        className="app-root"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div className="card" style={{ width: 420, textAlign: "center" }}>
          <div style={{ fontSize: 14, color: "var(--text-mid)" }}>
            {t("settingsApp.loading")}
          </div>
        </div>
      </div>
    );
  }

  const isChatActive = activeTab === "chat";

  return (
    <div className={isMacPlatform() ? "app-root" : "app-root native-frame"}>
      <div
        style={
          {
            "--summary-modal-top-offset": isMacPlatform() ? "48px" : "0px",
            display: "flex",
            flexDirection: "column",
            height: "100vh",
            position: "relative",
            zIndex: 1,
          } as CSSProperties
        }
      >
        {/* Windows/Linux use the native title bar + system window controls. */}
        {isMacPlatform() && <TitleBar />}

        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <aside
            style={{
              width: 254,
              padding: "14px 12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              background: "var(--sidebar-bg)",
              overflowY: "auto",
              flexShrink: 0,
              marginTop: -1,
            }}
          >
            <SidebarLogo />

            <nav style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {TABS.map((t) => (
                <TabButton
                  key={t.id}
                  tab={t}
                  isActive={activeTab === t.id}
                  onClick={() => setActiveTab(t.id)}
                />
              ))}
            </nav>

            <div style={{ display: "grid", gap: 4, marginTop: "auto" }}>
              <UserPanel />
              <AppUpdateFooter />
            </div>
          </aside>

          <main
            style={{
              flex: 1,
              padding: "18px 24px 24px",
              minHeight: 0,
              overflowY: isChatActive ? "hidden" : "auto",
              overflowX: "hidden",
              position: "relative",
              background: "var(--main-bg)",
            }}
          >
            <div
              style={{
                maxWidth: isChatActive ? "none" : 920,
                margin: "0 auto",
                minWidth: 0,
                minHeight: 0,
                height: isChatActive ? "100%" : undefined,
                display: isChatActive ? "flex" : "block",
                flexDirection: isChatActive ? "column" : undefined,
                overflowX: "hidden",
              }}
            >
              {loadError && (
                <div
                  className="card"
                  style={{
                    marginBottom: 14,
                    padding: "12px 14px",
                    background: "var(--danger-soft)",
                    border: "1px solid var(--danger-border)",
                    color: "var(--danger)",
                  }}
                >
                  {loadError}
                </div>
              )}
              <div
                key={navigationNonce}
                style={{
                  animation: "slide-down 0.18s ease",
                  flex: isChatActive ? "1 1 auto" : undefined,
                  minHeight: isChatActive ? 0 : undefined,
                }}
              >
                <div
                  style={{ display: activeTab === "main" ? "block" : "none" }}
                >
                  <MainTab
                    focusedEntryId={focusedHistoryEntryId}
                    focusedEntryNonce={focusedHistoryEntryNonce}
                  />
                </div>
                <div
                  style={{ display: activeTab === "file" ? "block" : "none" }}
                >
                  <FileTranscriptionTab focusedEntryId={focusedFileResultId} />
                </div>
                <div
                  style={{
                    display: activeTab === "chat" ? "block" : "none",
                    height: "100%",
                    minHeight: 0,
                    overflow: "hidden",
                  }}
                >
                  <DevChatTab
                    isActive={activeTab === "chat"}
                    onOpenHistoryEntry={openHistoryEntryFromChat}
                  />
                </div>
                <div
                  style={{
                    display: activeTab === "settings" ? "block" : "none",
                  }}
                >
                  <SettingsTab />
                </div>
                {activeTab === "model" && <SettingsTabs type="model" />}
                {activeTab === "style" && <SettingsTabs type="style" />}
                {activeTab === "interpreter" && <TranslationTab />}
              </div>
            </div>
          </main>
        </div>
      </div>

      {(showPermissions || devOnboardingRequestId > 0) && (
        <OnboardingFlow
          key={`onboarding-${devOnboardingRequestId}`}
          onComplete={handlePermissionsComplete}
        />
      )}
    </div>
  );
}
