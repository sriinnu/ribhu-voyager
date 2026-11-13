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
