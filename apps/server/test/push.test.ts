import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isClientMessage } from "@ribhu-voyager/protocol";
import * as webpush from "web-push";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import {
  DEFAULT_PUSH_HOSTS,
  createPushNotifier,
  validatePushEndpoint,
} from "../src/push.js";

function configFor(
  dir: string,
  keys: { publicKey: string; privateKey: string },
  extra: Partial<Config> = {},
): Config {
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
    ...extra,
  };
}

test("push protocol accepts a subscription, unsubscribe, and device registration", () => {
  assert.equal(
    isClientMessage({
      t: "push",
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        keys: { p256dh: "p", auth: "a" },
      },
    }),
    true,
  );
  assert.equal(
    isClientMessage({
      t: "push",
      subscription: null,
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    }),
    true,
  );
  assert.equal(
    isClientMessage({ t: "push-device", token: "a".repeat(32), platform: "ios" }),
    true,
  );
});

test("R8: push endpoints must be HTTPS public push-provider hosts", () => {
  assert.equal(validatePushEndpoint("https://fcm.googleapis.com/fcm/send/abc"), null);
  assert.equal(
    validatePushEndpoint("https://abc.notify.windows.com/w/?token=1"),
    null,
    "default allowlist covers WNS subdomains",
  );
  assert.equal(
    validatePushEndpoint("https://push.example/one", ["push.example"]),
    null,
    "explicit allowlist can extend the providers",
  );

  const rejected = [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://localhost/push",
    "https://127.0.0.1/push",
    "https://10.1.2.3/push",
    "https://172.16.4.5/push",
    "https://192.168.1.10/push",
    "https://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal/computeMetadata/v1",
    "https://evil.example/push",
    "https://fcm.googleapis.com.evil.example/push",
    "https://user:pass@fcm.googleapis.com/push",
    "not-a-url",
  ];
  for (const endpoint of rejected) {
    assert.notEqual(
      validatePushEndpoint(endpoint),
      null,
      `expected rejection for ${endpoint}`,
    );
  }
  assert.ok(DEFAULT_PUSH_HOSTS.includes("fcm.googleapis.com"));
});

test("R8: registering a push subscription validates the endpoint per tenant", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-push-validate-"));
  const api = await createApiRuntime(configFor(dir, webpush.generateVAPIDKeys()));
  try {
    await api.setPushSubscription?.({
      endpoint: "https://fcm.googleapis.com/fcm/send/ok",
      keys: { p256dh: "p", auth: "a" },
    });
    const stored = (await api.storage.settingsMatching("push:")).filter(
      (entry) => entry.value !== "",
    );
    assert.equal(stored.length, 1);

    for (const endpoint of [
      "https://localhost/push",
      "https://127.0.0.1/push",
      "https://169.254.169.254/latest/meta-data",
      "https://evil.example/push",
      "http://fcm.googleapis.com/fcm/send/plain",
    ]) {
      await assert.rejects(
        api.setPushSubscription?.({ endpoint, keys: { p256dh: "p", auth: "a" } }) ??
          Promise.resolve(),
        /push endpoint/i,
        `expected rejection for ${endpoint}`,
      );
    }

    // Allowlisted hosts can be configured explicitly.
    const custom = await createApiRuntime(
      configFor(dir, webpush.generateVAPIDKeys(), {
        pushAllowedHosts: ["push.example"],
        dataDir: join(dir, "custom"),
      }),
    );
    try {
      await custom.setPushSubscription?.({
        endpoint: "https://push.example/one",
        keys: { p256dh: "p", auth: "a" },
      });
    } finally {
      await custom.close();
    }
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("R8: approval pushes are redacted and only sent to valid endpoints", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-push-redact-"));
  const keys = webpush.generateVAPIDKeys();
  const api = await createApiRuntime(configFor(dir, keys));
  try {
    await api.setPushSubscription?.({
      endpoint: "https://fcm.googleapis.com/fcm/send/one",
      keys: { p256dh: "p256dh", auth: "auth" },
    });
    // Simulate a legacy/blocked endpoint that bypassed registration.
    await api.storage.setSetting(
      "push:legacy",
      JSON.stringify({
        endpoint: "http://127.0.0.1/internal",
        keys: { p256dh: "p", auth: "a" },
      }),
    );
    await api.setPushDevice?.("a".repeat(64), "ios");
    const devices = await api.storage.settingsMatching("device:");
    assert.equal(devices.length, 1);
    assert.match(devices[0]!.value, /"platform":"ios"/);

    const sent: Array<{ endpoint: string; payload: string }> = [];
    const notifier = createPushNotifier(
      api.storage,
      configFor(dir, keys),
      async (subscription, payload) => {
        sent.push({ endpoint: subscription.endpoint, payload });
        return {};
      },
    );
    await notifier.notify({
      conversationId: 1,
      callId: "call_1",
      name: "bash",
      args: { command: "npm test --secret-token", password: "hunter2" },
    });
    assert.equal(sent.length, 1, "blocked stored endpoint is skipped");
    assert.equal(sent[0]!.endpoint, "https://fcm.googleapis.com/fcm/send/one");

    const body = JSON.parse(sent[0]!.payload) as {
      title: string;
      body: string;
      callId: string;
      conversationId: number;
    };
    assert.equal(body.title, "Approval needed");
    assert.equal(body.body, "bash is waiting for your approval");
    assert.equal(body.callId, "call_1");
    assert.equal(body.conversationId, 1);
    assert.doesNotMatch(sent[0]!.payload, /npm test|secret-token|hunter2|command/);

    // A gone endpoint is cleared from storage.
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
    // The valid provider endpoint was cleared on 410; the pre-existing invalid
    // legacy entry is skipped, never sent, and left untouched.
    assert.deepEqual(
      remaining.filter((entry) => entry.value !== "").map((entry) => entry.key),
      ["push:legacy"],
    );
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("R8: device tokens can be unregistered per platform", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-push-device-"));
  const api = await createApiRuntime(configFor(dir, webpush.generateVAPIDKeys()));
  try {
    await api.setPushDevice?.("i".repeat(64), "ios");
    await api.setPushDevice?.("a".repeat(64), "android");
    const before = (await api.storage.settingsMatching("device:")).filter(
      (entry) => entry.value !== "",
    );
    assert.equal(before.length, 2);

    await api.setPushDevice?.(null, "ios");
    const after = (await api.storage.settingsMatching("device:")).filter(
      (entry) => entry.value !== "",
    );
    assert.equal(after.length, 1);
    assert.match(after[0]!.value, /"platform":"android"/);
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
