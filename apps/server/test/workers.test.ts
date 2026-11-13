import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { startWorker } from "../src/worker.js";

function configFor(dir: string): Config {
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
  };
}

test("two workers never answer one submission twice", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-workers-"));
  const api = await createApiRuntime(configFor(dir));
  const first = await startWorker(configFor(dir));
  const second = await startWorker(configFor(dir));
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "What is durable?",
      requestId: "two-workers-1",
      whenBusy: "steer",
    });

    let assistants = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      assistants = (await api.storage.entries(conversation.id)).entries.filter(
        (entry) => entry.kind === "pi.assistant",
      ).length;
      if (assistants > 0 && !(await api.storage.busy(conversation.id))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    assistants = (await api.storage.entries(conversation.id)).entries.filter(
      (entry) => entry.kind === "pi.assistant",
    ).length;
    assert.equal(assistants, 1);
  } finally {
    await first.close();
    await second.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start >= timeoutMs) {
      throw new Error("timed out waiting for the expected state");
    }
    await sleep(50);
  }
}

test("worker shutdown clears only its own health keys", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-worker-keys-"));
  const api = await createApiRuntime(configFor(dir));
  const worker = await startWorker(configFor(dir));
  try {
    const owner = await waitFor(async () => {
      const pairs = await api.storage.settingsMatching("worker_heartbeat:");
      const active = pairs.find((pair) => Number(pair.value) > 0);
      return active
        ? active.key.slice("worker_heartbeat:".length)
        : undefined;
    });

    // Simulate another worker owning the aggregate job slot.
    const foreignJob = JSON.stringify({
      id: 99,
      conversationId: 1,
      owner: "other:owner",
      startedAt: Date.now(),
    });
    await api.storage.setSetting("worker_job", foreignJob);
    await api.storage.setSetting(
      `worker_job:${owner}`,
      JSON.stringify({
        id: 1,
        conversationId: 1,
        owner,
        startedAt: Date.now(),
      }),
    );

    await worker.close();

    assert.equal(
      await api.storage.getSetting(`worker_job:${owner}`),
      "",
      "the worker cleared its own job key",
    );
    assert.equal(
      await api.storage.getSetting("worker_job"),
      foreignJob,
      "another worker's aggregate job is untouched",
    );
    const activeHeartbeats = (
      await api.storage.settingsMatching("worker_heartbeat:")
    ).filter((pair) => Number(pair.value) > 0);
    assert.equal(activeHeartbeats.length, 0, "its own heartbeat is cleared");
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
