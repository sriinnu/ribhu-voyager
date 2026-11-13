import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  approvalArgsKey,
  type JsonObject,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
  type Storage,
  type Usage,
} from "@ribhu-voyager/engine";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { startWorker } from "../src/worker.js";

const ZERO: Usage = { input: 0, output: 0, totalTokens: 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type PlannedCall = { id: string; name: string; arguments: JsonObject };

/**
 * Scripted provider: one planned tool call per user message, then a text
 * answer once the tool result is in the transcript.
 */
class ScriptedProvider implements Provider {
  readonly id = "scripted-approvals";
  readonly model = "scripted-approvals";

  constructor(
    private readonly plan: (userText: string) => PlannedCall | undefined,
  ) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const last = request.messages[request.messages.length - 1];
    if (last && last.role === "toolResult") {
      yield { type: "text", text: "Tool finished." };
      yield { type: "done", stopReason: "stop", usage: ZERO };
      return;
    }
    let user = "";
    for (const message of request.messages) {
      if (message.role === "user") user = message.content;
    }
    const planned = this.plan(user.trim());
    if (!planned) {
      yield { type: "text", text: "No tool for this message." };
      yield { type: "done", stopReason: "stop", usage: ZERO };
      return;
    }
    yield {
      type: "toolCall",
      id: planned.id,
      name: planned.name,
      arguments: planned.arguments,
    };
    yield { type: "done", stopReason: "toolUse", usage: ZERO };
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
    approvals: "ask",
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

async function entriesOfKind(
  storage: Storage,
  conversationId: number,
  kind: string,
): Promise<Array<{ id: number; data: Record<string, unknown> }>> {
  const { entries } = await storage.entries(conversationId, 500);
  return entries
    .filter((entry) => entry.kind === kind)
    .map((entry) => ({
      id: entry.id,
      data: (entry.data ?? {}) as Record<string, unknown>,
    }));
}

async function approvalData(
  storage: Storage,
  conversationId: number,
): Promise<Array<Record<string, unknown>>> {
  return (await entriesOfKind(storage, conversationId, "pi.approval")).map(
    (entry) => entry.data,
  );
}

async function ruleData(
  storage: Storage,
  conversationId: number,
): Promise<Array<Record<string, unknown>>> {
  return (await entriesOfKind(storage, conversationId, "pi.approval-rule")).map(
    (entry) => entry.data,
  );
}

async function pendingApproval(
  storage: Storage,
  conversationId: number,
  callId?: string,
): Promise<Record<string, unknown>> {
  return waitFor(async () => {
    const pending = (
      await approvalData(storage, conversationId)
    ).find(
      (data) =>
        data.status === "pending" &&
        (callId === undefined || data.callId === callId),
    );
    return pending;
  });
}

async function toolResultsFor(
  storage: Storage,
  conversationId: number,
  callId: string,
): Promise<Array<{ content: string; isError: boolean }>> {
  const { entries } = await storage.entries(conversationId, 500);
  const results: Array<{ content: string; isError: boolean }> = [];
  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result") continue;
    const message = entry.model?.[0];
    if (!message || message.role !== "toolResult") continue;
    if (message.toolCallId !== callId) continue;
    results.push({ content: message.content, isError: message.isError });
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

test("approvalArgsKey is deterministic sorted JSON at every depth", () => {
  assert.equal(approvalArgsKey({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(
    approvalArgsKey({ command: "npm test", cwd: "/tmp" }),
    '{"command":"npm test","cwd":"/tmp"}',
  );
  assert.equal(
    approvalArgsKey({ a: [{ z: 1, y: 2 }], b: null }),
    '{"a":[{"y":2,"z":1}],"b":null}',
  );
  assert.notEqual(
    approvalArgsKey({ command: "echo a" }),
    approvalArgsKey({ command: "echo b" }),
  );
});

test("always allows the exact call, then auto-approves it with audit entries", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-approval-memory-"));
  const config = configFor(dir);
  const args: JsonObject = { command: "echo memory > memory.txt" };
  const provider = new ScriptedProvider((user) => {
    if (user.includes("first run")) {
      return { id: "call_mem_1", name: "bash", arguments: { ...args } };
    }
    if (user.includes("second run")) {
      return { id: "call_mem_2", name: "bash", arguments: { ...args } };
    }
    return undefined;
  });
  const api = await createApiRuntime(config);
  const worker = await startWorker(config, { provider });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);

    await conversation.submit({
      type: "input",
      content: "first run",
      requestId: "memory-1",
      whenBusy: "steer",
    });
    const pending = await pendingApproval(api.storage, conversation.id);
    assert.equal(pending.callId, "call_mem_1");
    assert.equal(pending.name, "bash");
    assert.deepEqual(pending.args, args);
    assert.equal(typeof pending.requestedAt, "number");

    assert.equal(
      await worker.engine.decideApproval(conversation.id, "call_mem_1", "always"),
      true,
    );
    await waitFor(async () => {
      const row = await api.storage.findSubmission(conversation.id, "memory-1");
      return row?.status === "done" ? row : undefined;
    });
    assert.equal(
      (await fileText(join(config.workspaceDir, "memory.txt")))?.trim(),
      "memory",
    );

    // Audit trail: the pending request stays, followed by the always decision.
    const decisions = await approvalData(api.storage, conversation.id);
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0]!.status, "pending");
    assert.equal(decisions[0]!.callId, "call_mem_1");
    assert.deepEqual(decisions[1], {
      callId: "call_mem_1",
      status: "approved",
      decidedAt: decisions[1]!.decidedAt,
      always: true,
    });
    assert.equal(typeof decisions[1]!.decidedAt, "number");
    assert.equal((decisions[1] as Record<string, unknown>).auto, undefined);

    // The durable rule records name + canonical args key + the exact args.
    const rules = await ruleData(api.storage, conversation.id);
    assert.equal(rules.length, 1);
    assert.deepEqual(Object.keys(rules[0]!).sort(), [
      "args",
      "argsKey",
      "createdAt",
      "name",
    ]);
    assert.equal(rules[0]!.name, "bash");
    assert.equal(rules[0]!.argsKey, approvalArgsKey(args));
    assert.deepEqual(rules[0]!.args, args);
    assert.equal(typeof rules[0]!.createdAt, "number");

    // The same exact call runs again with no prompt: only an auto decision.
    await conversation.submit({
      type: "input",
      content: "second run",
      requestId: "memory-2",
      whenBusy: "steer",
    });
    await waitFor(async () => {
      const row = await api.storage.findSubmission(conversation.id, "memory-2");
      return row?.status === "done" ? row : undefined;
    });
    await sleep(200);

    const after = await approvalData(api.storage, conversation.id);
    const secondCall = after.filter((data) => data.callId === "call_mem_2");
    assert.equal(secondCall.length, 1, "no pending request is created for a rule match");
    assert.deepEqual(secondCall[0], {
      callId: "call_mem_2",
      status: "approved",
      decidedAt: secondCall[0]!.decidedAt,
      auto: true,
    });
    assert.equal((secondCall[0] as Record<string, unknown>).always, undefined);
    assert.equal((await ruleData(api.storage, conversation.id)).length, 1);
    assert.equal(
      (await worker.storage.findToolTask(conversation.id, "call_mem_2"))?.status,
      "done",
    );
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("different arguments still prompt instead of reusing an always rule", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-approval-diff-"));
  const config = configFor(dir);
  const provider = new ScriptedProvider((user) => {
    if (user.includes("safe run")) {
      return {
        id: "call_diff_1",
        name: "bash",
        arguments: { command: "echo one > one.txt" },
      };
    }
    if (user.includes("other run")) {
      return {
        id: "call_diff_2",
        name: "bash",
        arguments: { command: "echo two > two.txt" },
      };
    }
    return undefined;
  });
  const api = await createApiRuntime(config);
  const worker = await startWorker(config, { provider });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);

    await conversation.submit({
      type: "input",
      content: "safe run",
      requestId: "diff-1",
      whenBusy: "steer",
    });
    await pendingApproval(api.storage, conversation.id, "call_diff_1");
    assert.equal(
      await worker.engine.decideApproval(conversation.id, "call_diff_1", "always"),
      true,
    );
    await waitFor(async () => {
      const row = await api.storage.findSubmission(conversation.id, "diff-1");
      return row?.status === "done" ? row : undefined;
    });

    // Different args: a fresh pending request, and nothing ran yet.
    await conversation.submit({
      type: "input",
      content: "other run",
      requestId: "diff-2",
      whenBusy: "steer",
    });
    const pending = await pendingApproval(api.storage, conversation.id, "call_diff_2");
    assert.equal(pending.status, "pending");
    await sleep(300);
    assert.equal(await fileText(join(config.workspaceDir, "two.txt")), undefined);
    assert.equal(
      (await toolResultsFor(api.storage, conversation.id, "call_diff_2")).length,
      0,
    );

    assert.equal(
      await worker.engine.decideApproval(conversation.id, "call_diff_2", "deny"),
      true,
    );
    await waitFor(async () => {
      const row = await api.storage.findSubmission(conversation.id, "diff-2");
      return row?.status === "done" ? row : undefined;
    });
    assert.equal(await fileText(join(config.workspaceDir, "two.txt")), undefined);

    const results = await toolResultsFor(api.storage, conversation.id, "call_diff_2");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, true);
    assert.match(results[0]!.content, /Approval denied for tool "bash"/);

    const decisions = (await approvalData(api.storage, conversation.id)).filter(
      (data) => data.callId === "call_diff_2",
    );
    assert.deepEqual(decisions, [
      {
        callId: "call_diff_2",
        name: "bash",
        args: { command: "echo two > two.txt" },
        status: "pending",
        requestedAt: decisions[0]!.requestedAt,
      },
      {
        callId: "call_diff_2",
        status: "denied",
        decidedAt: decisions[1]!.decidedAt,
      },
    ]);
    assert.equal((decisions[1] as Record<string, unknown>).always, undefined);
    assert.equal((decisions[1] as Record<string, unknown>).auto, undefined);
    assert.equal((await ruleData(api.storage, conversation.id)).length, 1);
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the rule key ignores argument key order", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-approval-order-"));
  const config = configFor(dir);
  const provider = new ScriptedProvider((user) => {
    if (user.includes("order one")) {
      return {
        id: "call_order_1",
        name: "write",
        arguments: { path: "order.txt", content: "ok" },
      };
    }
    if (user.includes("order two")) {
      return {
        id: "call_order_2",
        name: "write",
        arguments: { content: "ok", path: "order.txt" },
      };
    }
    return undefined;
  });
  const api = await createApiRuntime(config);
  const worker = await startWorker(config, { provider });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);

    await conversation.submit({
      type: "input",
      content: "order one",
      requestId: "order-1",
      whenBusy: "steer",
    });
    await pendingApproval(api.storage, conversation.id, "call_order_1");
    assert.equal(
      await worker.engine.decideApproval(conversation.id, "call_order_1", "always"),
      true,
    );
    await waitFor(async () => {
      const row = await api.storage.findSubmission(conversation.id, "order-1");
      return row?.status === "done" ? row : undefined;
    });

    const rules = await ruleData(api.storage, conversation.id);
    assert.equal(rules.length, 1);
    assert.equal(
      rules[0]!.argsKey,
      approvalArgsKey({ content: "ok", path: "order.txt" }),
    );

    // Same arguments in a different key order: auto-approved by the same rule.
    await conversation.submit({
      type: "input",
      content: "order two",
      requestId: "order-2",
      whenBusy: "steer",
    });
    await waitFor(async () => {
      const row = await api.storage.findSubmission(conversation.id, "order-2");
      return row?.status === "done" ? row : undefined;
    });
    await sleep(200);

    const second = (await approvalData(api.storage, conversation.id)).filter(
      (data) => data.callId === "call_order_2",
    );
    assert.equal(second.length, 1);
    assert.equal(second[0]!.status, "approved");
    assert.equal(second[0]!.auto, true);
    assert.equal((await ruleData(api.storage, conversation.id)).length, 1);
    assert.equal(
      (await fileText(join(config.workspaceDir, "order.txt"))),
      "ok",
    );
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});
