import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

import { HISTORY_UPDATED_EVENT } from "./hotkeyEvents";
import { logError } from "./logger";
import {
  addHistoryEntry,
  updateHistoryEntry,
  type AppSettings,
  type HistoryEntry,
} from "./store";
import {
  transcribeFilePathOnly,
  transcribeFileOnly,
  type FileTranscriptionProgress,
  type FileTranscriptionStatus,
} from "./fileTranscription";

export type CaptureTargetKind = "systemOutput" | "process" | "window";
export type CallCaptureStatus = "starting" | "recording" | "stopped" | "failed";
export type CallCaptureTrackKind = "mic" | "system";

export interface CaptureTarget {
  id: string;
  label: string;
  kind: CaptureTargetKind;
  platform: string;
}

export interface StartCallCaptureRequest {
  targetId?: string | null;
  includeMic?: boolean;
  includeSystem?: boolean;
  micDeviceId?: string | null;
  sampleRate?: number | null;
}

export interface CallCaptureTrack {
  kind: CallCaptureTrackKind;
  label: string;
  path: string;
  channels: number;
  sampleRate: number;
}

export interface CallCaptureSession {
  id: string;
  platform: string;
  status: CallCaptureStatus;
  startedAt: string;
  endedAt?: string | null;
  directory: string;
  tracks: CallCaptureTrack[];
}

export async function listCallCaptureTargets(): Promise<CaptureTarget[]> {
  return invoke<CaptureTarget[]>("list_call_capture_targets");
}

export async function startCallCapture(
  req: StartCallCaptureRequest,
): Promise<CallCaptureSession> {
  return invoke<CallCaptureSession>("start_call_capture", { req });
}

export async function stopCallCapture(
  sessionId: string,
): Promise<CallCaptureSession> {
  return invoke<CallCaptureSession>("stop_call_capture", { sessionId });
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

export async function saveCallCaptureMicTrack(
  sessionId: string,
  blob: Blob,
): Promise<CallCaptureTrack> {
  const audioBase64 = arrayBufferToBase64(await blob.arrayBuffer());
  return invoke<CallCaptureTrack>("save_call_capture_mic_track", {
    sessionId,
    audioBase64,
    mimeType: blob.type || null,
  });
}

export async function getCallCaptureStatus(
  sessionId: string,
): Promise<CallCaptureSession> {
  return invoke<CallCaptureSession>("get_call_capture_status", { sessionId });
}

export async function getCallCaptureDurationMs(
  sessionId: string,
): Promise<number> {
  return invoke<number>("get_call_capture_duration_ms", { sessionId });
}

export async function saveFailedCallCaptureEntry({
  session,
  errorMessage,
  startedAt,
}: {
  session: CallCaptureSession;
  errorMessage: string;
  startedAt?: number;
}): Promise<HistoryEntry> {
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    duration: startedAt
      ? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      : 0,
    raw: "",
    cleaned: "",
    source: "call",
    fileName: "Созвон",
    status: "failed",
    errorMessage,
    processingTime: startedAt ? Date.now() - startedAt : undefined,
    callSessionId: session.id,
    callTracks: session.tracks.map((track) => ({
      kind: track.kind,
      label: track.label,
      path: track.path,
    })),
  };

  await addHistoryEntry(entry);
  await emit(HISTORY_UPDATED_EVENT, entry);
  return entry;
}

function callTrackTitle(track: CallCaptureTrack): string {
  return track.kind === "mic" ? "Вы" : "Созвон";
}

function formatTrackTranscript(track: CallCaptureTrack, text: string): string {
  return `${callTrackTitle(track)}:\n${text.trim()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TranscribeCallCaptureSessionParams {
  session: CallCaptureSession;
  settings: AppSettings;
  startedAt?: number;
  micFile?: File | null;
  onStatus?: (status: FileTranscriptionStatus) => void;
  onProgress?: (progress: FileTranscriptionProgress) => void;
}

async function buildCallCaptureHistoryEntry({
  session,
  settings,
  startedAt,
  micFile,
  onStatus,
  onProgress,
}: TranscribeCallCaptureSessionParams, overrides?: {
  id?: string;
  timestamp?: string;
  duration?: number;
}): Promise<HistoryEntry> {
  const orderedTracks = [...session.tracks].sort((left, right) => {
    if (left.kind === right.kind) return 0;
    return left.kind === "mic" ? -1 : 1;
  });

  const parts: string[] = [];
  const speakerSegments: NonNullable<HistoryEntry["segments"]> = [];
  const speakersById = new Map<
    string,
    NonNullable<HistoryEntry["speakers"]>[number]
  >();
  let mode: HistoryEntry["mode"] = "plain";
  let requiredSystemDiarizationFailed = false;

  const failedTracks: string[] = [];

  if (micFile) {
    try {
      const micResult = await transcribeFileOnly({
        file: micFile,
        settings,
        onStatus,
      });
      parts.push(`Вы:\n${micResult.text.trim()}`);
    } catch (error) {
      const message = errorMessage(error);
      failedTracks.push(`микрофон: ${message}`);
      void logError(
        "CALL_CAPTURE",
        `Mic track transcription failed: ${message}`,
      );
    }
  }

  for (const track of orderedTracks.filter(
    (track) => !(track.kind === "mic" && micFile),
  )) {
    const shouldDiarizeSystemTrack =
      track.kind === "system" && settings.fileSpeakerDiarization === true;

    try {
      const result = await transcribeFilePathOnly({
        filePath: track.path,
        settings,
        onStatus,
        onProgress,
        speakerDiarization: shouldDiarizeSystemTrack,
      });

      if (result.segments?.length) {
        mode = "speakers";
        result.speakers?.forEach((speaker) => {
          speakersById.set(speaker.id, speaker);
        });
        speakerSegments.push(...result.segments);
        parts.push(result.text);
        continue;
      }

      if (shouldDiarizeSystemTrack) {
        throw new Error("Разделение говорящих не вернуло сегменты.");
      }

      parts.push(formatTrackTranscript(track, result.text));
    } catch (error) {
      const message = errorMessage(error);
      failedTracks.push(`${callTrackTitle(track).toLowerCase()}: ${message}`);
      requiredSystemDiarizationFailed =
        requiredSystemDiarizationFailed || shouldDiarizeSystemTrack;
      void logError(
        "CALL_CAPTURE",
        `${track.kind} track transcription failed: ${message}`,
      );
    }
  }

  if (requiredSystemDiarizationFailed) {
    throw new Error(failedTracks.join("; "));
  }

  const text = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) {
    throw new Error(
      failedTracks.length > 0
        ? failedTracks.join("; ")
        : "В созвоне не удалось распознать речь.",
    );
  }

  const entry: HistoryEntry = {
    id: overrides?.id ?? crypto.randomUUID(),
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
    duration: overrides?.duration ?? 0,
    raw: text,
    cleaned: text,
    source: "call",
    fileName: "Созвон",
    status: "completed",
    processingTime: startedAt ? Date.now() - startedAt : undefined,
    mode,
    speakers:
      speakersById.size > 0 ? Array.from(speakersById.values()) : undefined,
    segments: speakerSegments.length > 0 ? speakerSegments : undefined,
    callSessionId: session.id,
    callTracks: session.tracks.map((track) => ({
      kind: track.kind,
      label: track.label,
      path: track.path,
    })),
  };

  return entry;
}

export async function transcribeCallCaptureSession(
  params: TranscribeCallCaptureSessionParams,
): Promise<HistoryEntry> {
  const entry = await buildCallCaptureHistoryEntry(params);

  await addHistoryEntry(entry);
  await emit(HISTORY_UPDATED_EVENT, entry);
  return entry;
}

function sessionFromHistoryEntry(entry: HistoryEntry): CallCaptureSession {
  return {
    id: entry.callSessionId || entry.id,
    platform: "macos",
    status: "stopped",
    startedAt: entry.timestamp,
    endedAt: null,
    directory: "",
    tracks: (entry.callTracks || []).map((track) => ({
      kind: track.kind,
      label: track.label,
      path: track.path,
      channels: track.kind === "mic" ? 1 : 2,
      sampleRate: 48_000,
    })),
  };
}

export async function retryCallCaptureHistoryEntry(
  entry: HistoryEntry,
  settings: AppSettings,
): Promise<HistoryEntry> {
  if (!entry.callTracks?.length) {
    throw new Error("У этой записи нет сохраненных дорожек созвона для повторной обработки.");
  }

  const session = sessionFromHistoryEntry(entry);

  try {
    const updatedEntry = await buildCallCaptureHistoryEntry(
      {
        session,
        settings,
        startedAt: Date.now(),
      },
      {
        id: entry.id,
        timestamp: entry.timestamp,
        duration: entry.duration,
      },
    );

    await updateHistoryEntry(updatedEntry);
    await emit(HISTORY_UPDATED_EVENT, updatedEntry);
    return updatedEntry;
  } catch (error) {
    const userFacingMessage =
      "Не удалось обработать запись. Попробуйте повторить попытку.";
    const failedEntry: HistoryEntry = {
      ...entry,
      status: "failed",
      errorMessage: userFacingMessage,
    };

    await updateHistoryEntry(failedEntry);
    await emit(HISTORY_UPDATED_EVENT, failedEntry);
    void logError("CALL_CAPTURE", `Retry call capture failed: ${errorMessage(error)}`);
    throw new Error(userFacingMessage);
  }
}
