import { emit, listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { logError, logInfo } from "./logger";

const FIRST_UPDATE_CHECK_DELAY_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

interface StartAppUpdateSchedulerOptions {
  canRunUpdate: () => boolean;
}

export type AppUpdateStatus = "idle" | "checking" | "available" | "installing" | "error" | "not_available";

export interface AppUpdateState {
  status: AppUpdateStatus;
  version?: string;
  errorMessage?: string;
  checkedAt?: string;
}

const APP_UPDATE_STATE_EVENT = "app-update-state";

let schedulerStarted = false;
let availableUpdate: Update | null = null;
let checkInFlight: Promise<AppUpdateState> | null = null;
let installInFlight: Promise<void> | null = null;
let updateState: AppUpdateState = { status: "idle" };
const listeners = new Set<(state: AppUpdateState) => void>();

function publishUpdateState(nextState: AppUpdateState): AppUpdateState {
  updateState = nextState;
  listeners.forEach((listener) => listener(updateState));
  void emit(APP_UPDATE_STATE_EVENT, updateState).catch((error) => {
    logError("UPDATER", `Failed to emit update state: ${formatUpdateError(error)}`);
  });
  return updateState;
}

function formatUpdateError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function replaceAvailableUpdate(nextUpdate: Update | null): Promise<void> {
  if (availableUpdate && availableUpdate !== nextUpdate) {
    await availableUpdate.close().catch((error) => {
      logError("UPDATER", `Failed to close previous update resource: ${formatUpdateError(error)}`);
    });
  }

  availableUpdate = nextUpdate;
}

export function getAppUpdateState(): AppUpdateState {
  return updateState;
}

export function subscribeToAppUpdateState(listener: (state: AppUpdateState) => void): () => void {
  listeners.add(listener);
  listener(updateState);

  const unlistenPromise = listen<AppUpdateState>(APP_UPDATE_STATE_EVENT, (event) => {
    updateState = event.payload;
    listener(updateState);
  });

  return () => {
    listeners.delete(listener);
    void unlistenPromise.then((unlisten) => unlisten());
  };
}

export async function checkForAppUpdateNow(options: { canRunUpdate?: () => boolean } = {}): Promise<AppUpdateState> {
  if (import.meta.env.DEV) {
    return updateState;
  }

  if (options.canRunUpdate && !options.canRunUpdate()) {
    logInfo("UPDATER", "Skipped update check while app is busy");
    return updateState;
  }

  if (checkInFlight) {
    return checkInFlight;
  }

  checkInFlight = (async () => {
    logInfo("UPDATER", "Checking for updates");
    publishUpdateState({ ...updateState, status: "checking", errorMessage: undefined });
    const update = await check({ timeout: UPDATE_CHECK_TIMEOUT_MS });
    const checkedAt = new Date().toISOString();

    if (!update) {
      await replaceAvailableUpdate(null);
      logInfo("UPDATER", "No updates available");
      return publishUpdateState({ status: "not_available", checkedAt });
    }

    await replaceAvailableUpdate(update);
    logInfo("UPDATER", `Update ${update.version} found, waiting for user install action`);
    return publishUpdateState({ status: "available", version: update.version, checkedAt });
  })();

  try {
    return await checkInFlight;
  } catch (error) {
    const errorMessage = formatUpdateError(error);
    logError("UPDATER", `Update check failed: ${errorMessage}`);
    return publishUpdateState({ status: "error", version: updateState.version, errorMessage, checkedAt: new Date().toISOString() });
  } finally {
    checkInFlight = null;
  }
}

export async function installAvailableAppUpdate(): Promise<void> {
  if (import.meta.env.DEV) {
    return;
  }

  if (installInFlight) {
    return installInFlight;
  }

  installInFlight = (async () => {
    let update = availableUpdate;

    if (!update) {
      const state = await checkForAppUpdateNow();
      if (state.status !== "available" || !availableUpdate) {
        return;
      }
      update = availableUpdate;
    }

    const version = update.version;

    try {
      logInfo("UPDATER", `Installing update ${version}`);
      publishUpdateState({ status: "installing", version, checkedAt: updateState.checkedAt });
      await update.downloadAndInstall(undefined, { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS });
      await replaceAvailableUpdate(null);

      logInfo("UPDATER", "Update installed, relaunching app");
      publishUpdateState({ status: "not_available", checkedAt: new Date().toISOString() });
      await relaunch();
    } catch (error) {
      await replaceAvailableUpdate(null);
      const errorMessage = formatUpdateError(error);
      logError("UPDATER", `Update install failed: ${errorMessage}`);
      publishUpdateState({ status: "error", version, errorMessage, checkedAt: updateState.checkedAt });
      throw error;
    }
  })();

  try {
    await installInFlight;
  } finally {
    installInFlight = null;
  }
}

async function runAppUpdateCheck(canRunUpdate: () => boolean): Promise<void> {
  try {
    await checkForAppUpdateNow({ canRunUpdate });
  } catch (error) {
    // checkForAppUpdateNow already logs and publishes the error state.
    logError("UPDATER", `Unexpected update scheduler error: ${formatUpdateError(error)}`);
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
