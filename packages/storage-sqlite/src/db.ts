import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  QUOTA_DAILY_TOKENS_KEY,
  QUOTA_MONTHLY_COST_KEY,
  type AuditEvent,
  type AuditEventInput,
  type Awaitable,
  type ConversationView,
  type EntryRecord,
  type Json,
  type JsonObject,
  type ModelMessage,
  type QueueJob,
  type SettingPair,
  type Storage,
  type SubmissionOptions,
  type SubmissionRow,
  type SubmissionStatus,
  type ToolTaskRow,
  type ToolTaskStatus,
  type Quota,
  type QuotaReservation,
  type QuotaReservationInput,
  type UsageEvent,
  type UsageEventInput,
  type UsagePeriod,
  type UsageSummary,
  type WriteGuard,
} from "@ribhu-voyager/engine";
import { QuotaExceeded, StaleFence } from "@ribhu-voyager/engine";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  parent_id INTEGER,
  fork_entry_id INTEGER,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  text,
  conversation_id UNINDEXED,
  entry_id UNINDEXED,
  tokenize = 'porter unicode61'
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  model TEXT,
  data TEXT,
  by_task_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_conv ON entries(conversation_id, id);
CREATE TABLE IF NOT EXISTS docs (
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (conversation_id, kind)
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  answer_entry_id INTEGER,
  error TEXT,
  when_busy TEXT NOT NULL DEFAULT 'steer',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(conversation_id, request_id)
);
CREATE INDEX IF NOT EXISTS submissions_conv ON submissions(conversation_id, status);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'run',
  fence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  owner TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, lease_until);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cancels (
  conversation_id INTEGER PRIMARY KEY,
  requested_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  args TEXT NOT NULL,
  replay_safe INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_tasks_status ON tool_tasks(status);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  conversation_id INTEGER,
  submission_id INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_tenant_time ON usage_events(tenant_id, created_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_tenant_time ON audit_events(tenant_id, created_at);
CREATE TABLE IF NOT EXISTS quota_state (
  tenant_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  day_tokens INTEGER NOT NULL DEFAULT 0,
  day_reserved_tokens INTEGER NOT NULL DEFAULT 0,
  month_tokens INTEGER NOT NULL DEFAULT 0,
  month_cost_micros INTEGER NOT NULL DEFAULT 0,
  month_reserved_cost_micros INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quota_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  conversation_id INTEGER NOT NULL,
  submission_id INTEGER,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quota_reservations_submission ON quota_reservations(submission_id);
CREATE INDEX IF NOT EXISTS quota_reservations_status ON quota_reservations(status);
`;

function parseJson<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

const DEFAULT_TENANT = "default";
const DEFAULT_LIST_LIMIT = 50;

function periodStart(period: UsagePeriod): number {
  const now = new Date();
  if (period === "day") {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function limitSetting(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

type UsageRow = {
  id: number;
  tenant_id: string;
  conversation_id: number | null;
  submission_id: number | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  created_at: number;
};

type AuditRow = {
  id: number;
  tenant_id: string;
  actor: string;
  action: string;
  target: string;
  data: string | null;
  created_at: number;
};

function usageEvent(row: UsageRow): UsageEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    submissionId: row.submission_id,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMicros: row.cost_micros,
    createdAt: row.created_at,
  };
}

type QuotaStateRow = {
  tenant_id: string;
  day: string;
  month: string;
  day_tokens: number;
  day_reserved_tokens: number;
  month_tokens: number;
  month_cost_micros: number;
  month_reserved_cost_micros: number;
};

type QuotaReservationRow = {
  id: number;
  tenant_id: string;
  conversation_id: number;
  submission_id: number | null;
  tokens: number;
  cost_micros: number;
  day: string;
  month: string;
  status: string;
  created_at: number;
  updated_at: number;
};

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function utcMonth(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function quotaReservation(row: QuotaReservationRow): QuotaReservation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    submissionId: row.submission_id,
    tokens: row.tokens,
    costMicros: row.cost_micros,
    day: row.day,
    month: row.month,
    status: row.status as QuotaReservation["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actor: row.actor,
    action: row.action,
    target: row.target,
    ...(row.data ? { data: JSON.parse(row.data) as JsonObject } : {}),
    createdAt: row.created_at,
  };
}

export class Db implements Storage {
  readonly db: DatabaseSync;
  private closed = false;
  /** True while an explicit transaction (own or serialized facade) is open. */
  private inTransaction = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES('schema', '1')")
      .run();
    this.migrate();
    this.ensureConversationColumns();
    this.ensureJobColumns();
    this.ensureJobUniqueness();
    this.ensureSearchIndex();
  }

  private entryText(model: ModelMessage[] | undefined): string {
    if (!model) return "";
    const parts: string[] = [];
    for (const message of model) {
      if (message.role === "user" || message.role === "toolResult") {
        if (typeof message.content === "string") parts.push(message.content);
        continue;
      }
      for (const block of message.content) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "toolCall") {
          parts.push(block.name, JSON.stringify(block.arguments));
        }
      }
    }
    return parts.join("\n").trim();
  }

  private indexEntry(
    entryId: number,
    conversationId: number,
    model: ModelMessage[] | undefined,
  ): void {
    const text = this.entryText(model);
    if (text === "") return;
    this.db
      .prepare(
        "INSERT INTO entries_fts(text, conversation_id, entry_id) VALUES(?, ?, ?)",
      )
      .run(text, conversationId, entryId);
  }

  private ensureSearchIndex(): void {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'fts'")
      .get() as { value: string } | undefined;
    if (row?.value === "1") return;
    this.db.prepare("DELETE FROM entries_fts").run();
    const rows = this.db
      .prepare("SELECT id, conversation_id, model FROM entries ORDER BY id")
      .all() as Array<{
      id: number;
      conversation_id: number;
      model: string | null;
    }>;
    for (const row of rows) {
      this.indexEntry(
        row.id,
        row.conversation_id,
        parseJson<ModelMessage[]>(row.model),
      );
    }
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('fts', '1')")
      .run();
  }

  private ensureJobColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "kind")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'run'");
    }
    if (!columns.some((column) => column.name === "fence")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN fence INTEGER NOT NULL DEFAULT 0");
    }
  }

  /**
   * At most one active run and one active compact per conversation, even across
   * the API/worker processes that share this SQLite file. Duplicate active jobs
   * (possible only on old journals) are collapsed to the newest one first so
   * the partial unique indexes can be created.
   */
  private ensureJobUniqueness(): void {
    this.db.exec(
      `DELETE FROM jobs
       WHERE status IN ('pending','running')
         AND id NOT IN (
           SELECT MAX(id) FROM jobs
           WHERE status IN ('pending','running')
           GROUP BY conversation_id, kind
         )`,
    );
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_run ON jobs(conversation_id) WHERE kind = 'run' AND status IN ('pending','running')",
    );
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_compact ON jobs(conversation_id) WHERE kind = 'compact' AND status IN ('pending','running')",
    );
  }

  private assertFence(guard: WriteGuard | undefined): void {
    if (!guard) return;
    if (!this.jobOwned(guard.jobId, guard.owner, guard.fence)) {
      throw new StaleFence();
    }
  }

  private ensureConversationColumns(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(conversations)")
      .all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("title")) this.db.exec("ALTER TABLE conversations ADD COLUMN title TEXT");
    if (!names.has("parent_id")) this.db.exec("ALTER TABLE conversations ADD COLUMN parent_id INTEGER");
    if (!names.has("fork_entry_id")) this.db.exec("ALTER TABLE conversations ADD COLUMN fork_entry_id INTEGER");
    if (!names.has("updated_at")) this.db.exec("ALTER TABLE conversations ADD COLUMN updated_at INTEGER");
    if (!names.has("archived_at")) this.db.exec("ALTER TABLE conversations ADD COLUMN archived_at INTEGER");
    this.db.exec("UPDATE conversations SET title = COALESCE(title, 'Conversation ' || id)");
    this.db.exec("UPDATE conversations SET updated_at = COALESCE(updated_at, created_at)");
  }

  private migrate(): void {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema'")
      .get() as { value: string } | undefined;
    if (row?.value === "2") return;

    const columns = this.db
      .prepare("PRAGMA table_info(submissions)")
      .all() as { name: string }[];
    const hasWhenBusy = columns.some((column) => column.name === "when_busy");

    this.txSync(() => {
      this.db.exec(`
        CREATE TABLE submissions_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL,
          request_id TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL,
          answer_entry_id INTEGER,
          error TEXT,
          when_busy TEXT NOT NULL DEFAULT 'steer',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(conversation_id, request_id)
        );
        INSERT INTO submissions_v2(
          id, conversation_id, request_id, content, status, answer_entry_id,
          error, when_busy, created_at, updated_at
        )
        SELECT id, conversation_id, request_id, content, status, answer_entry_id,
               error, ${hasWhenBusy ? "when_busy" : "'steer'"}, created_at, updated_at
        FROM submissions;
        DROP TABLE submissions;
        ALTER TABLE submissions_v2 RENAME TO submissions;
        CREATE INDEX IF NOT EXISTS submissions_conv ON submissions(conversation_id, status);
        INSERT OR REPLACE INTO meta(key, value) VALUES('schema', '2');
      `);
    });
  }

  private txSync<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      this.inTransaction = false;
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      this.inTransaction = false;
      throw error;
    }
  }

  private withTransaction<T>(fn: () => T): T {
    return this.inTransaction ? fn() : this.txSync(fn);
  }

  begin(): void {
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
  }

  commit(): void {
    this.db.exec("COMMIT");
    this.inTransaction = false;
  }

  rollback(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
  }

  async tx<T>(fn: () => Awaitable<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      this.inTransaction = false;
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  ensureRoot(): number {
    return this.txSync(() => {
      const row = this.db
        .prepare("SELECT id FROM conversations ORDER BY id ASC LIMIT 1")
        .get() as { id: number } | undefined;
      if (row) return row.id;
      const now = Date.now();
      const info = this.db
        .prepare(
          "INSERT INTO conversations(version, title, created_at, updated_at) VALUES(0, 'Ribhu Voyager', ?, ?)",
        )
        .run(now, now);
      return Number(info.lastInsertRowid);
    });
  }

  createConversation(title = "New conversation"): number {
    const now = Date.now();
    const info = this.db
      .prepare(
        "INSERT INTO conversations(version, title, created_at, updated_at) VALUES(0, ?, ?, ?)",
      )
      .run(title, now, now);
    return Number(info.lastInsertRowid);
  }

  listConversations(
    includeArchived = false,
  ): import("@ribhu-voyager/engine").ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, parent_id, fork_entry_id, archived_at, created_at, updated_at
         FROM conversations
         ${includeArchived ? "" : "WHERE archived_at IS NULL"}
         ORDER BY updated_at DESC, id DESC`,
      )
      .all() as Array<{
      id: number;
      title: string | null;
      parent_id: number | null;
      fork_entry_id: number | null;
      archived_at: number | null;
      created_at: number;
      updated_at: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? `Conversation ${row.id}`,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
      ...(row.fork_entry_id !== null ? { forkEntryId: row.fork_entry_id } : {}),
      ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
    }));
  }

  archiveConversation(id: number, archived: boolean): void {
    this.db
      .prepare("UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(archived ? Date.now() : null, Date.now(), id);
  }

  searchConversations(
    query: string,
    limit = 20,
  ): import("@ribhu-voyager/engine").ConversationSearchResult[] {
    const text = query.trim();
    if (text === "") return [];
    const conversations = new Map(
      this.listConversations().map((item) => [item.id, item]),
    );
    const matches: Array<{ id: number; snippet?: string }> = [];
    const seen = new Set<number>();

    const terms = text
      .split(/[^\p{L}\p{N}_]+/u)
      .map((term) => term.trim())
      .filter((term) => term !== "");
    if (terms.length > 0) {
      const ftsQuery = terms
        .map((term) => `"${term.replaceAll('"', '""')}"`)
        .join(" AND ");
      try {
        const rows = this.db
          .prepare(
            `SELECT f.conversation_id AS id,
                    snippet(entries_fts, 0, '[', ']', '…', 16) AS snippet
             FROM entries_fts f
             JOIN conversations c ON c.id = f.conversation_id
             WHERE entries_fts MATCH ? AND c.archived_at IS NULL
             ORDER BY rank LIMIT 100`,
          )
          .all(ftsQuery) as Array<{ id: number; snippet: string }>;
        for (const row of rows) {
          if (seen.has(row.id) || !conversations.has(row.id)) continue;
          seen.add(row.id);
          matches.push({ id: row.id, snippet: row.snippet });
        }
      } catch {
        /* FTS query syntax can fail on punctuation; fall through to LIKE. */
      }
    }

    if (matches.length < limit) {
      const like = `%${text.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      const rows = this.db
        .prepare(
          `SELECT id, title FROM conversations
           WHERE archived_at IS NULL AND title LIKE ? ESCAPE '\\'
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(like, limit) as Array<{ id: number; title: string | null }>;
      for (const row of rows) {
        if (seen.has(row.id) || !conversations.has(row.id)) continue;
        seen.add(row.id);
        matches.push({ id: row.id });
      }
    }

    return matches.slice(0, limit).flatMap((match) => {
      const summary = conversations.get(match.id);
      if (!summary) return [];
      return [
        {
          ...summary,
          ...(match.snippet ? { snippet: match.snippet } : {}),
        },
      ];
    });
  }

  renameConversation(id: number, title: string): void {
    const trimmed = title.trim();
    if (trimmed === "") return;
    this.db
      .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .run(trimmed.slice(0, 120), Date.now(), id);
    this.bump(id);
  }

  forkConversation(parentId: number, atEntryId?: number): number {
    return this.txSync(() => {
      const parent = this.db
        .prepare("SELECT id, title FROM conversations WHERE id = ?")
        .get(parentId) as { id: number; title: string | null } | undefined;
      if (!parent) throw new Error(`Unknown conversation ${parentId}`);
      const last = this.db
        .prepare("SELECT MAX(id) AS id FROM entries WHERE conversation_id = ?")
        .get(parentId) as { id: number | null };
      const cutoff = atEntryId ?? last.id;
      const now = Date.now();
      const info = this.db
        .prepare(
          `INSERT INTO conversations(version, title, parent_id, fork_entry_id, created_at, updated_at)
           VALUES(0, ?, ?, ?, ?, ?)`,
        )
        .run(
          `Fork of ${parent.title ?? `Conversation ${parentId}`}`,
          parentId,
          cutoff,
          now,
          now,
        );
      const childId = Number(info.lastInsertRowid);
      if (cutoff !== null) {
        this.db
          .prepare(
            `INSERT INTO entries(conversation_id, kind, model, data, by_task_id, created_at)
             SELECT ?, kind, model, data, by_task_id, created_at
             FROM entries WHERE conversation_id = ? AND id <= ? ORDER BY id`,
          )
          .run(childId, parentId, cutoff);
      }
      const copied = this.db
        .prepare(
          "SELECT id, model FROM entries WHERE conversation_id = ? ORDER BY id",
        )
        .all(childId) as Array<{ id: number; model: string | null }>;
      for (const entry of copied) {
        this.indexEntry(
          entry.id,
          childId,
          parseJson<ModelMessage[]>(entry.model),
        );
      }
      this.db
        .prepare(
          `INSERT INTO docs(conversation_id, kind, value)
           SELECT ?, kind, value FROM docs WHERE conversation_id = ? AND kind = 'pi.agent'`,
        )
        .run(childId, parentId);
      this.db
        .prepare("INSERT OR REPLACE INTO docs(conversation_id, kind, value) VALUES(?, 'pi.usage', ?)")
        .run(
          childId,
          JSON.stringify({ input: 0, output: 0, totalTokens: 0 }),
        );
      this.bump(childId);
      return childId;
    });
  }

  conversationExists(id: number): boolean {
    return (
      this.db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id) !==
      undefined
    );
  }

  version(id: number): number {
    const row = this.db
      .prepare("SELECT version FROM conversations WHERE id = ?")
      .get(id) as { version: number } | undefined;
    return row?.version ?? 0;
  }

  private bump(id: number): void {
    this.db
      .prepare(
        "UPDATE conversations SET version = version + 1, updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), id);
  }

  appendEntry(
    entry: Omit<EntryRecord, "id">,
    guard?: WriteGuard,
  ): number {
    const now = Date.now();
    const values = [
      entry.conversationId,
      entry.kind,
      entry.model === undefined ? null : JSON.stringify(entry.model),
      entry.data === undefined ? null : JSON.stringify(entry.data),
      entry.byTaskId ?? null,
      now,
    ] as const;
    // One statement: the INSERT only happens while the guard's job row still
    // matches the fence, so a stale worker cannot commit a journal entry.
    const info = guard
      ? this.db
          .prepare(
            `INSERT INTO entries(conversation_id, kind, model, data, by_task_id, created_at)
             SELECT ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM jobs
               WHERE id = ? AND owner = ? AND status = 'running'
                 AND lease_until > ? AND fence = ?
             )`,
          )
          .run(
            ...values,
            guard.jobId,
            guard.owner,
            now,
            guard.fence,
          )
      : this.db
          .prepare(
            `INSERT INTO entries(conversation_id, kind, model, data, by_task_id, created_at)
             VALUES(?, ?, ?, ?, ?, ?)`,
          )
          .run(...values);
    if (guard && info.changes === 0) throw new StaleFence();
    const entryId = Number(info.lastInsertRowid);
    this.indexEntry(entryId, entry.conversationId, entry.model);
    this.bump(entry.conversationId);
    return entryId;
  }

  entries(conversationId: number, limit = 100): {
    entries: EntryRecord[];
    before?: number;
  } {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT id, conversation_id, kind, model, data, by_task_id
           FROM entries WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(conversationId, limit) as Array<{
      id: number;
      conversation_id: number;
      kind: string;
      model: string | null;
      data: string | null;
      by_task_id: number | null;
    }>;

    const entries = rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      kind: row.kind,
      ...(row.model ? { model: parseJson<ModelMessage[]>(row.model) } : {}),
      ...(row.data ? { data: parseJson<Json>(row.data) } : {}),
      ...(row.by_task_id ? { byTaskId: row.by_task_id } : {}),
    }));

    let before: number | undefined;
    if (entries.length > 0) {
      const first = entries[0]!;
      const previous = this.db
        .prepare(
          "SELECT id FROM entries WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 1",
        )
        .get(conversationId, first.id) as { id: number } | undefined;
      before = previous?.id;
    }
    return { entries, before };
  }

  lastEntry(conversationId: number): EntryRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id, conversation_id, kind, model, data, by_task_id FROM entries WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(conversationId) as
      | {
          id: number;
          conversation_id: number;
          kind: string;
          model: string | null;
          data: string | null;
          by_task_id: number | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      kind: row.kind,
      ...(row.model ? { model: parseJson<ModelMessage[]>(row.model) } : {}),
      ...(row.data ? { data: parseJson<Json>(row.data) } : {}),
      ...(row.by_task_id ? { byTaskId: row.by_task_id } : {}),
    };
  }

  lastEntryOfKind(conversationId: number, kind: string): EntryRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id, conversation_id, kind, model, data, by_task_id FROM entries WHERE conversation_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
      )
      .get(conversationId, kind) as
      | {
          id: number;
          conversation_id: number;
          kind: string;
          model: string | null;
          data: string | null;
          by_task_id: number | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      kind: row.kind,
      ...(row.model ? { model: parseJson<ModelMessage[]>(row.model) } : {}),
      ...(row.data ? { data: parseJson<Json>(row.data) } : {}),
      ...(row.by_task_id ? { byTaskId: row.by_task_id } : {}),
    };
  }

  putDoc(conversationId: number, kind: string, value: JsonObject): void {
    this.db
      .prepare(
        "INSERT INTO docs(conversation_id, kind, value) VALUES(?, ?, ?) ON CONFLICT(conversation_id, kind) DO UPDATE SET value = excluded.value",
      )
      .run(conversationId, kind, JSON.stringify(value));
    this.bump(conversationId);
  }

  docs(conversationId: number): Record<string, JsonObject> {
    const rows = this.db
      .prepare("SELECT kind, value FROM docs WHERE conversation_id = ?")
      .all(conversationId) as Array<{ kind: string; value: string }>;
    const docs: Record<string, JsonObject> = {};
    for (const row of rows) {
      const value = parseJson<JsonObject>(row.value);
      if (value) docs[row.kind] = value;
    }
    return docs;
  }

  view(conversationId: number, limit = 100): ConversationView {
    const { entries, before } = this.entries(conversationId, limit);
    return {
      conversation: { id: conversationId },
      entries,
      ...(before !== undefined ? { before } : {}),
      docs: this.docs(conversationId),
    };
  }

  findSubmission(
    conversationId: number,
    requestId: string,
  ): SubmissionRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM submissions WHERE conversation_id = ? AND request_id = ?",
      )
      .get(conversationId, requestId) as SubmissionRow | undefined;
  }

  submission(id: number): SubmissionRow | undefined {
    return this.db
      .prepare("SELECT * FROM submissions WHERE id = ?")
      .get(id) as SubmissionRow | undefined;
  }

  createSubmission(
    conversationId: number,
    requestId: string,
    content: string,
    whenBusy = "steer",
  ): SubmissionRow {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO submissions(conversation_id, request_id, content, status, when_busy, created_at, updated_at)
         VALUES(?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(conversationId, requestId, content, whenBusy, now, now);
    this.bump(conversationId);
    return this.submission(Number(info.lastInsertRowid))!;
  }

  updateSubmission(
    id: number,
    status: SubmissionStatus,
    options: SubmissionOptions = {},
    guard?: WriteGuard,
  ): void {
    this.assertFence(guard);
    this.db
      .prepare(
        "UPDATE submissions SET status = ?, answer_entry_id = ?, error = ?, updated_at = ? WHERE id = ? AND status NOT IN ('done','failed','aborted')",
      )
      .run(
        status,
        options.answerEntryId ?? null,
        options.error ?? null,
        Date.now(),
        id,
      );
  }

  settleSubmissionIds(
    ids: number[],
    status: SubmissionStatus,
    options: SubmissionOptions = {},
    guard?: WriteGuard,
  ): void {
    if (ids.length === 0) return;
    this.assertFence(guard);
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE submissions SET status = ?, answer_entry_id = COALESCE(?, answer_entry_id),
           error = ?, updated_at = ?
         WHERE id IN (${placeholders})
           AND status NOT IN ('done','failed','aborted')`,
      )
      .run(
        status,
        options.answerEntryId ?? null,
        options.error ?? null,
        Date.now(),
        ...ids,
      );
  }

  settleSubmissions(
    conversationId: number,
    statuses: SubmissionStatus[],
    status: SubmissionStatus,
    options: SubmissionOptions = {},
  ): void {
    if (statuses.length === 0) return;
    const placeholders = statuses.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE submissions SET status = ?, answer_entry_id = COALESCE(?, answer_entry_id),
           error = ?, updated_at = ?
         WHERE conversation_id = ? AND status IN (${placeholders})
           AND status NOT IN ('done','failed','aborted')`,
      )
      .run(
        status,
        options.answerEntryId ?? null,
        options.error ?? null,
        Date.now(),
        conversationId,
        ...statuses,
      );
  }

  queuedSubmissions(conversationId: number): SubmissionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM submissions WHERE conversation_id = ? AND status IN ('queued','running') ORDER BY id ASC",
      )
      .all(conversationId) as SubmissionRow[];
  }

  allOpenSubmissions(): SubmissionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM submissions WHERE status IN ('queued','running') ORDER BY id ASC",
      )
      .all() as SubmissionRow[];
  }

  busy(conversationId: number): boolean {
    const queued = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM submissions WHERE conversation_id = ? AND status IN ('queued','running')",
      )
      .get(conversationId) as { n: number };
    if (queued.n > 0) return true;
    const tools = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tool_tasks WHERE conversation_id = ? AND status = 'running'",
      )
      .get(conversationId) as { n: number };
    return tools.n > 0;
  }

  createToolTask(
    conversationId: number,
    callId: string,
    name: string,
    args: JsonObject,
    replaySafe: boolean,
    guard?: WriteGuard,
  ): ToolTaskRow {
    const now = Date.now();
    const values = [
      conversationId,
      callId,
      name,
      JSON.stringify(args),
      replaySafe ? 1 : 0,
      now,
      now,
    ] as const;
    const info = guard
      ? this.db
          .prepare(
            `INSERT INTO tool_tasks(conversation_id, call_id, name, args, replay_safe, status, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, 'running', ?, ?
             WHERE EXISTS (
               SELECT 1 FROM jobs
               WHERE id = ? AND owner = ? AND status = 'running'
                 AND lease_until > ? AND fence = ?
             )`,
          )
          .run(...values, guard.jobId, guard.owner, now, guard.fence)
      : this.db
          .prepare(
            `INSERT INTO tool_tasks(conversation_id, call_id, name, args, replay_safe, status, created_at, updated_at)
             VALUES(?, ?, ?, ?, ?, 'running', ?, ?)`,
          )
          .run(...values);
    if (guard && info.changes === 0) throw new StaleFence();
    return this.toolTask(Number(info.lastInsertRowid))!;
  }

  findToolTask(conversationId: number, callId: string): ToolTaskRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM tool_tasks WHERE conversation_id = ? AND call_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(conversationId, callId) as ToolTaskRow | undefined;
  }

  toolTask(id: number): ToolTaskRow | undefined {
    return this.db
      .prepare("SELECT * FROM tool_tasks WHERE id = ?")
      .get(id) as ToolTaskRow | undefined;
  }

  runningToolTasks(conversationId?: number): ToolTaskRow[] {
    return (
      conversationId === undefined
        ? this.db
            .prepare("SELECT * FROM tool_tasks WHERE status = 'running' ORDER BY id ASC")
            .all()
        : this.db
            .prepare(
              "SELECT * FROM tool_tasks WHERE conversation_id = ? AND status = 'running' ORDER BY id ASC",
            )
            .all(conversationId)
    ) as ToolTaskRow[];
  }

  finishToolTask(
    id: number,
    result: string,
    status: ToolTaskStatus,
    guard?: WriteGuard,
  ): void {
    const now = Date.now();
    const info = guard
      ? this.db
          .prepare(
            `UPDATE tool_tasks SET status = ?, result = ?, updated_at = ?
             WHERE id = ? AND EXISTS (
               SELECT 1 FROM jobs
               WHERE id = ? AND owner = ? AND status = 'running'
                 AND lease_until > ? AND fence = ?
             )`,
          )
          .run(status, result, now, id, guard.jobId, guard.owner, now, guard.fence)
      : this.db
          .prepare(
            "UPDATE tool_tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?",
          )
          .run(status, result, now, id);
    if (guard && info.changes === 0) throw new StaleFence();
  }

  hasToolResult(conversationId: number, callId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM entries
           WHERE conversation_id = ? AND kind = 'pi.tool-result'
             AND json_extract(model, '$[0].toolCallId') = ?
           LIMIT 1`,
        )
        .get(conversationId, callId) !== undefined
    );
  }

  enqueueRun(conversationId: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs(conversation_id, kind, status, created_at, updated_at)
         SELECT ?, 'run', 'pending', ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM jobs
           WHERE conversation_id = ? AND kind = 'run' AND status IN ('pending','running')
         )`,
      )
      .run(conversationId, now, now, conversationId);
  }

  enqueueCompact(conversationId: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs(conversation_id, kind, status, created_at, updated_at)
         SELECT ?, 'compact', 'pending', ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM jobs
           WHERE conversation_id = ? AND kind = 'compact' AND status IN ('pending','running')
         )`,
      )
      .run(conversationId, now, now, conversationId);
  }

  claimRun(owner: string, leaseMs: number): QueueJob | undefined {
    return this.txSync(() => {
      const now = Date.now();
      const row = this.db
        .prepare(
          `SELECT * FROM jobs j
           WHERE (j.status = 'pending' OR (j.status = 'running' AND j.lease_until < ?))
             AND NOT EXISTS (
               SELECT 1 FROM jobs other
               WHERE other.conversation_id = j.conversation_id
                 AND other.status = 'running' AND other.id <> j.id
             )
           ORDER BY j.id ASC LIMIT 1`,
        )
        .get(now) as QueueJob | undefined;
      if (!row) return undefined;
      const leaseUntil = now + leaseMs;
      const fence = row.fence + 1;
      this.db
        .prepare(
          "UPDATE jobs SET status = 'running', owner = ?, lease_until = ?, fence = ?, updated_at = ? WHERE id = ?",
        )
        .run(owner, leaseUntil, fence, now, row.id);
      return {
        ...row,
        status: "running",
        owner,
        fence,
        lease_until: leaseUntil,
        updated_at: now,
      };
    });
  }

  renewRun(
    jobId: number,
    owner: string,
    leaseMs: number,
    fence?: number,
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE jobs SET lease_until = ?, updated_at = ?
         WHERE id = ? AND owner = ? AND status = 'running'
           ${fence === undefined ? "" : "AND fence = ?"}`,
      )
      .run(
        Date.now() + leaseMs,
        Date.now(),
        jobId,
        owner,
        ...(fence === undefined ? [] : [fence]),
      );
    return info.changes > 0;
  }

  finishRun(jobId: number, owner: string): void {
    this.db
      .prepare("DELETE FROM jobs WHERE id = ? AND owner = ?")
      .run(jobId, owner);
  }

  jobOwned(jobId: number, owner: string, fence?: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM jobs
           WHERE id = ? AND owner = ? AND status = 'running' AND lease_until > ?
             ${fence === undefined ? "" : "AND fence = ?"}`,
        )
        .get(
          jobId,
          owner,
          Date.now(),
          ...(fence === undefined ? [] : [fence]),
        ) !== undefined
    );
  }

  queueStats(): {
    pending: number;
    running: number;
    oldestPendingAgeMs: number | null;
  } {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
      .all() as { status: string; count: number }[];
    const counts = { pending: 0, running: 0, oldestPendingAgeMs: null as number | null };
    for (const row of rows) {
      if (row.status === "pending") counts.pending = row.count;
      if (row.status === "running") counts.running = row.count;
    }
    const oldest = this.db
      .prepare("SELECT MIN(created_at) AS oldest FROM jobs WHERE status = 'pending'")
      .get() as { oldest: number | null };
    counts.oldestPendingAgeMs =
      oldest.oldest === null ? null : Math.max(0, Date.now() - oldest.oldest);
    return counts;
  }

  getSetting(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  settingsMatching(prefix: string): SettingPair[] {
    // Prefix match without LIKE escaping: compare the leading slice exactly.
    return this.db
      .prepare(
        "SELECT key, value FROM settings WHERE substr(key, 1, ?) = ? ORDER BY key",
      )
      .all(prefix.length, prefix) as SettingPair[];
  }

  recordUsage(event: UsageEventInput): void {
    const inputTokens = Math.max(0, Math.trunc(event.inputTokens));
    const outputTokens = Math.max(0, Math.trunc(event.outputTokens));
    const costMicros = Math.max(0, Math.trunc(event.costMicros ?? 0));
    const createdAt = event.createdAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO usage_events(tenant_id, conversation_id, submission_id, provider, model, input_tokens, output_tokens, cost_micros, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        DEFAULT_TENANT,
        event.conversationId ?? null,
        event.submissionId ?? null,
        event.provider,
        event.model,
        inputTokens,
        outputTokens,
        costMicros,
        createdAt,
      );
    // Keep the atomic quota counters in step with the usage journal.
    this.quotaState(createdAt);
    this.db
      .prepare(
        `UPDATE quota_state
         SET day_tokens = day_tokens + ?,
             month_tokens = month_tokens + ?,
             month_cost_micros = month_cost_micros + ?
         WHERE tenant_id = ?`,
      )
      .run(inputTokens + outputTokens, inputTokens + outputTokens, costMicros, DEFAULT_TENANT);
  }

  private quotaState(now: number): QuotaStateRow {
    const day = utcDay(now);
    const month = utcMonth(now);
    let row = this.db
      .prepare("SELECT * FROM quota_state WHERE tenant_id = ?")
      .get(DEFAULT_TENANT) as QuotaStateRow | undefined;
    if (!row) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO quota_state(tenant_id, day, month) VALUES(?, ?, ?)",
        )
        .run(DEFAULT_TENANT, day, month);
      row = this.db
        .prepare("SELECT * FROM quota_state WHERE tenant_id = ?")
        .get(DEFAULT_TENANT) as QuotaStateRow;
    }
    if (row.day !== day) {
      this.db
        .prepare(
          "UPDATE quota_state SET day = ?, day_tokens = 0, day_reserved_tokens = 0 WHERE tenant_id = ?",
        )
        .run(day, DEFAULT_TENANT);
      row = { ...row, day, day_tokens: 0, day_reserved_tokens: 0 };
    }
    if (row.month !== month) {
      this.db
        .prepare(
          "UPDATE quota_state SET month = ?, month_tokens = 0, month_cost_micros = 0, month_reserved_cost_micros = 0 WHERE tenant_id = ?",
        )
        .run(month, DEFAULT_TENANT);
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

  reserveQuota(request: QuotaReservationInput): QuotaReservation | undefined {
    const quota = this.quota();
    if (quota.dailyTokens === null && quota.monthlyCostMicros === null) {
      return undefined;
    }
    return this.withTransaction(() => {
      const timestamp = Date.now();
      const state = this.quotaState(timestamp);
      const tokens = Math.max(0, Math.trunc(request.tokens));
      const costMicros = Math.max(0, Math.trunc(request.costMicros));
      if (quota.dailyTokens !== null) {
        const total = state.day_tokens + state.day_reserved_tokens + tokens;
        if (total > quota.dailyTokens) {
          throw new QuotaExceeded(
            `Daily token quota exceeded: ${state.day_tokens} used, ` +
              `${state.day_reserved_tokens} reserved, ${tokens} requested; ` +
              `limit ${quota.dailyTokens}.`,
          );
        }
      }
      if (quota.monthlyCostMicros !== null) {
        const total =
          state.month_cost_micros + state.month_reserved_cost_micros + costMicros;
        if (total > quota.monthlyCostMicros) {
          throw new QuotaExceeded(
            `Monthly cost quota exceeded: ${state.month_cost_micros} used, ` +
              `${state.month_reserved_cost_micros} reserved, ${costMicros} requested; ` +
              `limit ${quota.monthlyCostMicros} micros.`,
          );
        }
      }
      const info = this.db
        .prepare(
          `INSERT INTO quota_reservations(
             tenant_id, conversation_id, submission_id, tokens, cost_micros,
             day, month, status, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          DEFAULT_TENANT,
          request.conversationId,
          request.submissionId ?? null,
          tokens,
          costMicros,
          state.day,
          state.month,
          timestamp,
          timestamp,
        );
      this.db
        .prepare(
          `UPDATE quota_state
           SET day_reserved_tokens = day_reserved_tokens + ?,
               month_reserved_cost_micros = month_reserved_cost_micros + ?
           WHERE tenant_id = ?`,
        )
        .run(tokens, costMicros, DEFAULT_TENANT);
      const row = this.db
        .prepare("SELECT * FROM quota_reservations WHERE id = ?")
        .get(Number(info.lastInsertRowid)) as QuotaReservationRow;
      return quotaReservation(row);
    });
  }

  private finishQuotaReservation(
    reservationId: number,
    status: "committed" | "released",
  ): void {
    this.withTransaction(() => {
      const row = this.db
        .prepare("SELECT * FROM quota_reservations WHERE id = ?")
        .get(reservationId) as QuotaReservationRow | undefined;
      if (!row || row.status !== "active") return;
      const timestamp = Date.now();
      const state = this.quotaState(timestamp);
      const dayTokens = row.day === state.day ? row.tokens : 0;
      const monthCost = row.month === state.month ? row.cost_micros : 0;
      this.db
        .prepare(
          `UPDATE quota_state
           SET day_reserved_tokens = MAX(0, day_reserved_tokens - ?),
               month_reserved_cost_micros = MAX(0, month_reserved_cost_micros - ?)
           WHERE tenant_id = ?`,
        )
        .run(dayTokens, monthCost, DEFAULT_TENANT);
      this.db
        .prepare(
          "UPDATE quota_reservations SET status = ?, updated_at = ? WHERE id = ? AND status = 'active'",
        )
        .run(status, timestamp, reservationId);
    });
  }

  releaseQuota(reservationId: number): void {
    this.finishQuotaReservation(reservationId, "released");
  }

  commitQuota(reservationId: number): void {
    this.finishQuotaReservation(reservationId, "committed");
  }

  quotaReservationFor(submissionId: number): QuotaReservation | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM quota_reservations WHERE submission_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(submissionId) as QuotaReservationRow | undefined;
    return row ? quotaReservation(row) : undefined;
  }

  usageSummary(period: UsagePeriod): UsageSummary {
    const since = periodStart(period);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS events,
                COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cost_micros), 0) AS cost
         FROM usage_events WHERE tenant_id = ? AND created_at >= ?`,
      )
      .get(DEFAULT_TENANT, since) as {
      events: number;
      input: number;
      output: number;
      cost: number;
    };
    const inputTokens = Number(row.input);
    const outputTokens = Number(row.output);
    return {
      period,
      since,
      events: Number(row.events),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costMicros: Number(row.cost),
    };
  }

  listUsage(limit = DEFAULT_LIST_LIMIT): UsageEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, conversation_id, submission_id, provider, model,
                input_tokens, output_tokens, cost_micros, created_at
         FROM usage_events WHERE tenant_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(DEFAULT_TENANT, Math.max(1, Math.trunc(limit))) as UsageRow[];
    return rows.map(usageEvent);
  }

  recordAudit(event: AuditEventInput): void {
    this.db
      .prepare(
        `INSERT INTO audit_events(tenant_id, actor, action, target, data, created_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(
        DEFAULT_TENANT,
        event.actor,
        event.action,
        event.target,
        event.data === undefined ? null : JSON.stringify(event.data),
        event.createdAt ?? Date.now(),
      );
  }

  listAudit(limit = DEFAULT_LIST_LIMIT): AuditEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, tenant_id, actor, action, target, data, created_at
         FROM audit_events WHERE tenant_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(DEFAULT_TENANT, Math.max(1, Math.trunc(limit))) as AuditRow[];
    return rows.map(auditEvent);
  }

  quota(): Quota {
    return {
      dailyTokens: limitSetting(this.getSetting(QUOTA_DAILY_TOKENS_KEY)),
      monthlyCostMicros: limitSetting(this.getSetting(QUOTA_MONTHLY_COST_KEY)),
    };
  }

  setQuota(next: Partial<Quota>): void {
    if (next.dailyTokens !== undefined) {
      this.setSetting(
        QUOTA_DAILY_TOKENS_KEY,
        next.dailyTokens === null ? "" : String(Math.max(0, Math.trunc(next.dailyTokens))),
      );
    }
    if (next.monthlyCostMicros !== undefined) {
      this.setSetting(
        QUOTA_MONTHLY_COST_KEY,
        next.monthlyCostMicros === null
          ? ""
          : String(Math.max(0, Math.trunc(next.monthlyCostMicros))),
      );
    }
  }

  listTenants(): string[] {
    return [DEFAULT_TENANT];
  }

  /** Applied local schema version (meta.schema); 0 when unknown. */
  schemaVersion(): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema'")
      .get() as { value: string } | undefined;
    const parsed = Number(row?.value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Retention: delete local usage events older than `cutoff` (epoch ms).
   * With `dryRun` only counts the rows. Never touches journal tables.
   */
  deleteOldUsage(cutoff: number, options: { dryRun?: boolean } = {}): number {
    return this.deleteOlderThan("usage_events", cutoff, options);
  }

  /** Retention: delete local audit events older than `cutoff` (epoch ms). */
  deleteOldAudit(cutoff: number, options: { dryRun?: boolean } = {}): number {
    return this.deleteOlderThan("audit_events", cutoff, options);
  }

  private deleteOlderThan(
    table: "usage_events" | "audit_events",
    cutoff: number,
    options: { dryRun?: boolean },
  ): number {
    if (!Number.isFinite(cutoff) || cutoff <= 0) {
      throw new Error("retention cutoff must be a positive epoch-ms timestamp");
    }
    if (options.dryRun === true) {
      const row = this.db
        .prepare(`SELECT count(*) AS count FROM ${table} WHERE created_at < ?`)
        .get(cutoff) as { count: number } | undefined;
      return Number(row?.count ?? 0);
    }
    const info = this.db
      .prepare(`DELETE FROM ${table} WHERE created_at < ?`)
      .run(cutoff);
    return Number(info.changes);
  }

  requestCancel(conversationId: number): void {
    this.db
      .prepare(
        "INSERT INTO cancels(conversation_id, requested_at) VALUES(?, ?) ON CONFLICT(conversation_id) DO UPDATE SET requested_at = excluded.requested_at",
      )
      .run(conversationId, Date.now());
  }

  isCancelRequested(conversationId: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM cancels WHERE conversation_id = ?")
        .get(conversationId) !== undefined
    );
  }

  clearCancel(conversationId: number): void {
    this.db
      .prepare("DELETE FROM cancels WHERE conversation_id = ?")
      .run(conversationId);
  }

  conversationIdsWithOpenWork(): number[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT conversation_id FROM submissions WHERE status IN ('queued','running')
         UNION SELECT DISTINCT conversation_id FROM tool_tasks WHERE status = 'running'`,
      )
      .all() as Array<{ conversation_id: number }>;
    return rows.map((row) => row.conversation_id);
  }
}
