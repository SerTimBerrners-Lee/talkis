import { useState, useEffect, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LogOut, User, Crown } from "lucide-react";

import { CloudProfile, fetchCloudProfile, cloudLogout, getAuthLoginUrl } from "../lib/cloudAuth";
import { logError, logInfo } from "../lib/logger";

export function UserPanel() {
  const [profile, setProfile] = useState<CloudProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchCloudProfile();
      setProfile(data);
    } catch (error) {
      logError("USER_PANEL", `Failed to load profile: ${error}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const handleActivate = async () => {
    try {
      // Open auth URL in default browser via Tauri command
      await openUrl(getAuthLoginUrl());
    } catch (error) {
      logError("USER_PANEL", `Failed to open auth URL: ${error}`);
    }
  };

  const handleLogout = async () => {
    await cloudLogout();
    setProfile(null);
    logInfo("USER_PANEL", "User logged out");
  };

  if (loading) {
    return <div style={styles.container} />;
  }

  // ── Authenticated + active subscription ─────────────────────
  if (profile && profile.subscription.active) {
    return (
      <div style={styles.container}>
        <div style={styles.profileRow}>
          <div style={styles.avatar}>
            {profile.user.avatarUrl ? (
              <img
                src={profile.user.avatarUrl}
                alt=""
                style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }}
              />
            ) : (
              <User size={16} strokeWidth={1.5} color="var(--text-low)" />
            )}
          </div>
          <div style={styles.profileInfo}>
            <div style={styles.profileName}>
              {profile.user.login || profile.user.email.split("@")[0]}
            </div>
            <div style={styles.profileEmail}>{profile.user.email}</div>
          </div>
          <button onClick={handleLogout} style={styles.logoutButton} title="Выйти">
            <LogOut size={14} strokeWidth={1.8} />
          </button>
        </div>
        <div style={styles.badgeActive}>
          <div style={styles.badgeDot} />
          Подписка активна
        </div>
      </div>
    );
  }

  // ── Authenticated but no active subscription ────────────────
  if (profile && !profile.subscription.active) {
    return (
      <div style={styles.container}>
        <div style={{ ...styles.profileRow, marginBottom: 10 }}>
          <div style={styles.avatar}>
            <User size={16} strokeWidth={1.5} color="var(--text-low)" />
          </div>
          <div style={styles.profileInfo}>
            <div style={styles.profileName}>
              {profile.user.login || profile.user.email.split("@")[0]}
            </div>
            <div style={styles.profileEmail}>{profile.user.email}</div>
          </div>
          <button onClick={handleLogout} style={styles.logoutButton} title="Выйти">
            <LogOut size={14} strokeWidth={1.8} />
          </button>
        </div>
        <SubscriptionCTA onActivate={handleActivate} />
      </div>
    );
  }

  // ── Not authenticated ───────────────────────────────────────
  return (
    <div style={styles.container}>
      <SubscriptionCTA onActivate={handleActivate} />
    </div>
  );
}

function SubscriptionCTA({ onActivate }: { onActivate: () => void }) {
  return (
    <div style={styles.ctaBox}>
      <div style={styles.ctaHeader}>
        <Crown size={14} strokeWidth={2} color="var(--text-hi)" />
        <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: "-0.02em", color: "var(--text-hi)" }}>
          Активируйте TalkFlow
        </span>
      </div>

      <ul style={styles.ctaList}>
        <li>Безлимитное использование</li>
        <li>Без VPN и Прокси</li>
        <li>Синхронизация устройств</li>
      </ul>

      <div style={styles.ctaPrice}>
        <span style={{ textDecoration: "line-through", opacity: 0.4, fontSize: 11, color: "var(--text-low)" }}>1 500 ₽</span>
        <span style={{ fontWeight: 800, fontSize: 16, color: "var(--text-hi)" }}>390 ₽</span>
        <span style={{ opacity: 0.5, fontSize: 10, color: "var(--text-low)" }}>/ мес</span>
      </div>

      <button onClick={onActivate} style={styles.ctaButton}>
        Активировать
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    marginTop: "auto",
    padding: "12px 0 0",
    borderTop: "1px solid rgba(0,0,0,0.06)",
  },
  profileRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "4px 8px",
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    background: "rgba(0,0,0,0.05)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
  },
  profileInfo: {
    flex: 1,
    minWidth: 0,
  },
  profileName: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-hi)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  profileEmail: {
    fontSize: 11,
    color: "var(--text-low)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  logoutButton: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 6,
    borderRadius: 6,
    color: "var(--text-low)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "color 0.15s, background 0.15s",
  },
  badgeActive: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    margin: "6px 8px 0",
    borderRadius: 8,
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text-hi)",
    background: "rgba(0,0,0,0.04)",
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#000",
    flexShrink: 0,
  },
  ctaBox: {
    padding: "14px 14px",
    borderRadius: 10,
    background: "rgba(0,0,0,0.03)",
    border: "1px solid rgba(0,0,0,0.06)",
    margin: "0 4px",
  },
  ctaHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  ctaList: {
    listStyle: "none",
    padding: 0,
    margin: "0 0 10px",
    fontSize: 11,
    lineHeight: 1.8,
    color: "var(--text-mid)",
  },
  ctaPrice: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    marginBottom: 12,
  },
  ctaButton: {
    width: "100%",
    padding: "10px",
    borderRadius: 8,
    background: "#000",
    color: "#fff",
    border: "none",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    cursor: "pointer",
    transition: "opacity 0.15s",
    fontFamily: "var(--font)",
  },
};
