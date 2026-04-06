import { invoke } from "@tauri-apps/api/core";

export async function logInfo(tag: string, message: string): Promise<void> {
  console.log(`[${tag}] ${message}`);
  try {
    await invoke("log_event", { level: "INFO", tag, message });
  } catch {
    // ignore Tauri errors
  }
}

export async function logError(tag: string, message: string): Promise<void> {
  console.error(`[${tag}] ${message}`);
  try {
    await invoke("log_event", { level: "ERROR", tag, message });
  } catch {
    // ignore Tauri errors
  }
}

export async function logDebug(tag: string, message: string): Promise<void> {
  console.log(`[${tag}] ${message}`);
  try {
    await invoke("log_event", { level: "DEBUG", tag, message });
  } catch {
    // ignore Tauri errors
  }
}

export async function getLogPath(): Promise<string> {
  try {
    return await invoke("get_log_path_cmd");
  } catch {
    return "~/.talkis/talkis.log";
  }
}

export async function clearLogs(): Promise<void> {
  try {
    await invoke("clear_logs");
  } catch {
    // ignore
  }
}