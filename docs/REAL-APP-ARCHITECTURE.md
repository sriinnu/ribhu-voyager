# From Local Prototype to Real App

Status: **architecture target** for Phase 4+. The local engine, API/worker split, queue, leases, and
review hardening are already in place. This document is deliberately about what changes when Ribhu
Voyager becomes a real product, not about polishing the single-user prototype.

## 1. What exists today

```text
PWA ──WS──▶ API ──queue──▶ worker ──▶ engine ──▶ SQLite
                                      ├── providers
                                      └── local ToolRunner
```

Properties already true:

- Append-only journal, exactly-once admission, replay-safe tool policy.
- Durable jobs with leases; API and worker are separate processes.
- Committed `pi.live`; API polls a conversation version.
- Auth and cancellation through settings, not shared memory.
- 150 tests, including two workers, crash resume, abort, Postgres RLS/token isolation, and a purity-checked engine package.

What is still local-only:

- One SQLite writer, one host, one user, one workspace.
- `bash` runs as the host user.
- Multi-tenant RLS/tokens and a Docker sandbox exist; billing, quotas, audit, and a native shell do not.
- No multi-conversation, forks, or compaction in the UI.

## 2. Target topology

```text
Native shell / PWA
        │  HTTPS + WSS
        ▼
Edge (TLS, WAF, rate limit)
        ▼
API tier (stateless)
  authn/authz · admission · view polling · static · push
        │  enqueue / read
        ▼
Postgres (control plane + journal)
  tenants · users · workspaces · conversations · entries
  submissions · jobs · tool_tasks · usage · audit
        │  SKIP LOCKED / NOTIFY
        ▼
Worker pool (stateless, autoscaled)
  lease + fencing token · engine · providers
        │  tool RPC
        ▼
Sandbox fleet
  one container/VM per workspace turn
  overlay filesystem · egress proxy · CPU/mem/time limits
```

Object storage holds large tool output, snapshots, and attachments. Redis (optional) is a wakeup
bus, not the source of truth. Every durable fact remains in Postgres.

## 3. Tenancy and identity

Tables:

```text
tenants(id, name, plan, created_at)
users(id, email, identity_provider, created_at)
memberships(tenant_id, user_id, role)          -- owner/admin/member
workspaces(id, tenant_id, name, repo_url, created_at)
api_tokens(id, tenant_id, user_id, hash, scopes, expires_at)
usage_events(id, tenant_id, conversation_id, provider, model, tokens, cost_micros, created_at)
audit_events(id, tenant_id, actor, action, target, metadata, created_at)
```

Rules:

- Every row carries `tenant_id`; Postgres row-level security is the last line of defence.
- API resolves `(tenant, user, role)` before any storage call.
- A conversation belongs to exactly one workspace; a workspace belongs to one tenant.
- Tokens are hashed at rest, scoped (`chat`, `workspace:write`, `admin`), and revocable.
- Worker jobs carry `tenant_id`; a worker can never read across tenants, even with a bug.
- The current `RIBBHU_TOKEN` becomes a local-dev shortcut, not the production gate.

## 4. Storage v2: async and Postgres

The current `Storage` port is synchronous for SQLite. The hosted adapter needs `StorageV2`:

```ts
interface StorageV2 {
  admit(input: Admission): Promise<Submission>;
  claim(owner: string, leaseMs: number): Promise<Job | null>;
  append(entry: Entry): Promise<number>;
  view(conversationId: number, limit: number): Promise<ConversationView>;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
```

Why a v2 rather than forcing async through the engine now:

- The local engine stays simple and fast.
- The hosted engine is a separate composition of the same pure core.
- Both adapters must pass a shared conformance suite; the port is not "done" until it does.

Postgres schema mirrors the journal. Large `model`/`args`/`result` payloads move to object storage
with a content hash; Postgres keeps the pointer. `entries` is partitioned by `tenant_id` and time.
Admission, entry append, and job enqueue remain one transaction.

## 5. Durable queue and fencing

Current SQLite jobs have owner + lease. Hosted workers need a **fencing token**:

```text
jobs(id, conversation_id, status, lease_owner, lease_until, fence, attempts)
```

- `claim` increments `fence` and returns it.
- Every commit and every non-replay-safe tool call checks `(job_id, fence)` is still current.
- A stale worker's writes are rejected, not just ignored.
- `renew` extends the lease; failure marks the job `orphaned` and aborts the run.
- A supervisor reclaims expired jobs after a grace period.
- Per-conversation advisory lock prevents two workers from owning one conversation.
- Retries are bounded (`attempts`), with exponential backoff and a dead-letter state.

The engine receives `isLeaseValid` and `fence` at run start; the local adapter keeps the current
`jobOwned` guard.

## 6. Sandbox runner

This is the largest real-app change.

```ts
interface ToolRunner {
  specs: ToolSpec[];
  execute(name: string, args: JsonObject, ctx: ToolContext): Promise<ToolResult>;
}
```

Local runner stays for dev. Hosted runner:

- **Isolation:** Docker runner implemented (read-only root, workspace-only mount, no network, caps
  dropped, limits). Firecracker microVM or gVisor is the next isolation step.
- **Filesystem:** overlayfs seeded from the workspace snapshot; writes are discarded unless the
  turn commits.
- **Network:** default deny; an egress proxy allowlists package registries and model APIs.
- **Limits:** CPU, memory, PID count, wall clock, output bytes; `bash` timeout enforced outside the
  container too.
- **Secrets:** injected as short-lived env vars, never written to the overlay; scrubbed from output.
- **Tools:** `read`/`write`/`edit` are RPCs into the sandbox, not host fs calls. `bash` runs inside.
- **Snapshots:** after a successful turn, diff the overlay and store content-addressed layers; the
  next turn resumes from a snapshot, not a re-clone.
- **Audit:** every command, exit code, and changed path is journaled.

The runner is a port, so the engine does not change. A container runner can land before microVMs.

## 7. Mobile app

A Capacitor config, PKCE helpers, and the native guide now exist; see [NATIVE-SHELL.md](NATIVE-SHELL.md).
The actual iOS/Android projects and OAuth exchange backend are still to be generated.

The PWA is the prototype. The real app:

- **Shell:** Capacitor (fastest path from React) or React Native.
- **Auth:** OAuth/OIDC with PKCE; secure storage for refresh tokens; device registration.
- **Sync:** the existing IndexedDB replica + outbox, with per-conversation cursors.
- **Push:** APNs/FCM for "answer ready", "approval needed", "run failed".
- **Background:** reconnect/backoff; a foreground service is not needed because work is server-side.
- **Offline:** read cached transcript, queue messages, show queued state.
- **Multi-device:** the same conversation can be open on phone and web; snapshots reconcile.
- **Approvals:** for risky tools, the sandbox asks the user; the phone can approve/deny.

## 8. Conversation UX

Real use requires more than one thread:

- **Multi-conversation**: list, create, rename, archive, search; each with its own workspace.
- **Forks**: branch from an entry; copy entries up to the fork point, share immutable history via
  content-addressed entry IDs if storage grows.
- **Compaction**: summarize older entries into a `pi.compaction` entry with a `coversUpTo` boundary;
  full journal retained; manual "compact now" and automatic threshold.
- **Steering**: implemented in the local engine; hosted workers keep the same semantics.
- **Queue**: follow-up messages wait for the current run; UI distinguishes both honestly.
- **Search**: Postgres full-text over entries, scoped by tenant.

## 9. Security and threat model

Assets: source code, credentials, model keys, tenant data, tool output.

Threats:

| Threat | Control |
| --- | --- |
| Cross-tenant read | RLS + tenant-scoped queries + worker job tenant checks |
| Prompt-injected `bash` | sandbox, egress deny, no host mounts, approval for risky commands |
| Secret exfiltration | short-lived secrets, output scrubbing, proxy logs |
| Path traversal | sandbox-rooted fs, reject absolute/`..` escapes |
| Token theft | short-lived access tokens, rotating refresh tokens, device binding |
| Replay/double execution | fencing tokens, exactly-once admission, sticky terminal states |
| Malicious repo | read-only base image, resource limits, no network by default |
| Abuse/cost | quotas, per-tenant rate limits, max turns/tokens, billing alerts |

## 10. Observability and cost

- OpenTelemetry traces: `conversation → submission → job → model call → tool call`.
- Structured logs with `tenant_id`, `conversation_id`, `job_id`, `fence`, `trace_id`.
- Metrics: queue depth, lease losses, run latency, tokens by provider/model, tool failures, sandbox
  OOM/timeouts, auth refresh failures.
- Usage events are append-only and drive billing.
- `/api/health` keeps the local shape; hosted adds `/readyz`, `/metrics`, and a job dashboard.

## 11. Reliability

- Postgres backups + point-in-time recovery; object storage versioning.
- Migrations are expand/contract; the journal is never rewritten in place.
- Workers are stateless; a crash only loses the current in-flight model call, which is retried under
  a new fence.
- A run is idempotent at the submission level; tool side effects are guarded by replay policy and
  fencing.
- Chaos tests: kill worker mid-tool, expire lease mid-run, partition API/worker, corrupt a snapshot.
- A conversation can be exported as JSONL and replayed into a fresh engine for debugging.

## 12. Rollout phases

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| 4A | Steer/queue, per-conversation idempotency, guarded states, live auth, write-amplification cuts | 150 tests, live split |
| 4B | Multi-conversation, forks, compaction, search | real UI, migration tests |
| 4C | Postgres `StorageV2`, fencing tokens, worker pool, object storage | conformance suite, two-worker chaos |
| 4D | Sandbox runner (container first, microVM later), egress policy, approvals | escape tests, resource-limit tests |
| 4E | Native shell, OAuth, push, multi-device | device matrix, offline tests |
| 4F | Tenancy, billing, quotas, audit, dashboards | tenant-isolation audit, cost reports |

## 13. Non-goals (for now)

- Multi-region active-active.
- Arbitrary user-provided tool plugins in the sandbox without review.
- Running model inference locally on the phone.
- A full IDE; the phone is a control surface, not a code editor.

## 14. Tradeoffs to decide deliberately

- **SQLite now vs Postgres later:** keep the local product fast; don't fake async in the engine.
- **Polling now vs pub/sub later:** polling at 120 ms is fine for one host; hosted needs
  `LISTEN/NOTIFY` or a wakeup bus, not faster polling.
- **Container vs microVM:** containers are operationally simpler; microVMs are the security target
  for untrusted code.
- **Monorepo vs services:** keep one repo and separate deployables until scale forces a split.

The local engine is the invariant. The real app is a set of adapters around it: Postgres, a fenced
queue, a sandbox, a native shell, and tenancy.
