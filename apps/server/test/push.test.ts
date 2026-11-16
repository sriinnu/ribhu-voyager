import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isClientMessage } from "@ribhu-voyager/protocol";
import * as webpush from "web-push";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { createPushNotifier } from "../src/push.js";

function configFor(dir: string, keys: { publicKey: string; privateKey: string }): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    workspaceDir: join(dir, "workspace"),
    provider: "demo",
    model: "ribhu-demo",
    demo: true,
    demoTokensPerSecond: 4000,
    maxWindowEntries: 100,
    token: "",
    authMode: "auto",
    authSource: "auto",
    vapidPublicKey: keys.publicKey,
    vapidPrivateKey: keys.privateKey,
    vapidSubject: "mailto:test@example.com",
  };
}

test("push protocol accepts a subscription and unsubscribe", () => {
  assert.equal(
    isClientMessage({
      t: "push",
      subscription: {
        endpoint: "https://push.example/abc",
        keys: { p256dh: "p", auth: "a" },
      },
    }),
    true,
  );
  assert.equal(
    isClientMessage({ t: "push", subscription: null, endpoint: "https://push.example/abc" }),
    true,
  );
  assert.equal(
    isClientMessage({ t: "push-device", token: "a".repeat(32), platform: "ios" }),
    true,
  );
});

test("push notifier sends to stored subscriptions and drops gone endpoints", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-push-"));
  const keys = webpush.generateVAPIDKeys();
  const api = await createApiRuntime(configFor(dir, keys));
  try {
    await api.setPushSubscription?.({
      endpoint: "https://push.example/one",
      keys: { p256dh: "p256dh", auth: "auth" },
    });
    await api.setPushDevice?.("a".repeat(64), "ios");
    const devices = await api.storage.settingsMatching("device:");
    assert.equal(devices.length, 1);
    assert.match(devices[0]!.value, /"platform":"ios"/);

    const sent: Array<{ endpoint: string; payload: string }> = [];
    const notifier = createPushNotifier(api.storage, configFor(dir, keys), async (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload });
      return {};
    });
    await notifier.notify({
      conversationId: 1,
      callId: "call_1",
      name: "bash",
      args: { command: "npm test" },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.endpoint, "https://push.example/one");
    const body = JSON.parse(sent[0]!.payload) as { title: string; body: string; callId: string };
    assert.equal(body.title, "Approval needed");
    assert.match(body.body, /bash: npm test/);
    assert.equal(body.callId, "call_1");

    const gone = createPushNotifier(api.storage, configFor(dir, keys), async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    });
    await gone.notify({
      conversationId: 1,
      callId: "call_2",
      name: "write",
      args: { path: "a.txt" },
    });
    const remaining = await api.storage.settingsMatching("push:");
    assert.deepEqual(
      remaining.filter((entry) => entry.value !== "").map((entry) => entry.key),
      [],
    );
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
