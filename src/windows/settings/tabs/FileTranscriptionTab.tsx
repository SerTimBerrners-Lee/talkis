import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent, JSX } from "react";
import { emit } from "@tauri-apps/api/event";
import { AlertCircle, Check, Clipboard, FileAudio, Loader2, X } from "lucide-react";

import { addHistoryEntry, getSettings, HistoryEntry } from "../../../lib/store";
import { HISTORY_UPDATED_EVENT } from "../../../lib/hotkeyEvents";
import {
  FileTranscriptionStatus,
  formatFileSize,
  toFileTranscriptionErrorMessage,
  transcribeFileOnly,
} from "../../../lib/fileTranscription";

type ProcessingState = "idle" | FileTranscriptionStatus | "done" | "error";
const RESULT_PREVIEW_LIMIT = 250;

function statusLabel(status: ProcessingState): string {
  if (status === "reading") return "Читаем файл";
  if (status === "converting") return "Извлекаем и сжимаем аудио";
  if (status === "uploading") return "Отправляем на транскрибацию";
  if (status === "done") return "Готово";
  if (status === "error") return "Ошибка";
  return "Ожидаем файл";
}

export function FileTranscriptionTab(): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [resultEntry, setResultEntry] = useState<HistoryEntry | null>(null);
  const [error, setError] = useState("");
  const [convertedInfo, setConvertedInfo] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);

  const isProcessing = status === "reading" || status === "converting" || status === "uploading";

  const resetResult = (): void => {
    setResultEntry(null);
    setError("");
    setConvertedInfo("");
    setCopied(false);
    setResultExpanded(false);
  };

  const processFile = async (file: File): Promise<void> => {
    setSelectedFile(file);
    resetResult();
    setStatus("reading");

    try {
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

  const resultText = resultEntry?.cleaned ?? "";
  const shouldCollapseResult = resultText.length > RESULT_PREVIEW_LIMIT;
  const visibleResult = shouldCollapseResult && !resultExpanded
    ? `${resultText.slice(0, RESULT_PREVIEW_LIMIT).trimEnd()}...`
    : resultText;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section style={{ display: "grid", gap: 4 }}>
        <div style={{ display: "grid", gap: 4 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-hi)", margin: "0 0 4px", letterSpacing: "-0.03em" }}>
            Транскрибация файла
          </h2>
          <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
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
            inputRef.current?.click();
          }
        }}
        onKeyDown={(event) => {
          if (isProcessing || (event.key !== "Enter" && event.key !== " ")) {
            return;
          }

          event.preventDefault();
          inputRef.current?.click();
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
          borderColor: isDragOver ? "rgba(0,0,0,0.52)" : "rgba(0,0,0,0.24)",
          background: isDragOver ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.68)",
          cursor: isProcessing ? "default" : "pointer",
          transition: "background 0.18s ease, border-color 0.18s ease",
        }}
      >
        <div style={{ display: "grid", justifyItems: "center", gap: 14, maxWidth: 520, textAlign: "center" }}>
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: 14,
              display: "grid",
              placeItems: "center",
              color: "var(--text-hi)",
              background: "rgba(0,0,0,0.04)",
              border: "1px solid rgba(0,0,0,0.06)",
            }}
          >
            {isProcessing ? <Loader2 size={24} strokeWidth={1.8} style={{ animation: "spin 0.9s linear infinite" }} /> : <FileAudio size={25} strokeWidth={1.8} />}
          </div>

          <div style={{ display: "grid", gap: 4 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-hi)" }}>
              {selectedFile ? selectedFile.name : "Перетащите аудио или видео"}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-mid)", lineHeight: 1.6 }}>
              {selectedFile ? `${formatFileSize(selectedFile.size)} · ${statusLabel(status)}` : "Нажмите на область или перетащите файл. MP3, WAV, M4A, MP4, MOV, WEBM и другие форматы"}
            </div>
            {convertedInfo && (
              <div style={{ fontSize: 12, color: "var(--text-low)", lineHeight: 1.5 }}>
                {convertedInfo}
              </div>
            )}
          </div>

          {isProcessing && (
            <div style={{ width: "min(320px, 100%)", height: 4, borderRadius: 999, overflow: "hidden", background: "rgba(0,0,0,0.08)" }}>
              <div style={{ width: status === "reading" ? "30%" : status === "converting" ? "64%" : "88%", height: "100%", borderRadius: 999, background: "#000", transition: "width 0.24s ease" }} />
            </div>
          )}

          {error && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, color: "var(--danger)", fontSize: 13, lineHeight: 1.5, textAlign: "left" }}>
              <AlertCircle size={16} strokeWidth={2} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{error}</span>
            </div>
          )}
        </div>
      </section>

      <section style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-hi)" }}>Результат</div>

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
                {copied ? <Check size={13} strokeWidth={2.2} /> : <Clipboard size={13} strokeWidth={2} />}
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
          <table className="b-table" style={{ background: "transparent" }}>
            <thead>
              <tr>
                <th style={{ width: 92 }}>Время</th>
                <th style={{ paddingLeft: 8 }}>Текст</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ whiteSpace: "nowrap", verticalAlign: "top", color: "var(--text-low)" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span>
                      {new Date(resultEntry.timestamp).toLocaleTimeString("ru-RU", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <span style={{ fontSize: 10, opacity: 0.55, letterSpacing: "0.02em" }}>Файл</span>
                  </div>
                </td>
                <td style={{ verticalAlign: "top", paddingLeft: 8 }}>
                  <div style={{ display: "grid", gap: 2, color: "var(--text-mid)", lineHeight: 1.7, overflowWrap: "anywhere", wordBreak: "break-word" }}>
                    <span>{visibleResult}</span>
                    {shouldCollapseResult && (
                      <button
                        type="button"
                        onClick={() => setResultExpanded((current) => !current)}
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
        ) : (
          <div style={{ padding: "22px 16px", borderRadius: 12, border: "1px dashed rgba(0,0,0,0.12)", color: "var(--text-low)", fontSize: 13 }}>
            После обработки здесь появится текст.
          </div>
        )}
      </section>
    </div>
  );
}
