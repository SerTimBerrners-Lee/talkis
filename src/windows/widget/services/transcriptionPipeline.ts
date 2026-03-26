import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

import { addHistoryEntry, AppSettings, HistoryEntry, updateHistoryEntry } from "../../../lib/store";
import { logError, logInfo } from "../../../lib/logger";
import { HISTORY_UPDATED_EVENT } from "../../../lib/hotkeyEvents";

export interface ProcessRecordingBlobParams {
  blob: Blob;
  settings: AppSettings;
  recordingStartTimestamp: number;
}

export interface ProcessRecordingBlobResult {
  durationSeconds: number;
  hasTranscription: boolean;
  pasteErrorMessage?: string;
}

export interface RetryHistoryEntryResult {
  hasTranscription: boolean;
  updatedEntry: HistoryEntry;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function toUserFacingErrorMessage(error: unknown): string {
  const raw = formatErrorMessage(error);
  const normalized = raw.toLowerCase();

  if (normalized.includes("unsupported_country_region_territory") || normalized.includes("country, region, or territory not supported")) {
    return "Сервис распознавания сейчас недоступен в вашем регионе. Попробуйте другой endpoint или VPN.";
  }

  if (normalized.includes("403") || normalized.includes("forbidden")) {
    return "Сервис отклонил запрос. Проверьте API-ключ, регион доступа или настройки endpoint.";
  }

  if (normalized.includes("401") || normalized.includes("unauthorized") || normalized.includes("invalid api key")) {
    return "Не удалось авторизоваться в API. Проверьте ваш ключ доступа.";
  }

  if (normalized.includes("429") || normalized.includes("rate limit") || normalized.includes("quota")) {
    return "Превышен лимит запросов или закончилась квота API. Попробуйте позже.";
  }

  if (normalized.includes("network") || normalized.includes("fetch") || normalized.includes("failed to fetch") || normalized.includes("timed out")) {
    return "Не удалось связаться с сервером. Проверьте интернет и попробуйте снова.";
  }

  if (normalized.includes("500") || normalized.includes("502") || normalized.includes("503") || normalized.includes("504") || normalized.includes("server")) {
    return "Сервис временно недоступен. Попробуйте повторить отправку чуть позже.";
  }

  return "Не удалось обработать запись. Попробуйте отправить ее повторно.";
}

function toUserFacingPasteErrorMessage(): string {
  return "Текст распознан, но вставить его не удалось. Скопируйте его из истории.";
}

async function transcribeAudio({
  audioBase64,
  settings,
}: {
  audioBase64: string;
  settings: AppSettings;
}): Promise<{ raw: string; cleaned: string }> {
  logInfo("API", `Sending to backend, audio_size: ${audioBase64.length} chars`);

  const result = await invoke<{ raw: string; cleaned: string }>("transcribe_and_clean", {
    req: {
      audio_base64: audioBase64,
      language: settings.language,
      api_key: settings.apiKey,
      style: settings.style || "classic",
      whisper_endpoint: settings.whisperEndpoint || null,
      llm_endpoint: settings.llmEndpoint || null,
    },
  });

  return result;
}

async function pasteCleanedText(text: string): Promise<void> {
  logInfo("PASTE", "Sending cleaned text to paste_text");
  await invoke("paste_text", { text });
  logInfo("PASTE", "paste_text finished successfully");
}

async function saveAndEmitHistoryEntry(entry: HistoryEntry, mode: "add" | "update"): Promise<void> {
  try {
    if (mode === "add") {
      await addHistoryEntry(entry);
    } else {
      await updateHistoryEntry(entry);
    }

    logInfo("HISTORY", `History entry ${mode === "add" ? "saved" : "updated"}`);
    await emit(HISTORY_UPDATED_EVENT, entry);
  } catch (historyError) {
    logError("HISTORY", `Failed to persist entry: ${formatErrorMessage(historyError)}`);
  }
}

export async function processRecordingBlob({
  blob,
  settings,
  recordingStartTimestamp,
}: ProcessRecordingBlobParams): Promise<ProcessRecordingBlobResult> {
  const buffer = await blob.arrayBuffer();
  const base64Audio = arrayBufferToBase64(buffer);
  const durationSeconds = Math.floor((Date.now() - recordingStartTimestamp) / 1000);

  try {
    const result = await transcribeAudio({
      audioBase64: base64Audio,
      settings,
    });

    if (!result.raw.trim() && !result.cleaned.trim()) {
      logInfo("API", "Nothing recognized, skipping history save and paste");
      return { durationSeconds, hasTranscription: false };
    }

    logInfo("API", `Transcription complete: "${result.cleaned}"`);
    const historyEntry: HistoryEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      duration: durationSeconds,
      raw: result.raw,
      cleaned: result.cleaned,
      status: "completed",
    };

    await saveAndEmitHistoryEntry(historyEntry, "add");

    try {
      await pasteCleanedText(result.cleaned);
    } catch (pasteError) {
      logError("PASTE", `Paste failed after successful transcription: ${formatErrorMessage(pasteError)}`);

      return {
        durationSeconds,
        hasTranscription: true,
        pasteErrorMessage: toUserFacingPasteErrorMessage(),
      };
    }

    return { durationSeconds, hasTranscription: true };
  } catch (error) {
    const userFacingErrorMessage = toUserFacingErrorMessage(error);
    const failedEntry: HistoryEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      duration: durationSeconds,
      raw: "",
      cleaned: "",
      status: "failed",
      errorMessage: userFacingErrorMessage,
      audioBase64: base64Audio,
      language: settings.language,
      style: settings.style || "classic",
    };

    await saveAndEmitHistoryEntry(failedEntry, "add");
    throw new Error(userFacingErrorMessage);
  }
}

export async function retryHistoryEntry(
  entry: HistoryEntry,
  settings: AppSettings,
  options?: { shouldPaste?: boolean },
): Promise<RetryHistoryEntryResult> {
  if (!entry.audioBase64) {
    throw new Error("У этой записи нет сохраненного аудио для повторной отправки.");
  }

  const retrySettings: AppSettings = {
    ...settings,
    language: entry.language || settings.language,
    style: entry.style || settings.style,
  };
  const shouldPaste = options?.shouldPaste ?? false;

  try {
    const result = await transcribeAudio({
      audioBase64: entry.audioBase64,
      settings: retrySettings,
    });

    if (!result.raw.trim() && !result.cleaned.trim()) {
      throw new Error("Речь не распознана. Попробуйте отправить запись еще раз.");
    }

    const updatedEntry: HistoryEntry = {
      ...entry,
      raw: result.raw,
      cleaned: result.cleaned,
      status: "completed",
      errorMessage: undefined,
      audioBase64: undefined,
    };

    await saveAndEmitHistoryEntry(updatedEntry, "update");

    if (shouldPaste) {
      try {
        await pasteCleanedText(result.cleaned);
      } catch (pasteError) {
        logError("PASTE", `Retry paste failed: ${formatErrorMessage(pasteError)}`);
      }
    }

    return {
      hasTranscription: true,
      updatedEntry,
    };
  } catch (error) {
    const userFacingErrorMessage = toUserFacingErrorMessage(error);
    const failedEntry: HistoryEntry = {
      ...entry,
      status: "failed",
      errorMessage: userFacingErrorMessage,
    };

    await saveAndEmitHistoryEntry(failedEntry, "update");
    throw new Error(userFacingErrorMessage);
  }
}
