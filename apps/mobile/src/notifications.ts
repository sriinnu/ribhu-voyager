/**
 * Local approval notifications (browser Notification API only).
 *
 * ## What is implemented
 *
 * - An in-app "Enable notifications" control calls `requestPermission()` from
 *   a user gesture.
 * - When a pending `pi.approval` is observed while the page is hidden and
 *   permission is already granted, `notifyPendingApproval()` shows a local
 *   notification. Each tool call is notified at most once.
 *
 * ## What is NOT implemented
 *
 * - No push, VAPID, service-worker push, APNs or FCM: nothing arrives while
 *   the app is closed, and no notification actions (approve/deny from the
 *   notification shade) exist. The notification only deep-focuses the app,
 *   where the approval card is waiting.
 * - No re-notification or quiet hours; no per-tool preferences.
 */

import { approvalPreview, type Approval } from "./format";

/** `unsupported` covers non-browser / SSR / old webviews. */
export type NotificationSupport = "unsupported" | NotificationPermission;

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationSupport {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;
}

/**
 * Ask the browser for permission. Must be called from a user gesture.
 * Returns the resulting state (never throws).
 */
export async function requestNotificationPermission(): Promise<NotificationSupport> {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationPermission();
  }
}

/** CallIds already notified in this page session (avoids one notification per view update). */
const notified = new Set<string>();

export function resetApprovalNotifications(): void {
  notified.clear();
}

/**
 * Show one local notification for a pending approval. Returns `false` when the
 * notification was not shown (permission missing, unsupported, duplicate).
 */
export function notifyPendingApproval(approval: Approval): boolean {
  if (approval.status !== "pending") return false;
  if (!notificationsSupported()) return false;
  if (Notification.permission !== "granted") return false;
  if (notified.has(approval.callId)) return false;

  const preview = approvalPreview(approval, 120);
  try {
    const notification = new Notification(`Approval needed — ${approval.name}`, {
      body: preview === "" ? "Ribhu is waiting for your decision." : `Ribhu wants to run: ${preview}`,
      tag: `ribhu-approval-${approval.callId}`,
      data: { callId: approval.callId, name: approval.name },
    });
    notified.add(approval.callId);
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        /* focus is best-effort */
      }
      notification.close();
    };
    return true;
  } catch {
    /* Notification constructor can throw in some embedded webviews */
    return false;
  }
}
