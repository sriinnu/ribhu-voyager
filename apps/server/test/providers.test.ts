import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicProvider } from "@ribhu-voyager/providers";
import { OpenAICompatProvider } from "@ribhu-voyager/providers";
import type { ProviderEvent } from "@ribhu-voyager/engine";

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
