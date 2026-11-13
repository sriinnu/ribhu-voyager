import { DatabaseSync } from "node:sqlite";

import type { PoolClient } from "pg";

import { PostgresStorage } from "./storage.js";

export type MigrationCounts = {
  conversations: number;
  entries: number;
  docs: number;
  submissions: number;
  toolTasks: number;
  settings: number;
};

/**
 * Copy an existing local SQLite journal into Postgres. Jobs are deliberately
 * not copied: the hosted queue starts empty and the worker redispatches open
 * submissions on boot.
 */
export async function migrateSqliteToPostgres(
  sqlitePath: string,
  connectionString: string,
  options: { reset?: boolean } = {},
): Promise<MigrationCounts> {
  const storage = new PostgresStorage(connectionString);
  await storage.init();
  const sqlite = new DatabaseSync(sqlitePath);
  let client: PoolClient | undefined;
  const counts: MigrationCounts = {
    conversations: 0,
    entries: 0,
    docs: 0,
    submissions: 0,
    toolTasks: 0,
    settings: 0,
  };
  try {
    client = await storage.pool.connect();
    const db = client;
    await db.query("BEGIN");
    if (options.reset === true) {
      await db.query(
        "TRUNCATE conversations, entries, docs, submissions, jobs, tool_tasks, settings, cancels RESTART IDENTITY CASCADE",
      );
    }

    const conversations = sqlite
      .prepare(
        "SELECT id, version, title, parent_id, fork_entry_id, archived_at, created_at, updated_at FROM conversations ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of conversations) {
      await db.query(
        `INSERT INTO conversations(
           id, version, title, parent_id, fork_entry_id, archived_at, created_at, updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          row.id,
          row.version ?? 0,
          row.title ?? `Conversation ${row.id}`,
          row.parent_id ?? null,
          row.fork_entry_id ?? null,
          row.archived_at ?? null,
          row.created_at,
          row.updated_at ?? row.created_at,
        ],
      );
    }
    counts.conversations = conversations.length;

    const entries = sqlite
      .prepare(
        "SELECT id, conversation_id, kind, model, data, by_task_id, created_at FROM entries ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of entries) {
      await db.query(
        `INSERT INTO entries(id, conversation_id, kind, model, data, by_task_id, created_at)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
        [
          row.id,
          row.conversation_id,
          row.kind,
          row.model ?? null,
          row.data ?? null,
          row.by_task_id ?? null,
          row.created_at,
        ],
      );
    }
    counts.entries = entries.length;

    const docs = sqlite
      .prepare("SELECT conversation_id, kind, value FROM docs")
      .all() as Array<Record<string, unknown>>;
    for (const row of docs) {
      await db.query(
        `INSERT INTO docs(conversation_id, kind, value)
         VALUES($1,$2,$3::jsonb)
         ON CONFLICT(conversation_id, kind) DO UPDATE SET value = excluded.value`,
        [row.conversation_id, row.kind, row.value],
      );
    }
    counts.docs = docs.length;

    const submissions = sqlite
      .prepare(
        `SELECT id, conversation_id, request_id, content, status, when_busy,
                answer_entry_id, error, created_at, updated_at
         FROM submissions ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of submissions) {
      await db.query(
        `INSERT INTO submissions(
           id, conversation_id, request_id, content, status, when_busy,
           answer_entry_id, error, created_at, updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          row.id,
          row.conversation_id,
          row.request_id,
          row.content,
          row.status,
          row.when_busy ?? "steer",
          row.answer_entry_id ?? null,
          row.error ?? null,
          row.created_at,
          row.updated_at,
        ],
      );
    }
    counts.submissions = submissions.length;

    const tasks = sqlite
      .prepare(
        `SELECT id, conversation_id, call_id, name, args, replay_safe, status, result,
                created_at, updated_at FROM tool_tasks ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of tasks) {
      await db.query(
        `INSERT INTO tool_tasks(
           id, conversation_id, call_id, name, args, replay_safe, status, result,
           created_at, updated_at
         ) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
        [
          row.id,
          row.conversation_id,
          row.call_id,
          row.name,
          row.args,
          Boolean(row.replay_safe),
          row.status,
          row.result ?? null,
          row.created_at,
          row.updated_at,
        ],
      );
    }
    counts.toolTasks = tasks.length;

    const settings = sqlite
      .prepare("SELECT key, value FROM settings")
      .all() as Array<{ key: string; value: string }>;
    for (const row of settings) {
      await db.query(
        `INSERT INTO settings(tenant_id, key, value) VALUES('default', $1, $2)
         ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
        [row.key, row.value],
      );
    }
    counts.settings = settings.length;

    for (const table of [
      "conversations",
      "entries",
      "submissions",
      "tool_tasks",
    ]) {
      await db.query(
        `SELECT setval(
           pg_get_serial_sequence('${table}','id'),
           COALESCE(MAX(id), 0) + 1,
           false
         ) FROM ${table}`,
      );
    }
    await db.query("COMMIT");
    return counts;
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client?.release();
    sqlite.close();
    await storage.close();
  }
}
