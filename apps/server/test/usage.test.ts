import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  QuotaExceeded,
  type JsonObject,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
  type Usage,
} from "@ribhu-voyager/engine";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { startWorker } from "../src/worker.js";

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

function configFor(dir: string, overrides: Partial<Config> = {}): Config {
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
    ...overrides,
  };
}

/** Fixed usage so quota/cost assertions are exact (15 tokens per turn). */
const FIXED_USAGE: Usage = { input: 10, output: 5, totalTokens: 15 };

class FixedUsageProvider implements Provider {
  readonly id = "fixed-usage";
  readonly model = "fixed-usage";

  constructor(
    private readonly toolCall?: {
      id: string;
      name: string;
      arguments: JsonObject;
    },
  ) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const last = request.messages[request.messages.length - 1];
    if (last && last.role === "toolResult") {
      yield { type: "text", text: "Tool finished." };
      yield { type: "done", stopReason: "stop", usage: FIXED_USAGE };
      return;
    }
    if (this.toolCall) {
      yield {
        type: "toolCall",
        id: this.toolCall.id,
        name: this.toolCall.name,
        arguments: this.toolCall.arguments,
      };
      yield { type: "done", stopReason: "toolUse", usage: FIXED_USAGE };
      return;
    }
    yield { type: "text", text: "answer" };
    yield { type: "done", stopReason: "stop", usage: FIXED_USAGE };
  }
}

async function waitForDone(
  api: Awaited<ReturnType<typeof createApiRuntime>>,
  conversationId: number,
  requestId: string,
): Promise<void> {
  await waitFor(async () => {
    const row = await api.storage.findSubmission(conversationId, requestId);
    return row?.status === "done" ? true : undefined;
  });
}

test("a run records a usage event with provider, model and token counts", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-usage-"));
  const config = configFor(dir);
  const api = await createApiRuntime(config);
  const worker = await startWorker(config, { provider: new FixedUsageProvider() });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "hello",
      requestId: "usage-1",
      whenBusy: "steer",
    });
    await waitForDone(api, conversation.id, "usage-1");

    const day = await api.storage.usageSummary("day");
    assert.equal(day.events, 1);
    assert.equal(day.inputTokens, 10);
    assert.equal(day.outputTokens, 5);
    assert.equal(day.totalTokens, 15);
    assert.equal(day.costMicros, 0, "no pricing configured records zero cost");
    assert.ok(day.since <= Date.now());

    const [event] = await api.storage.listUsage(10);
    assert.ok(event);
    assert.equal(event.provider, "demo");
    assert.equal(event.model, "ribhu-demo");
    assert.equal(event.inputTokens, 10);
    assert.equal(event.outputTokens, 5);
    assert.equal(event.costMicros, 0);
    assert.equal(event.conversationId, conversation.id);
    assert.equal(typeof event.submissionId, "number");
    assert.equal(event.tenantId, "default");

    const month = await api.storage.usageSummary("month");
    assert.equal(month.totalTokens, 15);
    assert.ok(month.since <= day.since);
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("configured pricing is recorded as usage cost", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-usage-cost-"));
  const config = configFor(dir, { costMicrosPer1kTokens: 2000 });
  const api = await createApiRuntime(config);
  const worker = await startWorker(config, { provider: new FixedUsageProvider() });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "hello",
      requestId: "cost-1",
      whenBusy: "steer",
    });
    await waitForDone(api, conversation.id, "cost-1");

    const [event] = await api.storage.listUsage(1);
    // 15 tokens * 2000 micros / 1000 = 30 micros.
    assert.equal(event?.costMicros, 30);
    assert.equal((await api.storage.usageSummary("day")).costMicros, 30);
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("daily token and monthly cost quotas block admission", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-usage-quota-"));
  const config = configFor(dir, { costMicrosPer1kTokens: 2000 });
  const api = await createApiRuntime(config);
  const worker = await startWorker(config, { provider: new FixedUsageProvider() });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "first",
      requestId: "quota-1",
      whenBusy: "steer",
    });
    await waitForDone(api, conversation.id, "quota-1");

    await api.storage.setQuota({ dailyTokens: 0 });
    await assert.rejects(
      conversation.submit({
        type: "input",
        content: "blocked by tokens",
        requestId: "quota-2",
        whenBusy: "steer",
      }),
      (error: unknown) => {
        assert.ok(error instanceof QuotaExceeded);
        assert.match(error.message, /Daily token quota exceeded/);
        assert.equal(error.code, "quota_exceeded");
        return true;
      },
    );
    assert.equal(
      await api.storage.findSubmission(conversation.id, "quota-2"),
      undefined,
      "a denied admission is not stored",
    );

    await api.storage.setQuota({ dailyTokens: null, monthlyCostMicros: 30 });
    await assert.rejects(
      conversation.submit({
        type: "input",
        content: "blocked by cost",
        requestId: "quota-3",
        whenBusy: "steer",
      }),
      (error: unknown) => {
        assert.ok(error instanceof QuotaExceeded);
        assert.match(error.message, /Monthly cost quota exceeded/);
        return true;
      },
    );

    // Lifting the quota admits work again.
    await api.storage.setQuota({ monthlyCostMicros: 1_000 });
    await conversation.submit({
      type: "input",
      content: "after quota",
      requestId: "quota-4",
      whenBusy: "steer",
    });
    await waitForDone(api, conversation.id, "quota-4");
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("approval requests and decisions are audited", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-usage-audit-"));
  const config = configFor(dir, { approvals: "ask" });
  const provider = new FixedUsageProvider({
    id: "call_audit_1",
    name: "bash",
    arguments: { command: "echo audit > audit.txt" },
  });
  const api = await createApiRuntime(config);
  const worker = await startWorker(config, { provider });
  try {
    const conversation = await api.conversation();
    assert.ok(conversation);
    await conversation.submit({
      type: "input",
      content: "run the tool",
      requestId: "audit-1",
      whenBusy: "steer",
    });

    const pending = await waitFor(async () => {
      const { entries } = await api.storage.entries(conversation.id, 100);
      for (const entry of entries) {
        if (entry.kind !== "pi.approval") continue;
        const data = entry.data as { callId?: string; status?: string };
        if (data.status === "pending" && typeof data.callId === "string") {
          return data.callId;
        }
      }
      return undefined;
    });

    assert.equal(await conversation.decideApproval(pending, "always"), true);
    await waitForDone(api, conversation.id, "audit-1");

    const audit = await waitFor(async () => {
      const events = await api.storage.listAudit(50);
      const actions = new Set(events.map((event) => event.action));
      return actions.has("approval.requested") && actions.has("approval.always")
        ? events
        : undefined;
    });

    const requested = audit.find((event) => event.action === "approval.requested");
    assert.ok(requested);
    assert.equal(requested.actor, "engine");
    assert.equal(requested.target, `${conversation.id}:${pending}`);
    const requestedData = requested.data as {
      tool?: string;
      callId?: string;
    };
    assert.equal(requestedData.tool, "bash");
    assert.equal(requestedData.callId, pending);
    assert.equal(requested.tenantId, "default");

    const always = audit.find((event) => event.action === "approval.always");
    assert.ok(always);
    assert.equal(always.actor, "user");
    assert.equal((always.data as { tool?: string }).tool, "bash");

    // Newest decision first: listAudit is ordered by created_at/id DESC.
    assert.ok(audit.indexOf(always) < audit.indexOf(requested));
  } finally {
    await worker.close();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite storage reports the default tenant and attributes events to it", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-usage-tenant-"));
  const api = await createApiRuntime(configFor(dir));
  try {
    assert.deepEqual(await api.storage.listTenants(), ["default"]);
    await api.storage.recordUsage({
      conversationId: 1,
      submissionId: null,
      provider: "demo",
      model: "ribhu-demo",
      inputTokens: 3,
      outputTokens: 4,
      costMicros: 0,
    });
    const [event] = await api.storage.listUsage(1);
    assert.equal(event?.tenantId, "default");
    assert.equal(event?.conversationId, 1);
    await api.storage.recordAudit({
      actor: "test",
      action: "test.event",
      target: "default",
    });
    const [audit] = await api.storage.listAudit(1);
    assert.equal(audit?.tenantId, "default");
    assert.equal(audit?.action, "test.event");
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("auth mode changes are audited", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-usage-auth-"));
  const config = configFor(dir, {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    demo: false,
    anthropicApiKey: "sk-dummy",
  });
  const api = await createApiRuntime(config);
  try {
    assert.ok(api.auth);
    await api.auth.setMode("api-key");
    const audit = await api.storage.listAudit(10);
    const changed = audit.find((event) => event.action === "auth.mode_changed");
    assert.ok(changed);
    assert.equal(changed.actor, "user");
    assert.equal(changed.target, "auth");
    assert.deepEqual(changed.data, { mode: "api-key" });
  } finally {
    await api.close();
    await rm(dir, { recursive: true, force: true });
  }
});