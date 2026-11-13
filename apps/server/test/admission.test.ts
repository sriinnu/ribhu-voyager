import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConversationBusy, admitSubmission } from "@ribhu-voyager/engine";
import { Db } from "@ribhu-voyager/storage-sqlite";

async function setup(): Promise<{ dir: string; db: Db; conversationId: number }> {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-admission-"));
  const db = new Db(join(dir, "test.sqlite"));
  const conversationId = db.ensureRoot();
  return { dir, db, conversationId };
}

test("admits once and enqueues one run", { timeout: 20_000 }, async () => {
  const { dir, db, conversationId } = await setup();
  try {
    const first = await admitSubmission(db, conversationId, {
      type: "input",
      content: "hello",
      requestId: "r1",
    });
    assert.equal(first.status, "queued");

    const again = await admitSubmission(db, conversationId, {
      type: "input",
      content: "hello",
      requestId: "r1",
    });
    assert.equal(again.id, first.id);
    assert.equal(
      db.entries(conversationId).entries.filter((entry) => entry.kind === "pi.user")
        .length,
      1,
    );

    const job = db.claimRun("worker-a", 30_000);
    assert.equal(job?.conversation_id, conversationId);
    assert.equal(db.claimRun("worker-b", 30_000), undefined);
    assert.equal(db.renewRun(job!.id, "worker-a", 30_000), true);
    db.finishRun(job!.id, "worker-a");
    assert.equal(db.claimRun("worker-b", 30_000), undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects when busy and supports cancellation flags", { timeout: 20_000 }, async () => {
  const { dir, db, conversationId } = await setup();
  try {
    await admitSubmission(db, conversationId, {
      type: "input",
      content: "first",
      requestId: "r1",
    });
    await assert.rejects(
      () =>
        admitSubmission(db, conversationId, {
          type: "input",
          content: "second",
          requestId: "r2",
          whenBusy: "reject",
        }),
      ConversationBusy,
    );

    assert.equal(db.isCancelRequested(conversationId), false);
    db.requestCancel(conversationId);
    assert.equal(db.isCancelRequested(conversationId), true);
    db.clearCancel(conversationId);
    assert.equal(db.isCancelRequested(conversationId), false);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an expired lease is reclaimable", { timeout: 20_000 }, async () => {
  const { dir, db, conversationId } = await setup();
  try {
    await admitSubmission(db, conversationId, {
      type: "input",
      content: "lease",
      requestId: "r1",
    });
    const first = db.claimRun("worker-a", 1);
    assert.ok(first);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = db.claimRun("worker-b", 30_000);
    assert.equal(second?.id, first.id);
    assert.equal(second?.owner, "worker-b");
    assert.ok(second!.fence > first!.fence);
    assert.equal(db.jobOwned(first!.id, "worker-a", first!.fence), false);
    assert.equal(db.jobOwned(second!.id, "worker-b", second!.fence), true);
    db.finishRun(second!.id, "worker-b");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("requestId is scoped per conversation and terminal states are sticky", { timeout: 20_000 }, async () => {
  const { dir, db, conversationId } = await setup();
  try {
    const second = db.createConversation();
    const first = await admitSubmission(db, conversationId, {
      type: "input",
      content: "one",
      requestId: "shared",
    });
    const other = await admitSubmission(db, second, {
      type: "input",
      content: "two",
      requestId: "shared",
    });
    assert.notEqual(other.id, first.id);
    assert.equal(
      db.entries(second).entries.filter((entry) => entry.kind === "pi.user")
        .length,
      1,
    );

    db.updateSubmission(first.id, "done");
    db.updateSubmission(first.id, "aborted");
    db.settleSubmissionIds([first.id], "failed", { error: "late" });
    assert.equal(db.findSubmission(conversationId, "shared")?.status, "done");

    db.updateSubmission(other.id, "aborted");
    db.updateSubmission(other.id, "done");
    assert.equal(db.findSubmission(second, "shared")?.status, "aborted");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
