import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConversationBusy,
  Engine,
  StaleFence,
  admitSubmission,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "@ribhu-voyager/engine";
import { Db } from "@ribhu-voyager/storage-sqlite";

import { createToolRunner } from "../src/tools-runtime.js";

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class StaticProvider implements Provider {
  readonly id = "static";
  readonly model = "static";
  async *stream(): AsyncIterable<ProviderEvent> {
    yield { type: "text", text: "answer" };
    yield {
      type: "done",
      stopReason: "stop",
      usage: { input: 1, output: 1, totalTokens: 2 },
    };
  }
}

class SlowProvider implements Provider {
  readonly id = "slow";
  readonly model = "slow";
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    for (let index = 0; index < 100; index += 1) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (request.signal.aborted) {
          onAbort();
          return;
        }
        request.signal.addEventListener("abort", onAbort, { once: true });
      });
      yield { type: "text", text: "partial " };
    }
    yield {
      type: "done",
      stopReason: "stop",
      usage: { input: 0, output: 0, totalTokens: 0 },
    };
  }
}

async function openEngine(
  dir: string,
  db: Db,
  provider: Provider,
): Promise<ReturnType<typeof Engine.open>> {
  return await Engine.open({
    storage: db,
    provider,
    runner: createToolRunner(),
    cwd: join(dir, "workspace"),
    model: { provider: provider.id, modelId: provider.model },
    instructions: "test",
    autoRun: false,
    recoverOnOpen: false,
  });
}

test("stale cancel flags are cleared at admission, not at run start", { timeout: 20_000 }, async () => {
  const { dir, db, conversationId } = await setup();
  const engine = await openEngine(dir, db, new SlowProvider());
  try {
    db.requestCancel(conversationId);
    const admitted = await admitSubmission(db, conversationId, {
      type: "input",
      content: "hello",
      requestId: "r1",
    });
    assert.equal(admitted.status, "queued");
    assert.equal(
      db.isCancelRequested(conversationId),
      false,
      "a stale cancel flag is cleared when the new submission is admitted",
    );

    // A cancel requested after admission still aborts the run: run start no
    // longer blindly clears the flag.
    db.requestCancel(conversationId);
    await engine.run(conversationId);
    assert.equal(db.findSubmission(conversationId, "r1")?.status, "aborted");
    assert.equal(
      db.entries(conversationId).entries.filter((entry) => entry.kind === "pi.assistant")
        .length,
      0,
      "the aborted run committed no assistant entry",
    );
    assert.equal(db.isCancelRequested(conversationId), false);
  } finally {
    await engine.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("queue uniqueness: one active job per kind and busy conversations cannot be re-claimed", { timeout: 20_000 }, async () => {
  const { dir, db, conversationId } = await setup();
  try {
    db.enqueueRun(conversationId);
    db.enqueueRun(conversationId);
    db.enqueueCompact(conversationId);
    db.enqueueCompact(conversationId);
    const count = (kind: string): number =>
      Number(
        (
          db.db
            .prepare(
              "SELECT COUNT(*) AS n FROM jobs WHERE conversation_id = ? AND kind = ? AND status IN ('pending','running')",
            )
            .get(conversationId, kind) as { n: number }
        ).n,
      );
    assert.equal(count("run"), 1, "duplicate run enqueues collapse to one job");
    assert.equal(count("compact"), 1, "duplicate compact enqueues collapse to one job");

    const runJob = db.claimRun("worker-a", 30_000);
    assert.equal(runJob?.kind, "run");
    // A second worker cannot claim the compact job while the run is active.
    assert.equal(db.claimRun("worker-b", 30_000), undefined);
    db.finishRun(runJob!.id, "worker-a");
    const compactJob = db.claimRun("worker-b", 30_000);
    assert.equal(compactJob?.kind, "compact");
    db.finishRun(compactJob!.id, "worker-b");
    assert.equal(db.claimRun("worker-c", 30_000), undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale fence cannot commit and the new owner answers exactly once", { timeout: 20_000 }, async () => {
  const { dir, db, conversationId } = await setup();
  const engineA = await openEngine(dir, db, new StaticProvider());
  const engineB = await openEngine(dir, db, new StaticProvider());
  try {
    await admitSubmission(db, conversationId, {
      type: "input",
      content: "fenced",
      requestId: "r1",
    });
    const jobA = db.claimRun("worker-a", 1);
    assert.ok(jobA);
    await sleep(25);
    const jobB = db.claimRun("worker-b", 30_000);
    assert.ok(jobB);
    assert.equal(jobB.id, jobA.id, "the lease expiry lets worker B reclaim the job");
    assert.ok(jobB.fence > jobA.fence);

    const guardA = { jobId: jobA.id, owner: "worker-a", fence: jobA.fence };
    const guardB = { jobId: jobB.id, owner: "worker-b", fence: jobB.fence };

    // Direct guarded writes from the stale fence are rejected.
    assert.throws(
      () =>
        db.appendEntry(
          {
            conversationId,
            kind: "pi.assistant",
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: "stale" }],
                stopReason: "stop",
                timestamp: Date.now(),
                usage: { input: 0, output: 0, totalTokens: 0 },
              },
            ],
          },
          guardA,
        ),
      StaleFence,
    );
    assert.throws(
      () =>
        db.createToolTask(conversationId, "call_stale", "bash", {}, false, guardA),
      StaleFence,
    );

    // Engine A's renew may be frozen: it still thinks the lease is valid, but
    // its first guarded write is rejected and it commits nothing (the run
    // treats StaleFence as a lost lease).
    await engineA.run(conversationId, () => true, guardA);
    assert.equal(
      db.findSubmission(conversationId, "r1")?.status,
      "queued",
      "the stale worker neither ran the submission nor settled it",
    );
    assert.equal(
      db.entries(conversationId).entries.filter((entry) => entry.kind === "pi.assistant")
        .length,
      0,
    );

    // Engine B owns the fence and produces exactly one answer.
    await engineB.run(conversationId, () => true, guardB);
    assert.equal(db.findSubmission(conversationId, "r1")?.status, "done");
    assert.equal(
      db.entries(conversationId).entries.filter((entry) => entry.kind === "pi.assistant")
        .length,
      1,
      "exactly one answer was committed",
    );

    // Tool results are fenced too: B can create/finish one task, A cannot.
    const task = db.createToolTask(conversationId, "call_ok", "bash", {}, false, guardB);
    db.finishToolTask(task.id, "ok", "done", guardB);
    assert.throws(
      () => db.finishToolTask(task.id, "stale", "done", guardA),
      StaleFence,
    );
    assert.equal(
      db.runningToolTasks(conversationId).length,
      0,
      "the new owner's tool task is finished exactly once",
    );
  } finally {
    await engineA.close();
    await engineB.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test("old journals with duplicate active jobs are collapsed on open", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-admission-dedupe-"));
  const path = join(dir, "test.sqlite");
  try {
    const db = new Db(path);
    const conversationId = db.ensureRoot();
    db.enqueueRun(conversationId);
    // Simulate a journal written before the partial unique index existed.
    db.db.exec("DROP INDEX IF EXISTS jobs_active_run");
    db.db
      .prepare(
        "INSERT INTO jobs(conversation_id, kind, status, created_at, updated_at) VALUES(?, 'run', 'pending', ?, ?)",
      )
      .run(conversationId, Date.now(), Date.now());
    db.close();

    const reopened = new Db(path);
    try {
      const active = reopened.db
        .prepare(
          "SELECT COUNT(*) AS n FROM jobs WHERE conversation_id = ? AND kind = 'run' AND status IN ('pending','running')",
        )
        .get(conversationId) as { n: number };
      assert.equal(Number(active.n), 1, "duplicate active jobs are collapsed");
      assert.ok(
        reopened.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'jobs_active_run'",
          )
          .get(),
        "the partial unique index is recreated",
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
