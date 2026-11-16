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

function preview(args: Record<string, unknown>): string {
  const value = args.command ?? args.path ?? JSON.stringify(args);
  return String(value).replace(/\s+/g, " ").slice(0, 120);
}

/** Server Web Push for approval requests. No-op unless VAPID keys are set. */
export function createPushNotifier(
  storage: Storage,
  config: Config,
  send: PushSender = (subscription, payload) =>
    webpush.sendNotification(subscription, payload, { TTL: 300 }),
): PushNotifier {
  const enabled = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
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
        const payload = JSON.stringify({
          title: "Approval needed",
          body: `${approval.name}: ${preview(approval.args)}`,
          conversationId: approval.conversationId,
          callId: approval.callId,
          url: `/?conversation=${approval.conversationId}`,
        });
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
