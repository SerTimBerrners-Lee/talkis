import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  const statusLabel = isGranted ? "Готово" : isPrompting ? "Проверьте" : isDenied ? "Нужно действие" : "Не выдано";

  return (
    <div
      className="card"
      style={{
        padding: 20,
        display: "flex",
        alignItems: "flex-start",
        gap: 16,
        background: isGranted ? "rgba(255,255,255,0.88)" : "var(--surface)",
      }}
    >
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: isGranted ? "#000" : "rgba(255,255,255,0.7)",
          color: isGranted ? "#fff" : "var(--text-mid)",
          flexShrink: 0,
        }}
      >
        {isGranted ? <Check size={18} strokeWidth={2.5} /> : icon}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)", marginBottom: 2 }}>{title}</div>
            <div className="label">{statusLabel}</div>
          </div>

          {!isGranted && (
            <button onClick={onAction} className={isPrompting ? "btn" : "btn btn-primary"} style={{ minWidth: 124 }}>
              {isPrompting ? "Проверить" : isDenied ? "Повторить" : "Разрешить"}
            </button>
          )}
        </div>

        <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>{description}</div>
        {helpText && <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-low)", lineHeight: 1.55 }}>{helpText}</div>}
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
      await invoke("open_accessibility_settings");
      setAccStatus("prompting");
    } catch (e) {
      void logError("PERMISSIONS", `Failed to open accessibility settings: ${e instanceof Error ? e.message : String(e)}`);
      setAccStatus("denied");
    }
  };

  const handleContinue = async () => {
    const { nextMicStatus, nextAccStatus } = await refreshAllPermissions();

    if (nextMicStatus !== "granted" || nextAccStatus !== "granted") {
      return;
    }

    await invoke("widget_resize", { width: IDLE_WIDGET_WIDTH, height: IDLE_WIDGET_HEIGHT });
    onComplete();
  };

  const canContinue = micStatus === "granted" && accStatus === "granted";
  const shouldShowInstallWarning = Boolean(runtimeInfo?.shouldMoveToApplications);

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
          className="card"
          style={{
            width: "min(100%, 760px)",
            padding: 28,
            display: "flex",
            flexDirection: "column",
            gap: 22,
            boxShadow: "var(--shadow-panel)",
          }}
        >
          <div style={{ display: "grid", gap: 10 }}>
            <div className="label kicker">System Access</div>
            <h1 className="headline-accent" style={{ fontSize: 40, lineHeight: 0.96, margin: 0, fontWeight: 700 }}>
              Доступы для Talk Flow
            </h1>
            <p style={{ margin: 0, maxWidth: 560, fontSize: 14, color: "var(--text-mid)", lineHeight: 1.7 }}>
              Интерфейс уже готов. Осталось выдать системные разрешения для записи с микрофона и работы глобальной горячей клавиши.
            </p>
          </div>

          <div style={{ display: "grid", gap: 14 }}>
            {shouldShowInstallWarning && (
              <div
                className="card"
                style={{
                  padding: 18,
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  background: "rgba(143,45,32,0.08)",
                  border: "1px solid rgba(143,45,32,0.18)",
                }}
              >
                <AlertCircle size={16} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 1 }} />
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--danger)" }}>
                    Сначала переместите приложение в Applications
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
                    Текущая сборка запущена из временного или смонтированного места (`/Volumes` или App Translocation). Для релизной версии macOS может не применять универсальный доступ корректно в таком режиме. Переместите `Talk Flow.app` в `Applications`, откройте его оттуда и только потом выдавайте доступ.
                  </div>
                </div>
              </div>
            )}

            <PermissionRow
              icon={<Mic size={18} strokeWidth={1.75} />}
              title="Микрофон"
              description="Нужен для записи голоса перед отправкой на распознавание."
              status={micStatus}
              onAction={handleMicRequest}
            />

            <PermissionRow
              icon={<Keyboard size={18} strokeWidth={1.75} />}
              title="Универсальный доступ"
              description="Нужен для глобальной горячей клавиши и вставки текста в активное приложение."
              status={accStatus}
              onAction={handleAccessibilityRequest}
              helpText="Откроются системные настройки macOS. После выдачи доступа вернитесь сюда и нажмите «Продолжить»."
            />
          </div>

          {(accStatus === "prompting" || micStatus === "denied") && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "14px 16px",
                borderRadius: 18,
                border: "1px solid rgba(0,0,0,0.08)",
                background: "rgba(255,255,255,0.56)",
              }}
            >
              <AlertCircle size={15} style={{ color: "var(--text-low)", flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.6 }}>
              {micStatus === "denied"
                  ? "Если микрофон был отклонен ранее, откройте Системные настройки -> Конфиденциальность и безопасность -> Микрофон и включите Talk Flow вручную."
                  : shouldShowInstallWarning
                    ? "После перемещения приложения в Applications откройте его заново и повторите выдачу доступа."
                    : "macOS применяет доступ к универсальному доступу не мгновенно. После изменения системной настройки просто вернитесь в приложение и продолжите."}
              </div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 18, paddingTop: 6 }}>
            <div style={{ fontSize: 12, color: canContinue ? "var(--success)" : "var(--text-low)", lineHeight: 1.55 }}>
              {canContinue ? "Все доступы выданы." : "Продолжение станет доступно после проверки обоих разрешений."}
            </div>
            <button
              onClick={handleContinue}
              className={canContinue ? "btn btn-primary" : "btn"}
              style={{ minWidth: 160 }}
            >
              {canContinue ? "Продолжить" : "Проверить доступы"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
