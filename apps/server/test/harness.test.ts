import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { Config } from "../src/config.js";
import { createRuntime } from "../src/harness.js";

const here = fileURLToPath(new URL(".", import.meta.url));

function configFor(dataDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    workspaceDir: join(dataDir, "workspace"),
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

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ribhu-engine-test-"));
}

test("answers an input and dedupes by requestId", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  const runtime = await createRuntime(configFor(dir));
  try {
    const first = await runtime.root.submit({
      type: "input",
      content: "What is durable?",
      requestId: "req-1",
      whenBusy: "steer",
    });
    await runtime.root.waitForIdle();

    const view = await runtime.root.view();
    const users = view.entries.filter((entry) => entry.kind === "pi.user");
    const assistants = view.entries.filter(
      (entry) => entry.kind === "pi.assistant",
    );
    assert.equal(users.length, 1);
    assert.ok(assistants.length >= 1);
    assert.ok(
      JSON.stringify(assistants.at(-1)?.model).includes("Durable by construction"),
      "the scripted answer is in the journal",
    );

    const again = await runtime.root.submit({
      type: "input",
      content: "What is durable?",
      requestId: "req-1",
      whenBusy: "steer",
    });
    assert.equal(again.id, first.id);
    await runtime.root.waitForIdle();

    const after = await runtime.root.view();
    assert.equal(
      after.entries.filter((entry) => entry.kind === "pi.user").length,
      1,
      "the retry did not append a second user entry",
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runs a real tool and journals both calls", { timeout: 60_000 }, async () => {
  const dir = await tempDir();
  const runtime = await createRuntime(configFor(dir));
  try {
    await runtime.root.submit({
      type: "input",
      content: "run: echo durable-tool-output",
      requestId: "tool-1",
      whenBusy: "steer",
    });
    await runtime.root.waitForIdle();

    const view = await runtime.root.view();
    const tools = view.entries.filter(
      (entry) => entry.kind === "pi.tool-result",
    );
    assert.equal(tools.length, 1);
    assert.ok(
      JSON.stringify(tools[0]?.model).includes("durable-tool-output"),
      "bash output is in the tool result",
    );
    assert.ok(
      JSON.stringify(view.entries.at(-1)?.model).includes("Done."),
      "the model saw the tool output and answered",
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resumes an interrupted run after a hard process exit", { timeout: 90_000 }, async () => {
  const dir = await tempDir();
  const child = join(here, "fixtures", "crash-child.ts");
  assert.throws(
    () =>
      execFileSync(process.execPath, ["--import", "tsx", child], {
        env: { ...process.env, RIBBHU_TEST_DATA: dir },
        stdio: "pipe",
        timeout: 60_000,
      }),
    "the child exits mid-answer",
  );

  const runtime = await createRuntime(configFor(dir));
  try {
    await runtime.root.waitForIdle(60_000);
    const view = await runtime.root.view();
    const users = view.entries.filter((entry) => entry.kind === "pi.user");
    const assistants = view.entries.filter(
      (entry) => entry.kind === "pi.assistant",
    );
    assert.equal(users.length, 1, "the admission survived the crash");
    assert.ok(assistants.length >= 1, "the resumed run committed an answer");
    assert.ok(
      JSON.stringify(assistants.at(-1)?.model).includes("Durable by construction"),
      "the resumed answer is complete",
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
