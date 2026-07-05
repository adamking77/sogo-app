import { isTauriRuntime } from "@/lib/runtime";

let permissionChecked = false;
let permissionGranted = false;

async function ensurePermission(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  if (permissionChecked) return permissionGranted;

  try {
    const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      permissionGranted = (await requestPermission()) === "granted";
    }
  } catch {
    permissionGranted = false;
  }
  permissionChecked = true;
  return permissionGranted;
}

export async function notifyUser(title: string, body?: string) {
  if (!(await ensurePermission())) return;
  try {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title, body });
  } catch {
    // notifications are best-effort
  }
}

/** macOS dock badge with the count of sessions needing attention. */
export async function setAttentionBadge(count: number) {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
  } catch {
    // badge API is macOS-only and best-effort
  }
}
