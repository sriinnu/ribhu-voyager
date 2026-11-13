import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Engine,
  type Provider,
  type ProviderRequest,
  type ToolRunner,
} from "@ribhu-voyager/engine";
import { Db } from "@ribhu-voyager/storage-sqlite";

import { createToolRunner } from "../src/tools-runtime.js";

const usage = { input: 0, output: 0, totalTokens: 0 };

class StopProvider implements Provider {
  readonly id = "stop";
  readonly model = "stop";
  async *stream(_request: ProviderRequest) {
    yield { type: "done" as const, stopReason: "stop" as const, usage };
  }
}

test("a bare unsafe tool call from a crash is not re-executed", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-replay-"));
  const db = new Db(join(dir, "test.sqlite"));
  try {
    const root = db.ensureRoot();
    await db.tx(async () => {
      db.createSubmission(root, "replay-1", "go");
      db.appendEntry({
        conversationId: root,
        kind: "pi.user",
        model: [{ role: "user", content: "go", timestamp: Date.now() }],
      });
      db.appendEntry({
        conversationId: root,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "write",
                arguments: { path: "canary.txt", content: "x" },
              },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
            usage,
          },
        ],
      });
    });

    let executed = 0;
    const realRunner = createToolRunner();
    const writeSpec = realRunner.specs.find((spec) => spec.name === "write")!;
    const runner: ToolRunner = {
      specs: [writeSpec],
      async execute() {
        executed += 1;
        return { content: "wrote" };
      },
    };
    const engine = await Engine.open({
      storage: db,
      provider: new StopProvider(),
      runner,
      cwd: join(dir, "workspace"),
      model: { provider: "stop", modelId: "stop" },
      instructions: "test",
      autoRun: false,
    });
    await engine.run(root);

    assert.equal(executed, 0, "write must not run without a durable task");
    const result = db
      .entries(root)
      .entries.find((entry) => entry.kind === "pi.tool-result");
    assert.ok(
      JSON.stringify(result?.model).includes("not replayed"),
      "the journal records the interrupted unsafe tool",
    );
    await engine.close();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
