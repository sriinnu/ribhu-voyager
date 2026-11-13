import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Db } from "@ribhu-voyager/storage-sqlite";

test("schema v1 submissions migrate to scoped ids and when_busy", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-migrate-"));
  const path = join(dir, "old.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      answer_entry_id INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO meta(key, value) VALUES('schema', '1');
    INSERT INTO conversations(version, created_at) VALUES(0, 1);
    INSERT INTO submissions(
      conversation_id, request_id, content, status, created_at, updated_at
    ) VALUES(1, 'old-request', 'hello', 'done', 1, 1);
  `);
  raw.close();

  const db = new Db(path);
  try {
    const old = db.findSubmission(1, "old-request");
    assert.equal(old?.content, "hello");
    assert.equal(old?.when_busy, "steer");

    const second = db.createConversation();
    const row = db.createSubmission(second, "old-request", "second");
    assert.equal(row.when_busy, "steer");
    assert.notEqual(row.id, old?.id);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
