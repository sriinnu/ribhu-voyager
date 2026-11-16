# SaaS control plane: usage, quotas, tenant admin, audit

Status: **Phase 12, minimal but real**. This is the operations layer on top of the durable
journal and the tenant-scoped storage: it records what the agent spent, lets an operator cap
usage, and exposes an auditable admin surface. It does not add billing, payments, or per-user
roles yet.

## Data model

Two append-only tables are added by migration (Postgres) and by the SQLite schema
(`packages/storage-*/src`):

```text
usage_events(id, tenant_id, conversation_id, submission_id, provider, model,
             input_tokens, output_tokens, cost_micros, created_at)
audit_events(id, tenant_id, actor, action, target, data JSON, created_at)
admin_tokens(id, label, token_hash, created_at, expires_at, revoked_at, last_used_at)  -- Postgres, migration v9
```

`admin_tokens` is **deployment-global** (no `tenant_id`, no RLS): admin identity is about the
deployment, not a tenant. Only the SHA-256 hash of an admin token is stored; the plaintext is
printed once by the CLI. The application role needs SELECT/UPDATE on the table; run
`npm run provision:postgres -- --url "$ADMIN_URL" --role ribhu_app` again after migrating if the role
was provisioned before migration v9 by a different owner (default privileges are per-owner).

- **Postgres**: both tables have `tenant_id` and RLS policies identical to the journal tables
  (`tenant_id = current_setting('app.tenant_id', true)`), so the same rules protect prompts,
  usage, and audit rows. `tenant_id` is filled from the storage instance's tenant.
- **SQLite**: a single local tenant (`default`); the same tables and methods exist so the engine
  and tests share one code path. `listTenants()` returns `["default"]`.
- **Quotas** live in the tenant-scoped `settings` table:
  - `daily_tokens` — max tokens per UTC day
  - `monthly_cost_micros` — max cost per UTC calendar month, in millionths of a currency unit

`Storage` gained `recordUsage`, `usageSummary(period)`, `listUsage(limit)`, `recordAudit`,
`listAudit(limit)`, `quota`, `setQuota`, and `listTenants`.

### Usage

The engine records one `usage_events` row per model turn in `addUsage` (same transaction as the
assistant journal entry), with the model ref's provider/model, input/output token counts, the
conversation and the first active submission id.

Cost is configurable and defaults to **0** when pricing is unknown:

```bash
RIBBHU_COST_MICROS_PER_1K_TOKENS=2000   # 2000 micros = 0.002 per 1k tokens
```

`cost_micros = round((input + output tokens) / 1000 * rate)`. Per-conversation totals are still
kept in the `pi.usage` doc for the phone; the events table is the authoritative reporting source.

### Quotas

`admitSubmission` (shared by the API process and the engine) checks `quota()` before it creates a
submission:

- daily tokens: `usageSummary("day").totalTokens >= daily_tokens` → reject
- monthly cost: `usageSummary("month").costMicros >= monthly_cost_micros` → reject

A rejected admission throws `QuotaExceeded` (name `QuotaExceeded`, `code: "quota_exceeded"`) with a
message such as `Daily token quota exceeded: 1200 of 1000 tokens used today.` The submission is not
stored and no run is enqueued. The gateway's existing error path forwards the message to the
client; a dedicated wire code would require a protocol change.

Quotas are enforced at admission time. Work already admitted before a limit is lowered is not
retro-actively cancelled.

### Audit

Every approval transition is an immutable `audit_events` row in addition to the `pi.approval`
journal entries:

| action | actor | when |
| --- | --- | --- |
| `approval.requested` | `engine` | a pending request is journaled |
| `approval.approved` | `user` | the user approves once |
| `approval.denied` | `user` | the user denies (timeout denials add `reason: "timeout"`) |
| `approval.always` | `user` | the user approves and a durable exact-call rule is written |
| `approval.auto` | `engine` | an existing rule auto-approves the call |
| `auth.mode_changed` | `user` | the API process stored a requested auth mode |
| `auth.mode_applied` | `worker` | the worker actually switched the provider credential mode |
| `quota.updated` | `admin` / `admin:<label>` | an operator changed a quota |
| `admin.tenants_view` | `admin` / `admin:<label>` | an operator listed tenants |
| `admin.usage_view` | `admin` / `admin:<label>` | an operator read usage |
| `admin.audit_view` | `admin` / `admin:<label>` | an operator read the audit log |

`target` is `${conversationId}:${callId}` for approvals, `auth` for auth changes, and the tenant id
for quota changes. `data` carries the small structured context (tool, callId, argsKey, mode, limits).

## Admin API and dashboard

The admin surface is enabled by either:

- the legacy deployment-wide `RIBBHU_ADMIN_TOKEN` env token, or
- a Postgres `admin_tokens` row (multi-admin, expiring/revocable, audited with an actor label).

On SQLite/local, when `RIBBHU_ADMIN_TOKEN` is unset **every** admin route is a 404. In Postgres the
routes exist whenever the database is configured (401 until a valid token is presented).

```bash
RIBBHU_ADMIN_TOKEN="$(openssl rand -hex 16)" npm run start:api
```

All `/api/admin/*` and `/api/metrics` routes require `Authorization: Bearer <token>`; env-token
compares are constant-time (SHA-256 + `timingSafeEqual`) and DB tokens are looked up by hash
(revoked/expired tokens are rejected, `last_used_at` is updated). The audit actor is `admin` for the
env token and `admin:<label>` for DB tokens. Unknown tenants are 404s, bad payloads are 400s, wrong
methods 405s.

### Admin tokens (Postgres)

```bash
# RIBBHU_POSTGRES_URL must point at the database (admin URL recommended)
npm run admin-tokens -- issue --label ops-alice --days 30   # prints the plaintext once
npm run admin-tokens -- list                                # metadata only, never hashes
npm run admin-tokens -- revoke --id 3
npm run admin-tokens -- revoke --token ribhu_admin_...
```

Admin tokens are deployment-global, independent of tenant API tokens, and not exposed by the list
command (`token_hash` never leaves the database).

| Route | Result |
| --- | --- |
| `GET /admin` | minimal HTML dashboard (token prompt, tenant picker, usage cards, recent audit). No auth on the HTML itself; the JSON calls it makes carry the token. No external dependencies. |
| `GET /api/admin/tenants` | `{ tenants: [...] }` — Postgres `tenants` table; `["default"]` on SQLite |
| `GET /api/admin/usage?tenant=&limit=` | `{ tenant, day, month, recent }` where `day`/`month` are `usageSummary` totals and `recent` is `listUsage` |
| `GET /api/admin/audit?tenant=&limit=` | `{ tenant, events }` newest first (default 50, max 500) |
| `POST /api/admin/quota` | body `{ tenant, dailyTokens?, monthlyCostMicros? }`; numbers set a limit, `null` clears it, omitted fields are unchanged; journals `quota.updated` and returns `{ tenant, quota }` |
| `GET /api/metrics` | Prometheus text (see below); admin-token protected |

Postgres admin reads open a short-lived `PostgresStorage` per tenant (created lazily and cached for
the API process), so RLS — not the admin token — is what scopes rows to a tenant. `listTenants` uses
the `tenants` table, which is not RLS-scoped (it is the tenant index).

### Metrics

`GET /api/metrics` returns Prometheus text (`text/plain; version=0.0.4`) for the deployment's
default tenant. It is protected by the same admin bearer tokens as `/api/admin/*`.

| Metric | Meaning |
| --- | --- |
| `ribhu_queue_pending_jobs` / `ribhu_queue_running_jobs` | job queue depth |
| `ribhu_queue_oldest_pending_age_seconds` | how long the oldest pending job has waited |
| `ribhu_workers_total` / `ribhu_workers_alive` | workers with a published heartbeat / within the 15s stale window |
| `ribhu_usage_day_tokens` / `ribhu_usage_month_tokens` | recorded model tokens for the default tenant |
| `ribhu_usage_month_cost_micros` | recorded cost for the default tenant |
| `ribhu_tenant_runtimes_active` / `ribhu_tenant_runtimes_capacity` / `ribhu_tenant_runtimes_unlimited` | API-process tenant runtime pool |
| `ribhu_schema_version` | applied storage schema version |

`/api/health` is unchanged (it is not Prometheus output).

## Retention

`usage_events` and `audit_events` are append-only reporting tables and can be pruned by age without
touching the journal:

```bash
# dry-run is the default; prints the row counts per tenant
npm run retention:postgres -- --days 90
npm run retention:postgres -- --days 90 --apply            # delete older than 90 days
npm run retention:postgres -- --days 90 --tenant tenant-a  # one tenant only

# SQLite/local journal (same CLI, explicit --sqlite path)
npm run retention:postgres -- --days 90 --sqlite .ribhu-data/ribhu.sqlite --apply
```

Postgres mode uses the RLS-scoped storage per tenant (one storage instance per tenant, so a
`BYPASSRLS`/superuser role keeps working but a normal app role only sees its tenant). The command
deletes **only** `usage_events` and `audit_events` older than the cutoff — never conversations,
entries, docs, submissions, jobs, or tokens — and prints counts per tenant plus totals. Under RLS it
iterates the `tenants` table (or just `--tenant`). SQLite builds call `deleteOldUsage` /
`deleteOldAudit` on the local schema (schema marker stays at its current version; retention is data,
not a migration).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RIBBHU_ADMIN_TOKEN` | unset | Legacy deployment-wide bearer token for `/admin`, `/api/admin/*`, `/api/metrics`; Postgres can use DB admin tokens instead |
| `RIBBHU_COST_MICROS_PER_1K_TOKENS` | `0` | Usage pricing used for `cost_micros` and monthly cost quotas |
| `RIBBHU_POSTGRES_URL` | unset | Connection string for the admin-token and retention CLIs (or pass `--url`) |
| `RIBBHU_SQLITE_PATH` | unset | SQLite journal path for `retention:postgres --sqlite` (or pass `--sqlite`) |

`loadConfig` validates the pricing as a non-negative number; `describeConfig` prints whether the
admin surface is enabled.

## Tests

`apps/server/test/usage.test.ts` (SQLite, no Docker):

- a run records a usage event with provider/model/tokens/conversation/submission
- configured pricing is recorded as cost
- daily token and monthly cost quotas block admission with `QuotaExceeded`; lifting a quota admits again
- approval request and decision audit rows (engine + API runtime writers)
- SQLite default tenant scoping for usage and audit
- auth mode changes are audited

`apps/server/test/admin.test.ts` (SQLite, no Docker):

- all admin routes 404 when no token is configured
- bearer auth (missing/wrong/empty 401), method/route errors, dashboard HTML
- usage/audit JSON, quota POST (including validation, audit, unknown tenant)
- admin read auditing (`admin.tenants_view`, `admin.usage_view`, `admin.audit_view`)
- admin token hash stability (SHA-256, plaintext never stored)
- retention: dry-run counts, apply deletion, journal untouched, invalid cutoff rejected

`apps/server/test/metrics.test.ts` (SQLite, no Docker):

- `/api/metrics` 404 when admin is disabled, 401 without/with wrong token, 200 Prometheus text
- queue depth, worker alive/total (stale heartbeat excluded), day/month usage tokens + cost
- tenant runtime pool active/capacity/unlimited and schema version gauges

## Limits

- No billing, invoices, plan tiers, or payment provider integration.
- Quotas are per UTC day/month with no timezone configuration; they gate admission only.
- Admin identity is deployment-wide; there are no per-user roles. The legacy env token is
  static until rotated by restart; Prefer DB admin tokens (expiring/revocable) for hosted use.
- The audit table is append-only but not cryptographically signed or hash-chained, and retention
  can prune it by age (by design — export first if you need long-term evidence).
- Metrics report the default tenant only; per-tenant metrics labels are not implemented.
- SQLite has one tenant; Postgres multi-worker deployments share the tables via RLS.
- The dashboard is a thin HTML page, not a full operations product.
