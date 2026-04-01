/**
 * TalkFlow Cloud authentication client.
 *
 * Handles communication with talkis.ru API for:
 * - Fetching user profile and subscription status
 * - Deep link token handling
 * - Logout
 */

import { getSettings, saveSettings } from "./store";
import { logError, logInfo } from "./logger";

const CLOUD_API_BASE = "https://talkis.ru";

export interface CloudUser {
  id: string;
  email: string;
  login: string | null;
  avatarUrl: string | null;
}

export interface CloudSubscription {
  active: boolean;
  status: string; // "active" | "expired" | "cancelled" | "none"
  plan: string | null;
  expiresAt: string | null;
}

export interface CloudProfile {
  user: CloudUser;
  subscription: CloudSubscription;
}

/**
 * Fetch user profile and subscription status from the cloud.
 * Returns null if token is missing or invalid.
 */
export async function fetchCloudProfile(): Promise<CloudProfile | null> {
  const settings = await getSettings();
  const token = settings.deviceToken;

  if (!token) {
    return null;
  }

  try {
    const response = await fetch(`${CLOUD_API_BASE}/api/subscription/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401) {
      logInfo("CLOUD", "Device token invalid, clearing");
      await saveSettings({ deviceToken: "" });
      return null;
    }

    if (!response.ok) {
      logError("CLOUD", `API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data as CloudProfile;
  } catch (error) {
    logError("CLOUD", `Failed to fetch profile: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Save device token received from deep link callback.
 */
export async function handleAuthToken(token: string): Promise<void> {
  logInfo("CLOUD", "Received auth token from deep link");
  await saveSettings({ deviceToken: token });
}

/**
 * Clear device token (logout).
 */
export async function cloudLogout(): Promise<void> {
  logInfo("CLOUD", "Logging out");
  await saveSettings({ deviceToken: "" });
}

/**
 * Check if user is authenticated with cloud.
 */
export async function isCloudAuthenticated(): Promise<boolean> {
  const settings = await getSettings();
  return settings.deviceToken.length > 0;
}

/**
 * Get the auth login URL for opening in browser.
 */
export function getAuthLoginUrl(): string {
  return `${CLOUD_API_BASE}/auth/login?device=true`;
}
