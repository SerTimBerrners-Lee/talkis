import { invoke } from "@tauri-apps/api/core";

export type PermissionStatus = 'unknown' | 'granted' | 'denied' | 'prompting';

export interface PermissionsState {
  microphone: PermissionStatus;
  accessibility: PermissionStatus;
}

export async function checkMicrophonePermission(): Promise<PermissionStatus> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}

export async function requestMicrophonePermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
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

export async function checkAllPermissions(): Promise<PermissionsState> {
  return {
    microphone: await checkMicrophonePermission(),
    accessibility: await checkAccessibilityPermission(),
  };
}
