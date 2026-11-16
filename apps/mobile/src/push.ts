/**
 * Web Push subscription helpers. Server push requires HTTPS (or localhost),
 * a service worker, and a VAPID public key from the gateway.
 */

export type PushSubscriptionPayload = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(normalized);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

/** Register the SW and subscribe. Must be called from a user gesture. */
export async function subscribeForPush(
  publicKey: string,
): Promise<PushSubscriptionPayload> {
  if (!pushSupported()) throw new Error("Push is not supported in this browser.");
  if (Notification.permission === "denied") {
    throw new Error("Notifications are blocked for this site.");
  }
  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("Notification permission was not granted.");
    }
  }
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("Push subscription is missing keys.");
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

/** Unsubscribe locally and return the endpoint the server should forget. */
export async function unsubscribeFromPush(): Promise<string | undefined> {
  if (!pushSupported()) return undefined;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return undefined;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}
