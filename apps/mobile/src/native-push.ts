/**
 * Native push registration seam: APNs on iOS, FCM on Android.
 *
 * This is the native counterpart to `push.ts` (which handles Web Push/VAPID in
 * the browser/PWA). It is a seam only:
 *
 * - `registerNativePushToken()` requests notification permission, registers
 *   with APNs/FCM through `@capacitor/push-notifications`, and resolves the
 *   device token + platform for callers (for example a future token endpoint).
 * - `cachedNativePushToken()` returns the last token registered in this page
 *   session.
 * - Nothing here sends the token to the gateway: there is no protocol or
 *   server-side device registry for native tokens yet.
 * - End-to-end push does not work yet. It needs APNs credentials (Apple Push
 *   Notifications key/certificate, an `aps-environment` provisioning profile,
 *   the APNs provider in your backend) and FCM (`google-services.json` +
 *   Firebase project credentials). Without them the OS never returns a token and
 *   `registerNativePushToken()` resolves `null`.
 *
 * The plugin is loaded with a dynamic import so browser builds keep working.
 */

import type {
  PermissionStatus,
  Token as PluginToken,
} from "@capacitor/push-notifications";

export type NativePushPlatform = "ios" | "android";

export type NativePushPermission = "unsupported" | PermissionStatus["receive"];

export type NativePushToken = {
  token: string;
  platform: NativePushPlatform;
};

type CapacitorLike = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

function capacitor(): CapacitorLike | undefined {
  return (globalThis as { Capacitor?: CapacitorLike }).Capacitor;
}

export function nativePushPlatform(): NativePushPlatform | null {
  const platform = capacitor()?.getPlatform?.();
  return platform === "ios" || platform === "android" ? platform : null;
}

/** True only inside a native Capacitor shell (false in browsers). */
export function nativePushSupported(): boolean {
  return nativePushPlatform() !== null && capacitor()?.isNativePlatform?.() === true;
}

/** Ask for notification permission; never throws. */
export async function requestNativePushPermission(): Promise<NativePushPermission> {
  if (!nativePushSupported()) return "unsupported";
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    let status = await PushNotifications.checkPermissions();
    if (status.receive === "prompt" || status.receive === "prompt-with-rationale") {
      status = await PushNotifications.requestPermissions();
    }
    return status.receive;
  } catch {
    return "denied";
  }
}

let cached: NativePushToken | null = null;
let inFlight: Promise<NativePushToken | null> | null = null;

export function cachedNativePushToken(): NativePushToken | null {
  return cached;
}

/**
 * Request permission, register with APNs/FCM, and resolve the device token.
 *
 * Resolves `null` on web, when permission is denied, or when the platform never
 * delivers a registration token (simulator, missing push credentials).
 */
export function registerNativePushToken(
  timeoutMs = 15_000,
): Promise<NativePushToken | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const platform = nativePushPlatform();
      if (!nativePushSupported() || platform === null) return null;
      const permission = await requestNativePushPermission();
      if (permission !== "granted") return null;

      const { PushNotifications } = await import("@capacitor/push-notifications");
      const token = await new Promise<string | null>((resolve) => {
        const handles: { remove: () => Promise<void> }[] = [];
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (value: string | null) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          for (const handle of handles) {
            void handle.remove().catch(() => undefined);
          }
          resolve(value);
        };

        timer = setTimeout(() => finish(null), timeoutMs);
        void (async () => {
          try {
            handles.push(
              await PushNotifications.addListener("registration", (value: PluginToken) =>
                finish(value.value),
              ),
            );
            handles.push(
              await PushNotifications.addListener("registrationError", () => finish(null)),
            );
            await PushNotifications.register();
          } catch {
            finish(null);
          }
        })();
      });

      if (token === null) return null;
      cached = { token, platform };
      return cached;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
