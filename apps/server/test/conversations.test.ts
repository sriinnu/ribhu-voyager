import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { seedConversation } from "@ribhu-voyager/engine";
import { Db } from "@ribhu-voyager/storage-sqlite";

test("conversations list, rename, and fork by entry", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-conv-"));
  const db = new Db(join(dir, "test.sqlite"));
  try {
    const root = db.ensureRoot();
    await seedConversation(db, root, { provider: "demo", modelId: "ribhu-demo" });
    const first = db.appendEntry({
      conversationId: root,
      kind: "pi.user",
      model: [{ role: "user", content: "one", timestamp: 1 }],
    });
    db.appendEntry({
      conversationId: root,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "answer one" }],
          stopReason: "stop",
          timestamp: 1,
          usage: { input: 0, output: 0, totalTokens: 0 },
        },
      ],
    });
    db.appendEntry({
      conversationId: root,
      kind: "pi.user",
      model: [{ role: "user", content: "two", timestamp: 2 }],
    });

    const second = db.createConversation("Second");
    db.renameConversation(second, "Renamed");
    const list = db.listConversations();
    assert.ok(list.some((item) => item.id === second && item.title === "Renamed"));

    const fork = db.forkConversation(root, first);
    const forkSummary = db.listConversations().find((item) => item.id === fork);
    assert.equal(forkSummary?.parentId, root);
    assert.equal(forkSummary?.forkEntryId, first);
    assert.match(forkSummary?.title ?? "", /^Fork of /);
    assert.equal(db.entries(fork).entries.length, 1);
    assert.ok(db.docs(fork)["pi.agent"]);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("search finds transcript text and archive hides conversations", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-search-"));
  const db = new Db(join(dir, "test.sqlite"));
  try {
    const root = db.ensureRoot();
    db.appendEntry({
      conversationId: root,
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: "find the purple elephant in this transcript",
          timestamp: 1,
        },
      ],
    });
    const results = db.searchConversations("purple elephant");
    assert.equal(results.length, 1);
    assert.match(results[0]?.snippet ?? "", /purple/);
    assert.match(results[0]?.snippet ?? "", /elephant/);

    db.archiveConversation(root, true);
    assert.equal(db.listConversations().length, 0);
    assert.equal(db.searchConversations("purple elephant").length, 0);
    assert.equal(db.listConversations(true).length, 1);

    db.archiveConversation(root, false);
    assert.equal(db.listConversations().length, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
