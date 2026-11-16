import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicProvider } from "@ribhu-voyager/providers";
import { OpenAICompatProvider } from "@ribhu-voyager/providers";
import {
  DEFAULT_PROVIDER_RETRY,
  ProviderError,
  classifyProviderError,
  retryDelayMs,
  type ProviderEvent,
} from "@ribhu-voyager/engine";

function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(
  provider: AnthropicProvider | OpenAICompatProvider,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({
    model: "test",
    system: "system",
    messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    tools: [],
    maxTokens: 1024,
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

test("parses Anthropic text and tool_use streams", { timeout: 20_000 }, async () => {
  const original = globalThis.fetch;
  const body = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"bash"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"echo hi\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");

  globalThis.fetch = async () => sseResponse(body);
  try {
    const provider = new AnthropicProvider({
      model: "claude-test",
      getAuth: async () => ({ token: "token", mode: "api-key" }),
    });
    const events = await collect(provider);
    assert.deepEqual(
      events.filter((event) => event.type === "text"),
      [{ type: "text", text: "Hello" }],
    );
    const tool = events.find((event) => event.type === "toolCall");
    assert.deepEqual(tool, {
      type: "toolCall",
      id: "tool_1",
      name: "bash",
      arguments: { command: "echo hi" },
    });
    const done = events.find((event) => event.type === "done");
    assert.equal(done?.type === "done" ? done.stopReason : undefined, "toolUse");
  } finally {
    globalThis.fetch = original;
  }
});

test("parses OpenAI-compatible text and tool_call streams", { timeout: 20_000 }, async () => {
  const original = globalThis.fetch;
  const body = [
    'data: {"choices":[{"delta":{"content":"Hi "},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"there"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"command\\":\\"echo hi\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  globalThis.fetch = async () => sseResponse(body);
  try {
    const provider = new OpenAICompatProvider({
      id: "deepseek",
      model: "deepseek-test",
      baseUrl: "http://example.test/v1",
      apiKey: "sk-test",
    });
    const events = await collect(provider);
    assert.deepEqual(
      events.filter((event) => event.type === "text"),
      [
        { type: "text", text: "Hi " },
        { type: "text", text: "there" },
      ],
    );
    const tool = events.find((event) => event.type === "toolCall");
    assert.deepEqual(tool, {
      type: "toolCall",
      id: "call_1",
      name: "bash",
      arguments: { command: "echo hi" },
    });
    const done = events.find((event) => event.type === "done");
    assert.equal(done?.type === "done" ? done.stopReason : undefined, "toolUse");
    assert.equal(done?.type === "done" ? done.usage.totalTokens : undefined, 7);
  } finally {
    globalThis.fetch = original;
  }
});

function statusResponse(status: number, body = "", headers?: Record<string, string>): Response {
  return new Response(body, { status, headers });
}

async function expectFailure(
  provider: AnthropicProvider | OpenAICompatProvider,
): Promise<ProviderError> {
  try {
    await collect(provider);
  } catch (error) {
    assert.ok(error instanceof ProviderError, `expected ProviderError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the provider to throw");
}

test("classifies retryable vs permanent provider errors", () => {
  const rateLimited = classifyProviderError(
    new ProviderError("slow down", { kind: "rate_limited", retryable: true, status: 429 }),
  );
  assert.equal(rateLimited.kind, "rate_limited");
  assert.equal(rateLimited.retryable, true);

  assert.equal(classifyProviderError(new Error("503 Service Unavailable")).retryable, true);
  assert.equal(classifyProviderError(new Error("HTTP 500")).kind, "server");
  assert.equal(classifyProviderError(new Error("400 Bad Request")).retryable, false);
  assert.equal(classifyProviderError(new Error("rate limit exceeded")).kind, "rate_limited");
  assert.equal(classifyProviderError(new TypeError("fetch failed")).kind, "network");
  assert.equal(classifyProviderError(new TypeError("fetch failed")).retryable, true);
  const networkCode = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
  assert.equal(classifyProviderError(networkCode).kind, "network");
  const abort = new DOMException("Aborted", "AbortError");
  const aborted = classifyProviderError(abort);
  assert.equal(aborted.kind, "aborted");
  assert.equal(aborted.retryable, false);
  assert.equal(classifyProviderError(new Error("boom")).retryable, false);
  assert.equal(classifyProviderError(new Error("boom")).kind, "permanent");
});

test("backoff is exponential, capped, and jittered", () => {
  const policy = { ...DEFAULT_PROVIDER_RETRY, initialDelayMs: 100, factor: 2, jitter: 0.25, maxDelayMs: 400 };
  assert.equal(retryDelayMs(1, policy, () => 0.5), 100);
  assert.equal(retryDelayMs(2, policy, () => 0.5), 200);
  assert.equal(retryDelayMs(3, policy, () => 0.5), 400);
  assert.equal(retryDelayMs(10, policy, () => 0.5), 400, "delay is capped");
  const noJitter = { ...policy, jitter: 0 };
  assert.equal(retryDelayMs(2, noJitter, () => 0), 200);
  assert.ok(retryDelayMs(1, policy, () => 0) >= 75);
  assert.ok(retryDelayMs(1, policy, () => 1) <= 125);
});

test("Anthropic HTTP errors carry status, retryability and Retry-After", { timeout: 20_000 }, async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => statusResponse(429, "slow down", { "retry-after": "2" });
    const limited = await expectFailure(
      new AnthropicProvider({
        model: "claude-test",
        getAuth: async () => ({ token: "token", mode: "api-key" }),
      }),
    );
    assert.equal(limited.kind, "rate_limited");
    assert.equal(limited.status, 429);
    assert.equal(limited.retryable, true);
    assert.equal(limited.retryAfterMs, 2000);

    globalThis.fetch = async () => statusResponse(503, "overloaded");
    const server = await expectFailure(
      new AnthropicProvider({
        model: "claude-test",
        getAuth: async () => ({ token: "token", mode: "api-key" }),
      }),
    );
    assert.equal(server.kind, "server");
    assert.equal(server.retryable, true);

    globalThis.fetch = async () => statusResponse(400, "bad request");
    const permanent = await expectFailure(
      new AnthropicProvider({
        model: "claude-test",
        getAuth: async () => ({ token: "token", mode: "api-key" }),
      }),
    );
    assert.equal(permanent.kind, "permanent");
    assert.equal(permanent.retryable, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenAI-compatible HTTP and stream errors are classified", { timeout: 20_000 }, async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => statusResponse(429, "rate limited");
    const limited = await expectFailure(
      new OpenAICompatProvider({
        id: "deepseek",
        model: "deepseek-test",
        baseUrl: "http://example.test/v1",
        apiKey: "sk-test",
      }),
    );
    assert.equal(limited.kind, "rate_limited");
    assert.equal(limited.retryable, true);

    const streamError = [
      'data: {"error":{"type":"rate_limit_error","message":"too many requests"}}\n\n',
    ].join("");
    globalThis.fetch = async () => sseResponse(streamError);
    const inStream = await expectFailure(
      new OpenAICompatProvider({
        id: "deepseek",
        model: "deepseek-test",
        baseUrl: "http://example.test/v1",
        apiKey: "sk-test",
      }),
    );
    assert.equal(inStream.kind, "rate_limited");
    assert.equal(inStream.retryable, true);

    const quotaError = [
      'data: {"error":{"type":"insufficient_quota","message":"billing problem"}}\n\n',
    ].join("");
    globalThis.fetch = async () => sseResponse(quotaError);
    const permanent = await expectFailure(
      new OpenAICompatProvider({
        id: "deepseek",
        model: "deepseek-test",
        baseUrl: "http://example.test/v1",
        apiKey: "sk-test",
      }),
    );
    assert.equal(permanent.retryable, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic stream error events map to classified errors", { timeout: 20_000 }, async () => {
  const original = globalThis.fetch;
  try {
    const body = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n';
    globalThis.fetch = async () => sseResponse(body);
    const error = await expectFailure(
      new AnthropicProvider({
        model: "claude-test",
        getAuth: async () => ({ token: "token", mode: "api-key" }),
      }),
    );
    assert.equal(error.kind, "server");
    assert.equal(error.retryable, true);
  } finally {
    globalThis.fetch = original;
  }
});
