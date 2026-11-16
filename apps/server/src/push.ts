import type { Storage } from "@ribhu-voyager/engine";
import type { PushSubscription } from "@ribhu-voyager/protocol";
import * as webpush from "web-push";

import type { Config } from "./config.js";

export type ApprovalPush = {
  conversationId: number;
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

export type PushSender = (
  subscription: PushSubscription,
  payload: string,
) => Promise<unknown>;

export type PushNotifier = {
  enabled: boolean;
  notify(approval: ApprovalPush): Promise<void>;
};

/**
 * R8: browser Web Push endpoints are always hosted by a push service. Only
 * these providers are accepted unless `RIBBHU_PUSH_ALLOWED_HOSTS` overrides the
 * list, so a tenant cannot point the server at an arbitrary URL (SSRF/link
 * probing).
 */
export const DEFAULT_PUSH_HOSTS: readonly string[] = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "web.push.apple.com",
  "*.push.apple.com",
  "*.notify.windows.com",
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function parseIpv4(host: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return undefined;
  const parts = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => part > 255)) return undefined;
  return parts;
}

function isBlockedIpv4(parts: number[]): boolean {
  const [a = 0, b = 0] = parts;
  return (
    a === 0 || // "this network"
    a === 10 || // private
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast / reserved / broadcast
  );
}

function isBlockedIpv6(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true; // unique local
  if (value.startsWith("fe8") || value.startsWith("fe9") ||
      value.startsWith("fea") || value.startsWith("feb")) return true; // link-local
  if (value.startsWith("ff")) return true; // multicast
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (mapped) {
    const parts = parseIpv4(mapped[1]!);
    return parts ? isBlockedIpv4(parts) : true;
  }
  return false;
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

/**
 * Validate a stored/registered push endpoint. Returns `null` when allowed and a
 * human-readable reason otherwise. No DNS resolution: hostnames are checked
 * against the provider allowlist and dangerous literals/names are rejected.
 */
export function validatePushEndpoint(
  endpoint: string,
  allowedHosts: readonly string[] = DEFAULT_PUSH_HOSTS,
): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "push endpoint must be a valid URL";
  }
  if (url.protocol !== "https:") return "push endpoint must use HTTPS";
  if (url.username !== "" || url.password !== "") {
    return "push endpoint must not embed credentials";
  }
  const host = url.hostname.toLowerCase();
  if (host === "" || BLOCKED_HOSTNAMES.has(host)) {
    return "push endpoint host is not allowed";
  }
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return "push endpoint host is not allowed";
  }
  if (host.includes(":")) {
    if (isBlockedIpv6(host)) return "push endpoint must not target a private address";
  } else {
    const parts = parseIpv4(host);
    if (parts && isBlockedIpv4(parts)) {
      return "push endpoint must not target a private address";
    }
  }
  if (allowedHosts.length > 0 && !allowedHosts.some((pattern) => hostMatches(host, pattern))) {
    return "push endpoint host is not in the allowed push provider list";
  }
  return null;
}

/** Effective push host allowlist for a config (env override replaces defaults). */
export function pushHostAllowlist(config: Config): readonly string[] {
  return config.pushAllowedHosts && config.pushAllowedHosts.length > 0
    ? config.pushAllowedHosts
    : DEFAULT_PUSH_HOSTS;
}

/** Approval push payload never carries tool arguments (they can hold secrets). */
function approvalPayload(approval: ApprovalPush): string {
  return JSON.stringify({
    title: "Approval needed",
    body: `${approval.name} is waiting for your approval`,
    conversationId: approval.conversationId,
    callId: approval.callId,
    url: `/?conversation=${approval.conversationId}`,
  });
}

/** Server Web Push for approval requests. No-op unless VAPID keys are set. */
export function createPushNotifier(
  storage: Storage,
  config: Config,
  send: PushSender = (subscription, payload) =>
    webpush.sendNotification(subscription, payload, { TTL: 300 }),
): PushNotifier {
  const enabled = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
  const allowedHosts = pushHostAllowlist(config);
  if (enabled) {
    webpush.setVapidDetails(
      config.vapidSubject ?? "mailto:hello@srinivas.dev",
      config.vapidPublicKey!,
      config.vapidPrivateKey!,
    );
  }
  return {
    enabled,
    async notify(approval) {
      if (!enabled) return;
      const payload = approvalPayload(approval);
      const entries = await storage.settingsMatching("push:");
      for (const entry of entries) {
        if (entry.value === "") continue;
        let subscription: PushSubscription;
        try {
          subscription = JSON.parse(entry.value) as PushSubscription;
        } catch {
          continue;
        }
        if (!subscription.endpoint || !subscription.keys?.p256dh) continue;
        if (validatePushEndpoint(subscription.endpoint, allowedHosts) !== null) {
          continue;
        }
        try {
          await send(subscription, payload);
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await storage.setSetting(entry.key, "");
          }
        }
      }
    },
  };
}
