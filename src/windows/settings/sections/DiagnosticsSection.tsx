import { useEffect, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useI18n } from "../../../lib/i18n";
import { getLogPath, logError } from "../../../lib/logger";

/** Match the neighboring general-settings rows and their folder controls. */
export function DiagnosticsSection(): ReactElement {
  const { t } = useI18n();
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let mounted = true;

    void getLogPath().then((value) => {
      if (mounted) setPath(value);
    });

    return (): void => {
      mounted = false;
    };
  }, []);

  const openFolder = async (): Promise<void> => {
    setPending(true);
    setError("");

    try {
      await invoke("open_log_folder");
    } catch (failure) {
      setError(t("settings.diagnostics.openFailed"));
      void logError("SETTINGS", `Could not open log folder: ${String(failure)}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gap: 10,
        padding: "12px 0",
        borderTop: "1px solid var(--border-subtle)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 280px",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div style={{ minWidth: 0, fontSize: 13, fontWeight: 700, color: "var(--text-hi)" }}>
          {t("settings.diagnostics.title")}
        </div>
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => { void openFolder(); }}
          style={{
            minHeight: 38,
            width: "100%",
            justifySelf: "end",
            justifyContent: "center",
            padding: "0 10px",
            borderRadius: 8,
            fontSize: 12,
          }}
        >
          {t("settings.diagnostics.openFolder")}
        </button>
      </div>
      {path && (
        <div style={{ fontSize: 11, color: "var(--text-low)", overflowWrap: "anywhere", userSelect: "text" }}>
          {path}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--text-low)" }}>
        {t("settings.diagnostics.retention")}
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
