import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { AppSettings } from "./store";
import { fetchCloudProfile } from "./cloudAuth";
import { logError, logInfo } from "./logger";
import { formatErrorMessage } from "./utils";

const PROXY_BASE_URL = "https://proxy.talkis.ru";
const TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
const INPUT_MAX_BYTES = 200 * 1024 * 1024;
const FILE_TRANSCRIPTION_PROGRESS_EVENT = "file-transcription-progress";
const DIARIZED_WHISPER_ENDPOINT = "http://127.0.0.1:8000";
const DIARIZED_WHISPER_MODEL = "whisper-large-v3-turbo";
const CLOUD_CAPABILITIES_CACHE_MS = 60_000;
const DIARIZED_WHISPER_MODEL_OPTIONS = [
  "whisper-large-v3-turbo",
  "whisper-large-v3",
  "whisper-large-v2",
  "whisper-medium",
  "whisper-small",
  "whisper-base",
  "whisper-tiny",
] as const;
const STRONG_DIARIZED_WHISPER_MODELS = new Set(["whisper-large-v3-turbo", "whisper-large-v3", "whisper-large-v2", "whisper-medium"]);

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

export type FileTranscriptionStatus = "reading" | "converting" | "uploading" | "preparing" | "diarizing" | "transcribing" | "assembling" | "done";

export interface FileTranscriptionProgress {
  status: FileTranscriptionStatus;
  currentChunk: number;
  totalChunks: number;
  message: string;
}

export interface FileTranscriptionResult {
  text: string;
  converted: boolean;
  uploadedFileName: string;
  uploadedSizeBytes: number;
  mode: "plain" | "speakers";
  speakers?: Speaker[];
  segments?: SpeakerTranscriptSegment[];
}

export interface Speaker {
  id: string;
  label: string;
}

export interface SpeakerTranscriptSegment {
  start: number;
  end: number;
  speakerId: string;
  speakerLabel: string;
  text: string;
}

interface NativeTranscriptionResult {
  raw: string;
  cleaned: string;
  mode?: "plain" | "speakers";
  speakers?: Speaker[];
  segments?: SpeakerTranscriptSegment[];
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

interface FileTranscriptionProgressPayload {
  request_id: string;
  status: FileTranscriptionStatus;
  current_chunk: number;
  total_chunks: number;
  message: string;
}

interface FilePathRequestSettings {
  whisperApiKey: string | null;
  whisperEndpoint: string | null;
  whisperModel: string | null;
  useOwnKey: boolean;
  deviceToken: string | null;
}

interface CloudTranscriptionCapabilities {
  fileTranscription: boolean;
  speakerDiarization: boolean;
  speakerDiarizationProvider?: string;
  speakerDiarizationMaxSpeakers?: number;
}

let cloudCapabilitiesCache: { value: CloudTranscriptionCapabilities; expiresAt: number } | null = null;

function fileExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

export function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const name = normalized.split("/").filter(Boolean).pop();
  return name || "Файл";
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

function buildFilePathRequestSettings(
  settings: AppSettings,
  speakerDiarization: boolean,
  useCloudSpeakerDiarization: boolean,
): FilePathRequestSettings {
  if (!speakerDiarization || useCloudSpeakerDiarization) {
    return {
      whisperApiKey: settings.whisperApiKey || null,
      whisperEndpoint: settings.whisperEndpoint || null,
      whisperModel: settings.whisperModel || null,
      useOwnKey: settings.useOwnKey,
      deviceToken: settings.deviceToken || null,
    };
  }

  return {
    whisperApiKey: null,
    whisperEndpoint: DIARIZED_WHISPER_ENDPOINT,
    whisperModel: getDiarizedWhisperModel(settings),
    useOwnKey: true,
    deviceToken: null,
  };
}

export async function getCloudTranscriptionCapabilities(force = false): Promise<CloudTranscriptionCapabilities> {
  const now = Date.now();
  if (!force && cloudCapabilitiesCache && cloudCapabilitiesCache.expiresAt > now) {
    return cloudCapabilitiesCache.value;
  }

  const response = await fetch(`${PROXY_BASE_URL}/api/capabilities`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Proxy capabilities error (${response.status}): ${body}`);
  }

  let parsed: Partial<CloudTranscriptionCapabilities>;
  try {
    parsed = JSON.parse(body) as Partial<CloudTranscriptionCapabilities>;
  } catch (error) {
    logError("FILE_TRANSCRIPTION", `Proxy capabilities parse failed: ${formatErrorMessage(error)}; body=${body}`);
    throw new Error("Talkis Cloud returned invalid capabilities");
  }

  const capabilities: CloudTranscriptionCapabilities = {
    fileTranscription: parsed.fileTranscription === true,
    speakerDiarization: parsed.speakerDiarization === true,
    speakerDiarizationProvider: typeof parsed.speakerDiarizationProvider === "string" ? parsed.speakerDiarizationProvider : undefined,
    speakerDiarizationMaxSpeakers: typeof parsed.speakerDiarizationMaxSpeakers === "number" ? parsed.speakerDiarizationMaxSpeakers : undefined,
  };

  cloudCapabilitiesCache = {
    value: capabilities,
    expiresAt: now + CLOUD_CAPABILITIES_CACHE_MS,
  };

  return capabilities;
}

export async function canUseCloudSpeakerDiarization(settings: AppSettings, force = false): Promise<boolean> {
  if (settings.useOwnKey || !settings.deviceToken?.trim()) {
    return false;
  }

  try {
    const profile = await fetchCloudProfile({ force });
    if (profile?.subscription.active !== true) {
      return false;
    }

    const capabilities = await getCloudTranscriptionCapabilities(force);
    return capabilities.speakerDiarization === true;
  } catch (error) {
    logError("FILE_TRANSCRIPTION", `Cloud diarization capability check failed: ${formatErrorMessage(error)}`);
    return false;
  }
}

function getDiarizedWhisperModel(settings: AppSettings): string {
  const currentModel = (settings.whisperModel || "").trim().toLowerCase();
  const currentOption = DIARIZED_WHISPER_MODEL_OPTIONS.find((model) => (
    model.toLowerCase() === currentModel && settings.localModels?.[model]?.status === "downloaded"
  ));

  if (currentOption && STRONG_DIARIZED_WHISPER_MODELS.has(currentOption)) {
    return currentOption;
  }

  const strongestDownloadedOption = DIARIZED_WHISPER_MODEL_OPTIONS.find((model) => (
    STRONG_DIARIZED_WHISPER_MODELS.has(model) && settings.localModels?.[model]?.status === "downloaded"
  ));

  return strongestDownloadedOption || currentOption || DIARIZED_WHISPER_MODEL_OPTIONS.find((model) => (
    settings.localModels?.[model]?.status === "downloaded"
  )) || DIARIZED_WHISPER_MODEL;
}

export function formatFileSize(bytes: number): string {
  if (bytes <= 0) {
    return "0 Б";
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} КБ`;
  }

  return `${bytes} Б`;
}

export function getFileTranscriptionPercent(
  status: FileTranscriptionStatus | "idle" | "error",
  progress: FileTranscriptionProgress | null,
): number {
  if (status === "done") return 100;
  if (status === "error" || status === "idle") return 0;
  if (status === "reading") return 12;
  if (status === "converting") return 32;
  if (status === "uploading") return 58;
  if (status === "preparing") return 18;
  if (status === "diarizing") return 42;
  if (status === "assembling") return 96;

  if (status === "transcribing" && progress && progress.totalChunks > 0) {
    const currentChunk = Math.max(0, Math.min(progress.currentChunk, progress.totalChunks));
    const chunkProgress = currentChunk / progress.totalChunks;
    return Math.max(58, Math.min(94, Math.round(58 + chunkProgress * 36)));
  }

  if (status === "transcribing") return 70;

  return 0;
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

  if (normalized.includes("1 гб") || normalized.includes("1 gb")) {
    return "Файл слишком большой для транскрибации. Максимальный размер: 1 ГБ.";
  }

  if (normalized.includes("unsupported") || normalized.includes("не удалось извлечь аудио")) {
    return "Не удалось прочитать аудио из этого файла. Попробуйте MP3, WAV, M4A, MP4 или MOV.";
  }

  if (normalized.includes("talkis cloud session missing")) {
    return "Войдите в Talkis Cloud заново, чтобы использовать облачный режим.";
  }

  if (normalized.includes("speaker diarization is not configured")) {
    return "Облачная разметка говорящих пока недоступна. Используйте локальную подготовку в блоке транскрибации файла.";
  }

  if (normalized.includes("cloud speaker diarization unavailable")) {
    return "Облачное разделение по говорящим сейчас недоступно. Проверьте активную подписку PRO или переключитесь на локальный режим.";
  }

  if (normalized.includes("subscription inactive") || normalized.includes("403")) {
    return "Для облачной транскрибации нужна активная подписка Talkis.";
  }

  if (normalized.includes("не удалось подготовить аудио для разделения говорящих")) {
    return "Не удалось подготовить аудио для разметки говорящих. Попробуйте другой аудио- или видеофайл.";
  }

  if (normalized.includes("таймкод")) {
    return "Для разделения по говорящим нужна локальная Whisper-модель с таймкодами.";
  }

  if (
    normalized.includes("разделения говорящих ещё не скачана")
    || normalized.includes("sherpa-diarization-pyannote-titanet-int8") && normalized.includes("ещё не скачана")
  ) {
    return "Для разделения по говорящим скачайте локальные компоненты в блоке транскрибации файла.";
  }

  if (
    normalized.includes("sherpa-onnx установлен")
    && (normalized.includes("diarization binary") || normalized.includes("binary для разметки говорящих"))
  ) {
    return "Runtime для разметки установился не полностью. Нажмите «Скачать» в подготовке разметки, чтобы Talkis восстановил его.";
  }

  if (normalized.includes("sherpa-onnx diarization не вернул сегменты")) {
    return "Не удалось найти отдельные реплики говорящих в этом файле.";
  }

  if (normalized.includes("sherpa-onnx diarization завершился с ошибкой")) {
    return raw;
  }

  if (normalized.includes("not installed locally") || normalized.includes("ещё не скачана")) {
    return "Локальная модель распознавания не установлена. Откройте Настройки -> Модели -> Локально и нажмите «Скачать» для выбранной модели.";
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
): Promise<NativeTranscriptionResult> {
  return invoke<NativeTranscriptionResult>("transcribe_only", {
    req: {
      audio_base64: prepared.audioBase64,
      language: settings.language,
      api_key: settings.apiKey,
      whisper_api_key: settings.whisperApiKey || null,
      llm_api_key: null,
      style: settings.style || "classic",
      whisper_endpoint: settings.whisperEndpoint || null,
      local_models_dir: settings.localModelsDir || null,
      llm_endpoint: null,
      whisper_model: settings.whisperModel || null,
      llm_model: "none",
      file_name: prepared.fileName,
      mime_type: prepared.mimeType,
      mode: "transcribe_only",
    },
  });
}

async function transcribePreparedFile(
  prepared: PreparedTranscriptionFile,
  settings: AppSettings,
): Promise<NativeTranscriptionResult> {
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
    mode: "plain",
  };
}

export async function transcribeFilePathOnly({
  filePath,
  settings,
  onStatus,
  onProgress,
  speakerDiarization = false,
}: {
  filePath: string;
  settings: AppSettings;
  onStatus?: (status: FileTranscriptionStatus) => void;
  onProgress?: (progress: FileTranscriptionProgress) => void;
  speakerDiarization?: boolean;
}): Promise<FileTranscriptionResult> {
  const requestId = crypto.randomUUID();
  const fileName = fileNameFromPath(filePath);

  const unlisten = await listen<FileTranscriptionProgressPayload>(
    FILE_TRANSCRIPTION_PROGRESS_EVENT,
    (event) => {
      if (event.payload.request_id !== requestId) return;

      const progress: FileTranscriptionProgress = {
        status: event.payload.status,
        currentChunk: event.payload.current_chunk || 0,
        totalChunks: event.payload.total_chunks || 0,
        message: event.payload.message || "",
      };

      onStatus?.(progress.status);
      onProgress?.(progress);
    },
  );

  try {
    onStatus?.("preparing");
    onProgress?.({
      status: "preparing",
      currentChunk: 0,
      totalChunks: 0,
      message: "Готовим файл",
    });

    logInfo("FILE_TRANSCRIPTION", `Sending file path ${fileName} through native pipeline`);
    const useCloudSpeakerDiarization = speakerDiarization && await canUseCloudSpeakerDiarization(settings);
    if (speakerDiarization && !settings.useOwnKey && !useCloudSpeakerDiarization) {
      throw new Error("Cloud speaker diarization unavailable");
    }
    const requestSettings = buildFilePathRequestSettings(settings, speakerDiarization, useCloudSpeakerDiarization);

    const result = await invoke<NativeTranscriptionResult>("transcribe_file_path", {
      req: {
        request_id: requestId,
        file_path: filePath,
        file_name: fileName,
        file_size: null,
        language: settings.language,
        api_key: settings.apiKey,
        whisper_api_key: requestSettings.whisperApiKey,
        style: settings.style || "classic",
        whisper_endpoint: requestSettings.whisperEndpoint,
        local_models_dir: settings.localModelsDir || null,
        whisper_model: requestSettings.whisperModel,
        use_own_key: requestSettings.useOwnKey,
        device_token: requestSettings.deviceToken,
        speaker_diarization: speakerDiarization,
      },
    });
    const text = (result.raw || result.cleaned).trim();

    if (!text) {
      throw new Error("В файле не удалось распознать речь.");
    }

    return {
      text,
      converted: true,
      uploadedFileName: fileName,
      uploadedSizeBytes: 0,
      mode: result.mode || "plain",
      speakers: result.speakers,
      segments: result.segments,
    };
  } finally {
    unlisten();
  }
}
