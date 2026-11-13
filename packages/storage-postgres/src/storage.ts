import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";

import type {
  Awaitable,
  ConversationSummary,
  ConversationView,
  EntryRecord,
  JsonObject,
  ModelMessage,
  QueueJob,
  SettingPair,
  SubmissionRow,
  SubmissionStatus,
  Storage,
  ToolTaskRow,
  ToolTaskStatus,
} from "@ribhu-voyager/engine";

import { MIGRATIONS } from "./migrations.js";

const now = () => Date.now();
const n = (value: unknown): number => Number(value);

type SubRow = SubmissionRow;

function submission(row: Record<string, unknown>): SubRow {
  return {
    id: n(row.id),
    conversation_id: n(row.conversation_id),
    request_id: String(row.request_id),
    content: String(row.content),
    status: String(row.status) as SubmissionRow["status"],
    when_busy: String(row.when_busy ?? "steer"),
    answer_entry_id: row.answer_entry_id === null ? null : n(row.answer_entry_id),
    error: row.error === null ? null : String(row.error),
    created_at: n(row.created_at),
    updated_at: n(row.updated_at),
  };
}

function entry(row: Record<string, unknown>): EntryRecord {
  return {
    id: n(row.id),
    conversationId: n(row.conversation_id),
    kind: String(row.kind),
    ...(row.model ? { model: row.model as ModelMessage[] } : {}),
    ...(row.data ? { data: row.data as EntryRecord["data"] } : {}),
    ...(row.by_task_id ? { byTaskId: n(row.by_task_id) } : {}),
  };
}

/**
 * Hosted StorageV2 adapter. Async by design; the local engine still uses the
 * synchronous SQLite port. This is the foundation for the worker pool.
 */
export class PostgresStorage implements Storage {
  readonly pool: Pool;
  readonly tenantId: string;
  private readonly txContext = new AsyncLocalStorage<PoolClient>();

  constructor(connectionString: string, tenantId = "default") {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
      throw new Error("tenant id must be 1-64 alphanumeric, dash, or underscore");
    }
    this.tenantId = tenantId;
    this.pool = new Pool({
      connectionString,
      options: `-c app.tenant_id=${tenantId}`,
    });
  }

  private db(): Pool | PoolClient {
    return this.txContext.getStore() ?? this.pool;
  }

  async tx<T>(fn: () => Awaitable<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.txContext.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async init(): Promise<void> {
    const lock = await this.pool.connect();
    await lock.query("SELECT pg_advisory_lock(727274)");
    try {
      await this.migrate();
    } finally {
      await lock
        .query("SELECT pg_advisory_unlock(727274)")
        .catch(() => undefined);
      lock.release();
    }
    await this.pool.query(
      `INSERT INTO tenants(id, name, created_at) VALUES($1, $1, $2)
       ON CONFLICT(id) DO NOTHING`,
      [this.tenantId, now()],
    );
    const role = await this.pool.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    if (role.rows[0]?.rolsuper || role.rows[0]?.rolbypassrls) {
      const warning =
        "Postgres role is SUPERUSER or BYPASSRLS; tenant RLS is bypassed. " +
        "Use a NOSUPERUSER NOBYPASSRLS app role.";
      if (process.env.RIBBHU_STRICT_RLS === "1") throw new Error(warning);
      console.warn(`  storage   ${warning}`);
    }
  }

  private async migrate(): Promise<void> {
    const existing = await this.pool.query(
      "SELECT to_regclass('public.schema_migrations') AS name",
    );
    if (existing.rows[0]?.name === null) {
      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           name TEXT NOT NULL,
           applied_at BIGINT NOT NULL
         )`,
      );
    }
    const applied = await this.pool.query(
      "SELECT version FROM schema_migrations",
    );
    const versions = new Set(applied.rows.map((row) => Number(row.version)));
    for (const migration of MIGRATIONS) {
      if (versions.has(migration.version)) continue;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES($1, $2, $3)",
          [migration.version, migration.name, now()],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async bump(
    client: PoolClient | Pool,
    conversationId: number,
  ): Promise<void> {
    await client.query(
      "UPDATE conversations SET version = version + 1, updated_at = $1 WHERE id = $2",
      [now(), conversationId],
    );
  }

  async ensureRoot(): Promise<number> {
    return this.tx(async () => {
      await this.db().query("SELECT pg_advisory_xact_lock(727275)");
      const existing = await this.db().query(
        "SELECT id FROM conversations ORDER BY id ASC LIMIT 1",
      );
      if (existing.rows[0]) return n(existing.rows[0].id);
      const created = await this.db().query(
        `INSERT INTO conversations(version, title, tenant_id, created_at, updated_at)
         VALUES(0, 'Ribhu Voyager', $1, $2, $2) RETURNING id`,
        [this.tenantId, now()],
      );
      return n(created.rows[0].id);
    });
  }

  async createConversation(title = "New conversation"): Promise<number> {
    const created = await this.db().query(
      `INSERT INTO conversations(version, title, tenant_id, created_at, updated_at)
       VALUES(0, $1, $2, $3, $3) RETURNING id`,
      [title, this.tenantId, now()],
    );
    return n(created.rows[0].id);
  }

  async version(id: number): Promise<number> {
    const result = await this.db().query(
      "SELECT version FROM conversations WHERE id = $1",
      [id],
    );
    return result.rows[0] ? n(result.rows[0].version) : 0;
  }

  async conversationExists(id: number): Promise<boolean> {
    const result = await this.db().query(
      "SELECT 1 FROM conversations WHERE id = $1",
      [id],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async listConversations(
    includeArchived = false,
  ): Promise<ConversationSummary[]> {
    const result = await this.db().query(
      `SELECT id, title, parent_id, fork_entry_id, archived_at, created_at, updated_at
       FROM conversations
       ${includeArchived ? "" : "WHERE archived_at IS NULL"}
       ORDER BY updated_at DESC, id DESC`,
    );
    return result.rows.map((row) => ({
      id: n(row.id),
      title: String(row.title),
      createdAt: n(row.created_at),
      updatedAt: n(row.updated_at),
      ...(row.parent_id !== null ? { parentId: n(row.parent_id) } : {}),
      ...(row.fork_entry_id !== null ? { forkEntryId: n(row.fork_entry_id) } : {}),
      ...(row.archived_at !== null ? { archivedAt: n(row.archived_at) } : {}),
    }));
  }

  async renameConversation(id: number, title: string): Promise<void> {
    await this.db().query(
      "UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3",
      [title.trim().slice(0, 120), now(), id],
    );
  }

  async archiveConversation(id: number, archived: boolean): Promise<void> {
    await this.db().query(
      "UPDATE conversations SET archived_at = $1, updated_at = $2 WHERE id = $3",
      [archived ? now() : null, now(), id],
    );
  }

  async lastEntry(conversationId: number): Promise<EntryRecord | undefined> {
    const result = await this.db().query(
      `SELECT id, conversation_id, kind, model, data, by_task_id
       FROM entries WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`,
      [conversationId],
    );
    return result.rows[0] ? entry(result.rows[0]) : undefined;
  }

  async lastEntryOfKind(
    conversationId: number,
    kind: string,
  ): Promise<EntryRecord | undefined> {
    const result = await this.db().query(
      `SELECT id, conversation_id, kind, model, data, by_task_id
       FROM entries WHERE conversation_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1`,
      [conversationId, kind],
    );
    return result.rows[0] ? entry(result.rows[0]) : undefined;
  }

  async forkConversation(
    parentId: number,
    atEntryId?: number,
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const parent = await client.query(
        "SELECT id, title FROM conversations WHERE id = $1",
        [parentId],
      );
      if (!parent.rows[0]) throw new Error(`Unknown conversation ${parentId}`);
      const last = atEntryId ?? null;
      const cutoff =
        last ??
        n(
          (
            await client.query(
              "SELECT COALESCE(MAX(id), 0) AS id FROM entries WHERE conversation_id = $1",
              [parentId],
            )
          ).rows[0].id,
        );
      const child = await client.query(
        `INSERT INTO conversations(
           version, title, parent_id, fork_entry_id, tenant_id, created_at, updated_at
         ) VALUES(0, $1, $2, $3, $4, $5, $5) RETURNING id`,
        [
          `Fork of ${parent.rows[0].title}`,
          parentId,
          cutoff,
          this.tenantId,
          now(),
        ],
      );
      const childId = n(child.rows[0].id);
      await client.query(
        `INSERT INTO entries(conversation_id, kind, model, data, by_task_id, tenant_id, created_at)
         SELECT $1, kind, model, data, by_task_id, $2, created_at
         FROM entries WHERE conversation_id = $3 AND id <= $4 ORDER BY id`,
        [childId, this.tenantId, parentId, cutoff],
      );
      await client.query(
        `INSERT INTO docs(conversation_id, kind, value, tenant_id)
         SELECT $1, kind, value, $2 FROM docs
         WHERE conversation_id = $3 AND kind = 'pi.agent'`,
        [childId, this.tenantId, parentId],
      );
      await client.query(
        `INSERT INTO docs(conversation_id, kind, value, tenant_id)
         VALUES($1, 'pi.usage', '{"input":0,"output":0,"totalTokens":0}'::jsonb, $2)
         ON CONFLICT(conversation_id, kind) DO NOTHING`,
        [childId, this.tenantId],
      );
      await this.bump(client, childId);
      await client.query("COMMIT");
      return childId;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async searchConversations(
    query: string,
    limit = 20,
  ): Promise<Array<ConversationSummary & { snippet?: string }>> {
    const text = query.trim();
    if (text === "") return [];
    const like = `%${text}%`;
    const result = await this.pool.query(
      `SELECT c.id, c.title, c.parent_id, c.fork_entry_id, c.archived_at,
              c.created_at, c.updated_at,
              (SELECT ts_headline(
                        'simple', COALESCE(e.model::text, ''),
                        plainto_tsquery('simple', $2),
                        'MaxWords=24, MinWords=5'
                      )
               FROM entries e
               WHERE e.conversation_id = c.id
                 AND e.search @@ plainto_tsquery('simple', $2)
               ORDER BY e.id DESC LIMIT 1) AS snippet
       FROM conversations c
       WHERE c.archived_at IS NULL AND (
         c.title ILIKE $1 OR EXISTS (
           SELECT 1 FROM entries e
           WHERE e.conversation_id = c.id
             AND e.search @@ plainto_tsquery('simple', $2)
         )
       )
       ORDER BY c.updated_at DESC LIMIT $3`,
      [like, text, limit],
    );
    return result.rows.map((row) => {
      const summary: ConversationSummary & { snippet?: string } = {
        id: n(row.id),
        title: String(row.title),
        createdAt: n(row.created_at),
        updatedAt: n(row.updated_at),
        ...(row.parent_id !== null ? { parentId: n(row.parent_id) } : {}),
        ...(row.fork_entry_id !== null ? { forkEntryId: n(row.fork_entry_id) } : {}),
      };
      if (row.snippet) summary.snippet = String(row.snippet);
      return summary;
    });
  }

  async entries(
    conversationId: number,
    limit = 100,
  ): Promise<{ entries: EntryRecord[]; before?: number }> {
    const result = await this.db().query(
      `SELECT * FROM (
         SELECT id, conversation_id, kind, model, data, by_task_id
         FROM entries WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2
       ) recent ORDER BY id ASC`,
      [conversationId, limit],
    );
    return { entries: result.rows.map(entry) };
  }

  async docs(conversationId: number): Promise<Record<string, JsonObject>> {
    const result = await this.db().query(
      "SELECT kind, value FROM docs WHERE conversation_id = $1",
      [conversationId],
    );
    const docs: Record<string, JsonObject> = {};
    for (const row of result.rows) docs[String(row.kind)] = row.value as JsonObject;
    return docs;
  }

  async view(conversationId: number, limit = 100): Promise<ConversationView> {
    const { entries: list } = await this.entries(conversationId, limit);
    return {
      conversation: { id: conversationId },
      entries: list,
      docs: await this.docs(conversationId),
    };
  }

  async appendEntry(entryRow: Omit<EntryRecord, "id">): Promise<number> {
    const result = await this.db().query(
      `INSERT INTO entries(conversation_id, kind, model, data, by_task_id, tenant_id, created_at)
       VALUES($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7) RETURNING id`,
      [
        entryRow.conversationId,
        entryRow.kind,
        entryRow.model ? JSON.stringify(entryRow.model) : null,
        entryRow.data ? JSON.stringify(entryRow.data) : null,
        entryRow.byTaskId ?? null,
        this.tenantId,
        now(),
      ],
    );
    await this.bump(this.db(), entryRow.conversationId);
    return n(result.rows[0].id);
  }

  async putDoc(
    conversationId: number,
    kind: string,
    value: JsonObject,
  ): Promise<void> {
    await this.db().query(
      `INSERT INTO docs(conversation_id, kind, value, tenant_id)
       VALUES($1, $2, $3::jsonb, $4)
       ON CONFLICT(conversation_id, kind) DO UPDATE
       SET value = excluded.value, tenant_id = excluded.tenant_id`,
      [conversationId, kind, JSON.stringify(value), this.tenantId],
    );
    await this.bump(this.db(), conversationId);
  }

  async createSubmission(
    conversationId: number,
    requestId: string,
    content: string,
    whenBusy = "steer",
  ): Promise<SubmissionRow> {
    const result = await this.db().query(
      `INSERT INTO submissions(
         conversation_id, request_id, content, status, when_busy, tenant_id, created_at, updated_at
       ) VALUES($1, $2, $3, 'queued', $4, $5, $6, $6) RETURNING *`,
      [conversationId, requestId, content, whenBusy, this.tenantId, now()],
    );
    await this.bump(this.db(), conversationId);
    return submission(result.rows[0]);
  }

  async findSubmission(
    conversationId: number,
    requestId: string,
  ): Promise<SubmissionRow | undefined> {
    const result = await this.db().query(
      "SELECT * FROM submissions WHERE conversation_id = $1 AND request_id = $2",
      [conversationId, requestId],
    );
    return result.rows[0] ? submission(result.rows[0]) : undefined;
  }

  async admitSubmission(
    conversationId: number,
    requestId: string,
    content: string,
    whenBusy = "steer",
  ): Promise<SubmissionRow> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO submissions(
           conversation_id, request_id, content, status, when_busy, tenant_id, created_at, updated_at
         ) VALUES($1, $2, $3, 'queued', $4, $5, $6, $6)
         ON CONFLICT(conversation_id, request_id) DO NOTHING
         RETURNING *`,
        [conversationId, requestId, content, whenBusy, this.tenantId, now()],
      );
      if (inserted.rows[0]) {
        const row = submission(inserted.rows[0]);
        await client.query(
          `INSERT INTO entries(conversation_id, kind, model, data, tenant_id, created_at)
           VALUES($1, 'pi.user', $2::jsonb, $3::jsonb, $4, $5)`,
          [
            conversationId,
            JSON.stringify([
              { role: "user", content, timestamp: now() },
            ]),
            JSON.stringify({ submissionId: row.id }),
            this.tenantId,
            now(),
          ],
        );
        await client.query(
          `INSERT INTO jobs(conversation_id, kind, status, tenant_id, created_at, updated_at)
           SELECT $1, 'run', 'pending', $2, $3, $3
           WHERE NOT EXISTS (
             SELECT 1 FROM jobs
             WHERE conversation_id = $1 AND kind = 'run' AND status IN ('pending','running')
           )`,
          [conversationId, this.tenantId, now()],
        );
        await this.bump(client, conversationId);
        await client.query("COMMIT");
        return row;
      }
      const existing = await client.query(
        "SELECT * FROM submissions WHERE conversation_id = $1 AND request_id = $2",
        [conversationId, requestId],
      );
      await client.query("COMMIT");
      return submission(existing.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateSubmission(
    id: number,
    status: SubmissionStatus,
    options: { answerEntryId?: number; error?: string } = {},
  ): Promise<void> {
    await this.db().query(
      `UPDATE submissions SET status = $1, answer_entry_id = $2, error = $3, updated_at = $4
       WHERE id = $5 AND status NOT IN ('done','failed','aborted')`,
      [status, options.answerEntryId ?? null, options.error ?? null, now(), id],
    );
  }

  async settleSubmissionIds(
    ids: number[],
    status: SubmissionStatus,
    options: { answerEntryId?: number; error?: string } = {},
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.db().query(
      `UPDATE submissions SET status = $1,
         answer_entry_id = COALESCE($2, answer_entry_id), error = $3, updated_at = $4
       WHERE id = ANY($5::int[]) AND status NOT IN ('done','failed','aborted')`,
      [status, options.answerEntryId ?? null, options.error ?? null, now(), ids],
    );
  }

  async queuedSubmissions(conversationId: number): Promise<SubmissionRow[]> {
    const result = await this.db().query(
      `SELECT * FROM submissions
       WHERE conversation_id = $1 AND status IN ('queued','running') ORDER BY id ASC`,
      [conversationId],
    );
    return result.rows.map(submission);
  }

  async busy(conversationId: number): Promise<boolean> {
    const result = await this.db().query(
      `SELECT 1 FROM submissions
       WHERE conversation_id = $1 AND status IN ('queued','running')
       UNION ALL
       SELECT 1 FROM tool_tasks
       WHERE conversation_id = $1 AND status = 'running'
       LIMIT 1`,
      [conversationId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async enqueueRun(conversationId: number): Promise<void> {
    await this.db().query(
      `INSERT INTO jobs(conversation_id, kind, status, tenant_id, created_at, updated_at)
       SELECT $1, 'run', 'pending', $2, $3, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM jobs
         WHERE conversation_id = $1 AND kind = 'run' AND status IN ('pending','running')
       )`,
      [conversationId, this.tenantId, now()],
    );
  }

  async enqueueCompact(conversationId: number): Promise<void> {
    await this.db().query(
      `INSERT INTO jobs(conversation_id, kind, status, tenant_id, created_at, updated_at)
       SELECT $1, 'compact', 'pending', $2, $3, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM jobs
         WHERE conversation_id = $1 AND kind = 'compact' AND status IN ('pending','running')
       )`,
      [conversationId, this.tenantId, now()],
    );
  }

  async claimRun(owner: string, leaseMs: number): Promise<QueueJob | undefined> {
    const timestamp = now();
    const leaseUntil = timestamp + leaseMs;
    const result = await this.db().query(
      `UPDATE jobs SET status = 'running', owner = $1, lease_until = $2,
         fence = fence + 1, updated_at = $3
       WHERE id = (
         SELECT j.id FROM jobs j
         WHERE (j.status = 'pending' OR (j.status = 'running' AND j.lease_until < $3))
           AND NOT EXISTS (
             SELECT 1 FROM jobs other
             WHERE other.conversation_id = j.conversation_id
               AND other.status = 'running' AND other.id <> j.id
           )
         ORDER BY j.id ASC FOR UPDATE SKIP LOCKED LIMIT 1
       ) RETURNING *`,
      [owner, leaseUntil, timestamp],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: n(row.id),
      conversation_id: n(row.conversation_id),
      kind: String(row.kind) as QueueJob["kind"],
      status: "running",
      fence: n(row.fence),
      owner: String(row.owner),
      lease_until: n(row.lease_until),
      created_at: n(row.created_at),
      updated_at: n(row.updated_at),
    };
  }

  async renewRun(
    jobId: number,
    owner: string,
    leaseMs: number,
    fence?: number,
  ): Promise<boolean> {
    const result = await this.db().query(
      `UPDATE jobs SET lease_until = $1, updated_at = $2
       WHERE id = $3 AND owner = $4 AND status = 'running'
         ${fence === undefined ? "" : "AND fence = $5"} RETURNING id`,
      fence === undefined
        ? [now() + leaseMs, now(), jobId, owner]
        : [now() + leaseMs, now(), jobId, owner, fence],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async finishRun(jobId: number, owner: string): Promise<void> {
    await this.db().query("DELETE FROM jobs WHERE id = $1 AND owner = $2", [
      jobId,
      owner,
    ]);
  }

  async jobOwned(
    jobId: number,
    owner: string,
    fence?: number,
  ): Promise<boolean> {
    const result = await this.db().query(
      `SELECT 1 FROM jobs
       WHERE id = $1 AND owner = $2 AND status = 'running' AND lease_until > $3
         ${fence === undefined ? "" : "AND fence = $4"}`,
      fence === undefined
        ? [jobId, owner, now()]
        : [jobId, owner, now(), fence],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async conversationIdsWithOpenWork(): Promise<number[]> {
    const result = await this.db().query(
      `SELECT DISTINCT conversation_id FROM submissions
       WHERE status IN ('queued','running')
       UNION
       SELECT DISTINCT conversation_id FROM tool_tasks
       WHERE status = 'running'`,
    );
    return result.rows.map((row) => n(row.conversation_id));
  }

  async createToolTask(
    conversationId: number,
    callId: string,
    name: string,
    args: JsonObject,
    replaySafe: boolean,
  ): Promise<ToolTaskRow> {
    const result = await this.db().query(
      `INSERT INTO tool_tasks(
         conversation_id, call_id, name, args, replay_safe, status, tenant_id, created_at, updated_at
       ) VALUES($1, $2, $3, $4::jsonb, $5, 'running', $6, $7, $7) RETURNING *`,
      [conversationId, callId, name, JSON.stringify(args), replaySafe, this.tenantId, now()],
    );
    return this.toolTask(result.rows[0]);
  }

  private toolTask(row: Record<string, unknown>): ToolTaskRow {
    return {
      id: n(row.id),
      conversation_id: n(row.conversation_id),
      call_id: String(row.call_id),
      name: String(row.name),
      args: JSON.stringify(row.args),
      replay_safe: Boolean(row.replay_safe) ? 1 : 0,
      status: String(row.status) as ToolTaskStatus,
      result: row.result === null ? null : String(row.result),
      created_at: n(row.created_at),
      updated_at: n(row.updated_at),
    };
  }

  async findToolTask(
    conversationId: number,
    callId: string,
  ): Promise<ToolTaskRow | undefined> {
    const result = await this.db().query(
      `SELECT * FROM tool_tasks
       WHERE conversation_id = $1 AND call_id = $2 ORDER BY id DESC LIMIT 1`,
      [conversationId, callId],
    );
    return result.rows[0] ? this.toolTask(result.rows[0]) : undefined;
  }

  async finishToolTask(
    id: number,
    result: string,
    status: ToolTaskStatus,
  ): Promise<void> {
    await this.db().query(
      "UPDATE tool_tasks SET result = $1, status = $2, updated_at = $3 WHERE id = $4",
      [result, status, now(), id],
    );
  }

  async runningToolTasks(conversationId?: number): Promise<ToolTaskRow[]> {
    const result =
      conversationId === undefined
        ? await this.db().query(
            "SELECT * FROM tool_tasks WHERE status = 'running' ORDER BY id",
          )
        : await this.db().query(
            "SELECT * FROM tool_tasks WHERE conversation_id = $1 AND status = 'running' ORDER BY id",
            [conversationId],
          );
    return result.rows.map((row) => this.toolTask(row));
  }

  async hasToolResult(conversationId: number, callId: string): Promise<boolean> {
    const result = await this.db().query(
      `SELECT 1 FROM entries
       WHERE conversation_id = $1 AND kind = 'pi.tool-result'
         AND model @> jsonb_build_array(jsonb_build_object('toolCallId', $2::text))
       LIMIT 1`,
      [conversationId, callId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async queueStats(): Promise<{
    pending: number;
    running: number;
    oldestPendingAgeMs: number | null;
  }> {
    const result = await this.db().query(
      "SELECT status, COUNT(*)::int AS count FROM jobs GROUP BY status",
    );
    const stats = {
      pending: 0,
      running: 0,
      oldestPendingAgeMs: null as number | null,
    };
    for (const row of result.rows) {
      if (row.status === "pending") stats.pending = n(row.count);
      if (row.status === "running") stats.running = n(row.count);
    }
    const oldest = await this.db().query(
      "SELECT MIN(created_at) AS oldest FROM jobs WHERE status = 'pending'",
    );
    if (oldest.rows[0]?.oldest !== null && oldest.rows[0]?.oldest !== undefined) {
      stats.oldestPendingAgeMs = Math.max(
        0,
        Date.now() - n(oldest.rows[0].oldest),
      );
    }
    return stats;
  }

  async getSetting(key: string): Promise<string | undefined> {
    const result = await this.db().query(
      "SELECT value FROM settings WHERE key = $1",
      [key],
    );
    return result.rows[0]?.value as string | undefined;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db().query(
      `INSERT INTO settings(tenant_id, key, value) VALUES($1, $2, $3)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
      [this.tenantId, key, value],
    );
  }

  async settingsMatching(prefix: string): Promise<SettingPair[]> {
    // Prefix match without LIKE escaping; RLS scopes rows to this tenant.
    const result = await this.db().query(
      "SELECT key, value FROM settings WHERE left(key, length($1)) = $1 ORDER BY key",
      [prefix],
    );
    return result.rows.map((row) => ({
      key: String(row.key),
      value: String(row.value),
    }));
  }

  async requestCancel(conversationId: number): Promise<void> {
    await this.db().query(
      `INSERT INTO cancels(conversation_id, requested_at, tenant_id) VALUES($1, $2, $3)
       ON CONFLICT(conversation_id) DO UPDATE SET requested_at = excluded.requested_at`,
      [conversationId, now(), this.tenantId],
    );
  }

  async isCancelRequested(conversationId: number): Promise<boolean> {
    const result = await this.db().query(
      "SELECT 1 FROM cancels WHERE conversation_id = $1",
      [conversationId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async clearCancel(conversationId: number): Promise<void> {
    await this.db().query("DELETE FROM cancels WHERE conversation_id = $1", [
      conversationId,
    ]);
  }
}
