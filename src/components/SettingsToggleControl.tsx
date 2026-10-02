import type { ReactElement } from "react";

interface SettingsToggleControlProps {
  enabled: boolean;
  disabled?: boolean;
  label: string;
  ariaLabel: string;
  describedBy?: string;
  onToggle: () => void;
}

/** Shared switch presentation used by the general settings rows. */
export function SettingsToggleControl({
  enabled,
  disabled = false,
  label,
  ariaLabel,
  describedBy,
  onToggle,
}: SettingsToggleControlProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onToggle}
      className="btn"
      style={{
        width: "100%",
        minHeight: 38,
        padding: "0 10px",
        borderRadius: 8,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 34px",
        alignItems: "center",
        gap: 10,
        opacity: disabled ? 0.72 : 1,
        cursor: disabled ? "wait" : "pointer",
        transform: "none",
        justifySelf: "end",
      }}
    >
      <span
        style={{
          color: "var(--text-hi)",
          fontSize: 12,
          fontWeight: 700,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        style={{
          width: 34,
          height: 20,
          borderRadius: 999,
          background: enabled ? "var(--accent)" : "var(--switch-track)",
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
            transform: enabled ? "translateX(14px)" : "translateX(0)",
            transition: "transform 0.18s ease",
          }}
        />
      </span>
    </button>
  );
}
