import { invoke } from "@tauri-apps/api/core";

export type PermissionStatus = "unknown" | "granted" | "denied" | "prompting";

export interface PermissionsState {
  microphone: PermissionStatus;
  accessibility: PermissionStatus;
  systemAudio: PermissionStatus;
}

export async function checkMicrophonePermission(): Promise<PermissionStatus> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return "granted";
  } catch {
    return "denied";
  }
}

export async function requestMicrophonePermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

export async function checkAccessibilityPermission(): Promise<PermissionStatus> {
  try {
    const trusted = await invoke<boolean>("check_accessibility_permission");
    return trusted ? "granted" : "denied";
  } catch {
    return "unknown";
  }
}

export async function checkSystemAudioPermission(): Promise<PermissionStatus> {
  return requiresSystemAudioPermission() ? "unknown" : "granted";
}

export function requiresSystemAudioPermission(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  return value.includes("mac");
}

export async function requestSystemAudioPermission(): Promise<boolean> {
  if (!requiresSystemAudioPermission()) {
    return true;
  }

  let session: { id: string } | null = null;

  try {
    session = await invoke<{ id: string }>("start_call_capture", {
      req: {
        targetId: "system-output",
        includeMic: false,
        includeSystem: true,
      },
    });
    return true;
  } catch {
    return false;
  } finally {
    if (session) {
      await invoke("stop_call_capture", { sessionId: session.id }).catch(
        () => undefined,
      );
    }
  }
}

export async function checkAllPermissions(): Promise<PermissionsState> {
  return {
    microphone: await checkMicrophonePermission(),
    accessibility: await checkAccessibilityPermission(),
    systemAudio: await checkSystemAudioPermission(),
  };
}
