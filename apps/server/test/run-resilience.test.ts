import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Engine,
  ProviderError,
  admitSubmission,
  type Provider,
  type ProviderErrorKind,
  type ProviderEvent,
  type ProviderRequest,
  type RetryPolicy,
} from "@ribhu-voyager/engine";
import { Db } from "@ribhu-voyager/storage-sqlite";

import { loadConfig } from "../src/config.js";
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
    await sleep(10);
  }
}

type PlanStep =
  | "ok"
  | "hang"
  | "text-then-error"
  | "tool-then-error"
  | {
      errorKind: ProviderErrorKind;
      retryable: boolean;
      status?: number;
      retryAfterMs?: number;
      message?: string;
    };

class FlakyProvider implements Provider {
  readonly id = "flaky";
  readonly model = "flaky";
  attempts = 0;
  attemptTimes: number[] = [];

  constructor(private readonly plan: PlanStep[]) {}

  async *stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const step = this.plan[Math.min(this.attempts, this.plan.length - 1)]!;
    this.attempts += 1;
    this.attemptTimes.push(Date.now());
    if (step === "ok") {
      yield { type: "text", text: "answer" };
      yield {
        type: "done",
        stopReason: "stop",
        usage: { input: 1, output: 1, totalTokens: 2 },
      };
      return;
    }
    if (step === "text-then-error") {
      yield { type: "text", text: "partial output" };
      throw new ProviderError("rate limited mid-stream", {
        kind: "rate_limited",
        retryable: true,
        status: 429,
      });
    }
    if (step === "tool-then-error") {
      yield {
        type: "toolCall",
        id: "call_partial",
        name: "noop",
        arguments: {},
      };
      throw new ProviderError("rate limited after tool intent", {
        kind: "rate_limited",
        retryable: true,
        status: 429,
      });
    }
    if (step === "hang") {
      // Deliberately ignores the abort signal: the engine's request deadline
      // must release a provider that never settles.
      await new Promise<void>(() => undefined);
      return;
    }
    throw new ProviderError(step.message ?? `provider HTTP ${step.status ?? 500}`, {
      kind: step.errorKind,
      retryable: step.retryable,
      ...(step.status !== undefined ? { status: step.status } : {}),
      ...(step.retryAfterMs !== undefined
        ? { retryAfterMs: step.retryAfterMs }
        : {}),
    });
  }
}

const FAST_RETRY: Partial<RetryPolicy> = {
  maxAttempts: 3,
  initialDelayMs: 1,
  maxDelayMs: 10,
  factor: 2,
  jitter: 0,
  timeoutMs: 2_000,
};

async function setup(
  dir: string,
  provider: Provider,
  providerRetry: Partial<RetryPolicy> = FAST_RETRY,
) {
  const db = new Db(join(dir, "resilience.sqlite"));
  const engine = await Engine.open({
    storage: db,
    provider,
    runner: createToolRunner(),
    cwd: join(dir, "workspace"),
    model: { provider: provider.id, modelId: provider.model },
    instructions: "test",
    autoRun: false,
    recoverOnOpen: false,
    providerRetry,
  });
  const conversation = await engine.root();
  return { db, engine, conversation };
}

test("retries a 429 and then succeeds (Retry-After respected)", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-resilience-429-"));
  const provider = new FlakyProvider([
    {
      errorKind: "rate_limited",
      retryable: true,
      status: 429,
      retryAfterMs: 40,
      message: "429 Too Many Requests",
    },
    "ok",
  ]);
  const { db, engine, conversation } = await setup(dir, provider, {
    ...FAST_RETRY,
    maxAttempts: 3,
    initialDelayMs: 1,
    maxDelayMs: 1,
  });
  try {
    await admitSubmission(db, conversation.id, {
      type: "input",
      content: "hello",
      requestId: "retry-1",
    });
    await engine.run(conversation.id);
    assert.equal(provider.attempts, 2, "one retry after the 429");
    assert.ok(
      provider.attemptTimes[1]! - provider.attemptTimes[0]! >= 35,
      "backoff waited for the Retry-After hint",
    );
    assert.equal(db.findSubmission(conversation.id, "retry-1")?.status, "done");
    assert.equal(
      db.entries(conversation.id).entries.filter((entry) => entry.kind === "pi.assistant")
        .length,
      1,
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("5xx exhaustion fails the run after the configured attempts", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-resilience-503-"));
  const provider = new FlakyProvider([
    { errorKind: "server", retryable: true, status: 503, message: "503 unavailable" },
  ]);
  const { db, engine, conversation } = await setup(dir, provider, {
    ...FAST_RETRY,
    maxAttempts: 3,
  });
  try {
    await admitSubmission(db, conversation.id, {
      type: "input",
      content: "hello",
      requestId: "retry-503",
    });
    await engine.run(conversation.id);
    assert.equal(provider.attempts, 3, "all attempts were used");
    const submission = db.findSubmission(conversation.id, "retry-503");
    assert.equal(submission?.status, "failed");
    assert.match(submission?.error ?? "", /503|unavailable/);
    assert.equal(
      db.entries(conversation.id).entries.filter((entry) => entry.kind === "pi.assistant")
        .length,
      0,
      "no assistant entry is committed for a failed request",
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("aborting during backoff stops the run before another attempt", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-resilience-abort-"));
  const provider = new FlakyProvider([
    {
      errorKind: "rate_limited",
      retryable: true,
      status: 429,
      message: "429 slow down",
    },
  ]);
  const { db, engine, conversation } = await setup(dir, provider, {
    maxAttempts: 5,
    initialDelayMs: 5_000,
    maxDelayMs: 5_000,
    factor: 2,
    jitter: 0,
    timeoutMs: 2_000,
  });
  try {
    await admitSubmission(db, conversation.id, {
      type: "input",
      content: "hello",
      requestId: "retry-abort",
    });
    const run = engine.run(conversation.id);
    await waitFor(() => (provider.attempts === 1 ? true : undefined));
    await sleep(20);
    await engine.abort(conversation.id);
    await run;
    assert.equal(provider.attempts, 1, "the backoff was aborted, no retry happened");
    assert.equal(db.findSubmission(conversation.id, "retry-abort")?.status, "aborted");
    assert.equal(
      db.entries(conversation.id).entries.filter((entry) => entry.kind === "pi.assistant")
        .length,
      0,
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hung stream is timed out with a retryable error", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-resilience-timeout-"));
  const provider = new FlakyProvider(["hang"]);
  const { db, engine, conversation } = await setup(dir, provider, {
    maxAttempts: 2,
    initialDelayMs: 1,
    maxDelayMs: 5,
    factor: 2,
    jitter: 0,
    timeoutMs: 60,
  });
  try {
    await admitSubmission(db, conversation.id, {
      type: "input",
      content: "hang",
      requestId: "retry-timeout",
    });
    const started = Date.now();
    await engine.run(conversation.id);
    assert.ok(Date.now() - started < 5_000, "the request deadline released the stream");
    assert.equal(provider.attempts, 2, "the timeout error was retried");
    const submission = db.findSubmission(conversation.id, "retry-timeout");
    assert.equal(submission?.status, "failed");
    assert.match(submission?.error ?? "", /timed out|timeout/i);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("permanent 400s are not retried", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-resilience-400-"));
  const provider = new FlakyProvider([
    { errorKind: "permanent", retryable: false, status: 400, message: "400 bad request" },
  ]);
  const { db, engine, conversation } = await setup(dir, provider);
  try {
    await admitSubmission(db, conversation.id, {
      type: "input",
      content: "bad",
      requestId: "retry-400",
    });
    await engine.run(conversation.id);
    assert.equal(provider.attempts, 1, "a permanent error is never retried");
    const submission = db.findSubmission(conversation.id, "retry-400");
    assert.equal(submission?.status, "failed");
    assert.match(submission?.error ?? "", /400/);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("never retries after partial output or a tool intent was delivered", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-resilience-partial-"));
  const provider = new FlakyProvider(["text-then-error", "ok"]);
  const { db, engine, conversation } = await setup(dir, provider);
  try {
    await admitSubmission(db, conversation.id, {
      type: "input",
      content: "partial",
      requestId: "retry-partial",
    });
    await engine.run(conversation.id);
    assert.equal(provider.attempts, 1, "partial text blocks the retry");
    const submission = db.findSubmission(conversation.id, "retry-partial");
    assert.equal(submission?.status, "failed");
    assert.match(submission?.error ?? "", /rate limited/);
    assert.equal(
      db.entries(conversation.id).entries.filter((entry) => entry.kind === "pi.assistant")
        .length,
      0,
      "no partial assistant entry was committed",
    );

    const toolProvider = new FlakyProvider(["tool-then-error", "ok"]);
    const second = await setup(dir, toolProvider);
    try {
      await admitSubmission(second.db, second.conversation.id, {
        type: "input",
        content: "partial tool",
        requestId: "retry-partial-tool",
      });
      await second.engine.run(second.conversation.id);
      assert.equal(toolProvider.attempts, 1, "a delivered tool intent blocks the retry");
      assert.equal(
        second.db.runningToolTasks(second.conversation.id).length,
        0,
        "no tool task was created",
      );
    } finally {
      await second.engine.close();
    }
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider retry config has sane defaults and validation", () => {
  const defaults = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(defaults.providerMaxAttempts, 4);
  assert.equal(defaults.providerTimeoutMs, 120_000);
  assert.equal(defaults.providerRetryBaseMs, 500);
  assert.equal(defaults.providerRetryMaxMs, 30_000);
  assert.equal(defaults.providerRetryJitter, 0.25);

  const custom = loadConfig({
    RIBBHU_PROVIDER_MAX_ATTEMPTS: "6",
    RIBBHU_PROVIDER_TIMEOUT_MS: "9000",
    RIBBHU_PROVIDER_RETRY_BASE_MS: "250",
    RIBBHU_PROVIDER_RETRY_MAX_MS: "4000",
    RIBBHU_PROVIDER_RETRY_JITTER: "0.5",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(custom.providerRetry, {
    maxAttempts: 6,
    initialDelayMs: 250,
    maxDelayMs: 4_000,
    factor: 2,
    jitter: 0.5,
    timeoutMs: 9_000,
  });

  assert.throws(
    () => loadConfig({ RIBBHU_PROVIDER_MAX_ATTEMPTS: "0" } as NodeJS.ProcessEnv),
    /positive integer/,
  );
  assert.throws(
    () => loadConfig({ RIBBHU_PROVIDER_RETRY_JITTER: "2" } as NodeJS.ProcessEnv),
    /between 0 and 1/,
  );
  assert.throws(
    () =>
      loadConfig({
        RIBBHU_PROVIDER_RETRY_BASE_MS: "5000",
        RIBBHU_PROVIDER_RETRY_MAX_MS: "1000",
      } as NodeJS.ProcessEnv),
    />=/,
  );
});
