import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import {
  QUOTA_DAILY_TOKENS_KEY,
  QUOTA_MONTHLY_COST_KEY,
  type AuditEvent,
  type AuditEventInput,
  type Awaitable,
  type ConversationSummary,
  type ConversationView,
  type EntryRecord,
  type JsonObject,
  type ModelMessage,
  type QueueJob,
  type Quota,
  type QuotaReservation,
  type QuotaReservationInput,
  type SettingPair,
  type Storage,
  type SubmissionRow,
  type SubmissionStatus,
  type ToolTaskRow,
  type ToolTaskStatus,
  type UsageEvent,
  type UsageEventInput,
  type UsagePeriod,
  type UsageSummary,
  type WriteGuard,
} from "@ribhu-voyager/engine";
import { QuotaExceeded, StaleFence } from "@ribhu-voyager/engine";

import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { acquirePool, type PoolLease } from "./shared-pool.js";

const now = () => Date.now();
const n = (value: unknown): number => Number(value);

const DEFAULT_LIST_LIMIT = 50;

function periodStart(period: UsagePeriod): number {
  const date = new Date();
  if (period === "day") {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function limitSetting(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function utcMonth(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function quotaReservation(row: Record<string, unknown>): QuotaReservation {
  return {
    id: n(row.id),
    tenantId: String(row.tenant_id),
    conversationId: n(row.conversation_id),
    submissionId: row.submission_id === null ? null : n(row.submission_id),
    tokens: n(row.tokens),
    costMicros: n(row.cost_micros),
    day: String(row.day),
    month: String(row.month),
    status: String(row.status) as QuotaReservation["status"],
    createdAt: n(row.created_at),
    updatedAt: n(row.updated_at),
  };
}

type QuotaStateRow = {
  day: string;
  month: string;
  day_tokens: unknown;
  day_reserved_tokens: unknown;
  month_tokens: unknown;
  month_cost_micros: unknown;
  month_reserved_cost_micros: unknown;
};

function usageEvent(row: Record<string, unknown>): UsageEvent {
  return {
    id: n(row.id),
    tenantId: String(row.tenant_id),
    conversationId: row.conversation_id === null ? null : n(row.conversation_id),
    submissionId: row.submission_id === null ? null : n(row.submission_id),
    provider: String(row.provider),
    model: String(row.model),
    inputTokens: n(row.input_tokens),
    outputTokens: n(row.output_tokens),
    costMicros: n(row.cost_micros),
    createdAt: n(row.created_at),
  };
}

function auditEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: n(row.id),
    tenantId: String(row.tenant_id),
    actor: String(row.actor),
    action: String(row.action),
    target: String(row.target),
    ...(row.data ? { data: row.data as JsonObject } : {}),
    createdAt: n(row.created_at),
  };
}

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
  /** Shared pool for this connection string (also used for raw admin queries). */
  readonly pool: Pool;
  readonly tenantId: string;
  readonly connectionString: string;
  private readonly lease: PoolLease;
  private readonly txContext = new AsyncLocalStorage<PoolClient>();
  private closed = false;

  constructor(
    connectionString: string,
    tenantId = "default",
    options: { max?: number } = {},
  ) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
      throw new Error("tenant id must be 1-64 alphanumeric, dash, or underscore");
    }
    this.tenantId = tenantId;
    this.connectionString = connectionString;
    // One pool per URL per process, shared by every tenant storage instance.
    this.lease = acquirePool(connectionString, options);
    this.pool = this.lease.pool;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("PostgresStorage has been closed.");
  }

  /**
   * Run `fn` inside a transaction that has set the tenant for RLS via
   * `SET LOCAL app.tenant_id`. Nested calls join the current transaction (they
   * already have the tenant set), and every public operation goes through here
   * or `q`, so RLS is enforced even outside an explicit `tx`.
   */
  private async withTenant<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const existing = this.txContext.getStore();
    if (existing) return await fn(existing);
    this.assertOpen();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        this.tenantId,
      ]);
      const result = await this.txContext.run(client, () => fn(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Tenant-scoped single statement (joins an active transaction if any). */
  private async q<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>> {
    return await this.withTenant((client) => client.query<R>(sql, params));
  }

  /** Reject a fenced write once this worker no longer owns the job/fence. */
  private async assertFence(guard?: WriteGuard): Promise<void> {
    if (!guard) return;
    const result = await this.q(
      `SELECT 1 FROM jobs
       WHERE id = $1 AND owner = $2 AND status = 'running'
         AND lease_until > $3 AND fence = $4`,
      [guard.jobId, guard.owner, now(), guard.fence],
    );
    if ((result.rowCount ?? 0) === 0) throw new StaleFence();
  }

  /** Tenant-scoped transaction; nested calls join the active transaction. */
  async tx<T>(fn: () => Awaitable<T>): Promise<T> {
    return await this.withTenant(async () => await fn());
  }

  /**
   * Prepare the storage for use. By default this only *verifies* the schema
   * version (read-only DDL check) so app credentials never run migrations.
   * Schema-admin flows pass `{ migrate: true }` (RIBBHU_MIGRATE_ONLY / the
   * migrate:postgres CLI) to apply pending DDL under an advisory lock.
   */
  async init(options: { migrate?: boolean } = {}): Promise<void> {
    if (options.migrate === true) {
      await this.migrateSchema();
    } else {
      await this.verifySchema();
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

  /** Highest applied schema version (0 when the migrations table is absent). */
  async schemaVersion(): Promise<number> {
    const existing = await this.pool.query(
      "SELECT to_regclass('public.schema_migrations') AS name",
    );
    if (existing.rows[0]?.name === null) return 0;
    const applied = await this.pool.query(
      "SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations",
    );
    return n(applied.rows[0]?.version);
  }

  /** Fail clearly when the database schema is behind this build (no DDL). */
  async verifySchema(): Promise<void> {
    const version = await this.schemaVersion();
    if (version === LATEST_SCHEMA_VERSION) return;
    if (version > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${version} is newer than this build ` +
          `(${LATEST_SCHEMA_VERSION}). Upgrade Ribhu Voyager before starting.`,
      );
    }
    throw new Error(
      `Database schema is behind: version ${version}, expected ${LATEST_SCHEMA_VERSION}. ` +
        "Run migrations with schema-admin credentials first: " +
        "RIBBHU_MIGRATE_ONLY=1 RIBBHU_STORAGE=postgres RIBBHU_POSTGRES_URL=... npm run start:api " +
        "(or the migrate:postgres CLI). The app credential is verified read-only and never runs DDL.",
    );
  }

  /**
   * Apply pending DDL migrations under the global advisory lock. Requires
   * schema-admin credentials; the application role must not own tables.
   */
  async migrateSchema(): Promise<number> {
    const lock = await this.pool.connect();
    await lock.query("SELECT pg_advisory_lock(727274)");
    try {
      await this.applyMigrations();
      const version = await this.schemaVersion();
      if (version !== LATEST_SCHEMA_VERSION) {
        throw new Error(
          `Migration run finished at schema version ${version}, expected ${LATEST_SCHEMA_VERSION}.`,
        );
      }
      return version;
    } finally {
      await lock
        .query("SELECT pg_advisory_unlock(727274)")
        .catch(() => undefined);
      lock.release();
    }
  }

  private async applyMigrations(): Promise<void> {
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

  /**
   * Release this instance's reference to the shared pool. The pool is ended
   * only when the last tenant storage using it closes.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.lease.release();
  }

  private async bump(conversationId: number): Promise<void> {
    await this.q(
      "UPDATE conversations SET version = version + 1, updated_at = $1 WHERE id = $2",
      [now(), conversationId],
    );
  }

  async ensureRoot(): Promise<number> {
    return this.tx(async () => {
      await this.q("SELECT pg_advisory_xact_lock(727275)");
      const existing = await this.q(
        "SELECT id FROM conversations ORDER BY id ASC LIMIT 1",
      );
      if (existing.rows[0]) return n(existing.rows[0].id);
      const created = await this.q(
        `INSERT INTO conversations(version, title, tenant_id, created_at, updated_at)
         VALUES(0, 'Ribhu Voyager', $1, $2, $2) RETURNING id`,
        [this.tenantId, now()],
      );
      return n(created.rows[0].id);
    });
  }

  async createConversation(title = "New conversation"): Promise<number> {
    const created = await this.q(
      `INSERT INTO conversations(version, title, tenant_id, created_at, updated_at)
       VALUES(0, $1, $2, $3, $3) RETURNING id`,
      [title, this.tenantId, now()],
    );
    return n(created.rows[0].id);
  }

  async version(id: number): Promise<number> {
    const result = await this.q(
      "SELECT version FROM conversations WHERE id = $1",
      [id],
    );
    return result.rows[0] ? n(result.rows[0].version) : 0;
  }

  async conversationExists(id: number): Promise<boolean> {
    const result = await this.q(
      "SELECT 1 FROM conversations WHERE id = $1",
      [id],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  async listConversations(
    includeArchived = false,
  ): Promise<ConversationSummary[]> {
    const result = await this.q(
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
    await this.q(
      "UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3",
      [title.trim().slice(0, 120), now(), id],
    );
  }

  async archiveConversation(id: number, archived: boolean): Promise<void> {
    await this.q(
      "UPDATE conversations SET archived_at = $1, updated_at = $2 WHERE id = $3",
      [archived ? now() : null, now(), id],
    );
  }

  async lastEntry(conversationId: number): Promise<EntryRecord | undefined> {
    const result = await this.q(
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
    const result = await this.q(
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
    return await this.tx(async () => {
      const parent = await this.q(
        "SELECT id, title FROM conversations WHERE id = $1",
        [parentId],
      );
      if (!parent.rows[0]) throw new Error(`Unknown conversation ${parentId}`);
      const last = atEntryId ?? null;
      const cutoff =
        last ??
        n(
          (
            await this.q(
              "SELECT COALESCE(MAX(id), 0) AS id FROM entries WHERE conversation_id = $1",
              [parentId],
            )
          ).rows[0].id,
        );
      const child = await this.q(
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
      await this.q(
        `INSERT INTO entries(conversation_id, kind, model, data, by_task_id, tenant_id, created_at)
         SELECT $1, kind, model, data, by_task_id, $2, created_at
         FROM entries WHERE conversation_id = $3 AND id <= $4 ORDER BY id`,
        [childId, this.tenantId, parentId, cutoff],
      );
      await this.q(
        `INSERT INTO docs(conversation_id, kind, value, tenant_id)
         SELECT $1, kind, value, $2 FROM docs
         WHERE conversation_id = $3 AND kind = 'pi.agent'`,
        [childId, this.tenantId, parentId],
      );
      await this.q(
        `INSERT INTO docs(conversation_id, kind, value, tenant_id)
         VALUES($1, 'pi.usage', '{"input":0,"output":0,"totalTokens":0}'::jsonb, $2)
         ON CONFLICT(conversation_id, kind) DO NOTHING`,
        [childId, this.tenantId],
      );
      await this.bump(childId);
      return childId;
    });
  }

  async searchConversations(
    query: string,
    limit = 20,
  ): Promise<Array<ConversationSummary & { snippet?: string }>> {
    const text = query.trim();
    if (text === "") return [];
    const like = `%${text}%`;
    const result = await this.q(
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
    const result = await this.q(
      `SELECT * FROM (
         SELECT id, conversation_id, kind, model, data, by_task_id
         FROM entries WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2
       ) recent ORDER BY id ASC`,
      [conversationId, limit],
    );
    const entries = result.rows.map(entry);
    if (entries.length === 0) return { entries };
    const previous = await this.q(
      "SELECT id FROM entries WHERE conversation_id = $1 AND id < $2 ORDER BY id DESC LIMIT 1",
      [conversationId, entries[0]!.id],
    );
    return {
      entries,
      ...(previous.rows[0] ? { before: n(previous.rows[0].id) } : {}),
    };
  }

  async docs(conversationId: number): Promise<Record<string, JsonObject>> {
    const result = await this.q(
      "SELECT kind, value FROM docs WHERE conversation_id = $1",
      [conversationId],
    );
    const docs: Record<string, JsonObject> = {};
    for (const row of result.rows) docs[String(row.kind)] = row.value as JsonObject;
    return docs;
  }

  async view(conversationId: number, limit = 100): Promise<ConversationView> {
    // One transaction gives the client a consistent entries+docs snapshot.
    return this.tx(async () => {
      const { entries: list } = await this.entries(conversationId, limit);
      return {
        conversation: { id: conversationId },
        entries: list,
        docs: await this.docs(conversationId),
      };
    });
  }

  async appendEntry(
    entryRow: Omit<EntryRecord, "id">,
    guard?: WriteGuard,
  ): Promise<number> {
    const timestamp = now();
    const params: unknown[] = [
      entryRow.conversationId,
      entryRow.kind,
      entryRow.model ? JSON.stringify(entryRow.model) : null,
      entryRow.data ? JSON.stringify(entryRow.data) : null,
      entryRow.byTaskId ?? null,
      this.tenantId,
      timestamp,
    ];
    let sql =
      `INSERT INTO entries(conversation_id, kind, model, data, by_task_id, tenant_id, created_at)
       VALUES($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7) RETURNING id`;
    if (guard) {
      // Conditional INSERT: the row only lands while the fence still owns the
      // job, so a stale worker cannot append to the journal.
      sql =
        `INSERT INTO entries(conversation_id, kind, model, data, by_task_id, tenant_id, created_at)
         SELECT $1, $2, $3::jsonb, $4::jsonb, $5, $6, $7
         WHERE EXISTS (
           SELECT 1 FROM jobs
           WHERE id = $8 AND owner = $9 AND status = 'running'
             AND lease_until > $7 AND fence = $10
         ) RETURNING id`;
      params.push(guard.jobId, guard.owner, guard.fence);
    }
    const result = await this.q(sql, params);
    if (guard && result.rows.length === 0) throw new StaleFence();
    await this.bump(entryRow.conversationId);
    return n(result.rows[0].id);
  }

  async putDoc(
    conversationId: number,
    kind: string,
    value: JsonObject,
  ): Promise<void> {
    await this.q(
      `INSERT INTO docs(conversation_id, kind, value, tenant_id)
       VALUES($1, $2, $3::jsonb, $4)
       ON CONFLICT(conversation_id, kind) DO UPDATE
       SET value = excluded.value, tenant_id = excluded.tenant_id`,
      [conversationId, kind, JSON.stringify(value), this.tenantId],
    );
    await this.bump(conversationId);
  }

  async createSubmission(
    conversationId: number,
    requestId: string,
    content: string,
    whenBusy = "steer",
  ): Promise<SubmissionRow> {
    const result = await this.q(
      `INSERT INTO submissions(
         conversation_id, request_id, content, status, when_busy, tenant_id, created_at, updated_at
       ) VALUES($1, $2, $3, 'queued', $4, $5, $6, $6) RETURNING *`,
      [conversationId, requestId, content, whenBusy, this.tenantId, now()],
    );
    await this.bump(conversationId);
    return submission(result.rows[0]);
  }

  async findSubmission(
    conversationId: number,
    requestId: string,
  ): Promise<SubmissionRow | undefined> {
    const result = await this.q(
      "SELECT * FROM submissions WHERE conversation_id = $1 AND request_id = $2",
      [conversationId, requestId],
    );
    return result.rows[0] ? submission(result.rows[0]) : undefined;
  }

  /**
   * Legacy direct admission helper used by the storage-level tests/CLI. Server
   * admission goes through the engine's `admitSubmission`; both rely on the
   * tenant-scoped transaction wrapper for RLS.
   */
  async admitSubmission(
    conversationId: number,
    requestId: string,
    content: string,
    whenBusy = "steer",
  ): Promise<SubmissionRow> {
    return await this.tx(async () => {
      const inserted = await this.q(
        `INSERT INTO submissions(
           conversation_id, request_id, content, status, when_busy, tenant_id, created_at, updated_at
         ) VALUES($1, $2, $3, 'queued', $4, $5, $6, $6)
         ON CONFLICT(conversation_id, request_id) DO NOTHING
         RETURNING *`,
        [conversationId, requestId, content, whenBusy, this.tenantId, now()],
      );
      if (inserted.rows[0]) {
        const row = submission(inserted.rows[0]);
        await this.q(
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
        await this.q(
          `INSERT INTO jobs(conversation_id, kind, status, tenant_id, created_at, updated_at)
           SELECT $1, 'run', 'pending', $2, $3, $3
           WHERE NOT EXISTS (
             SELECT 1 FROM jobs
             WHERE conversation_id = $1 AND kind = 'run' AND status IN ('pending','running')
           )`,
          [conversationId, this.tenantId, now()],
        );
        await this.bump(conversationId);
        return row;
      }
      const existing = await this.q(
        "SELECT * FROM submissions WHERE conversation_id = $1 AND request_id = $2",
        [conversationId, requestId],
      );
      return submission(existing.rows[0]);
    });
  }

  async updateSubmission(
    id: number,
    status: SubmissionStatus,
    options: { answerEntryId?: number; error?: string } = {},
    guard?: WriteGuard,
  ): Promise<void> {
    await this.assertFence(guard);
    await this.q(
      `UPDATE submissions SET status = $1, answer_entry_id = $2, error = $3, updated_at = $4
       WHERE id = $5 AND status NOT IN ('done','failed','aborted')`,
      [status, options.answerEntryId ?? null, options.error ?? null, now(), id],
    );
  }

  async settleSubmissionIds(
    ids: number[],
    status: SubmissionStatus,
    options: { answerEntryId?: number; error?: string } = {},
    guard?: WriteGuard,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.assertFence(guard);
    await this.q(
      `UPDATE submissions SET status = $1,
         answer_entry_id = COALESCE($2, answer_entry_id), error = $3, updated_at = $4
       WHERE id = ANY($5::int[]) AND status NOT IN ('done','failed','aborted')`,
      [status, options.answerEntryId ?? null, options.error ?? null, now(), ids],
    );
  }

  async queuedSubmissions(conversationId: number): Promise<SubmissionRow[]> {
    const result = await this.q(
      `SELECT * FROM submissions
       WHERE conversation_id = $1 AND status IN ('queued','running') ORDER BY id ASC`,
      [conversationId],
    );
    return result.rows.map(submission);
  }

  async busy(conversationId: number): Promise<boolean> {
    const result = await this.q(
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
    await this.q(
      `INSERT INTO jobs(conversation_id, kind, status, tenant_id, created_at, updated_at)
       VALUES($1, 'run', 'pending', $2, $3, $3)
       ON CONFLICT DO NOTHING`,
      [conversationId, this.tenantId, now()],
    );
  }

  async enqueueCompact(conversationId: number): Promise<void> {
    await this.q(
      `INSERT INTO jobs(conversation_id, kind, status, tenant_id, created_at, updated_at)
       VALUES($1, 'compact', 'pending', $2, $3, $3)
       ON CONFLICT DO NOTHING`,
      [conversationId, this.tenantId, now()],
    );
  }

  async claimRun(owner: string, leaseMs: number): Promise<QueueJob | undefined> {
    // One claim transaction: pick a candidate, take a per-conversation advisory
    // xact lock, then re-check and update. The lock serializes claims for one
    // conversation across workers, so two workers can never claim two active
    // jobs for the same conversation; the partial unique indexes are the
    // durable backstop.
    return await this.tx(async () => {
      const timestamp = now();
      const leaseUntil = timestamp + leaseMs;
      const candidate = await this.q(
        `SELECT j.id, j.conversation_id FROM jobs j
         WHERE (j.status = 'pending' OR (j.status = 'running' AND j.lease_until < $1))
           AND NOT EXISTS (
             SELECT 1 FROM jobs other
             WHERE other.conversation_id = j.conversation_id
               AND other.status = 'running' AND other.id <> j.id
           )
         ORDER BY j.id ASC LIMIT 1`,
        [timestamp],
      );
      const row = candidate.rows[0];
      if (!row) return undefined;
      await this.q("SELECT pg_advisory_xact_lock(727274, $1)", [
        n(row.conversation_id),
      ]);
      const result = await this.q(
        `UPDATE jobs AS j SET status = 'running', owner = $1, lease_until = $2,
           fence = j.fence + 1, updated_at = $3
         WHERE j.id = $4
           AND (j.status = 'pending' OR (j.status = 'running' AND j.lease_until < $3))
           AND NOT EXISTS (
             SELECT 1 FROM jobs other
             WHERE other.conversation_id = j.conversation_id
               AND other.status = 'running' AND other.id <> j.id
           )
         RETURNING *`,
        [owner, leaseUntil, timestamp, n(row.id)],
      );
      const claimed = result.rows[0];
      if (!claimed) return undefined;
      return {
        id: n(claimed.id),
        conversation_id: n(claimed.conversation_id),
        kind: String(claimed.kind) as QueueJob["kind"],
        status: "running",
        fence: n(claimed.fence),
        owner: String(claimed.owner),
        lease_until: n(claimed.lease_until),
        created_at: n(claimed.created_at),
        updated_at: n(claimed.updated_at),
      };
    });
  }

  async renewRun(
    jobId: number,
    owner: string,
    leaseMs: number,
    fence?: number,
  ): Promise<boolean> {
    const result = await this.q(
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
    await this.q("DELETE FROM jobs WHERE id = $1 AND owner = $2", [
      jobId,
      owner,
    ]);
  }

  async jobOwned(
    jobId: number,
    owner: string,
    fence?: number,
  ): Promise<boolean> {
    const result = await this.q(
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
    const result = await this.q(
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
    guard?: WriteGuard,
  ): Promise<ToolTaskRow> {
    const timestamp = now();
    const params: unknown[] = [
      conversationId,
      callId,
      name,
      JSON.stringify(args),
      replaySafe,
      this.tenantId,
      timestamp,
    ];
    let sql =
      `INSERT INTO tool_tasks(
         conversation_id, call_id, name, args, replay_safe, status, tenant_id, created_at, updated_at
       ) VALUES($1, $2, $3, $4::jsonb, $5, 'running', $6, $7, $7) RETURNING *`;
    if (guard) {
      sql =
        `INSERT INTO tool_tasks(
           conversation_id, call_id, name, args, replay_safe, status, tenant_id, created_at, updated_at
         )
         SELECT $1, $2, $3, $4::jsonb, $5, 'running', $6, $7, $7
         WHERE EXISTS (
           SELECT 1 FROM jobs
           WHERE id = $8 AND owner = $9 AND status = 'running'
             AND lease_until > $7 AND fence = $10
         ) RETURNING *`;
      params.push(guard.jobId, guard.owner, guard.fence);
    }
    const result = await this.q(sql, params);
    if (guard && result.rows.length === 0) throw new StaleFence();
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
    const result = await this.q(
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
    guard?: WriteGuard,
  ): Promise<void> {
    const timestamp = now();
    if (guard) {
      const updated = await this.q(
        `UPDATE tool_tasks SET result = $1, status = $2, updated_at = $3
         WHERE id = $4 AND EXISTS (
           SELECT 1 FROM jobs
           WHERE id = $5 AND owner = $6 AND status = 'running'
             AND lease_until > $3 AND fence = $7
         ) RETURNING id`,
        [result, status, timestamp, id, guard.jobId, guard.owner, guard.fence],
      );
      if ((updated.rowCount ?? 0) === 0) throw new StaleFence();
      return;
    }
    await this.q(
      "UPDATE tool_tasks SET result = $1, status = $2, updated_at = $3 WHERE id = $4",
      [result, status, timestamp, id],
    );
  }

  async runningToolTasks(conversationId?: number): Promise<ToolTaskRow[]> {
    const result =
      conversationId === undefined
        ? await this.q(
            "SELECT * FROM tool_tasks WHERE status = 'running' ORDER BY id",
          )
        : await this.q(
            "SELECT * FROM tool_tasks WHERE conversation_id = $1 AND status = 'running' ORDER BY id",
            [conversationId],
          );
    return result.rows.map((row) => this.toolTask(row));
  }

  async hasToolResult(conversationId: number, callId: string): Promise<boolean> {
    const result = await this.q(
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
    const result = await this.q(
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
    const oldest = await this.q(
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
    const result = await this.q(
      "SELECT value FROM settings WHERE key = $1",
      [key],
    );
    return result.rows[0]?.value as string | undefined;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.q(
      `INSERT INTO settings(tenant_id, key, value) VALUES($1, $2, $3)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
      [this.tenantId, key, value],
    );
  }

  async settingsMatching(prefix: string): Promise<SettingPair[]> {
    // Prefix match without LIKE escaping; RLS scopes rows to this tenant.
    const result = await this.q(
      "SELECT key, value FROM settings WHERE left(key, length($1)) = $1 ORDER BY key",
      [prefix],
    );
    return result.rows.map((row) => ({
      key: String(row.key),
      value: String(row.value),
    }));
  }

  async recordUsage(event: UsageEventInput): Promise<void> {
    const inputTokens = Math.max(0, Math.trunc(event.inputTokens));
    const outputTokens = Math.max(0, Math.trunc(event.outputTokens));
    const costMicros = Math.max(0, Math.trunc(event.costMicros ?? 0));
    const createdAt = event.createdAt ?? now();
    await this.q(
      `INSERT INTO usage_events(tenant_id, conversation_id, submission_id, provider, model,
                                 input_tokens, output_tokens, cost_micros, created_at)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        this.tenantId,
        event.conversationId ?? null,
        event.submissionId ?? null,
        event.provider,
        event.model,
        inputTokens,
        outputTokens,
        costMicros,
        createdAt,
      ],
    );
    // Keep the row-locked quota counters in step with the usage journal.
    await this.quotaState(createdAt);
    await this.q(
      `UPDATE quota_state
       SET day_tokens = day_tokens + $1,
           month_tokens = month_tokens + $1,
           month_cost_micros = month_cost_micros + $2
       WHERE tenant_id = $3`,
      [inputTokens + outputTokens, costMicros, this.tenantId],
    );
  }

  async usageSummary(period: UsagePeriod): Promise<UsageSummary> {
    const since = periodStart(period);
    const result = await this.q(
      `SELECT COUNT(*)::int AS events,
              COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(cost_micros), 0) AS cost
       FROM usage_events WHERE tenant_id = $1 AND created_at >= $2`,
      [this.tenantId, since],
    );
    const row = result.rows[0] ?? {};
    const inputTokens = n(row.input);
    const outputTokens = n(row.output);
    return {
      period,
      since,
      events: n(row.events),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costMicros: n(row.cost),
    };
  }

  async listUsage(limit = DEFAULT_LIST_LIMIT): Promise<UsageEvent[]> {
    const result = await this.q(
      `SELECT id, tenant_id, conversation_id, submission_id, provider, model,
              input_tokens, output_tokens, cost_micros, created_at
       FROM usage_events WHERE tenant_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [this.tenantId, Math.max(1, Math.trunc(limit))],
    );
    return result.rows.map(usageEvent);
  }

  async recordAudit(event: AuditEventInput): Promise<void> {
    await this.q(
      `INSERT INTO audit_events(tenant_id, actor, action, target, data, created_at)
       VALUES($1, $2, $3, $4, $5, $6)`,
      [
        this.tenantId,
        event.actor,
        event.action,
        event.target,
        event.data === undefined ? null : JSON.stringify(event.data),
        event.createdAt ?? now(),
      ],
    );
  }

  async listAudit(limit = DEFAULT_LIST_LIMIT): Promise<AuditEvent[]> {
    const result = await this.q(
      `SELECT id, tenant_id, actor, action, target, data, created_at
       FROM audit_events WHERE tenant_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [this.tenantId, Math.max(1, Math.trunc(limit))],
    );
    return result.rows.map(auditEvent);
  }

  /**
   * Retention: delete this tenant's usage events older than `cutoff` (epoch ms).
   * With `dryRun` only counts the rows. RLS keeps this tenant-scoped.
   */
  async deleteOldUsage(
    cutoff: number,
    options: { dryRun?: boolean } = {},
  ): Promise<number> {
    return this.deleteOlderThan("usage_events", cutoff, options);
  }

  /** Retention: delete this tenant's audit events older than `cutoff` (epoch ms). */
  async deleteOldAudit(
    cutoff: number,
    options: { dryRun?: boolean } = {},
  ): Promise<number> {
    return this.deleteOlderThan("audit_events", cutoff, options);
  }

  private async deleteOlderThan(
    table: "usage_events" | "audit_events",
    cutoff: number,
    options: { dryRun?: boolean },
  ): Promise<number> {
    if (!Number.isFinite(cutoff) || cutoff <= 0) {
      throw new Error("retention cutoff must be a positive epoch-ms timestamp");
    }
    if (options.dryRun === true) {
      const result = await this.q(
        `SELECT count(*)::int AS count FROM ${table} WHERE created_at < $1`,
        [cutoff],
      );
      return n(result.rows[0]?.count);
    }
    const result = await this.q(
      `WITH deleted AS (
         DELETE FROM ${table} WHERE created_at < $1 RETURNING 1
       ) SELECT count(*)::int AS count FROM deleted`,
      [cutoff],
    );
    return n(result.rows[0]?.count);
  }

  async quota(): Promise<Quota> {
    const [daily, monthly] = await Promise.all([
      this.getSetting(QUOTA_DAILY_TOKENS_KEY),
      this.getSetting(QUOTA_MONTHLY_COST_KEY),
    ]);
    return {
      dailyTokens: limitSetting(daily),
      monthlyCostMicros: limitSetting(monthly),
    };
  }

  async setQuota(next: Partial<Quota>): Promise<void> {
    if (next.dailyTokens !== undefined) {
      await this.setSetting(
        QUOTA_DAILY_TOKENS_KEY,
        next.dailyTokens === null ? "" : String(Math.max(0, Math.trunc(next.dailyTokens))),
      );
    }
    if (next.monthlyCostMicros !== undefined) {
      await this.setSetting(
        QUOTA_MONTHLY_COST_KEY,
        next.monthlyCostMicros === null
          ? ""
          : String(Math.max(0, Math.trunc(next.monthlyCostMicros))),
      );
    }
  }

  async listTenants(): Promise<string[]> {
    const result = await this.q("SELECT id FROM tenants ORDER BY id");
    return result.rows.map((row) => String(row.id));
  }

  private async inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.txContext.getStore() ? await fn() : await this.tx(fn);
  }

  /** Row-locked quota counters for the current UTC day/month. */
  private async quotaState(timestamp: number): Promise<QuotaStateRow> {
    const day = utcDay(timestamp);
    const month = utcMonth(timestamp);
    await this.q(
      `INSERT INTO quota_state(tenant_id, day, month) VALUES($1, $2, $3)
       ON CONFLICT(tenant_id) DO NOTHING`,
      [this.tenantId, day, month],
    );
    const result = await this.q(
      "SELECT * FROM quota_state WHERE tenant_id = $1 FOR UPDATE",
      [this.tenantId],
    );
    let row = result.rows[0]! as QuotaStateRow;
    if (row.day !== day) {
      await this.q(
        `UPDATE quota_state SET day = $1, day_tokens = 0, day_reserved_tokens = 0
         WHERE tenant_id = $2`,
        [day, this.tenantId],
      );
      row = { ...row, day, day_tokens: 0, day_reserved_tokens: 0 };
    }
    if (row.month !== month) {
      await this.q(
        `UPDATE quota_state
         SET month = $1, month_tokens = 0, month_cost_micros = 0, month_reserved_cost_micros = 0
         WHERE tenant_id = $2`,
        [month, this.tenantId],
      );
      row = {
        ...row,
        month,
        month_tokens: 0,
        month_cost_micros: 0,
        month_reserved_cost_micros: 0,
      };
    }
    return row;
  }

  async reserveQuota(
    request: QuotaReservationInput,
  ): Promise<QuotaReservation | undefined> {
    return await this.inTransaction(async () => {
      const quota = await this.quota();
      if (quota.dailyTokens === null && quota.monthlyCostMicros === null) {
        return undefined;
      }
      const timestamp = now();
      const state = await this.quotaState(timestamp);
      const tokens = Math.max(0, Math.trunc(request.tokens));
      const costMicros = Math.max(0, Math.trunc(request.costMicros));
      if (quota.dailyTokens !== null) {
        const total = n(state.day_tokens) + n(state.day_reserved_tokens) + tokens;
        if (total > quota.dailyTokens) {
          throw new QuotaExceeded(
            `Daily token quota exceeded: ${n(state.day_tokens)} used, ` +
              `${n(state.day_reserved_tokens)} reserved, ${tokens} requested; ` +
              `limit ${quota.dailyTokens}.`,
          );
        }
      }
      if (quota.monthlyCostMicros !== null) {
        const total =
          n(state.month_cost_micros) + n(state.month_reserved_cost_micros) + costMicros;
        if (total > quota.monthlyCostMicros) {
          throw new QuotaExceeded(
            `Monthly cost quota exceeded: ${n(state.month_cost_micros)} used, ` +
              `${n(state.month_reserved_cost_micros)} reserved, ${costMicros} requested; ` +
              `limit ${quota.monthlyCostMicros} micros.`,
          );
        }
      }
      const inserted = await this.q(
        `INSERT INTO quota_reservations(
           tenant_id, conversation_id, submission_id, tokens, cost_micros,
           day, month, status, created_at, updated_at
         ) VALUES($1, $2, $3, $4, $5, $6, $7, 'active', $8, $8) RETURNING *`,
        [
          this.tenantId,
          request.conversationId,
          request.submissionId ?? null,
          tokens,
          costMicros,
          state.day,
          state.month,
          timestamp,
        ],
      );
      await this.q(
        `UPDATE quota_state
         SET day_reserved_tokens = day_reserved_tokens + $1,
             month_reserved_cost_micros = month_reserved_cost_micros + $2
         WHERE tenant_id = $3`,
        [tokens, costMicros, this.tenantId],
      );
      return quotaReservation(inserted.rows[0]!);
    });
  }

  private async finishQuotaReservation(
    reservationId: number,
    status: "committed" | "released",
  ): Promise<void> {
    await this.inTransaction(async () => {
      const found = await this.q(
        "SELECT * FROM quota_reservations WHERE id = $1 FOR UPDATE",
        [reservationId],
      );
      const row = found.rows[0];
      if (!row || String(row.status) !== "active") return;
      const timestamp = now();
      const state = await this.quotaState(timestamp);
      const dayTokens = String(row.day) === state.day ? n(row.tokens) : 0;
      const monthCost = String(row.month) === state.month ? n(row.cost_micros) : 0;
      await this.q(
        `UPDATE quota_state
         SET day_reserved_tokens = GREATEST(0, day_reserved_tokens - $1),
             month_reserved_cost_micros = GREATEST(0, month_reserved_cost_micros - $2)
         WHERE tenant_id = $3`,
        [dayTokens, monthCost, this.tenantId],
      );
      await this.q(
        "UPDATE quota_reservations SET status = $1, updated_at = $2 WHERE id = $3 AND status = 'active'",
        [status, timestamp, reservationId],
      );
    });
  }

  async releaseQuota(reservationId: number): Promise<void> {
    await this.finishQuotaReservation(reservationId, "released");
  }

  async commitQuota(reservationId: number): Promise<void> {
    await this.finishQuotaReservation(reservationId, "committed");
  }

  async quotaReservationFor(
    submissionId: number,
  ): Promise<QuotaReservation | undefined> {
    const result = await this.q(
      "SELECT * FROM quota_reservations WHERE submission_id = $1 ORDER BY id DESC LIMIT 1",
      [submissionId],
    );
    return result.rows[0] ? quotaReservation(result.rows[0]) : undefined;
  }

  async requestCancel(conversationId: number): Promise<void> {
    await this.q(
      `INSERT INTO cancels(conversation_id, requested_at, tenant_id) VALUES($1, $2, $3)
       ON CONFLICT(conversation_id) DO UPDATE SET requested_at = excluded.requested_at`,
      [conversationId, now(), this.tenantId],
    );
  }

  async isCancelRequested(conversationId: number): Promise<boolean> {
    const result = await this.q(
      "SELECT 1 FROM cancels WHERE conversation_id = $1",
      [conversationId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async clearCancel(conversationId: number): Promise<void> {
    await this.q("DELETE FROM cancels WHERE conversation_id = $1", [
      conversationId,
    ]);
  }
}

/**
 * Create a tenant-scoped Postgres storage backed by the process-wide shared
 * pool for `connectionString`. This is the factory server processes should use
 * for API runtimes, workers and admin reads: every instance shares one
 * `pg.Pool`, and tenant RLS is applied per transaction with `SET LOCAL`.
 */
export function createSharedPostgresStorage(
  connectionString: string,
  tenantId = "default",
  options: { max?: number } = {},
): PostgresStorage {
  return new PostgresStorage(connectionString, tenantId, options);
}
