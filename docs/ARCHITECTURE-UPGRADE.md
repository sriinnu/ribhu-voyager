# Architecture Upgrade — Ribhu Voyager

Status: **Phase 8 complete** — the engine runs on an async storage port against SQLite or
Postgres. API and worker are separate processes over a durable queue; Postgres has versioned
migrations, FTS, RLS tenant isolation, fence tokens, and Dockerized engine/worker/API/crash tests.
Approvals are a policy gate, and the native/PKCE work is a foundation only. See
[REAL-APP-ARCHITECTURE.md](REAL-APP-ARCHITECTURE.md) for the hosted target.

Current topology:

```text
PWA ──WS/HTTP──▶ API ──admission──▶ Postgres/SQLite journal + jobs
                  │                         │
                  │                    worker ──▶ engine ──▶ providers/tools
                  └── snapshots ◀── view polling
```

## Goals

- API and agent execution restart independently.
- Agent work is claimed from a durable queue with leases, so a crashed worker resumes.
- The engine becomes a pure TypeScript package with explicit ports.
- Storage, providers, and tool execution become replaceable adapters.
- A path to multiple workers, sandboxed execution, and multi-user tenancy without rewriting the loop.
- No behavior change for the phone: same protocol, same snapshots.

Non-goals for this phase: multi-tenant auth, Postgres, Redis, container orchestration, edge
deployment. The ports and queue are designed so those can be added later.

## Target

```text
PWA
 │ WS/HTTP
API                  auth/session · admission · static · view polling
 │ enqueue + wake
Queue                durable leases (SQLite now; Postgres/Redis later)
 │ claim
Worker(s)            run loop · providers · tool runner · OAuth refresh
 │
Engine core          pure TypeScript; no HTTP, fs, child_process, or SQLite
 ├── Storage port     → packages/storage-sqlite (later Postgres)
 ├── Provider port    → packages/providers (Anthropic/OpenAI-compat/demo)
 └── ToolRunner port  → local runner now; container runner later
```

### Packages

```text
packages/
  protocol/           wire types (v2)
  engine/             types, ports, admission, run loop, tool specs
  storage-sqlite/     journal, submissions, queue, settings, views
  providers/          Anthropic SSE, OpenAI-compatible SSE, demo
apps/
  api/                HTTP/WS, static, admission, auth info, view polling
  worker/             queue loop, engine runner, provider/auth/tool runner
  mobile/             PWA (unchanged)
```

`packages/engine` must not import `node:http`, `node:fs`, `node:sqlite`, `node:child_process`, or
any app package.

## Ports

```ts
// packages/engine/src/ports.ts
export interface Storage {
  ensureRoot(): number;
  conversationExists(id: number): boolean;
  version(id: number): number;
  view(id: number, limit?: number): ConversationView;
  entries(id: number, limit?: number): { entries: EntryRecord[]; before?: number };
  lastEntry(id: number): EntryRecord | undefined;
  lastEntryOfKind(id: number, kind: string): EntryRecord | undefined;
  appendEntry(entry: Omit<EntryRecord, "id">): number;
  putDoc(id: number, kind: string, value: JsonObject): void;
  docs(id: number): Record<string, JsonObject>;

  findSubmission(requestId: string): SubmissionRow | undefined;
  createSubmission(id: number, requestId: string, content: string): SubmissionRow;
  updateSubmission(id: number, status: SubmissionStatus, opts?): void;
  settleSubmissionIds(ids: number[], status: SubmissionStatus, opts?): void;
  queuedSubmissions(id: number): SubmissionRow[];
  busy(id: number): boolean;

  createToolTask(id: number, callId: string, name: string, args: JsonObject, safe: boolean): ToolTaskRow;
  finishToolTask(id: number, result: string, status: ToolTaskStatus): void;
  runningToolTasks(id?: number): ToolTaskRow[];
  hasToolResult(id: number, callId: string): boolean;

  enqueueRun(conversationId: number): void;
  claimRun(owner: string, leaseMs: number): QueueJob | undefined;
  renewRun(jobId: number, owner: string, leaseMs: number): boolean;
  finishRun(jobId: number, owner: string): void;

  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;

  requestCancel(conversationId: number): void;
  isCancelRequested(conversationId: number): boolean;
  clearCancel(conversationId: number): void;
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

export interface ToolRunner {
  readonly specs: ToolSpec[];
  execute(name: string, args: JsonObject, ctx: ToolContext): Promise<ToolResult>;
}
```

The Storage port is **synchronous** for this phase (SQLite). It is the one deliberate compromise:
Postgres would need an async variant, which is a later, isolated change (`Storage` v2) rather than
threading `await` through the engine now.

## Queue

```sql
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  status TEXT NOT NULL,           -- pending | running | done
  owner TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_ready ON jobs(status, lease_until);
```

Claim algorithm (one transaction, `BEGIN IMMEDIATE`):

1. Select the oldest `pending`, or `running` with `lease_until < now`.
2. `UPDATE ... SET status='running', owner=?, lease_until=?`.
3. Return the job.

Worker renews every `leaseMs / 3`; after a crash the lease expires and another worker claims it.
`enqueueRun` is idempotent enough for this phase: if a pending job already exists for the
conversation, do not add another.

## Live views

The API must not share memory with the worker. Each committed change bumps
`conversations.version`; the worker also commits the in-flight `pi.live` doc at **80–150 ms**
intervals. That makes streaming durable and visible across processes.

API watcher per conversation:

```text
on first client attach: read view + version, send welcome
every 120 ms:           if version changed, read view, send snapshot
when last client detaches: clear timer
```

This replaces the in-process `watch()` callback. The phone receives full snapshots (protocol v2),
so no delta protocol is needed.

Crash behavior becomes stronger: a streamed partial is already in `pi.live`; if the worker dies, the
API can still show it. On restart the worker clears stale live state and retries the request (or
converts the partial to an aborted entry, depending on policy).

## Auth and control

Auth stays in the worker (Keychain access, OAuth refresh, API keys). The API needs only display and
selection:

- Worker writes `settings.auth_info` JSON after init and after a mode change.
- API reads it for `welcome`.
- API writes `settings.auth_mode` when the user taps Subscription/API credits.
- Worker reads `settings.auth_mode` before each model request, applies `setMode`, and republishes
  `auth_info`.
- Abort: API writes a cancel flag (`requestCancel`); the worker checks it between stream events and
  tool steps, aborts the controller, settles submissions, and clears the flag.

No secrets cross the queue.

## Processes and scripts

```bash
npm start        # API + worker (concurrently)
npm run start:api
npm run start:worker
npm run dev      # API + worker (tsx watch) + Vite
```

Both share one SQLite file (WAL, `busy_timeout=5000`). One writer at a time is enforced by SQLite;
API writes admissions/queue/settings, worker writes journal/live/queue completions.

## Migration phases

### Phase 1 — packages and ports (behavior unchanged)

- Move `engine` to `packages/engine`; replace `Db` with `Storage`; split `ToolDefinition` into
  `ToolSpec` + `ToolRunner`.
- Move SQLite to `packages/storage-sqlite`.
- Move providers to `packages/providers`.
- Current server keeps an embedded worker so the app still runs.
- Acceptance: all existing tests pass; no PWA/protocol changes; `packages/engine` has no Node
  built-ins.

### Phase 2 — queue and process split

- Add `jobs` table, `enqueueRun`, lease/renew/finish.
- API: admission + view polling; delete engine usage.
- Worker: claim loop, engine runner, resume stale jobs.
- `npm start` runs both; scripts for each.
- Acceptance: submit on API, worker executes; kill worker mid-run, restart, run resumes; kill API,
  worker finishes, new API serves the result; view streams via committed `pi.live`.

### Phase 3 — control, observability, and drain

- Auth settings and abort flag wiring. **Done**: API writes `auth_mode`/cancel; worker applies and
  aborts active runs.
- `ToolRunner` local adapter in worker. **Done**: container adapter behind the same port remains.
- Observability. **Done**: `/api/health` exposes worker heartbeat age, active job, and queue depth;
  worker logs job IDs.
- Shutdown. **Done**: `worker.close()` aborts an active run before draining, instead of waiting for
  the stream to finish.

### Phase 4 — optional scale-out

- Postgres Storage v2 (async), Redis/Postgres queue, multiple workers, per-conversation leases.
- Multi-user tenancy: users, workspaces, quotas.
- Container sandboxes with network/CPU limits.

## Review hardening

Two independent reviews of Phases 1–2 found two blockers and several high-risk gaps. Fixed:

- **Unsafe tool replay:** tool intents are committed atomically with the assistant entry; a bare
  unsafe tool call from a crash is journaled as interrupted, never re-executed.
- **Lease fencing:** workers check `jobOwned` before tool calls and abort when `renewRun` fails; the
  engine has an `autoRun:false` mode so resumes enqueue jobs instead of running without a lease.
- **Shutdown:** `Engine.close()` aborts and drains active runs; `Db.close()` is idempotent; worker
  SIGTERM aborts in-flight work.
- **Queue wakeup/cancel:** worker finish re-enqueues open work in one transaction; stale cancel rows
  are cleared at run start; idle Stop cannot abort the next message.
- **Boundaries:** `packages/engine` has its own no-Node tsconfig, a purity test, and runner/spec
  parity; provider base URLs and `google` registry drift are fixed.

## Acceptance tests (Phase 2)

1. **API submit → worker run**: submit via WS, ack arrives after admission, snapshots show the
   answer.
2. **Worker crash**: `SIGKILL` worker mid-answer, restart; lease is reclaimed; run finishes; one
   user entry.
3. **API restart**: kill API, worker completes; restart API; welcome snapshot includes the answer.
4. **Tool crash**: kill worker mid-tool; unsafe tool reports interrupted; safe `read` reruns.
5. **Auth isolation**: API-credit mode with a dummy key returns 401, no subscription fallback.
6. **View latency**: streaming snapshots arrive without a shared process; `pi.live` survives.

## Risks / tradeoffs

- SQLite polling (120 ms) is simple but not a push bus; acceptable for one host, not for many users.
- Synchronous Storage port blocks an async Postgres adapter; isolate it behind a v2 port later.
- Lease renewal and cancellation need careful tests to avoid double execution.
- Moving packages changes imports across every test; do it in one mechanical phase with a green
  suite at the end.
