import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Home, Cpu, Sparkles, Sliders, LucideIcon } from "lucide-react";
import { TitleBar } from "../../components/TitleBar";
import { MainTab } from "./tabs/MainTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { SettingsTabs } from "./tabs/SettingsTabs";
import { PermissionScreen } from "../../components/PermissionScreen";
import { SETTINGS_NAVIGATE_EVENT, SettingsNavigatePayload } from "../../lib/hotkeyEvents";
import { getPermissionsPassed, setPermissionsPassed, getHistory, HistoryEntry } from "../../lib/store";
import { checkAllPermissions } from "../../lib/permissions";
import { logError } from "../../lib/logger";
import { UserPanel } from "../../components/UserPanel";

type Tab = "main" | "settings" | "model" | "style";

function resolveInitialTab(): Tab {
  const requestedTab = new URLSearchParams(window.location.search).get("tab");

  if (requestedTab === "settings" || requestedTab === "model" || requestedTab === "style") {
    return requestedTab;
  }

  return "main";
}

const TABS: { id: Tab; label: string; icon: LucideIcon; note: string }[] = [
  { id: "main", label: "Главное", icon: Home, note: "История записей" },
  { id: "settings", label: "Настройки", icon: Sliders, note: "Язык, микрофон и горячая клавиша" },
  { id: "model", label: "Подписка", icon: Cpu, note: "Ключи и подключение модели" },
  { id: "style", label: "Стиль", icon: Sparkles, note: "Обработка текста" },
];

function TabButton({ tab, isActive, onClick }: { tab: typeof TABS[0]; isActive: boolean; onClick: () => void }) {
  const Icon = tab.icon;

  return (
    <button onClick={onClick} className={`nav-item ${isActive ? "active" : ""}`} style={{ width: "100%", textAlign: "left", font: "inherit" }}>
      <Icon size={18} strokeWidth={isActive ? 2.2 : 1.6} />
      <span>{tab.label}</span>
    </button>
  );
}

function SidebarLogo() {
  return (
    <div style={{ padding: "4px 8px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 3, height: 22 }}>
          {[8, 16, 11, 19, 10].map((height, index) => (
            <span
              key={index}
              style={{
                display: "block",
                width: 3,
                height,
                borderRadius: 999,
                background: "#000",
                animation: `voice-logo-pulse 1.15s ease-in-out ${index * 0.1}s infinite`,
              }}
            />
          ))}
        </div>
        <div style={{ fontSize: 30, lineHeight: 0.95, fontWeight: 800, letterSpacing: "-0.06em", fontFamily: "var(--font-brand)", color: "var(--text-hi)" }}>
          Talk Flow
        </div>
      </div>
    </div>
  );
}

export function SettingsApp() {
  const [activeTab, setActiveTab] = useState<Tab>(resolveInitialTab);
  const [navigationNonce, setNavigationNonce] = useState(0);
  const [showPermissions, setShowPermissions] = useState<boolean | null>(null);
  const [initialHistory, setInitialHistory] = useState<HistoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getPermissionsPassed(), checkAllPermissions(), getHistory()])
      .then(([passed, permissions, history]) => {
        const hasAllPermissions = permissions.microphone === "granted" && permissions.accessibility === "granted";
        setInitialHistory(history);
        setShowPermissions(!(passed && hasAllPermissions));
        setLoadError(null);
      })
      .catch((error) => {
        void logError("SETTINGS_APP", `Failed to load initial state: ${error instanceof Error ? error.message : String(error)}`);
        setInitialHistory([]);
        setShowPermissions(false);
        setLoadError("Не удалось загрузить состояние приложения. Некоторые данные могут быть недоступны.");
      });
  }, []);

  useEffect(() => {
    const unlisten = listen<SettingsNavigatePayload>(SETTINGS_NAVIGATE_EVENT, ({ payload }) => {
      setActiveTab(payload.tab);
      setNavigationNonce((current) => current + 1);

      requestAnimationFrame(() => {
        document.querySelector("main")?.scrollTo({ top: 0, left: 0, behavior: "auto" });
      });
    });

    return () => {
      unlisten.then((dispose) => dispose());
    };
  }, []);

  const handlePermissionsComplete = async () => {
    await setPermissionsPassed(true);
    setShowPermissions(false);
  };

  if (showPermissions === null || initialHistory === null) {
    return (
      <div className="app-root" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="card" style={{ width: 420, textAlign: "center" }}>
          <div style={{ fontSize: 14, color: "var(--text-mid)" }}>Загружаем настройки…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-root">
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", position: "relative", zIndex: 1 }}>
        <TitleBar />

        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <aside
            style={{
              width: 254,
              padding: "14px 12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              background: "rgba(250,249,246,0.92)",
              overflowY: "auto",
              flexShrink: 0,
              marginTop: -1,
            }}
          >
            <SidebarLogo />

            <nav style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {TABS.map((t) => (
                <TabButton key={t.id} tab={t} isActive={activeTab === t.id} onClick={() => setActiveTab(t.id)} />
              ))}
            </nav>

            <UserPanel />
          </aside>

          <main style={{ flex: 1, padding: "18px 24px 24px", overflowY: "auto", overflowX: "hidden", position: "relative", background: "rgba(250,249,246,0.72)" }}>
            <div style={{ maxWidth: 920, margin: "0 auto", minWidth: 0, overflowX: "hidden" }}>
              {loadError && (
                <div className="card" style={{ marginBottom: 14, padding: "12px 14px", background: "rgba(143,45,32,0.08)", border: "1px solid rgba(143,45,32,0.18)", color: "var(--danger)" }}>
                  {loadError}
                </div>
              )}
              <div key={`${activeTab}:${navigationNonce}`} style={{ animation: "slide-down 0.18s ease" }}>
                {activeTab === "main" && <MainTab initialHistory={initialHistory} />}
                {activeTab === "settings" && <SettingsTab />}
                {activeTab === "model" && <SettingsTabs type="model" />}
                {activeTab === "style" && <SettingsTabs type="style" />}
              </div>
            </div>
          </main>
        </div>
      </div>

      {showPermissions && <PermissionScreen onComplete={handlePermissionsComplete} />}
    </div>
  );
}
