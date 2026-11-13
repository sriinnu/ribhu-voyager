import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Storage } from "@ribhu-voyager/engine";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { createToolRunner } from "../src/tools-runtime.js";
import { startWorker } from "../src/worker.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ApprovalData = {
  callId?: string;
  name?: string;
  args?: unknown;
  status?: string;
  requestedAt?: number;
  decidedAt?: number;
};

function configFor(dir: string, approvals: Config["approvals"]): Config {
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
    approvals,
  };
}

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

async function approvalEntries(
  storage: Storage,
  conversationId: number,
): Promise<ApprovalData[]> {
  const { entries } = await storage.entries(conversationId, 200);
  return entries
    .filter((entry) => entry.kind === "pi.approval")
    .map((entry) => (entry.data ?? {}) as ApprovalData);
}

async function waitForPendingApproval(
  storage: Storage,
  conversationId: number,
): Promise<{ callId: string; name: string }> {
  return waitFor(async () => {
    const pending = (await approvalEntries(storage, conversationId)).find(
      (entry) => entry.status === "pending" && typeof entry.callId === "string",
    );
    return pending?.callId
      ? { callId: pending.callId, name: String(pending.name ?? "") }
      : undefined;
  });
}

async function toolResultEntries(
  storage: Storage,
  conversationId: number,
): Promise<Array<{ content: string; isError: boolean; toolCallId: string }>> {
  const { entries } = await storage.entries(conversationId, 200);
  const results: Array<{ content: string; isError: boolean; toolCallId: string }> = [];
  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result") continue;
    const message = entry.model?.[0];
    if (!message || message.role !== "toolResult") continue;
    results.push({
      content: message.content,
      isError: message.isError,
      toolCallId: message.toolCallId,
    });
  }
  return results;
}

async function fileText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

test("ask mode exposes every tool so the engine can pause instead of hiding it", () => {
  const runner = createToolRunner({ approvals: "ask" });
  assert.deepEqual(
    runner.specs.map((spec) => spec.name).sort(),
    ["bash", "edit", "read", "write"],
  );
});

test("ask mode pauses for approval and executes the tool once approved", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-approve-"));
  const config = configFor(dir, "ask");
  const api = await createApiRuntime(config);
  const worker = await startWorker(config);
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "run: echo approved > approved.txt",
      requestId: "approve-1",
      whenBusy: "steer",
    });

    const pending = await waitForPendingApproval(api.storage, conversation.id);
    assert.equal(pending.name, "bash");

    // Paused: no tool result and no side effect while the decision is pending.
    await sleep(400);
    assert.equal(await fileText(join(config.workspaceDir, "approved.txt")), undefined);
    assert.equal((await toolResultEntries(api.storage, conversation.id)).length, 0);

    assert.equal(
      await worker.engine.decideApproval(conversation.id, pending.callId, true),
      true,
      "the first decision is accepted",
    );
    assert.equal(
      await worker.engine.decideApproval(conversation.id, pending.callId, true),
      false,
      "a decided call cannot be decided twice",
    );

    const submission = await waitFor(async () => {
      const row = await api.storage.findSubmission(conversation.id, "approve-1");
      return row?.status === "done" ? row : undefined;
    });
    assert.equal(submission.status, "done");
    assert.equal(
      (await fileText(join(config.workspaceDir, "approved.txt")))?.trim(),
      "approved",
    );

    const results = await toolResultEntries(api.storage, conversation.id);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, false);

    const task = await worker.storage.findToolTask(conversation.id, pending.callId);
    assert.equal(task?.status, "done");

    const approvals = await approvalEntries(api.storage, conversation.id);
    assert.deepEqual(
      approvals.map((entry) => entry.status),
      ["pending", "approved"],
    );
    assert.equal(typeof approvals[0]?.requestedAt, "number");
    assert.equal(typeof approvals[1]?.decidedAt, "number");
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ask mode journals a normal tool error when the call is denied", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-deny-"));
  const config = configFor(dir, "ask");
  const api = await createApiRuntime(config);
  const worker = await startWorker(config);
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "run: echo denied > denied.txt",
      requestId: "deny-1",
      whenBusy: "steer",
    });

    const pending = await waitForPendingApproval(api.storage, conversation.id);
    // Deny through the API-side wrapper, exactly like the API process does in
    // production: it appends the same journal entry via its own storage handle
    // and the worker picks it up on its next poll.
    assert.equal(
      await conversation.decideApproval(pending.callId, false),
      true,
      "the API wrapper appends a durable decision the worker can observe",
    );

    const submission = await waitFor(async () => {
      const row = await api.storage.findSubmission(conversation.id, "deny-1");
      return row?.status === "done" ? row : undefined;
    });
    assert.equal(submission.status, "done", "the model continues after a denial");
    assert.equal(await fileText(join(config.workspaceDir, "denied.txt")), undefined);

    const results = await toolResultEntries(api.storage, conversation.id);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, true);
    assert.match(results[0]!.content, /Approval denied for tool "bash"/);
    assert.match(results[0]!.content, /not executed/);

    const task = await worker.storage.findToolTask(conversation.id, pending.callId);
    assert.equal(task?.status, "failed");

    const approvals = await approvalEntries(api.storage, conversation.id);
    assert.deepEqual(
      approvals.map((entry) => entry.status),
      ["pending", "denied"],
    );

    assert.equal(
      await worker.engine.decideApproval(conversation.id, pending.callId, true),
      false,
      "a denied call is not reopened",
    );
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("aborting a turn while approval is pending never executes the tool", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-approval-abort-"));
  const config = configFor(dir, "ask");
  const api = await createApiRuntime(config);
  const worker = await startWorker(config);
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "run: echo aborted > aborted.txt",
      requestId: "abort-pending-1",
      whenBusy: "steer",
    });

    const pending = await waitForPendingApproval(api.storage, conversation.id);
    await conversation.abort();

    const submission = await waitFor(async () => {
      const row = await api.storage.findSubmission(conversation.id, "abort-pending-1");
      return row?.status === "aborted" ? row : undefined;
    });
    assert.equal(submission.status, "aborted");

    await sleep(400);
    assert.equal(await fileText(join(config.workspaceDir, "aborted.txt")), undefined);
    assert.equal(
      (await toolResultEntries(api.storage, conversation.id)).length,
      0,
      "no tool result is journaled for a call that never ran",
    );
    const task = await worker.storage.findToolTask(conversation.id, pending.callId);
    assert.equal(task?.status, "aborted");
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// A hard crash leaves the approval request and the running tool task in the
// journal. The inline child is killed with process.exit so nothing is closed.
const CRASH_CHILD = `
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Engine } from "@ribhu-voyager/engine";
import { Db } from "@ribhu-voyager/storage-sqlite";

const dataDir = process.env.RIBBHU_TEST_DATA;
if (!dataDir) throw new Error("RIBBHU_TEST_DATA is required");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ToolCallProvider {
  id = "approval-child";
  model = "approval-child";
  async *stream(request) {
    const last = request.messages[request.messages.length - 1];
    if (last && last.role === "toolResult") {
      yield {
        type: "done",
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
      };
      return;
    }
    yield {
      type: "toolCall",
      id: "call_restart_1",
      name: "write",
      arguments: { path: "restart-approved.txt", content: "approved after restart" },
    };
    yield {
      type: "done",
      stopReason: "toolUse",
      usage: { input: 0, output: 0, totalTokens: 0 },
    };
  }
}

const workspace = join(dataDir, "workspace");
await mkdir(workspace, { recursive: true });
const storage = new Db(join(dataDir, "ribhu.sqlite"));
const engine = await Engine.open({
  storage,
  provider: new ToolCallProvider(),
  runner: {
    specs: [
      {
        name: "write",
        description: "write a file",
        parameters: { type: "object" },
        replaySafe: false,
      },
    ],
    async execute(name, args) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(workspace, String(args.path)), String(args.content), "utf8");
      return { content: "wrote " + String(args.path) };
    },
  },
  cwd: workspace,
  model: { provider: "approval-child", modelId: "approval-child" },
  instructions: "test agent",
  approvals: "ask",
});

const root = await engine.root();
await root.submit({
  type: "input",
  content: "write restart-approved.txt",
  requestId: "restart-1",
  whenBusy: "steer",
});

for (let attempt = 0; attempt < 200; attempt += 1) {
  const { entries } = await storage.entries(root.id, 50);
  if (entries.some((entry) => entry.kind === "pi.approval")) process.exit(9);
  await sleep(25);
}
process.exit(8);
`;

test("a pending approval survives a worker crash and re-enters the wait", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-approval-restart-"));
  const config = configFor(dir, "ask");
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", CRASH_CHILD],
      {
        cwd: process.cwd(),
        env: { ...process.env, RIBBHU_TEST_DATA: dir },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let childError = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      childError += chunk;
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    assert.equal(code, 9, `the child crashed while the approval was pending: ${childError}`);

    // Recovery must re-enter the wait, not execute the write and not report an
    // interruption for the running task.
    worker = await startWorker(config);
    const conversationId = worker.root.id;
    await waitFor(async () => {
      const job = await worker!.storage.getSetting("worker_job");
      return job ? job : undefined;
    });
    await sleep(500);
    assert.equal(
      await fileText(join(config.workspaceDir, "restart-approved.txt")),
      undefined,
      "the tool did not execute while the approval was pending",
    );
    assert.equal((await toolResultEntries(worker.storage, conversationId)).length, 0);

    const pending = await waitForPendingApproval(worker.storage, conversationId);
    assert.equal(pending.callId, "call_restart_1");
    const task = await worker.storage.findToolTask(conversationId, pending.callId);
    assert.equal(task?.status, "running", "the durable task is still running, not aborted");

    assert.equal(
      await worker.engine.decideApproval(conversationId, pending.callId, true),
      true,
    );

    const text = await waitFor(async () =>
      fileText(join(config.workspaceDir, "restart-approved.txt")),
    );
    assert.equal(text.trim(), "approved after restart");

    const submission = await waitFor(async () => {
      const row = await worker!.storage.findSubmission(conversationId, "restart-1");
      return row?.status === "done" ? row : undefined;
    });
    assert.equal(submission.status, "done");

    const results = await toolResultEntries(worker.storage, conversationId);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, false);
    assert.match(results[0]!.content, /restart-approved\.txt/);

    const approvals = await approvalEntries(worker.storage, conversationId);
    assert.deepEqual(
      approvals.map((entry) => entry.status),
      ["pending", "approved"],
    );
  } finally {
    if (worker) await worker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
