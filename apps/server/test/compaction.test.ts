import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Engine,
  LeaseLost,
  admitSubmission,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "@ribhu-voyager/engine";
import { Db } from "@ribhu-voyager/storage-sqlite";

import { createToolRunner } from "../src/tools-runtime.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start >= timeoutMs) {
      throw new Error("timed out waiting for the expected state");
    }
    await sleep(20);
  }
}

const usage = { input: 0, output: 0, totalTokens: 0 };

class SummaryProvider implements Provider {
  readonly id = "summary";
  readonly model = "summary";
  summaries = 0;
  lastSystem = "";
  lastMessages: ProviderRequest["messages"] = [];

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.lastSystem = request.system;
    this.lastMessages = request.messages;
    if (request.system.includes("Summarize this coding-agent")) {
      this.summaries += 1;
      yield { type: "text", text: "SUMMARY: files changed, tests passed." };
      yield { type: "done", stopReason: "stop", usage };
      return;
    }
    yield { type: "text", text: "answer" };
    yield { type: "done", stopReason: "stop", usage };
  }
}

/** Summarization blocks until the request is aborted, then throws AbortError. */
class BlockingSummaryProvider implements Provider {
  readonly id = "blocking-summary";
  readonly model = "blocking-summary";
  started = false;
  aborted = false;

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    if (!request.system.includes("Summarize this coding-agent")) {
      yield { type: "text", text: "answer" };
      yield { type: "done", stopReason: "stop", usage };
      return;
    }
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, 15_000);
      const onAbort = () => {
        cleanup();
        this.aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
      };
      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener("abort", onAbort, { once: true });
    });
    yield { type: "text", text: "LATE SUMMARY" };
    yield { type: "done", stopReason: "stop", usage };
  }
}

async function blockingSetup() {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-compact-abort-"));
  const db = new Db(join(dir, "test.sqlite"));
  const root = db.ensureRoot();
  const provider = new BlockingSummaryProvider();
  const engine = await Engine.open({
    storage: db,
    provider,
    runner: createToolRunner(),
    cwd: join(dir, "workspace"),
    model: { provider: "blocking-summary", modelId: "blocking-summary" },
    instructions: "test",
    autoRun: false,
    compactionThresholdChars: 0,
    compactionKeepEntries: 2,
  });
  for (let index = 0; index < 6; index += 1) {
    db.appendEntry({
      conversationId: root,
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: `abort message ${index} ${"z".repeat(80)}`,
          timestamp: index,
        },
      ],
    });
  }
  return { dir, db, root, provider, engine };
}

async function setup(threshold = 0) {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-compact-"));
  const db = new Db(join(dir, "test.sqlite"));
  const root = db.ensureRoot();
  const provider = new SummaryProvider();
  const engine = await Engine.open({
    storage: db,
    provider,
    runner: createToolRunner(),
    cwd: join(dir, "workspace"),
    model: { provider: "summary", modelId: "summary" },
    instructions: "test",
    autoRun: false,
    compactionThresholdChars: threshold,
    compactionKeepEntries: 2,
  });
  return { dir, db, root, provider, engine };
}

test("manual compaction writes a summary boundary and rebuilds context", { timeout: 20_000 }, async () => {
  const { dir, db, root, provider, engine } = await setup();
  try {
    for (let index = 0; index < 6; index += 1) {
      db.appendEntry({
        conversationId: root,
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: `old message ${index} ${"x".repeat(80)}`,
            timestamp: index,
          },
        ],
      });
    }
    const entryId = await engine.compact(root);
    assert.ok(entryId);
    const compaction = db.lastEntryOfKind(root, "pi.compaction");
    const data = compaction?.data as { summary?: string; coversUpTo?: number };
    assert.match(data?.summary ?? "", /SUMMARY/);
    assert.equal(typeof data?.coversUpTo, "number");

    await admitSubmission(db, root, {
      type: "input",
      content: "new message",
      requestId: "after-compact",
    });
    await engine.run(root);
    assert.match(provider.lastSystem, /Summary of earlier context/);
    assert.match(provider.lastSystem, /SUMMARY/);
    assert.ok(
      provider.lastMessages.some(
        (message) => message.role === "user" && message.content === "new message",
      ),
    );
    assert.ok(
      !provider.lastMessages.some(
        (message) =>
          message.role === "user" && message.content.startsWith("old message 0"),
      ),
      "summarized entries were removed from the active context",
    );
    assert.ok(
      provider.lastMessages.some(
        (message) =>
          message.role === "user" && message.content.startsWith("old message 4"),
      ),
      "the retained tail is still in context",
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("automatic compaction triggers above the threshold", { timeout: 20_000 }, async () => {
  const { dir, db, root, provider, engine } = await setup(200);
  try {
    for (let index = 0; index < 8; index += 1) {
      db.appendEntry({
        conversationId: root,
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: `long ${index} ${"y".repeat(120)}`,
            timestamp: index,
          },
        ],
      });
    }
    await admitSubmission(db, root, {
      type: "input",
      content: "please continue",
      requestId: "auto-compact",
    });
    await engine.run(root);
    assert.equal(provider.summaries, 1);
    assert.ok(db.lastEntryOfKind(root, "pi.compaction"));
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("manual compaction travels through the worker queue", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-compact-queue-"));
  const api = await createApiRuntime(configFor(dir));
  const worker = await startWorker(configFor(dir));
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    for (let index = 0; index < 14; index += 1) {
      api.storage.appendEntry({
        conversationId: conversation.id,
        kind: "pi.user",
        model: [{ role: "user", content: `turn ${index}`, timestamp: index }],
      });
    }
    await conversation.compact();

    let compaction = await api.storage.lastEntryOfKind(
      conversation.id,
      "pi.compaction",
    );
    for (let attempt = 0; attempt < 100 && !compaction; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      compaction = await api.storage.lastEntryOfKind(
        conversation.id,
        "pi.compaction",
      );
    }
    assert.ok(compaction, "the worker wrote a compaction entry");
    assert.equal(typeof (compaction?.data as { coversUpTo?: unknown })?.coversUpTo, "number");
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction aborts on abortAll and journals no boundary", { timeout: 20_000 }, async () => {
  const { dir, db, root, provider, engine } = await blockingSetup();
  try {
    const pending = engine.compact(root);
    await waitFor(() => (provider.started ? true : undefined));
    engine.abortAll();
    await assert.rejects(pending, (error: unknown) => {
      return error instanceof Error && error.name === "AbortError";
    });
    assert.equal(provider.aborted, true, "the provider stream was aborted");
    assert.equal(
      db.lastEntryOfKind(root, "pi.compaction"),
      undefined,
      "an aborted compaction writes no summary",
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("compaction aborts when the worker loses its lease", { timeout: 20_000 }, async () => {
  const { dir, db, root, provider, engine } = await blockingSetup();
  try {
    await assert.rejects(
      engine.compact(root, undefined, () => false),
      (error: unknown) => error instanceof LeaseLost,
      "the lease guard runs before the provider stream",
    );
    assert.equal(provider.started, false);

    const pending = engine.compact(root, undefined, async () => true);
    await waitFor(() => (provider.started ? true : undefined));
    engine.loseLease(root);
    await assert.rejects(pending, (error: unknown) => {
      return error instanceof Error && error.name === "AbortError";
    });
    assert.equal(provider.aborted, true);
    assert.equal(db.lastEntryOfKind(root, "pi.compaction"), undefined);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker shutdown aborts a running compaction", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-compact-shutdown-"));
  const config = configFor(dir);
  const provider = new BlockingSummaryProvider();
  const api = await createApiRuntime(config);
  const worker = await startWorker(config, { provider });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    for (let index = 0; index < 20; index += 1) {
      await api.storage.appendEntry({
        conversationId: conversation.id,
        kind: "pi.user",
        model: [{ role: "user", content: `turn ${index}`, timestamp: index }],
      });
    }
    await conversation.compact();
    await waitFor(() => (provider.started ? true : undefined));

    const startedAt = Date.now();
    await worker.close();
    assert.ok(
      Date.now() - startedAt < 10_000,
      "shutdown aborts the stream instead of waiting for it",
    );
    assert.equal(provider.aborted, true, "shutdown aborted the provider stream");
    assert.equal(
      await api.storage.lastEntryOfKind(conversation.id, "pi.compaction"),
      undefined,
      "an aborted compaction writes no summary",
    );
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
