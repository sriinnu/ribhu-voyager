import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { admitSubmission } from "@ribhu-voyager/engine";
import { Db, serializedStorage } from "@ribhu-voyager/storage-sqlite";

test("serialized SQLite handles concurrent admissions", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-serialize-"));
  const raw = new Db(join(dir, "test.sqlite"));
  const storage = serializedStorage(raw);
  try {
    const root = await storage.ensureRoot();
    const [first, second] = await Promise.all([
      admitSubmission(storage, root, {
        type: "input",
        content: "one",
        requestId: "concurrent-1",
      }),
      admitSubmission(storage, root, {
        type: "input",
        content: "two",
        requestId: "concurrent-2",
      }),
    ]);
    assert.notEqual(first.id, second.id);
    assert.equal((await storage.queuedSubmissions(root)).length, 2);
  } finally {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an outside write waits for a rolling-back transaction", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-serialize-"));
  const raw = new Db(join(dir, "test.sqlite"));
  const storage = serializedStorage(raw);
  try {
    const root = await storage.ensureRoot();
    const failing = storage
      .tx(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error("rollback");
      })
      .catch(() => "failed");
    const outside = storage.putDoc(root, "outside", { ok: true });
    await Promise.all([failing, outside]);
    assert.deepEqual((await storage.docs(root)).outside, { ok: true });
  } finally {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
