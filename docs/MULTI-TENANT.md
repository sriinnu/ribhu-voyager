# Multi-Tenant Routing

The API process can serve multiple Postgres tenants on one port. A token selects the tenant; a
runtime (storage, engine, auth) is created lazily and cached per tenant.

## Topology

```text
PWA / API client
   │  token
   ▼
API (runtime pool) ──▶ tenant-a runtime ──▶ Postgres RLS (tenant-a)
   │                 └▶ tenant-b runtime ──▶ Postgres RLS (tenant-b)
   │
   └── WebSocket / health per token
Worker A (RIBBHU_TENANT=tenant-a) ──▶ tenant-a jobs
Worker B (RIBBHU_TENANT=tenant-b) ──▶ tenant-b jobs
```

- One API process can serve many tenants.
- Run **one worker per tenant**: workers still bind to `RIBBHU_TENANT`. There is no worker
  autoscaler or cross-tenant job router yet.
- Postgres must use a `NOSUPERUSER NOBYPASSRLS` role; RLS separates conversations, entries, docs,
  submissions, jobs, tool tasks, settings, and cancels.

## Tokens

Issue one token per tenant with the admin URL:

```bash
RIBBHU_POSTGRES_URL="$ADMIN_URL" \
  npm run tokens:postgres -- issue --tenant tenant-a --label phone-a --days 30
```

The API resolves the token with `resolveApiToken`; unknown/revoked/expired tokens get HTTP 401 on
WebSocket upgrade and only minimal health over HTTP. In Postgres mode the shared `RIBBHU_TOKEN` is
not a master key.

## Health

```bash
curl -H "Authorization: Bearer $TENANT_TOKEN" https://gateway.example.com/api/health
```

Authenticated health is scoped to that token's tenant: worker snapshots, queue, auth state.
Unauthenticated health returns only `{ok, protocol, uptimeMs}`.

## Isolation guarantees

- A tenant token cannot resync, fork, rename, archive, submit to, or abort another tenant's
  conversation ID; the ID simply does not exist in that runtime.
- WebSocket views and auth broadcasts are runtime-scoped.
- Postgres RLS is the final boundary; SQLite multi-tenant mode is for tests only (separate data
  directories).

## Limits

- No tenant provisioning/admin API, per-tenant quotas, billing, or audit dashboard.
- Workers are deployed per tenant; no shared worker pool.
- No token rotation UI beyond the CLI (`issue` / `revoke`).
- The API process holds one runtime per active tenant; capacity planning is per process.
