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
```

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
| `quota.updated` | `admin` | an operator changed a quota |

`target` is `${conversationId}:${callId}` for approvals, `auth` for auth changes, and the tenant id
for quota changes. `data` carries the small structured context (tool, callId, argsKey, mode, limits).

## Admin API and dashboard

Set a token to enable the admin surface; when `RIBBHU_ADMIN_TOKEN` is unset **every** admin route
is a 404, so the surface does not exist for a self-hosted single-user install.

```bash
RIBBHU_ADMIN_TOKEN="$(openssl rand -hex 16)" npm run start:api
```

All `/api/admin/*` routes require `Authorization: Bearer <token>`; the compare is constant-time
(SHA-256 + `timingSafeEqual`). Unknown tenants are 404s, bad payloads are 400s, wrong methods 405s.

| Route | Result |
| --- | --- |
| `GET /admin` | minimal HTML dashboard (token prompt, tenant picker, usage cards, recent audit). No auth on the HTML itself; the JSON calls it makes carry the token. No external dependencies. |
| `GET /api/admin/tenants` | `{ tenants: [...] }` — Postgres `tenants` table; `["default"]` on SQLite |
| `GET /api/admin/usage?tenant=&limit=` | `{ tenant, day, month, recent }` where `day`/`month` are `usageSummary` totals and `recent` is `listUsage` |
| `GET /api/admin/audit?tenant=&limit=` | `{ tenant, events }` newest first (default 50, max 500) |
| `POST /api/admin/quota` | body `{ tenant, dailyTokens?, monthlyCostMicros? }`; numbers set a limit, `null` clears it, omitted fields are unchanged; journals `quota.updated` and returns `{ tenant, quota }` |

Postgres admin reads open a short-lived `PostgresStorage` per tenant (created lazily and cached for
the API process), so RLS — not the admin token — is what scopes rows to a tenant. `listTenants` uses
the `tenants` table, which is not RLS-scoped (it is the tenant index).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RIBBHU_ADMIN_TOKEN` | unset | Bearer token for `/admin` and `/api/admin/*`; unset disables them |
| `RIBBHU_COST_MICROS_PER_1K_TOKENS` | `0` | Usage pricing used for `cost_micros` and monthly cost quotas |

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

## Limits

- No billing, invoices, plan tiers, or payment provider integration.
- Quotas are per UTC day/month with no timezone configuration; they gate admission only.
- No per-user roles: one admin token for the whole deployment.
- The audit table is append-only but not cryptographically signed or hash-chained.
- SQLite has one tenant; Postgres multi-worker deployments share the tables via RLS.
- The dashboard is a thin HTML page, not a full operations product.
