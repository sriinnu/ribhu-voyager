import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  RESET_TRUNCATE_TABLES,
} from "@ribhu-voyager/storage-postgres";
import { Db } from "@ribhu-voyager/storage-sqlite";

import { loadConfig } from "../src/config.js";

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

test("migration list is contiguous, uniquely named and versioned", () => {
  assert.ok(MIGRATIONS.length > 0, "at least one migration exists");
  for (const [index, migration] of MIGRATIONS.entries()) {
    assert.equal(
      migration.version,
      index + 1,
      `migration ${migration.name} must be version ${index + 1}`,
    );
    assert.ok(migration.name.trim() !== "", "every migration is named");
    assert.ok(
      migration.sql.trim().length > 0,
      `migration ${migration.name} has SQL`,
    );
  }
  assert.equal(
    LATEST_SCHEMA_VERSION,
    MIGRATIONS[MIGRATIONS.length - 1]!.version,
    "LATEST_SCHEMA_VERSION tracks the newest migration",
  );
  assert.equal(
    new Set(MIGRATIONS.map((migration) => migration.name)).size,
    MIGRATIONS.length,
    "migration names are unique",
  );
});

test("reset/force truncation covers usage and audit but keeps api_tokens", () => {
  const tables = RESET_TRUNCATE_TABLES as readonly string[];
  for (const table of [
    "conversations",
    "usage_events",
    "audit_events",
    "quota_state",
    "quota_reservations",
  ]) {
    assert.ok(tables.includes(table), `${table} is truncated by --force`);
  }
  assert.ok(
    !tables.includes("api_tokens"),
    "api_tokens stays: tenant tokens are provisioning credentials",
  );
});

test("quota budget and pricing config parse from the environment", () => {
  const config = loadConfig({
    RIBBHU_RUN_TOKEN_BUDGET: "1234",
    RIBBHU_RUN_COST_MICROS: "500",
    RIBBHU_MODEL_PRICING:
      '{"demo/ribhu-demo":{"inputMicrosPer1k":100,"outputMicrosPer1k":200}}',
    RIBBHU_MIGRATE_ONLY: "1",
  } as NodeJS.ProcessEnv);
  assert.equal(config.runTokenBudget, 1234);
  assert.equal(config.runCostMicros, 500);
  assert.deepEqual(config.modelPricing, {
    "demo/ribhu-demo": { inputMicrosPer1k: 100, outputMicrosPer1k: 200 },
  });
  assert.equal(config.migrateOnly, true);

  const defaults = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(defaults.runTokenBudget, 200_000);
  assert.equal(defaults.runCostMicros, 0);
  assert.equal(defaults.migrateOnly, false);

  assert.throws(
    () =>
      loadConfig({
        RIBBHU_MODEL_PRICING: '{"not-a-model-key": 100}',
      } as NodeJS.ProcessEnv),
    /provider\/model/,
  );
  assert.throws(
    () =>
      loadConfig({
        RIBBHU_MODEL_PRICING: '{"demo/ribhu-demo": {"inputMicrosPer1k": -1, "outputMicrosPer1k": 2}}',
      } as NodeJS.ProcessEnv),
    /non-negative/,
  );
  assert.throws(
    () =>
      loadConfig({ RIBBHU_RUN_TOKEN_BUDGET: "-5" } as NodeJS.ProcessEnv),
    /non-negative integer/,
  );
});

test("RIBBHU_MIGRATE_ONLY=1 applies the local schema and exits without serving", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-migrate-only-"));
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/server/src/index.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RIBBHU_MIGRATE_ONLY: "1",
          RIBBHU_STORAGE: "sqlite",
          RIBBHU_DATA_DIR: dir,
          RIBBHU_WORKSPACE: join(dir, "workspace"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
    });
    assert.equal(code, 0, `migrate-only exits cleanly: ${stderr}`);
    assert.match(stdout, /migrate\s+SQLite journal schema is up to date/);

    // The journal schema (including the quota tables) exists after the run.
    const db = new Db(join(dir, "ribhu.sqlite"));
    try {
      const tables = db.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const names = new Set(tables.map((table) => table.name));
      for (const table of [
        "conversations",
        "usage_events",
        "audit_events",
        "quota_state",
        "quota_reservations",
      ]) {
        assert.ok(names.has(table), `${table} exists after migrate-only`);
      }
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
