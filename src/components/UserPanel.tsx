import { useState, useEffect, useCallback, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { LogOut, User, Crown } from "lucide-react";

import { CloudProfile, fetchCloudProfile, cloudLogout, getAuthLoginUrl, handleAuthToken, generateExchangeCode, getAuthLoginUrlWithCode, pollForToken } from "../lib/cloudAuth";
import { logError, logInfo } from "../lib/logger";

/** Extract token from talkis://auth?token=... */
function extractTokenFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("token") || null;
  } catch {
    return null;
  }
}

export function UserPanel() {
  const [profile, setProfile] = useState<CloudProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [waitingForAuth, setWaitingForAuth] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const exchangeCodeRef = useRef<string | null>(null);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchCloudProfile();
      setProfile(data);
      if (data) {
        // Got profile — stop polling
        setWaitingForAuth(false);
      }
    } catch (error) {
      logError("USER_PANEL", `Failed to load profile: ${error}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  // ── Deep link: Rust event ─────────────────────────────────
  useEffect(() => {
    const unlistenPromise = listen<string>("deep-link-auth", async (event) => {
      logInfo("USER_PANEL", "Received auth token via Tauri event");
      await handleAuthToken(event.payload);
      await loadProfile();
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [loadProfile]);

  // ── Deep link: JS plugin API ──────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        await onOpenUrl(async (urls) => {
          if (cancelled) return;
          for (const url of urls) {
            logInfo("USER_PANEL", `Deep link (JS): ${url}`);
            const token = extractTokenFromUrl(url);
            if (token) {
              await handleAuthToken(token);
              await loadProfile();
            }
          }
        });
      } catch (err) {
        // Plugin may not be available in dev mode
        logInfo("USER_PANEL", `Deep link JS API unavailable: ${err}`);
      }
    };

    void setup();

    return () => {
      cancelled = true;
    };
  }, [loadProfile]);

  // ── Polling fallback via exchange code ──────────────────────
  useEffect(() => {
    if (!waitingForAuth) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    logInfo("USER_PANEL", `Starting auth polling with code: ${exchangeCodeRef.current?.slice(0, 8)}...`);
    pollingRef.current = setInterval(async () => {
      const code = exchangeCodeRef.current;
      if (!code) return;

      const token = await pollForToken(code);
      if (token) {
        logInfo("USER_PANEL", "Auth polling: token received!");
        await handleAuthToken(token);
        const data = await fetchCloudProfile();
        if (data) {
          setProfile(data);
        }
        setWaitingForAuth(false);
        exchangeCodeRef.current = null;
      }
    }, 3000);

    // Stop polling after 2 minutes
    const timeout = setTimeout(() => {
      logInfo("USER_PANEL", "Auth polling timed out");
      setWaitingForAuth(false);
    }, 120_000);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      clearTimeout(timeout);
    };
  }, [waitingForAuth]);

  const handleActivate = async () => {
    try {
      // Generate exchange code for polling
      const code = generateExchangeCode();
      exchangeCodeRef.current = code;

      const url = profile
        ? `${getAuthLoginUrl().replace('/auth/login?device=true', '/dashboard')}`
        : getAuthLoginUrlWithCode(code);
      await openUrl(url);
      // Start polling for token via exchange code
      setWaitingForAuth(true);
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
        <ProfileRow profile={profile} onLogout={handleLogout} />
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
        <ProfileRow profile={profile} onLogout={handleLogout} />
        <button onClick={handleActivate} style={styles.compactCta}>
          <Crown size={13} strokeWidth={2} color="#fff" />
          <span style={styles.compactCtaLabel}>Активировать подписку</span>
        </button>
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

function ProfileRow({ profile, onLogout }: { profile: CloudProfile; onLogout: () => void }) {
  return (
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
      <button onClick={onLogout} style={styles.logoutButton} title="Выйти">
        <LogOut size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
}

function SubscriptionCTA({ onActivate }: { onActivate: () => void }) {
  return (
    <div style={styles.ctaBox}>
      <div style={styles.ctaHeader}>
        <Crown size={14} strokeWidth={2} color="var(--text-hi)" />
        <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: "-0.02em", color: "var(--text-hi)" }}>
          Активируйте Talkis
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
  compactCta: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    width: "calc(100% - 16px)",
    margin: "8px 8px 0",
    padding: "10px",
    borderRadius: 8,
    background: "#000",
    color: "#fff",
    border: "none",
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    lineHeight: 1,
    whiteSpace: "nowrap" as const,
    cursor: "pointer",
    transition: "opacity 0.15s",
    fontFamily: "var(--font)",
  },
  compactCtaLabel: {
    display: "flex",
    alignItems: "center",
    lineHeight: 1,
    whiteSpace: "nowrap" as const,
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
