import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Mic, Keyboard, Check, AlertCircle } from "lucide-react";
import {
  PermissionStatus,
  checkAccessibilityPermission,
  checkMicrophonePermission,
  requestMicrophonePermission,
} from "../lib/permissions";
import { logError } from "../lib/logger";
import { IDLE_WIDGET_HEIGHT, IDLE_WIDGET_WIDTH } from "../windows/widget/widgetConstants";

interface PermissionRowProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  status: PermissionStatus;
  onAction: () => void;
  helpText?: string;
}

function PermissionRow({ icon, title, description, status, onAction, helpText }: PermissionRowProps) {
  const isGranted = status === "granted";
  const isDenied = status === "denied";
  const isPrompting = status === "prompting";

  return (
    <div
      style={{
        padding: "16px 18px",
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
        borderRadius: 10,
        background: isGranted ? "rgba(0,0,0,0.02)" : "rgba(0,0,0,0.02)",
        border: `1px solid ${isGranted ? "rgba(0,0,0,0.06)" : "rgba(0,0,0,0.06)"}`,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: isGranted ? "#000" : "rgba(0,0,0,0.04)",
          color: isGranted ? "#fff" : "var(--text-mid)",
          flexShrink: 0,
        }}
      >
        {isGranted ? <Check size={16} strokeWidth={2.5} /> : icon}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-hi)" }}>{title}</div>
            <span style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: isGranted ? "var(--success)" : "var(--text-low)",
            }}>
              {isGranted ? "Готово" : isPrompting ? "Проверьте" : isDenied ? "Нужно действие" : "Не выдано"}
            </span>
          </div>

          {!isGranted && (
            <button
              onClick={onAction}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                cursor: "pointer",
                border: "none",
                background: isPrompting ? "rgba(0,0,0,0.04)" : "#000",
                color: isPrompting ? "var(--text-hi)" : "#fff",
                fontFamily: "var(--font)",
                transition: "opacity 0.15s",
              }}
            >
              {isPrompting ? "Проверить" : isDenied ? "Повторить" : "Разрешить"}
            </button>
          )}
        </div>

        <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>{description}</div>
        {helpText && <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-low)", lineHeight: 1.55 }}>{helpText}</div>}
      </div>
    </div>
  );
}

interface PermissionScreenProps {
  onComplete: () => void;
}

interface AppRuntimeInfo {
  executablePath: string;
  bundlePath: string;
  launchedViaTranslocation: boolean;
  launchedFromMountedVolume: boolean;
  shouldMoveToApplications: boolean;
}

export function PermissionScreen({ onComplete }: PermissionScreenProps) {
  const [micStatus, setMicStatus] = useState<PermissionStatus>("unknown");
  const [accStatus, setAccStatus] = useState<PermissionStatus>("unknown");
  const [runtimeInfo, setRuntimeInfo] = useState<AppRuntimeInfo | null>(null);

  const refreshAccessibilityStatus = useCallback(async () => {
    const nextStatus = await checkAccessibilityPermission();

    setAccStatus((current) => {
      if (nextStatus === "granted") {
        return "granted";
      }

      return current === "prompting" ? "prompting" : nextStatus;
    });

    return nextStatus;
  }, []);

  const refreshAllPermissions = useCallback(async () => {
    const [nextMicStatus, nextAccStatus] = await Promise.all([
      checkMicrophonePermission(),
      refreshAccessibilityStatus(),
    ]);

    setMicStatus(nextMicStatus);
    return { nextMicStatus, nextAccStatus };
  }, [refreshAccessibilityStatus]);

  useEffect(() => {
    void refreshAllPermissions();
  }, [refreshAllPermissions]);

  useEffect(() => {
    invoke<AppRuntimeInfo>("get_app_runtime_info")
      .then(setRuntimeInfo)
      .catch((error) => {
        void logError("PERMISSIONS", `Failed to load runtime info: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, []);

  useEffect(() => {
    if (accStatus !== "prompting") {
      return;
    }

    const refreshOnReturn = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void refreshAccessibilityStatus();
    };

    const intervalId = window.setInterval(() => {
      void refreshAccessibilityStatus();
    }, 1000);

    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [accStatus, refreshAccessibilityStatus]);

  const handleMicRequest = async () => {
    setMicStatus("prompting");
    const granted = await requestMicrophonePermission();
    setMicStatus(granted ? "granted" : "denied");
  };

  const handleAccessibilityRequest = async () => {
    if (accStatus === "prompting") {
      await refreshAccessibilityStatus();
      return;
    }

    try {
      await invoke("reset_accessibility_permission");
    } catch (e) {
      void logError("PERMISSIONS", `Failed to reset accessibility permission: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      await invoke("open_accessibility_settings");
      setAccStatus("prompting");
    } catch (e) {
      void logError("PERMISSIONS", `Failed to open accessibility settings: ${e instanceof Error ? e.message : String(e)}`);
      setAccStatus("denied");
    }
  };

  const handleContinue = async () => {
    if (shouldShowInstallWarning) {
      await openPath("/Applications");
      return;
    }

    const { nextMicStatus, nextAccStatus } = await refreshAllPermissions();

    if (nextMicStatus !== "granted" || nextAccStatus !== "granted") {
      return;
    }

    await invoke("widget_resize", { width: IDLE_WIDGET_WIDTH, height: IDLE_WIDGET_HEIGHT });
    onComplete();
  };

  const canContinue = micStatus === "granted" && accStatus === "granted";
  // In dev mode the binary lives in the build target dir (e.g. /Volumes/...),
  // which is not /Applications — but that's expected, so skip the warning.
  const shouldShowInstallWarning = import.meta.env.DEV
    ? false
    : Boolean(runtimeInfo?.shouldMoveToApplications);
  const canCompleteOnboarding = canContinue && !shouldShowInstallWarning;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(244, 241, 235, 0.72)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        zIndex: 9999,
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: "min(100%, 680px)",
            padding: "28px 28px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 20,
            borderRadius: 14,
            background: "rgba(255,255,255,0.82)",
            border: "1px solid rgba(0,0,0,0.08)",
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
            boxShadow: "0 16px 40px rgba(0,0,0,0.08)",
          }}
        >
          {/* Header */}
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--text-low)",
            }}>
              Настройка доступов
            </div>
            <h1 style={{
              fontSize: 28,
              lineHeight: 1,
              margin: 0,
              fontWeight: 800,
              fontFamily: "var(--font-brand)",
              letterSpacing: "-0.04em",
              color: "var(--text-hi)",
            }}>
              Доступы для Talkis
            </h1>
            <p style={{ margin: 0, maxWidth: 520, fontSize: 13, color: "var(--text-mid)", lineHeight: 1.7 }}>
              Осталось выдать системные разрешения для записи с микрофона и работы глобальной горячей клавиши.
            </p>
          </div>

          {/* Permission rows */}
          <div style={{ display: "grid", gap: 10 }}>
            {shouldShowInstallWarning && (
              <div
                style={{
                  padding: "14px 16px",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  borderRadius: 10,
                  background: "rgba(143,45,32,0.06)",
                  border: "1px solid rgba(143,45,32,0.14)",
                }}
              >
                <AlertCircle size={16} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 1 }} />
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--danger)" }}>
                    Переместите приложение в Applications
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.6 }}>
                    Текущая сборка запущена из временного места. Переместите Talkis в Applications и откройте оттуда.
                  </div>
                </div>
              </div>
            )}

            <PermissionRow
              icon={<Mic size={16} strokeWidth={1.8} />}
              title="Микрофон"
              description="Нужен для записи голоса перед отправкой на распознавание."
              status={micStatus}
              onAction={handleMicRequest}
            />

            <PermissionRow
              icon={<Keyboard size={16} strokeWidth={1.8} />}
              title="Универсальный доступ"
              description="Нужен для глобальной горячей клавиши и вставки текста."
              status={shouldShowInstallWarning ? "denied" : accStatus}
              onAction={() => {
                if (shouldShowInstallWarning) {
                  void openPath("/Applications");
                  return;
                }

                void handleAccessibilityRequest();
              }}
              helpText={shouldShowInstallWarning
                ? `Приложение запущено не из Applications: ${runtimeInfo?.bundlePath ?? "—"}`
                : undefined}
            />
          </div>

          {/* Hint */}
          {(accStatus === "prompting" || micStatus === "denied") && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "12px 14px",
                borderRadius: 10,
                background: "rgba(0,0,0,0.02)",
                border: "1px solid rgba(0,0,0,0.06)",
              }}
            >
              <AlertCircle size={14} style={{ color: "var(--text-low)", flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.6 }}>
              {micStatus === "denied"
                  ? "Если микрофон был отклонен, откройте Системные настройки → Конфиденциальность → Микрофон и включите Talkis."
                  : shouldShowInstallWarning
                    ? "После перемещения приложения в Applications откройте его заново."
                    : "macOS применяет доступ не мгновенно. После изменения настройки вернитесь в приложение."}
              </div>
            </div>
          )}

          {/* Footer */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
            <div style={{ fontSize: 12, color: canContinue ? "var(--success)" : "var(--text-low)", lineHeight: 1.55 }}>
              {shouldShowInstallWarning
                ? "Сначала запустите из Applications."
                : canContinue
                  ? "Все доступы выданы."
                  : "Выдайте оба разрешения для продолжения."}
            </div>
            <button
              onClick={handleContinue}
              style={{
                padding: "10px 20px",
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                cursor: "pointer",
                border: "none",
                background: canCompleteOnboarding ? "#000" : "rgba(0,0,0,0.04)",
                color: canCompleteOnboarding ? "#fff" : "var(--text-hi)",
                fontFamily: "var(--font)",
                transition: "opacity 0.15s",
                minWidth: 140,
              }}
            >
              {canCompleteOnboarding ? "Продолжить" : shouldShowInstallWarning ? "Applications" : "Проверить"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
