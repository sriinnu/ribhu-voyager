import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Provider,
  ProviderEvent,
  ProviderRequest,
  Usage,
} from "@ribhu-voyager/engine";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { startWorker } from "../src/worker.js";

const usage: Usage = { input: 0, output: 0, totalTokens: 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class SteerProvider implements Provider {
  readonly id = "steer";
  readonly model = "steer";
  calls = 0;
  sawSteer = false;

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: "toolCall",
        id: "call-sleep",
        name: "bash",
        arguments: { command: "sleep 0.5" },
      };
      yield { type: "done", stopReason: "toolUse", usage };
      return;
    }
    this.sawSteer = request.messages.some(
      (message) =>
        message.role === "user" && message.content.includes("steer me"),
    );
    yield { type: "text", text: "steered answer" };
    yield { type: "done", stopReason: "stop", usage };
  }
}

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

test("a steered message joins the running turn", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-steer-"));
  const api = await createApiRuntime(configFor(dir));
  const provider = new SteerProvider();
  const worker = await startWorker(configFor(dir), { provider });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "first",
      requestId: "steer-1",
      whenBusy: "steer",
    });
    await sleep(150);
    await conversation.submit({
      type: "input",
      content: "steer me",
      requestId: "steer-2",
      whenBusy: "steer",
    });

    let first = "";
    let second = "";
    for (let attempt = 0; attempt < 150; attempt += 1) {
      first =
        (await api.storage.findSubmission(conversation.id, "steer-1"))?.status ?? "";
      second =
        (await api.storage.findSubmission(conversation.id, "steer-2"))?.status ?? "";
      if (first === "done" && second === "done") break;
      await sleep(50);
    }
    assert.equal(first, "done");
    assert.equal(second, "done");
    assert.equal(provider.sawSteer, true, "the model saw the steered input");
    assert.ok(provider.calls >= 2);
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class QueueProvider implements Provider {
  readonly id = "queue";
  readonly model = "queue";
  calls = 0;
  sawQueueEarly = false;
  sawQueueLater = false;

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: "toolCall",
        id: "call-sleep-queue",
        name: "bash",
        arguments: { command: "sleep 0.5" },
      };
      yield { type: "done", stopReason: "toolUse", usage };
      return;
    }
    const queued = request.messages.some(
      (message) => message.role === "user" && message.content.includes("queue me"),
    );
    if (this.calls === 2) this.sawQueueEarly = queued;
    else if (queued) this.sawQueueLater = true;
    yield { type: "text", text: `answer ${this.calls}` };
    yield { type: "done", stopReason: "stop", usage };
  }
}

test("a queued message waits for the next run", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-queue-"));
  const api = await createApiRuntime(configFor(dir));
  const provider = new QueueProvider();
  const worker = await startWorker(configFor(dir), { provider });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "first",
      requestId: "queue-1",
      whenBusy: "steer",
    });
    await sleep(150);
    await conversation.submit({
      type: "input",
      content: "queue me",
      requestId: "queue-2",
      whenBusy: "followUp",
    });

    let first = "";
    let second = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      first = (await api.storage.findSubmission(conversation.id, "queue-1"))?.status ?? "";
      second = (await api.storage.findSubmission(conversation.id, "queue-2"))?.status ?? "";
      if (first === "done" && second === "done") break;
      await sleep(50);
    }
    assert.equal(first, "done");
    assert.equal(second, "done");
    assert.equal(provider.sawQueueEarly, false, "queued input stayed out of the first run");
    assert.equal(provider.sawQueueLater, true, "the next run picked it up");
    assert.equal(
      (await api.storage.entries(conversation.id)).entries.filter(
        (entry) => entry.kind === "pi.assistant",
      ).length,
      3,
    );
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
