import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { logError, logInfo } from "./logger";

const FIRST_UPDATE_CHECK_DELAY_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

interface StartAppUpdateSchedulerOptions {
  canRunUpdate: () => boolean;
}

let schedulerStarted = false;

async function runAppUpdateCheck(canRunUpdate: () => boolean): Promise<void> {
  if (import.meta.env.DEV) {
    return;
  }

  if (!canRunUpdate()) {
    logInfo("UPDATER", "Skipped update check while app is busy");
    return;
  }

  try {
    logInfo("UPDATER", "Checking for updates");
    const update = await check({ timeout: UPDATE_CHECK_TIMEOUT_MS });

    if (!update) {
      logInfo("UPDATER", "No updates available");
      return;
    }

    if (!canRunUpdate()) {
      logInfo("UPDATER", `Update ${update.version} found, install deferred because app is busy`);
      return;
    }

    logInfo("UPDATER", `Update ${update.version} found, downloading and installing`);
    await update.downloadAndInstall(undefined, { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS });

    logInfo("UPDATER", "Update installed, relaunching app");
    await relaunch();
  } catch (error) {
    logError("UPDATER", `Update check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function startAppUpdateScheduler({ canRunUpdate }: StartAppUpdateSchedulerOptions): () => void {
  if (schedulerStarted) {
    return () => {};
  }

  schedulerStarted = true;

  const firstCheckTimer = window.setTimeout(() => {
    void runAppUpdateCheck(canRunUpdate);
  }, FIRST_UPDATE_CHECK_DELAY_MS);

  const interval = window.setInterval(() => {
    void runAppUpdateCheck(canRunUpdate);
  }, UPDATE_CHECK_INTERVAL_MS);

  return () => {
    schedulerStarted = false;
    window.clearTimeout(firstCheckTimer);
    window.clearInterval(interval);
  };
}
