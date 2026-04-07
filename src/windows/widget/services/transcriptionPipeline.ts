import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

import { addHistoryEntry, AppSettings, HistoryEntry, updateHistoryEntry } from "../../../lib/store";
import { logError, logInfo } from "../../../lib/logger";
import { formatErrorMessage } from "../../../lib/utils";
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

const PROXY_BASE_URL = "https://proxy.talkis.ru";

async function transcribeViaProxy({
  audioBase64,
  settings,
}: {
  audioBase64: string;
  settings: AppSettings;
}): Promise<{ raw: string; cleaned: string }> {
  logInfo("API", `Sending to proxy, audio_size: ${audioBase64.length} chars`);

  // Decode base64 → binary → Blob
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: "audio/webm" });

  const form = new FormData();
  form.append("file", blob, "recording.webm");
  form.append("language", settings.language || "ru");
  form.append("style", settings.style || "classic");

  const resp = await fetch(`${PROXY_BASE_URL}/api/transcribe`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.deviceToken}`,
    },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Proxy error (${resp.status}): ${body}`);
  }

  return resp.json();
}

async function transcribeViaBackend({
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
      whisper_api_key: settings.whisperApiKey || null,
      llm_api_key: settings.llmApiKey || null,
      style: settings.style || "classic",
      whisper_endpoint: settings.whisperEndpoint || null,
      llm_endpoint: settings.llmEndpoint || null,
      whisper_model: settings.whisperModel || null,
      llm_model: settings.llmModel || null,
    },
  });

  return result;
}

async function transcribeAudio({
  audioBase64,
  settings,
}: {
  audioBase64: string;
  settings: AppSettings;
}): Promise<{ raw: string; cleaned: string }> {
  // Subscription mode: send to proxy
  if (!settings.useOwnKey && settings.deviceToken?.trim()) {
    return transcribeViaProxy({ audioBase64, settings });
  }

  // Own key mode: send to Rust backend
  return transcribeViaBackend({ audioBase64, settings });
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
    const apiStart = Date.now();
    const result = await transcribeAudio({
      audioBase64: base64Audio,
      settings,
    });
    const processingTime = Date.now() - apiStart;

    if (!result.raw.trim() && !result.cleaned.trim()) {
      logInfo("API", "Nothing recognized, skipping history save and paste");
      return { durationSeconds, hasTranscription: false };
    }

    logInfo("API", `Transcription complete in ${processingTime}ms: "${result.cleaned}"`);
    const historyEntry: HistoryEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      duration: durationSeconds,
      raw: result.raw,
      cleaned: result.cleaned,
      status: "completed",
      processingTime,
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
