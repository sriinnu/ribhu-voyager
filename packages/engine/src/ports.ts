import type {
  ConversationView,
  EntryRecord,
  JsonObject,
  ToolContext,
  ToolResult,
  ToolSpec,
} from "./types.js";

export type SubmissionStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "aborted";

export type SubmissionRow = {
  id: number;
  conversation_id: number;
  request_id: string;
  content: string;
  when_busy: string;
  status: SubmissionStatus;
  answer_entry_id: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export type ToolTaskStatus = "running" | "done" | "failed" | "aborted";

export type ToolTaskRow = {
  id: number;
  conversation_id: number;
  call_id: string;
  name: string;
  args: string;
  replay_safe: number;
  status: ToolTaskStatus;
  result: string | null;
  created_at: number;
  updated_at: number;
};

export type ConversationSummary = {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  parentId?: number;
  forkEntryId?: number;
  archivedAt?: number;
};

export type ConversationSearchResult = ConversationSummary & {
  snippet?: string;
};

export type QueueJob = {
  id: number;
  conversation_id: number;
  kind: "run" | "compact";
  status: "pending" | "running";
  fence: number;
  owner: string | null;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
};

export type QueueStats = {
  pending: number;
  running: number;
  oldestPendingAgeMs: number | null;
};

export type SubmissionOptions = {
  answerEntryId?: number;
  error?: string;
};

/**
 * Optional fence guard threaded into engine writes while a worker runs a
 * claimed job. Storage rejects the write with `StaleFence` when the job row is
 * no longer owned by this owner/fence (or its lease expired), so a worker that
 * lost its lease cannot commit stale journal entries or tool results.
 */
export type WriteGuard = {
  jobId: number;
  owner: string;
  fence: number;
};

export type Awaitable<T> = T | Promise<T>;

/** One `settings` row exposed by `settingsMatching`. */
export type SettingPair = { key: string; value: string };

export type UsagePeriod = "day" | "month";

export type UsageSummary = {
  period: UsagePeriod;
  /** Epoch ms where the counted window starts (UTC day or month boundary). */
  since: number;
  events: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
};

export type UsageEventInput = {
  conversationId?: number | null;
  submissionId?: number | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cost in millionths of a currency unit; 0 when no rate is configured. */
  costMicros?: number;
  createdAt?: number;
};

export type UsageEvent = UsageEventInput & {
  id: number;
  tenantId: string;
  conversationId: number | null;
  submissionId: number | null;
  costMicros: number;
  createdAt: number;
};

export type AuditEventInput = {
  actor: string;
  action: string;
  target: string;
  data?: JsonObject;
  createdAt?: number;
};

export type AuditEvent = AuditEventInput & {
  id: number;
  tenantId: string;
  createdAt: number;
};

/** Per-tenant limits; null means "no limit configured". */
export type Quota = {
  dailyTokens: number | null;
  monthlyCostMicros: number | null;
};

/**
 * Settings keys for quota limits. Settings are already tenant-scoped in
 * Postgres (RLS); SQLite has one default tenant.
 */
export const QUOTA_DAILY_TOKENS_KEY = "daily_tokens";
export const QUOTA_MONTHLY_COST_KEY = "monthly_cost_micros";

/**
 * The journal boundary as implemented synchronously by SQLite. `Storage`
 * below widens every method to `Awaitable`, so the same engine can run on
 * SQLite or Postgres.
 */
export interface SyncStorage {
  ensureRoot(): number;
  createConversation(title?: string): number;
  listConversations(includeArchived?: boolean): ConversationSummary[];
  renameConversation(id: number, title: string): void;
  archiveConversation(id: number, archived: boolean): void;
  searchConversations(query: string, limit?: number): ConversationSearchResult[];
  forkConversation(parentId: number, atEntryId?: number): number;
  conversationExists(id: number): boolean;
  version(id: number): number;
  view(id: number, limit?: number): ConversationView;
  entries(
    id: number,
    limit?: number,
  ): { entries: EntryRecord[]; before?: number };
  lastEntry(id: number): EntryRecord | undefined;
  lastEntryOfKind(id: number, kind: string): EntryRecord | undefined;
  appendEntry(entry: Omit<EntryRecord, "id">, guard?: WriteGuard): number;
  putDoc(id: number, kind: string, value: JsonObject): void;
  docs(id: number): Record<string, JsonObject>;

  findSubmission(
    conversationId: number,
    requestId: string,
  ): SubmissionRow | undefined;
  createSubmission(
    conversationId: number,
    requestId: string,
    content: string,
    whenBusy?: string,
  ): SubmissionRow;
  updateSubmission(
    id: number,
    status: SubmissionStatus,
    options?: SubmissionOptions,
    guard?: WriteGuard,
  ): void;
  /** Settle many submissions; guarded settlement is rejected when stale. */
  settleSubmissionIds(
    ids: number[],
    status: SubmissionStatus,
    options?: SubmissionOptions,
    guard?: WriteGuard,
  ): void;
  queuedSubmissions(conversationId: number): SubmissionRow[];
  busy(conversationId: number): boolean;

  enqueueRun(conversationId: number): void;
  enqueueCompact(conversationId: number): void;
  claimRun(owner: string, leaseMs: number): QueueJob | undefined;
  renewRun(
    jobId: number,
    owner: string,
    leaseMs: number,
    fence?: number,
  ): boolean;
  finishRun(jobId: number, owner: string): void;
  jobOwned(jobId: number, owner: string, fence?: number): boolean;
  queueStats(): QueueStats;

  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  /** Every setting whose key starts with `prefix`, ordered by key. */
  settingsMatching(prefix: string): SettingPair[];

  recordUsage(event: UsageEventInput): void;
  usageSummary(period: UsagePeriod): UsageSummary;
  listUsage(limit?: number): UsageEvent[];
  recordAudit(event: AuditEventInput): void;
  listAudit(limit?: number): AuditEvent[];
  quota(): Quota;
  /** Update only the provided limits; `null` clears a limit. */
  setQuota(quota: Partial<Quota>): void;
  /** Tenants known to this storage (SQLite has a single default tenant). */
  listTenants(): string[];

  requestCancel(conversationId: number): void;
  isCancelRequested(conversationId: number): boolean;
  clearCancel(conversationId: number): void;

  findToolTask(conversationId: number, callId: string): ToolTaskRow | undefined;
  createToolTask(
    conversationId: number,
    callId: string,
    name: string,
    args: JsonObject,
    replaySafe: boolean,
    guard?: WriteGuard,
  ): ToolTaskRow;
  /** Finish a tool task; guarded finish is rejected when stale. */
  finishToolTask(
    id: number,
    result: string,
    status: ToolTaskStatus,
    guard?: WriteGuard,
  ): void;
  runningToolTasks(conversationId?: number): ToolTaskRow[];
  hasToolResult(conversationId: number, callId: string): boolean;
  conversationIdsWithOpenWork(): number[];
  close(): void;
}

export type Storage = {
  [K in keyof SyncStorage]: SyncStorage[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Awaitable<R>
    : SyncStorage[K];
} & {
  tx<T>(fn: () => Awaitable<T>): Promise<T>;
};

/** Tool execution lives outside the engine (local, container, remote later). */
export interface ToolRunner {
  readonly specs: readonly ToolSpec[];
  execute(
    name: string,
    args: JsonObject,
    context: ToolContext,
  ): Promise<ToolResult>;
}
