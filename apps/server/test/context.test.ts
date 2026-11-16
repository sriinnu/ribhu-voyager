import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Engine,
  admitSubmission,
  type ModelMessage,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
  type Usage,
} from "@ribhu-voyager/engine";
import { Db } from "@ribhu-voyager/storage-sqlite";

import { createToolRunner } from "../src/tools-runtime.js";

const usage: Usage = { input: 0, output: 0, totalTokens: 0 };

class RecordingProvider implements Provider {
  readonly id = "recording";
  readonly model = "recording";
  lastMessages: ModelMessage[] = [];
  summaries = 0;

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    if (request.system.includes("Summarize this coding-agent")) {
      this.summaries += 1;
      yield { type: "text", text: "SUMMARY: earlier turns." };
      yield { type: "done", stopReason: "stop", usage };
      return;
    }
    this.lastMessages = request.messages;
    yield { type: "text", text: "answer" };
    yield { type: "done", stopReason: "stop", usage };
  }
}

async function setup(options: {
  compactionKeepEntries?: number;
  compactionThresholdChars?: number;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-context-"));
  const db = new Db(join(dir, "test.sqlite"));
  const root = db.ensureRoot();
  const provider = new RecordingProvider();
  const engine = await Engine.open({
    storage: db,
    provider,
    runner: createToolRunner(),
    cwd: join(dir, "workspace"),
    model: { provider: "recording", modelId: "recording" },
    instructions: "test",
    autoRun: false,
    recoverOnOpen: false,
    ...options,
  });
  return { dir, db, root, provider, engine };
}

/** Every tool result must follow the assistant tool call that produced it. */
function assertWellFormed(messages: ModelMessage[]): void {
  assert.equal(messages[0]?.role, "user", "context starts with a user turn");
  const pendingToolCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") pendingToolCalls.add(block.id);
      }
    } else if (message.role === "toolResult") {
      assert.ok(
        pendingToolCalls.has(message.toolCallId),
        `orphan tool result ${message.toolCallId} in model context`,
      );
      pendingToolCalls.delete(message.toolCallId);
    }
  }
}

function assistantWithTools(
  conversationId: number,
  calls: Array<{ id: string; name?: string }>,
  text = "",
) {
  return {
    conversationId,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant" as const,
        content: [
          ...(text === "" ? [] : [{ type: "text" as const, text }]),
          ...calls.map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name ?? "bash",
            arguments: { command: "true" },
          })),
        ],
        stopReason: calls.length > 0 ? ("toolUse" as const) : ("stop" as const),
        timestamp: Date.now(),
        usage,
      },
    ],
  };
}

function toolResult(conversationId: number, toolCallId: string, content: string) {
  return {
    conversationId,
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult" as const,
        toolCallId,
        toolName: "bash",
        content,
        isError: false,
        timestamp: Date.now(),
      },
    ],
  };
}

test("context assembles whole turns and drops orphan tool results", { timeout: 20_000 }, async () => {
  const { dir, db, root, provider, engine } = await setup();
  try {
    db.appendEntry({
      conversationId: root,
      kind: "pi.user",
      model: [{ role: "user", content: "turn one", timestamp: 1 }],
    });
    db.appendEntry(assistantWithTools(root, [{ id: "call_1" }]));
    db.appendEntry(toolResult(root, "call_1", "result one"));
    db.appendEntry(assistantWithTools(root, [], "done one"));
    db.appendEntry({
      conversationId: root,
      kind: "pi.user",
      model: [{ role: "user", content: "turn two", timestamp: 2 }],
    });
    // Orphan: no assistant tool call with this id exists in the transcript.
    db.appendEntry(toolResult(root, "call_missing", "stale output"));
    db.appendEntry(assistantWithTools(root, [{ id: "call_2" }]));
    db.appendEntry(toolResult(root, "call_2", "result two"));
    db.appendEntry(assistantWithTools(root, [], "done two"));

    await admitSubmission(db, root, {
      type: "input",
      content: "latest question",
      requestId: "ctx-1",
    });
    await engine.run(root);

    const messages = provider.lastMessages;
    assertWellFormed(messages);
    assert.ok(
      !messages.some(
        (message) =>
          message.role === "toolResult" && message.toolCallId === "call_missing",
      ),
      "the orphan tool result is not sent to the provider",
    );
    const toolResults = messages.filter((message) => message.role === "toolResult");
    assert.equal(toolResults.length, 2);
    const last = messages[messages.length - 1];
    assert.equal(last?.role, "user");
    assert.equal(last?.role === "user" ? last.content : "", "latest question");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("long tool-heavy context trims whole turns only", { timeout: 30_000 }, async () => {
  const { dir, db, root, provider, engine } = await setup();
  try {
    const long = "x".repeat(8_000);
    for (let index = 0; index < 60; index += 1) {
      db.appendEntry({
        conversationId: root,
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: `turn ${index} ${long}`,
            timestamp: index,
          },
        ],
      });
      db.appendEntry(assistantWithTools(root, [{ id: `call_${index}` }], long));
      db.appendEntry(toolResult(root, `call_${index}`, long));
      db.appendEntry(assistantWithTools(root, [], `done ${index}`));
    }

    await admitSubmission(db, root, {
      type: "input",
      content: "final question",
      requestId: "ctx-long-1",
    });
    await engine.run(root);

    const messages = provider.lastMessages;
    assertWellFormed(messages);
    const first = messages[0];
    assert.equal(first?.role, "user");
    assert.match(
      first?.role === "user" ? first.content : "",
      /^turn \d+ /,
      "the oldest surviving message starts a whole turn",
    );
    assert.match(first?.role === "user" ? first.content : "", /^turn (?!0 )/);
    const totalChars = messages.reduce(
      (sum, message) => sum + JSON.stringify(message).length,
      0,
    );
    assert.ok(
      totalChars <= 360_000 + 20_000,
      `trimmed context stays near the budget (got ${totalChars})`,
    );
    const toolCalls = messages.filter((message) => message.role === "assistant")
      .flatMap((message) =>
        message.role === "assistant"
          ? message.content.filter((block) => block.type === "toolCall")
          : [],
      );
    const toolResults = messages.filter((message) => message.role === "toolResult");
    assert.equal(toolResults.length, toolCalls.length, "all retained pairs are complete");
    assert.ok(toolResults.length > 0 && toolResults.length < 60);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a compaction boundary never splits an assistant/tool pair", { timeout: 20_000 }, async () => {
  const { dir, db, root, provider, engine } = await setup({
    compactionKeepEntries: 2,
    compactionThresholdChars: 0,
  });
  try {
    const user1 = db.appendEntry({
      conversationId: root,
      kind: "pi.user",
      model: [{ role: "user", content: "old turn", timestamp: 1 }],
    });
    db.appendEntry(assistantWithTools(root, [], "old answer"));
    const user2 = db.appendEntry({
      conversationId: root,
      kind: "pi.user",
      model: [{ role: "user", content: "tool turn", timestamp: 2 }],
    });
    db.appendEntry(assistantWithTools(root, [{ id: "call_boundary" }]));
    db.appendEntry(toolResult(root, "call_boundary", "tool output"));
    db.appendEntry({
      conversationId: root,
      kind: "pi.user",
      model: [{ role: "user", content: "newest turn", timestamp: 3 }],
    });
    assert.ok(user1 < user2);

    assert.ok(await engine.compact(root));
    assert.equal(provider.summaries, 1);
    const compaction = db.lastEntryOfKind(root, "pi.compaction");
    const data = compaction?.data as { coversUpTo?: number };
    assert.equal(
      data.coversUpTo,
      user2,
      "the boundary backs up to the user entry instead of cutting the pair",
    );
    const boundaryEntry = db
      .entries(root)
      .entries.find((entry) => entry.id === data.coversUpTo);
    assert.equal(boundaryEntry?.kind, "pi.user");

    await admitSubmission(db, root, {
      type: "input",
      content: "after compaction",
      requestId: "ctx-compact-1",
    });
    await engine.run(root);
    const messages = provider.lastMessages;
    assertWellFormed(messages);
    assert.ok(
      !messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolCallId === "call_boundary",
      ),
      "the split pair's tool result is not an orphan in the resumed context",
    );
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
