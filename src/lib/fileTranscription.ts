import { invoke } from "@tauri-apps/api/core";

import { AppSettings } from "./store";
import { logError, logInfo } from "./logger";
import { formatErrorMessage } from "./utils";

const PROXY_BASE_URL = "https://proxy.talkis.ru";
const TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
const INPUT_MAX_BYTES = 200 * 1024 * 1024;

const DIRECT_EXTENSIONS = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"]);
const MIME_BY_EXTENSION: Record<string, string> = {
  flac: "audio/flac",
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
};

export type FileTranscriptionStatus = "reading" | "converting" | "uploading";

export interface FileTranscriptionResult {
  text: string;
  converted: boolean;
  uploadedFileName: string;
  uploadedSizeBytes: number;
}

interface PreparedMediaResponse {
  audio_base64: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
}

interface PreparedTranscriptionFile {
  audioBase64: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  converted: boolean;
}

function fileExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
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

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

function mimeTypeForFile(file: File): string {
  if (file.type.trim()) {
    return file.type;
  }

  return MIME_BY_EXTENSION[fileExtension(file.name)] || "application/octet-stream";
}

function shouldConvert(file: File): boolean {
  const extension = fileExtension(file.name);
  const isDirectFormat = DIRECT_EXTENSIONS.has(extension);
  const isVideo = file.type.startsWith("video/");

  return isVideo || !isDirectFormat || file.size > TRANSCRIPTION_MAX_BYTES;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} КБ`;
  }

  return `${bytes} Б`;
}

export function toFileTranscriptionErrorMessage(error: unknown): string {
  const raw = formatErrorMessage(error);
  const normalized = raw.toLowerCase();

  if (normalized.includes("ffmpeg") || normalized.includes("медиаконвертер")) {
    return "Для этого файла нужно извлечь и сжать аудио, но встроенный медиаконвертер недоступен. Попробуйте поддерживаемый файл до 25 МБ или переустановите приложение.";
  }

  if (normalized.includes("больше 25") || normalized.includes("too large")) {
    return "Файл слишком большой для транскрибации. Попробуйте более короткий фрагмент.";
  }

  if (normalized.includes("unsupported") || normalized.includes("не удалось извлечь аудио")) {
    return "Не удалось прочитать аудио из этого файла. Попробуйте MP3, WAV, M4A, MP4 или MOV.";
  }

  if (normalized.includes("talkis cloud session missing")) {
    return "Войдите в Talkis Cloud заново, чтобы использовать облачный режим.";
  }

  if (normalized.includes("subscription inactive") || normalized.includes("403")) {
    return "Для облачной транскрибации нужна активная подписка Talkis.";
  }

  if (normalized.includes("401") || normalized.includes("unauthorized") || normalized.includes("invalid api key")) {
    return "Не удалось авторизоваться в API. Проверьте ключ доступа.";
  }

  if (normalized.includes("429") || normalized.includes("rate limit") || normalized.includes("quota")) {
    return "Превышен лимит запросов или закончилась квота API. Попробуйте позже.";
  }

  if (normalized.includes("network") || normalized.includes("fetch") || normalized.includes("timed out")) {
    return "Не удалось связаться с сервером. Проверьте интернет и попробуйте снова.";
  }

  return "Не удалось транскрибировать файл. Попробуйте другой формат или более короткий фрагмент.";
}

async function prepareFile(
  file: File,
  onStatus?: (status: FileTranscriptionStatus) => void,
): Promise<PreparedTranscriptionFile> {
  if (file.size <= 0) {
    throw new Error("Пустой файл нельзя транскрибировать.");
  }

  if (file.size > INPUT_MAX_BYTES) {
    throw new Error("Файл слишком большой. Максимум для подготовки в приложении: 200 МБ.");
  }

  onStatus?.("reading");
  const audioBase64 = arrayBufferToBase64(await file.arrayBuffer());

  if (!shouldConvert(file)) {
    return {
      audioBase64,
      fileName: file.name,
      mimeType: mimeTypeForFile(file),
      sizeBytes: file.size,
      converted: false,
    };
  }

  onStatus?.("converting");
  const prepared = await invoke<PreparedMediaResponse>("prepare_media_for_transcription", {
    req: {
      file_base64: audioBase64,
      file_name: file.name,
    },
  });

  return {
    audioBase64: prepared.audio_base64,
    fileName: prepared.file_name,
    mimeType: prepared.mime_type,
    sizeBytes: prepared.size_bytes,
    converted: true,
  };
}

async function transcribeViaProxy(
  prepared: PreparedTranscriptionFile,
  settings: AppSettings,
): Promise<{ raw: string; cleaned: string }> {
  const blob = base64ToBlob(prepared.audioBase64, prepared.mimeType);
  const form = new FormData();
  form.append("file", blob, prepared.fileName);
  form.append("language", settings.language || "ru");
  form.append("style", settings.style || "classic");

  const response = await fetch(`${PROXY_BASE_URL}/api/transcribe-only`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.deviceToken}`,
    },
    body: form,
  });

  const body = await response.text();

  if (!response.ok) {
    logError("FILE_TRANSCRIPTION", `Proxy error (${response.status}): ${body}`);
    throw new Error(`Proxy error (${response.status}): ${body}`);
  }

  try {
    const parsed = JSON.parse(body) as { raw?: string; cleaned?: string };
    return {
      raw: typeof parsed.raw === "string" ? parsed.raw : "",
      cleaned: typeof parsed.cleaned === "string" ? parsed.cleaned : "",
    };
  } catch (error) {
    logError("FILE_TRANSCRIPTION", `Proxy response parse failed: ${formatErrorMessage(error)}; body=${body}`);
    throw new Error("Talkis Cloud returned an invalid response");
  }
}

async function transcribeViaBackend(
  prepared: PreparedTranscriptionFile,
  settings: AppSettings,
): Promise<{ raw: string; cleaned: string }> {
  return invoke<{ raw: string; cleaned: string }>("transcribe_only", {
    req: {
      audio_base64: prepared.audioBase64,
      language: settings.language,
      api_key: settings.apiKey,
      whisper_api_key: settings.whisperApiKey || null,
      llm_api_key: settings.llmApiKey || null,
      style: settings.style || "classic",
      whisper_endpoint: settings.whisperEndpoint || null,
      llm_endpoint: settings.llmEndpoint || null,
      whisper_model: settings.whisperModel || null,
      llm_model: settings.llmModel || null,
      file_name: prepared.fileName,
      mime_type: prepared.mimeType,
      mode: "transcribe_only",
    },
  });
}

async function transcribePreparedFile(
  prepared: PreparedTranscriptionFile,
  settings: AppSettings,
): Promise<{ raw: string; cleaned: string }> {
  if (!settings.useOwnKey && settings.deviceToken?.trim()) {
    return transcribeViaProxy(prepared, settings);
  }

  if (!settings.useOwnKey) {
    throw new Error("Talkis Cloud session missing");
  }

  return transcribeViaBackend(prepared, settings);
}

export async function transcribeFileOnly({
  file,
  settings,
  onStatus,
}: {
  file: File;
  settings: AppSettings;
  onStatus?: (status: FileTranscriptionStatus) => void;
}): Promise<FileTranscriptionResult> {
  const prepared = await prepareFile(file, onStatus);
  onStatus?.("uploading");

  logInfo(
    "FILE_TRANSCRIPTION",
    `Sending ${prepared.fileName}, size=${prepared.sizeBytes}, converted=${prepared.converted}`,
  );

  const result = await transcribePreparedFile(prepared, settings);
  const text = (result.raw || result.cleaned).trim();

  if (!text) {
    throw new Error("В файле не удалось распознать речь.");
  }

  return {
    text,
    converted: prepared.converted,
    uploadedFileName: prepared.fileName,
    uploadedSizeBytes: prepared.sizeBytes,
  };
}
