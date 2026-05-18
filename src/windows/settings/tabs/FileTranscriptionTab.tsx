import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Check,
  Clipboard,
  FileAudio,
  Loader2,
  X,
} from "lucide-react";

import {
  addHistoryEntry,
  getHistory,
  getSettings,
  HistoryEntry,
  saveSettings,
  updateHistoryEntry,
  type AppSettings,
  type SpeakerTranscriptSegment,
} from "../../../lib/store";
import { HISTORY_UPDATED_EVENT } from "../../../lib/hotkeyEvents";
import { formatErrorMessage } from "../../../lib/utils";
import {
  canUseCloudSpeakerDiarization,
  fileNameFromPath,
  FileTranscriptionProgress,
  FileTranscriptionStatus,
  formatFileSize,
  getFileTranscriptionPercent,
  toFileTranscriptionErrorMessage,
  transcribeFilePathOnly,
  transcribeFileOnly,
} from "../../../lib/fileTranscription";

type ProcessingState = "idle" | FileTranscriptionStatus | "error";
type SpeakerSetupIntent = "toggle" | "process";
interface SelectedTranscriptionFile {
  name: string;
  size: number | null;
}
interface FileTranscriptionTabProps {
  focusedEntryId?: string | null;
}
const RESULT_PREVIEW_LIMIT = 250;
const DIARIZATION_MODEL_ID = "sherpa-diarization-pyannote-titanet-int8";
const LOCAL_WHISPER_MODEL_ID = "whisper-large-v3-turbo";
const LOCAL_WHISPER_ENDPOINT = "http://127.0.0.1:8000";
const RECOMMENDED_LOCAL_WHISPER_LABEL = "Whisper Large V3 Turbo";
const DIARIZATION_WHISPER_OPTIONS = [
  {
    id: "whisper-large-v3-turbo",
    model: "whisper-large-v3-turbo",
    label: "Whisper Large V3 Turbo",
  },
  {
    id: "whisper-large-v3",
    model: "whisper-large-v3",
    label: "Whisper Large V3",
  },
  {
    id: "whisper-large-v2",
    model: "whisper-large-v2",
    label: "Whisper Large V2",
  },
  { id: "whisper-medium", model: "whisper-medium", label: "Whisper Medium" },
  { id: "whisper-small", model: "whisper-small", label: "Whisper Small" },
  { id: "whisper-base", model: "whisper-base", label: "Whisper Base" },
  { id: "whisper-tiny", model: "whisper-tiny", label: "Whisper Tiny" },
] as const;
const STRONG_DIARIZATION_WHISPER_IDS = new Set([
  "whisper-large-v3-turbo",
  "whisper-large-v3",
  "whisper-large-v2",
  "whisper-medium",
]);

function isModelDownloaded(settings: AppSettings, modelId: string): boolean {
  return settings.localModels?.[modelId]?.status === "downloaded";
}

function getDiarizationWhisperOption(
  settings: AppSettings,
): (typeof DIARIZATION_WHISPER_OPTIONS)[number] | null {
  const currentModel = (settings.whisperModel || "").trim().toLowerCase();
  const currentOption = DIARIZATION_WHISPER_OPTIONS.find(
    (option) =>
      option.model.toLowerCase() === currentModel &&
      isModelDownloaded(settings, option.id),
  );

  if (currentOption && STRONG_DIARIZATION_WHISPER_IDS.has(currentOption.id)) {
    return currentOption;
  }

  const strongestDownloadedOption = DIARIZATION_WHISPER_OPTIONS.find(
    (option) =>
      STRONG_DIARIZATION_WHISPER_IDS.has(option.id) &&
      isModelDownloaded(settings, option.id),
  );

  return (
    strongestDownloadedOption ||
    currentOption ||
    DIARIZATION_WHISPER_OPTIONS.find((option) =>
      isModelDownloaded(settings, option.id),
    ) ||
    null
  );
}

function statusLabel(
  status: ProcessingState,
  progress: FileTranscriptionProgress | null,
): string {
  if (status === "reading") return "Читаем файл";
  if (status === "converting") return "Извлекаем и сжимаем аудио";
  if (status === "uploading") return "Отправляем на транскрибацию";
  if (status === "preparing") return progress?.message || "Готовим файл";
  if (status === "diarizing") return progress?.message || "Разделяем говорящих";
  if (status === "transcribing") {
    if (progress && progress.totalChunks > 0) {
      return `Распознаём фрагмент ${progress.currentChunk} из ${progress.totalChunks}`;
    }

    return "Распознаём фрагменты";
  }
  if (status === "assembling") return progress?.message || "Собираем протокол";
  if (status === "done") return "Готово";
  if (status === "error") return "Ошибка";
  return "Ожидаем файл";
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatSpeakerTranscript(segments: SpeakerTranscriptSegment[]): string {
  return segments
    .map(
      (segment) =>
        `[${formatTimestamp(segment.start)}] ${segment.speakerLabel}: ${segment.text.trim()}`,
    )
    .join("\n");
}

function resultSourceLabel(entry: HistoryEntry): string {
  if (entry.source === "call") return "Созвон";
  if (entry.source === "file") return "Файл";
  return "Голос";
}

function requirementStatusColor(isReady: boolean): string {
  return isReady ? "var(--success)" : "var(--text-low)";
}

function isSpeakerSetupReady(settings: AppSettings): boolean {
  return (
    getDiarizationWhisperOption(settings) !== null &&
    settings.localModels?.[DIARIZATION_MODEL_ID]?.status === "downloaded"
  );
}

function isSpeakerSetupRepairError(error: unknown): boolean {
  const normalized = formatErrorMessage(error).toLowerCase();
  return (
    normalized.includes("sherpa-onnx установлен") &&
    (normalized.includes("diarization binary") ||
      normalized.includes("binary для разметки говорящих"))
  );
}

async function refreshSpeakerInstalledModels(
  settings: AppSettings,
): Promise<AppSettings> {
  let result: { success: boolean; models: string[]; message: string };
  try {
    result = await invoke<{
      success: boolean;
      models: string[];
      message: string;
    }>("list_stt_models", {
      req: {
        api_key: settings.apiKey || "",
        whisper_api_key: settings.whisperApiKey || null,
        whisper_endpoint: LOCAL_WHISPER_ENDPOINT,
        local_models_dir: settings.localModelsDir || null,
      },
    });
  } catch {
    return settings;
  }

  if (!result.success) {
    return settings;
  }

  const installedModels = new Set(result.models || []);
  const now = new Date().toISOString();
  const nextLocalModels = { ...(settings.localModels || {}) };
  let changed = false;

  for (const option of DIARIZATION_WHISPER_OPTIONS) {
    const current = nextLocalModels[option.id];
    if (installedModels.has(option.model)) {
      nextLocalModels[option.id] = {
        ...current,
        status: "downloaded",
        message: undefined,
        downloadedAt: current?.downloadedAt || now,
        lastCheckedAt: now,
      };
      changed = true;
    } else if (current?.status === "downloaded") {
      delete nextLocalModels[option.id];
      changed = true;
    }
  }

  const currentDiarization = nextLocalModels[DIARIZATION_MODEL_ID];
  if (installedModels.has(DIARIZATION_MODEL_ID)) {
    nextLocalModels[DIARIZATION_MODEL_ID] = {
      ...currentDiarization,
      status: "downloaded",
      message: undefined,
      downloadedAt: currentDiarization?.downloadedAt || now,
      lastCheckedAt: now,
    };
    changed = true;
  } else if (currentDiarization?.status === "downloaded") {
    delete nextLocalModels[DIARIZATION_MODEL_ID];
    changed = true;
  }

  if (!changed) {
    return settings;
  }

  await saveSettings({ localModels: nextLocalModels });
  return { ...settings, localModels: nextLocalModels };
}

export function FileTranscriptionTab({
  focusedEntryId = null,
}: FileTranscriptionTabProps = {}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultSectionRef = useRef<HTMLElement | null>(null);
  const isProcessingRef = useRef(false);
  const nativeDropAtRef = useRef(0);
  const processFilePathRef = useRef<(filePath: string) => Promise<void>>(
    async () => {},
  );
  const [selectedFile, setSelectedFile] =
    useState<SelectedTranscriptionFile | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState<FileTranscriptionProgress | null>(
    null,
  );
  const [resultEntry, setResultEntry] = useState<HistoryEntry | null>(null);
  const [error, setError] = useState("");
  const [convertedInfo, setConvertedInfo] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [speakerDiarization, setSpeakerDiarization] = useState(false);
  const [diarizationInstalled, setDiarizationInstalled] = useState(false);
  const [localWhisperDownloaded, setLocalWhisperDownloaded] = useState(false);
  const [localWhisperLabel, setLocalWhisperLabel] = useState("");
  const [speakerSetupModalOpen, setSpeakerSetupModalOpen] = useState(false);
  const [speakerSetupInstalling, setSpeakerSetupInstalling] = useState(false);
  const [speakerSetupMessage, setSpeakerSetupMessage] = useState("");
  const [speakerSetupError, setSpeakerSetupError] = useState("");
  const [pendingSpeakerFilePath, setPendingSpeakerFilePath] = useState<
    string | null
  >(null);
  const [speakerSetupIntent, setSpeakerSetupIntent] =
    useState<SpeakerSetupIntent | null>(null);
  const [speakerSetupForceRepair, setSpeakerSetupForceRepair] = useState(false);

  const isProcessing =
    status === "reading" ||
    status === "converting" ||
    status === "uploading" ||
    status === "preparing" ||
    status === "diarizing" ||
    status === "assembling" ||
    status === "transcribing";
  const progressPercent = getFileTranscriptionPercent(status, progress);

  const syncSpeakerSetupState = (settings: AppSettings): void => {
    const localWhisperOption = getDiarizationWhisperOption(settings);
    setDiarizationInstalled(
      settings.localModels?.[DIARIZATION_MODEL_ID]?.status === "downloaded",
    );
    setLocalWhisperDownloaded(localWhisperOption !== null);
    setLocalWhisperLabel(
      localWhisperOption?.label || RECOMMENDED_LOCAL_WHISPER_LABEL,
    );
  };

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    getSettings({ reload: true })
      .then(async (settings) => {
        const syncedSettings = await refreshSpeakerInstalledModels(settings);
        const cloudSpeakerReady =
          await canUseCloudSpeakerDiarization(syncedSettings);
        syncSpeakerSetupState(syncedSettings);
        if (
          syncedSettings.fileSpeakerDiarization &&
          ((!syncedSettings.useOwnKey && !cloudSpeakerReady) ||
            (syncedSettings.useOwnKey && !isSpeakerSetupReady(syncedSettings)))
        ) {
          setSpeakerDiarization(false);
          void saveSettings({ fileSpeakerDiarization: false });
          return;
        }

        setSpeakerDiarization(syncedSettings.fileSpeakerDiarization);
      })
      .catch(() => {});
  }, []);

  const resetResult = (): void => {
    setResultEntry(null);
    setError("");
    setConvertedInfo("");
    setProgress(null);
    setCopied(false);
    setResultExpanded(false);
  };

  const showHistoryEntryResult = (
    entry: HistoryEntry,
    scrollToResult = false,
  ): void => {
    setSelectedFile({
      name: entry.fileName || "Файл",
      size: entry.fileSize ?? null,
    });
    setError("");
    setConvertedInfo("");
    setProgress(null);
    setCopied(false);
    setResultExpanded(entry.mode === "speakers");
    setResultEntry(entry);
    setStatus("done");

    if (scrollToResult) {
      requestAnimationFrame(() => {
        resultSectionRef.current?.scrollIntoView({
          block: "start",
          behavior: "smooth",
        });
      });
    }
  };

  useEffect(() => {
    const unlistenPromise = listen<HistoryEntry>(
      HISTORY_UPDATED_EVENT,
      ({ payload }) => {
        if (
          isProcessingRef.current ||
          (payload.source !== "file" && payload.source !== "call") ||
          payload.status !== "completed"
        ) {
          return;
        }

        showHistoryEntryResult(payload);
      },
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!focusedEntryId) {
      return;
    }

    let mounted = true;

    const showFocusedEntry = async (): Promise<void> => {
      try {
        const history = await getHistory();
        const entry = history.find((item) => item.id === focusedEntryId);

        if (!mounted || !entry) {
          return;
        }

        showHistoryEntryResult(entry, true);
      } catch (caughtError) {
        if (!mounted) {
          return;
        }

        setError(toFileTranscriptionErrorMessage(caughtError));
        setStatus("error");
      }
    };

    void showFocusedEntry();

    return () => {
      mounted = false;
    };
  }, [focusedEntryId]);

  const processFile = async (file: File): Promise<void> => {
    setSelectedFile({ name: file.name, size: file.size });
    resetResult();
    setStatus("reading");

    try {
      if (speakerDiarization) {
        throw new Error(
          "Разделение по говорящим доступно для файлов, выбранных через системный диалог или перетаскиванием в окно Talkis.",
        );
      }
      const settings = await getSettings();
      const startedAt = Date.now();
      const transcription = await transcribeFileOnly({
        file,
        settings,
        onStatus: setStatus,
      });
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        duration: 0,
        raw: transcription.text,
        cleaned: transcription.text,
        source: "file",
        fileName: file.name,
        fileSize: file.size,
        status: "completed",
        processingTime: Date.now() - startedAt,
        mode: "plain",
      };

      await addHistoryEntry(entry);
      await emit(HISTORY_UPDATED_EVENT, entry);
      setResultEntry(entry);
      setConvertedInfo(
        transcription.converted
          ? `Отправлено как ${transcription.uploadedFileName}, ${formatFileSize(transcription.uploadedSizeBytes)}`
          : "",
      );
      setStatus("done");
    } catch (caughtError) {
      setError(toFileTranscriptionErrorMessage(caughtError));
      setStatus("error");
    }
  };

  const processFilePath = async (
    filePath: string,
    speakerMode = speakerDiarization,
  ): Promise<void> => {
    const fileName = fileNameFromPath(filePath);
    setSelectedFile({ name: fileName, size: null });
    resetResult();
    setStatus("idle");

    try {
      const settings = await refreshSpeakerInstalledModels(
        await getSettings({ reload: true }),
      );
      const cloudSpeakerReady = await canUseCloudSpeakerDiarization(
        settings,
        true,
      );
      syncSpeakerSetupState(settings);
      if (speakerMode && !settings.useOwnKey && !cloudSpeakerReady) {
        setSpeakerDiarization(false);
        await saveSettings({ fileSpeakerDiarization: false });
        throw new Error("Cloud speaker diarization unavailable");
      }

      if (speakerMode && settings.useOwnKey && !isSpeakerSetupReady(settings)) {
        setPendingSpeakerFilePath(filePath);
        setSpeakerSetupIntent("process");
        setSpeakerSetupMessage("");
        setSpeakerSetupError("");
        setSpeakerSetupModalOpen(true);
        return;
      }

      setStatus("preparing");
      const startedAt = Date.now();
      const transcription = await transcribeFilePathOnly({
        filePath,
        settings,
        onStatus: setStatus,
        onProgress: setProgress,
        speakerDiarization: speakerMode,
      });
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        duration: 0,
        raw: transcription.text,
        cleaned: transcription.text,
        source: "file",
        fileName,
        status: "completed",
        processingTime: Date.now() - startedAt,
        mode: transcription.mode,
        speakers: transcription.speakers,
        segments: transcription.segments,
      };

      await addHistoryEntry(entry);
      await emit(HISTORY_UPDATED_EVENT, entry);
      setResultEntry(entry);
      setConvertedInfo("");
      setStatus("done");
    } catch (caughtError) {
      if (speakerMode && isSpeakerSetupRepairError(caughtError)) {
        setSpeakerDiarization(false);
        await saveSettings({ fileSpeakerDiarization: false });
        setPendingSpeakerFilePath(filePath);
        setSpeakerSetupIntent("process");
        setSpeakerSetupForceRepair(true);
        setSpeakerSetupMessage("");
        setSpeakerSetupError(toFileTranscriptionErrorMessage(caughtError));
        setSpeakerSetupModalOpen(true);
        setStatus("idle");
        return;
      }

      setError(toFileTranscriptionErrorMessage(caughtError));
      setStatus("error");
    }
  };

  processFilePathRef.current = processFilePath;

  useEffect(() => {
    const unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        if (!isProcessingRef.current) {
          setIsDragOver(true);
        }
        return;
      }

      if (event.payload.type === "leave") {
        setIsDragOver(false);
        return;
      }

      setIsDragOver(false);
      nativeDropAtRef.current = Date.now();

      const filePath = event.payload.paths[0];
      if (!filePath || isProcessingRef.current) {
        return;
      }

      void processFilePathRef.current(filePath);
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const openFileDialog = async (): Promise<void> => {
    if (isProcessing) return;

    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Аудио и видео",
            extensions: [
              "mp3",
              "wav",
              "m4a",
              "mp4",
              "mov",
              "webm",
              "ogg",
              "flac",
              "mpeg",
              "mpga",
              "avi",
              "mkv",
            ],
          },
        ],
      });

      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (typeof filePath === "string" && filePath.trim()) {
        void processFilePath(filePath);
      }
    } catch (caughtError) {
      setError(toFileTranscriptionErrorMessage(caughtError));
      setStatus("error");
    }
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (file) {
      void processFile(file);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setIsDragOver(false);

    if (Date.now() - nativeDropAtRef.current < 1000) {
      return;
    }

    const file = event.dataTransfer.files?.[0];
    if (file) {
      void processFile(file);
    }
  };

  const copyResult = async (): Promise<void> => {
    if (!resultEntry?.cleaned) return;

    await navigator.clipboard.writeText(resultEntry.cleaned);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const installSpeakerSetup = async (): Promise<void> => {
    if (speakerSetupInstalling) return;

    setSpeakerSetupInstalling(true);
    setSpeakerSetupMessage("Готовим локальные компоненты...");
    setSpeakerSetupError("");
    try {
      let settings = await getSettings({ reload: true });
      const now = new Date().toISOString();
      const nextLocalModels = { ...(settings.localModels || {}) };

      if (!getDiarizationWhisperOption(settings)) {
        setSpeakerSetupMessage(
          `Скачиваем ${RECOMMENDED_LOCAL_WHISPER_LABEL}...`,
        );
        const whisperResult = await invoke<{
          success: boolean;
          message: string;
          whisper_endpoint?: string | null;
        }>("install_stt_model", {
          req: {
            api_key: settings.apiKey || "",
            whisper_api_key: settings.whisperApiKey || null,
            whisper_endpoint: LOCAL_WHISPER_ENDPOINT,
            local_models_dir: settings.localModelsDir || null,
            whisper_model: LOCAL_WHISPER_MODEL_ID,
          },
        });

        if (!whisperResult.success) {
          throw new Error(whisperResult.message);
        }

        nextLocalModels[LOCAL_WHISPER_MODEL_ID] = {
          status: "downloaded",
          downloadedAt: now,
          lastCheckedAt: now,
        };

        await saveSettings({ localModels: nextLocalModels });
        settings = await getSettings({ reload: true });
      }

      if (
        speakerSetupForceRepair ||
        settings.localModels?.[DIARIZATION_MODEL_ID]?.status !== "downloaded"
      ) {
        setSpeakerSetupMessage(
          speakerSetupForceRepair
            ? "Восстанавливаем runtime для разметки..."
            : "Скачиваем компоненты для разметки говорящих...",
        );
        const speakerResult = await invoke<{
          success: boolean;
          message: string;
        }>("install_stt_model", {
          req: {
            api_key: settings.apiKey || "",
            whisper_api_key: settings.whisperApiKey || null,
            whisper_endpoint: "http://127.0.0.1:8003",
            local_models_dir: settings.localModelsDir || null,
            whisper_model: DIARIZATION_MODEL_ID,
          },
        });

        if (!speakerResult.success) {
          throw new Error(speakerResult.message);
        }

        const refreshedSettings = await getSettings({ reload: true });
        await saveSettings({
          localModels: {
            ...(refreshedSettings.localModels || {}),
            [DIARIZATION_MODEL_ID]: {
              status: "downloaded",
              downloadedAt: new Date().toISOString(),
              lastCheckedAt: new Date().toISOString(),
            },
          },
        });
      }

      const finalSettings = await getSettings({ reload: true });
      syncSpeakerSetupState(finalSettings);
      setSpeakerSetupMessage(
        speakerSetupIntent === "toggle"
          ? "Готово."
          : "Готово. Продолжаем обработку файла...",
      );
      setSpeakerSetupError("");
      setError("");
      setSpeakerSetupModalOpen(false);
      setSpeakerSetupForceRepair(false);
      setSpeakerDiarization(true);
      await saveSettings({ fileSpeakerDiarization: true });

      if (speakerSetupIntent === "toggle") {
        setSpeakerSetupIntent(null);
        return;
      }

      if (pendingSpeakerFilePath) {
        const filePath = pendingSpeakerFilePath;
        setPendingSpeakerFilePath(null);
        setStatus("preparing");
        void processFilePath(filePath, true);
      }
      setSpeakerSetupIntent(null);
    } catch (caughtError) {
      setSpeakerSetupError(toFileTranscriptionErrorMessage(caughtError));
    } finally {
      setSpeakerSetupInstalling(false);
    }
  };

  const renameSpeaker = async (
    speakerId: string,
    label: string,
  ): Promise<void> => {
    if (!resultEntry?.segments || !resultEntry.speakers) return;

    const nextSpeakers = resultEntry.speakers.map((speaker) =>
      speaker.id === speakerId ? { ...speaker, label } : speaker,
    );
    const nextSegments = resultEntry.segments.map((segment) =>
      segment.speakerId === speakerId
        ? { ...segment, speakerLabel: label }
        : segment,
    );
    const nextText = formatSpeakerTranscript(nextSegments);
    const nextEntry: HistoryEntry = {
      ...resultEntry,
      raw: nextText,
      cleaned: nextText,
      speakers: nextSpeakers,
      segments: nextSegments,
      mode: "speakers",
    };

    setResultEntry(nextEntry);
    await updateHistoryEntry(nextEntry);
    await emit(HISTORY_UPDATED_EVENT, nextEntry);
  };

  const toggleSpeakerDiarization = async (): Promise<void> => {
    if (speakerDiarization) {
      setSpeakerDiarization(false);
      await saveSettings({ fileSpeakerDiarization: false });
      return;
    }

    const settings = await refreshSpeakerInstalledModels(
      await getSettings({ reload: true }),
    );
    const cloudSpeakerReady = await canUseCloudSpeakerDiarization(
      settings,
      true,
    );
    syncSpeakerSetupState(settings);

    if (!settings.useOwnKey) {
      if (cloudSpeakerReady) {
        setSpeakerDiarization(true);
        await saveSettings({ fileSpeakerDiarization: true });
        return;
      }

      setError(
        toFileTranscriptionErrorMessage(
          new Error("Cloud speaker diarization unavailable"),
        ),
      );
      setSpeakerDiarization(false);
      await saveSettings({ fileSpeakerDiarization: false });
      return;
    }

    if (isSpeakerSetupReady(settings)) {
      setSpeakerDiarization(true);
      await saveSettings({ fileSpeakerDiarization: true });
      return;
    }

    setPendingSpeakerFilePath(null);
    setSpeakerSetupIntent("toggle");
    setSpeakerSetupMessage("");
    setSpeakerSetupError("");
    setSpeakerSetupModalOpen(true);
  };

  const resultText = resultEntry?.cleaned ?? "";
  const shouldCollapseResult = resultText.length > RESULT_PREVIEW_LIMIT;
  const visibleResult =
    shouldCollapseResult && !resultExpanded
      ? `${resultText.slice(0, RESULT_PREVIEW_LIMIT).trimEnd()}...`
      : resultText;
  const speakerSetupActionLabel = "Скачать";
  const closeSpeakerSetupModal = (): void => {
    if (speakerSetupInstalling) return;

    setSpeakerSetupModalOpen(false);
    setPendingSpeakerFilePath(null);
    setSpeakerSetupIntent(null);
    setSpeakerSetupForceRepair(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section style={{ display: "grid", gap: 4 }}>
        <div style={{ display: "grid", gap: 4 }}>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "var(--text-hi)",
              margin: "0 0 4px",
              letterSpacing: "-0.03em",
            }}
          >
            Транскрибация
          </h2>
          <div
            style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}
          >
            Голый текст без дополнительного форматирования.
          </div>
        </div>
      </section>

      <input
        ref={inputRef}
        type="file"
        accept="audio/*,video/*,.mp3,.wav,.m4a,.mp4,.mov,.webm,.ogg,.flac,.mpeg,.mpga,.avi,.mkv"
        onChange={handleInputChange}
        style={{ display: "none" }}
      />

      <section
        role="button"
        tabIndex={isProcessing ? -1 : 0}
        onClick={() => {
          if (!isProcessing) {
            void openFileDialog();
          }
        }}
        onKeyDown={(event) => {
          if (isProcessing || (event.key !== "Enter" && event.key !== " ")) {
            return;
          }

          event.preventDefault();
          void openFileDialog();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className="card"
        style={{
          display: "grid",
          placeItems: "center",
          minHeight: 220,
          padding: 24,
          borderWidth: 2,
          borderStyle: "dashed",
          borderColor: isDragOver
            ? "var(--border-strong)"
            : "var(--border-dashed)",
          background: isDragOver ? "var(--surface-hi)" : "var(--surface)",
          cursor: isProcessing ? "default" : "pointer",
          transition: "background 0.18s ease, border-color 0.18s ease",
        }}
      >
        <div
          style={{
            display: "grid",
            justifyItems: "center",
            gap: 14,
            maxWidth: 520,
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: 14,
              display: "grid",
              placeItems: "center",
              color: "var(--text-hi)",
              background: "var(--icon-soft-bg)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            {isProcessing ? (
              <Loader2
                size={24}
                strokeWidth={1.8}
                style={{ animation: "spin 0.9s linear infinite" }}
              />
            ) : (
              <FileAudio size={25} strokeWidth={1.8} />
            )}
          </div>

          <div style={{ display: "grid", gap: 4 }}>
            <div
              style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}
            >
              {selectedFile ? selectedFile.name : "Перетащите аудио или видео"}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--text-mid)",
                lineHeight: 1.6,
              }}
            >
              {selectedFile
                ? `${selectedFile.size !== null ? `${formatFileSize(selectedFile.size)} · ` : ""}${statusLabel(status, progress)}${isProcessing ? ` · ${progressPercent}%` : ""}`
                : "Нажмите на область или перетащите файл. MP3, WAV, M4A, MP4, MOV, WEBM и другие форматы"}
            </div>
            {convertedInfo && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-low)",
                  lineHeight: 1.5,
                }}
              >
                {convertedInfo}
              </div>
            )}
          </div>

          {isProcessing && (
            <div
              style={{
                width: "min(320px, 100%)",
                height: 4,
                borderRadius: 999,
                overflow: "hidden",
                background: "var(--progress-track)",
              }}
            >
              <div
                style={{
                  width: `${progressPercent}%`,
                  height: "100%",
                  borderRadius: 999,
                  background: "var(--accent)",
                  transition: "width 0.24s ease",
                }}
              />
            </div>
          )}

          {error && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                color: "var(--danger)",
                fontSize: 13,
                lineHeight: 1.5,
                textAlign: "left",
              }}
            >
              <AlertCircle
                size={16}
                strokeWidth={2}
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <span>{error}</span>
            </div>
          )}
        </div>
      </section>

      <section
        className="card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          background: "var(--surface)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: "var(--text-hi)",
              marginBottom: 3,
            }}
          >
            Разделить по говорящим
          </div>
          <div
            style={{ fontSize: 12, color: "var(--text-mid)", lineHeight: 1.5 }}
          >
            Протокол с таймкодами и метками Гость 1, Гость 2.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={speakerDiarization}
          onClick={() => {
            void toggleSpeakerDiarization();
          }}
          disabled={isProcessing}
          style={{
            width: 44,
            height: 26,
            borderRadius: 999,
            border: "none",
            background: speakerDiarization
              ? "var(--accent)"
              : "var(--switch-track)",
            padding: 3,
            cursor: isProcessing ? "not-allowed" : "pointer",
            flexShrink: 0,
            position: "relative",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 3,
              left: 3,
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "var(--accent-contrast)",
              transform: speakerDiarization
                ? "translateX(18px)"
                : "translateX(0)",
              transition: "transform 0.16s ease",
            }}
          />
        </button>
      </section>

      <section ref={resultSectionRef} style={{ display: "grid", gap: 10 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div
            style={{ fontSize: 14, fontWeight: 700, color: "var(--text-hi)" }}
          >
            Результат
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {resultEntry && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void copyResult();
                }}
                style={{ minHeight: 32, padding: "0 12px" }}
              >
                {copied ? (
                  <Check size={13} strokeWidth={2.2} />
                ) : (
                  <Clipboard size={13} strokeWidth={2} />
                )}
                {copied ? "Скопировано" : "Скопировать"}
              </button>
            )}

            {(resultEntry || error || selectedFile) && !isProcessing && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSelectedFile(null);
                  setStatus("idle");
                  resetResult();
                }}
                style={{ width: 32, minWidth: 32, minHeight: 32, padding: 0 }}
                title="Очистить"
              >
                <X size={14} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>

        {resultEntry ? (
          resultEntry.mode === "speakers" && resultEntry.segments?.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {resultEntry.speakers?.length ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {resultEntry.speakers.map((speaker) => (
                    <input
                      key={speaker.id}
                      className="input"
                      value={speaker.label}
                      onChange={(event) => {
                        void renameSpeaker(
                          speaker.id,
                          event.target.value || speaker.label,
                        );
                      }}
                      style={{
                        width: 140,
                        height: 34,
                        padding: "7px 10px",
                        fontSize: 12,
                        fontWeight: 650,
                      }}
                      aria-label={`Имя ${speaker.label}`}
                    />
                  ))}
                </div>
              ) : null}
              <div style={{ display: "grid", gap: 8 }}>
                {resultEntry.segments.map((segment, index) => (
                  <div
                    key={`${segment.start}-${index}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "84px minmax(0, 1fr)",
                      gap: 10,
                      alignItems: "start",
                      padding: "10px 0",
                      borderBottom: "1px solid var(--border-subtle)",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--text-low)",
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      }}
                    >
                      {formatTimestamp(segment.start)}
                    </div>
                    <div style={{ display: "grid", gap: 3 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 800,
                          color: "var(--text-hi)",
                        }}
                      >
                        {segment.speakerLabel}
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          color: "var(--text-mid)",
                          lineHeight: 1.65,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {segment.text}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <table className="b-table" style={{ background: "transparent" }}>
              <thead>
                <tr>
                  <th style={{ width: 92 }}>Время</th>
                  <th style={{ paddingLeft: 8 }}>Текст</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td
                    style={{
                      whiteSpace: "nowrap",
                      verticalAlign: "top",
                      color: "var(--text-low)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 3,
                      }}
                    >
                      <span>
                        {new Date(resultEntry.timestamp).toLocaleTimeString(
                          "ru-RU",
                          {
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          opacity: 0.55,
                          letterSpacing: "0.02em",
                        }}
                      >
                        {resultSourceLabel(resultEntry)}
                      </span>
                    </div>
                  </td>
                  <td style={{ verticalAlign: "top", paddingLeft: 8 }}>
                    <div
                      style={{
                        display: "grid",
                        gap: 2,
                        color: "var(--text-mid)",
                        lineHeight: 1.7,
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                      }}
                    >
                      <span>{visibleResult}</span>
                      {shouldCollapseResult && (
                        <button
                          type="button"
                          onClick={() =>
                            setResultExpanded((current) => !current)
                          }
                          style={{
                            marginLeft: 0,
                            padding: 0,
                            border: "none",
                            background: "transparent",
                            color: "var(--text-hi)",
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: "pointer",
                            textDecoration: "none",
                            justifySelf: "start",
                          }}
                        >
                          {resultExpanded ? "Скрыть" : "Раскрыть"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          )
        ) : (
          <div
            style={{
              padding: "22px 16px",
              borderRadius: 12,
              border: "1px dashed var(--border-dashed)",
              color: "var(--text-low)",
              fontSize: 13,
            }}
          >
            После обработки здесь появится текст.
          </div>
        )}
      </section>

      {speakerSetupModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="speaker-setup-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "var(--modal-scrim)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
          onClick={closeSpeakerSetupModal}
        >
          <div
            className="card"
            style={{
              width: "min(420px, 100%)",
              background: "var(--bg)",
              padding: 18,
              boxShadow: "var(--shadow-modal)",
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              id="speaker-setup-title"
              style={{
                fontSize: 17,
                fontWeight: 750,
                color: "var(--text-hi)",
                marginBottom: 8,
              }}
            >
              Нужна локальная подготовка
            </div>
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.6,
                color: "var(--text-mid)",
                marginBottom: 16,
              }}
            >
              {localWhisperDownloaded
                ? `Для разделения по говорящим Talkis использует ${localWhisperLabel} для распознавания с таймкодами и подготовит локальные компоненты для разметки говорящих.`
                : `Для разделения по говорящим Talkis подготовит ${RECOMMENDED_LOCAL_WHISPER_LABEL} для распознавания с таймкодами и локальные компоненты для разметки говорящих.`}
            </div>

            <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: requirementStatusColor(localWhisperDownloaded),
                  lineHeight: 1.45,
                }}
              >
                {localWhisperDownloaded ? (
                  <Check size={15} strokeWidth={2.2} />
                ) : (
                  <AlertCircle size={15} strokeWidth={2} />
                )}
                <span>
                  {localWhisperDownloaded
                    ? `${localWhisperLabel} готова для разметки`
                    : `${RECOMMENDED_LOCAL_WHISPER_LABEL} будет скачан`}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: requirementStatusColor(diarizationInstalled),
                  lineHeight: 1.45,
                }}
              >
                {diarizationInstalled ? (
                  <Check size={15} strokeWidth={2.2} />
                ) : (
                  <AlertCircle size={15} strokeWidth={2} />
                )}
                <span>
                  {diarizationInstalled
                    ? "Компоненты для разметки"
                    : "Компоненты для разметки говорящих будут скачаны"}
                </span>
              </div>
            </div>

            {(speakerSetupMessage || speakerSetupError) && (
              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.6,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: speakerSetupError
                    ? "var(--danger-soft)"
                    : "var(--control-muted)",
                  color: speakerSetupError
                    ? "var(--error-bright)"
                    : "var(--text-mid)",
                  border: `1px solid ${speakerSetupError ? "var(--danger-border)" : "var(--border-subtle)"}`,
                  marginBottom: 16,
                }}
              >
                {speakerSetupError || speakerSetupMessage}
              </div>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                disabled={speakerSetupInstalling}
                onClick={closeSpeakerSetupModal}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid var(--border-dashed)",
                  background: "var(--control-muted)",
                  color: "var(--text-hi)",
                  fontSize: 12,
                  fontWeight: 700,
                  fontFamily: "var(--font-main)",
                  cursor: speakerSetupInstalling ? "not-allowed" : "pointer",
                }}
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={speakerSetupInstalling}
                onClick={() => {
                  void installSpeakerSetup();
                }}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid var(--border-dashed)",
                  background: "var(--accent)",
                  color: "var(--accent-contrast)",
                  fontSize: 12,
                  fontWeight: 700,
                  fontFamily: "var(--font-main)",
                  cursor: speakerSetupInstalling ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {speakerSetupInstalling ? (
                  <Loader2
                    size={15}
                    strokeWidth={2}
                    style={{ animation: "spin 0.9s linear infinite" }}
                  />
                ) : null}
                {speakerSetupActionLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
