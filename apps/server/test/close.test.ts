import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Engine,
  type Provider,
  type ProviderRequest,
  type Usage,
} from "@ribhu-voyager/engine";
import { Db } from "@ribhu-voyager/storage-sqlite";

import { createToolRunner } from "../src/tools-runtime.js";

const usage: Usage = { input: 0, output: 0, totalTokens: 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class SlowProvider implements Provider {
  readonly id = "slow";
  readonly model = "slow";
  async *stream(request: ProviderRequest) {
    yield { type: "text" as const, text: "partial " };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000);
      request.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
    yield { type: "done" as const, stopReason: "stop" as const, usage };
  }
}

test("closing the engine during a stream drains without a closed-DB crash", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-close-"));
  const path = join(dir, "test.sqlite");
  const db = new Db(path);
  const engine = await Engine.open({
    storage: db,
    provider: new SlowProvider(),
    runner: createToolRunner(),
    cwd: join(dir, "workspace"),
    model: { provider: "slow", modelId: "slow" },
    instructions: "test",
    autoRun: false,
  });
  try {
    const root = await engine.root();
    await engine.submit(root.id, {
      type: "input",
      content: "stream",
      requestId: "close-1",
      whenBusy: "steer",
    });
    await sleep(300);
    await engine.close();

    const check = new Db(path);
    try {
      assert.equal(check.findSubmission(root.id, "close-1")?.status, "aborted");
    } finally {
      check.close();
    }
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
