import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = 15_000,
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

class SlowProvider implements Provider {
  readonly id = "slow";
  readonly model = "slow";

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    for (let index = 0; index < 100; index += 1) {
      if (request.signal.aborted) throw new Error("aborted");
      yield { type: "text", text: "partial " };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (request.signal.aborted) {
          onAbort();
          return;
        }
        request.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
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

test("aborts a running turn through the API control path", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-abort-"));
  const api = await createApiRuntime(configFor(dir));
  const worker = await startWorker(configFor(dir), {
    provider: new SlowProvider(),
  });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "keep going",
      requestId: "abort-1",
      whenBusy: "steer",
    });
    await sleep(300);
    await conversation.abort();

    let status = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const submission = await api.storage.findSubmission(conversation.id, "abort-1");
      status = submission?.status ?? "";
      if (status === "aborted" && !(await api.storage.busy(conversation.id))) break;
      await sleep(50);
    }
    assert.equal(status, "aborted");
    assert.equal(
      (await api.storage.entries(conversation.id)).entries.filter(
        (entry) => entry.kind === "pi.assistant",
      ).length,
      0,
      "an aborted turn does not commit an assistant entry",
    );
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker shutdown aborts an active turn instead of hanging", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-drain-"));
  const api = await createApiRuntime(configFor(dir));
  const worker = await startWorker(configFor(dir), {
    provider: new SlowProvider(),
  });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "slow turn",
      requestId: "drain-1",
      whenBusy: "steer",
    });
    await sleep(300);

    const started = Date.now();
    await worker.close();
    assert.ok(Date.now() - started < 5_000, "close should not wait for the stream");

    let status = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      status = (await api.storage.findSubmission(conversation.id, "drain-1"))?.status ?? "";
      if (status === "aborted") break;
      await sleep(50);
    }
    assert.equal(status, "aborted");
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort while idle does not cancel the next message", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-idle-abort-"));
  const api = await createApiRuntime(configFor(dir));
  const worker = await startWorker(configFor(dir));
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.abort();
    await conversation.submit({
      type: "input",
      content: "What is durable?",
      requestId: "idle-abort-1",
      whenBusy: "steer",
    });

    let status = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = (await api.storage.findSubmission(conversation.id, "idle-abort-1"))?.status ?? "";
      if (status === "done") break;
      await sleep(50);
    }
    assert.equal(status, "done");
    assert.ok(
      (await api.storage.entries(conversation.id)).entries.some(
        (entry) => entry.kind === "pi.assistant",
      ),
    );
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stop sent while the worker is down aborts open work on restart", { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-stop-down-"));
  const config = configFor(dir);
  const api = await createApiRuntime(config);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);

    // A real worker process picks up a long-running bash tool, then dies hard.
    child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/server/src/worker-main.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RIBBHU_DATA_DIR: dir,
          RIBBHU_WORKSPACE: join(dir, "workspace"),
          RIBBHU_PROVIDER: "demo",
        },
        stdio: "ignore",
      },
    );
    await conversation.submit({
      type: "input",
      content: "run: sleep 5",
      requestId: "down-stop-1",
      whenBusy: "steer",
    });
    await waitFor(async () => {
      const tasks = await api.storage.runningToolTasks(conversation.id);
      return tasks.length > 0 ? true : undefined;
    }, 20_000);
    child.kill("SIGKILL");
    await new Promise((resolve) => child!.once("exit", resolve));
    assert.equal(
      (await api.storage.findSubmission(conversation.id, "down-stop-1"))?.status,
      "running",
      "the submission is still open while the worker is down",
    );

    // Stop while the worker is down.
    await conversation.abort();
    assert.equal(await api.storage.isCancelRequested(conversation.id), true);

    // Restarting consumes the cancel instead of resuming the open work.
    const worker = await startWorker(config);
    try {
      await waitFor(async () => {
        const row = await api.storage.findSubmission(conversation.id, "down-stop-1");
        return row?.status === "aborted" ? true : undefined;
      });
      assert.equal(await api.storage.isCancelRequested(conversation.id), false);
      assert.equal(
        (await api.storage.runningToolTasks(conversation.id)).length,
        0,
        "the interrupted tool task is aborted, not re-run",
      );
      assert.equal(
        (await api.storage.entries(conversation.id)).entries.filter(
          (entry) => entry.kind === "pi.tool-result",
        ).length,
        0,
        "no tool result is journaled for the stopped turn",
      );
    } finally {
      await worker.close();
    }
  } finally {
    child?.kill("SIGKILL");
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
